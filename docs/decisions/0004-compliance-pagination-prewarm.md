# ADR-0004: Compliance API pagination + startup prewarm

- **Status**: Accepted
- **Date**: 2026-05-09
- **Deciders**: @whchoi98

## Context

Anthropic's Compliance API (`/v1/compliance/activities`) has two properties
that together caused the audit feed to break in production:

1. **No timestamp filter.** The endpoint accepts neither `since` /
   `created_after` nor any equivalent. To reach events from N days ago you
   must paginate from "now" backward.
2. **Cursor pagination via `after_id`** — the next page is fetched by
   passing the *last event id* of the current page. The response does NOT
   include a `next_page` token; relying on `body.next_page` (a pattern that
   works for `cost_report` / `usage_report` / `users/range`) silently
   breaks after the first page.

The original server implementation read `body.next_page` to advance the
cursor. With that field always `null`, the loop exited after page 1 → the
audit feed effectively returned only the most-recent ~100 events,
typically a single day on this org.

A second issue compounds the first: this org generates ~1500 events/day,
so a 14-day window requires ~21000 events = 210 sequential `after_id`
hops × ~1.5 s/hop ≈ 5 minutes. CloudFront's default origin response
timeout is 30 s and ALB's idle timeout is 60 s — a synchronous fetch
would time out long before completion.

## Decision

Two-part fix.

**1. Cursor correctness.** Derive the `after_id` cursor from `data[-1].id`
of each upstream page rather than `body.next_page`. Continue paginating
while `body.has_more` is true. Accept `starting_date` and stop the loop
as soon as a page's oldest event predates that date — for date-bound
queries this terminates in ≤(events_per_day × days)/100 hops instead of
walking the full event log.

**2. Startup prewarm + capped page size.** The user-facing route caps at
`max=2000` / `pages=20` (~30 s in the worst case, comfortably inside the
ALB and CloudFront timeouts). On every ECS task boot, a background
self-fetch warms the upstream cache for the three preset windows
(7d / 14d / 30d) and a 5-minute interval keeps the cache fresh. The
upstream cache TTL was bumped from 5 to 10 minutes to overlap with the
prewarm interval.

The result: when a user lands on the audit page, the request hits the
already-warm upstream cache and returns in <1 s; even on a cold-cache
first request the cap keeps the response inside the timeout budget.

## Consequences

### Positive

- Audit feed actually shows the requested window (was: silently 1 day).
- Sub-second response on warm cache; ≤30 s on cold.
- Zero new infra: the prewarm runs inside the existing Express server,
  uses the existing in-memory cache.
- The same approach works on additional Compliance views in the future
  (just add a window to the prewarm list).

### Negative

- Very noisy orgs (>2000 events in the requested window) hit the per-
  request cap before reaching `starting_date`. The UI surfaces this via
  an amber `audit.cap.warning` banner sourced from the `stop_reason`
  response field. Workaround: pick a narrower window or wait for the
  next cache refresh — there is no graceful "load more" yet.
- The in-memory cache is per-task. Both Fargate tasks prewarm
  independently, so a fresh deploy briefly halves the warm hit rate
  (5 min until both tasks finish their first prewarm cycle). Acceptable
  for the deploy cadence; a shared external cache would solve it but
  isn't worth the operational cost yet.
- The Compliance API is consumed N times per task per 5 minutes, where
  N = number of preset windows × pages per window. With the current
  configuration this is well within the 60-rpm rate limit per key.

### Rejected alternatives

- **S3 archive (collector pattern)**: extend `collector/handler.js` to
  snapshot compliance events daily. Proper long-term solution and
  consistent with how Analytics endpoints work, but heavier (new Glue
  table, IAM, partition projection, cursor restart logic for
  partial-day failures). Tracked as a follow-up.
- **Synchronous fan-out across multiple cursors**: cursor pagination is
  inherently sequential — without a starting cursor for the second
  worker, you can't parallelize.
- **Client-side polling for additional pages**: avoids the timeout but
  shifts complexity to the React side and breaks the "single fetch,
  single render" pattern every other page on the dashboard uses.

## References

- [`server/index.js`](../../server/index.js) — `/api/compliance/activities`
  handler with `after_id` cursor + `starting_date` early termination, and
  the `app.listen` callback that schedules the prewarm.
- [`src/pages/Compliance.tsx`](../../src/pages/Compliance.tsx) — passes
  `max=2000&pages=20&starting_date=&ending_date=` and renders the
  `audit.cap.warning` banner when `stop_reason === 'max'`.
- Anthropic Compliance API docs (cursor format inferred from live
  request probing — `before_id` / `after_id` accepted, `next_page` not
  emitted).
