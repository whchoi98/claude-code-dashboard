# ADR-0016: Audit response-level cache + degraded-200 partial contract

- **Status**: Accepted
- **Date**: 2026-07-15
- **Deciders**: @whchoi98
- **Amends**: [ADR-0004](0004-compliance-pagination-prewarm.md) · **Extends**: [ADR-0015](0015-performance-caching-layer.md)

## Context

ADR-0004's design (cap the after_id walk at `pages=20/max=2000`, prewarm the
upstream *page* cache via HTTP self-calls) held while a capped walk fit inside
the origin timeout. Two things broke it in 2026-07:

1. **Audit volume explosion.** `claude_file_viewed` events pushed org volume
   past 2000 events per preset window (≈700+/day, 1400 events in 1.5 days
   measured 2026-07-15). Every preset window now hits the cap, so every cold
   walk runs the full 20 pages — **30–85 s** at observed upstream latency
   (~2–4 s/page under the shared 60 rpm budget contention).
2. **CloudFront origin timeout is 60 s.** Any request landing on a task whose
   10-min page cache had just expired re-paginated in the foreground and got
   killed by CloudFront → the Audit page never loaded. A mid-walk 429 also
   failed the entire request even with 19 pages already aggregated.

A subtle third defect surfaced during review: the prewarm windows still used
the *engagement-buffer* offsets (`today−9/−16/−32`) from before the
DateRangeControl allowed `today` as the upper bound, while the frontend sends
`today−(days−1)`. For the page-cache era that mismatch was harmless (the
after_id page chain is date-agnostic); the moment a *response*-level cache
keyed on the query tuple was introduced, it became fatal — the prewarm warmed
keys nobody requests.

## Decision

Wrap `/api/compliance/activities` in the same `makeTtlCache` SWR machinery as
the cost family (ADR-0015), with walk semantics tuned for the sequential
cursor:

1. **Response-level SWR cache** — key = the full query tuple (`auditKey`),
   10-min TTL, in-flight dedup, stale-while-revalidate up to 6×TTL.
2. **Dual walk budgets** — foreground walks get **45 s + a 15 s per-page
   `AbortSignal`** (hard-bounded under CloudFront's 60 s even against a hung
   socket); background walks (prewarm top-ups and the throttled
   `scheduleAuditCompletion` retry that follows any partial serve) get
   **240 s** so cached entries converge to *complete* results. Foreground and
   page TTLs are equal, so a budget-capped refresh would otherwise
   re-truncate at the same depth forever.
3. **Degraded-200 partial contract** — mid-walk failures (429/5xx/network)
   and budget exhaustion return the aggregated events as HTTP 200 with
   `partial: true` and a diagnostic `stop_reason`
   (`time_budget` / `upstream_<status>` / `upstream_network`) instead of
   failing the request. Only a first-page failure surfaces the upstream
   error. Consumers (Compliance page banner, Executive Risk KPI hint) must
   treat any stop outside `starting_date / has_more=false / empty` as a
   truncated window.
4. **Prewarm = direct `topUp`, formula-identical keys** — the prewarm calls
   `auditCache.topUp` in-process (no HTTP self-call) for the four
   DateRangeControl preset windows (`1d = today−3`, `7d/14d/30d =
   today−(days−1)`, upper = `today`, `max=2000&pages=20`). **The prewarm
   windows and the frontend presets must stay formula-identical** or the
   response cache warms dead keys.

## Consequences

### Positive

- Warm requests serve in ~1–8 ms; the Audit page can no longer 504.
- A single upstream flap degrades one response to a labeled partial instead
  of erroring the page; background completion self-heals within ~a minute.
- Concurrent visitors share one walk (in-flight dedup) instead of stacking
  20-page cursor walks on the shared 60 rpm budget.

### Negative / accepted

- Data is still truncated to the newest 2000 events per window at current
  volume — the UI banner communicates this; longer audit history needs the
  (not yet built) Compliance→S3 archive.
- Partial results are cached like successes for up to one TTL before the
  background completion replaces them; consumers see a `partial` flag but a
  brief window of under-counted data is possible.
- The formula coupling between `useDateRange` presets and the server prewarm
  is a cross-layer invariant enforced only by convention + docs — changing
  preset math without touching the prewarm reintroduces dead-key warming.
