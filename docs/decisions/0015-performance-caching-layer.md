# ADR-0015: Performance layer — TTL+SWR cost caching, keep-warm loops, compression, asset edge-caching

- **Status**: Accepted
- **Date**: 2026-07-12
- **Deciders**: @whchoi98
- **Relates to**: [ADR-0004](0004-compliance-pagination-prewarm.md) (the original prewarm pattern), [ADR-0011](0011-rbac-group-visibility-native.md)/[ADR-0014](0014-membership-source-compliance-members.md) (the group features whose latency this absorbs)

## Context

Measured 2026-07-12: the Cost page's upstream calls run 1.5 s (org cost
report, 1-day window) to **12.8–30 s** (`cost_report × rbac_group_id` — the
same slow membership backend behind the documented 503 flap), and the
group-scoped `/cost/live` filter costs ~12 s cold. Every dashboard visit
re-paid these against the **shared 60 rpm org budget**; two Fargate tasks
hold independent in-memory state (ALB round-robin), so warming one task
didn't help the other; every deploy reset everything. The transfer layer was
also raw: CloudFront's dynamic behaviors run `CACHING_DISABLED` (which
disables its compression too), Express had no compression middleware, so the
~1.1 MB SPA bundle and every JSON payload shipped uncompressed with no edge
caching — re-downloaded after each deploy's hash change.

## Decision

Four cooperating pieces, all in-process (no Redis/ElastiCache — see below):

1. **`makeTtlCache`** (pure, exported, unit-tested): 10-min success TTL;
   expired hits serve stale immediately with one deduped background refresh
   (**stale-while-revalidate**); a failed refresh marks subsequent serves
   `stale: true` (an upstream flap must never hide behind unmarked cached
   data); past 6×TTL the entry drops and failures reach the route's normal
   degradation chain (last-good / flap 503 / 502); concurrent misses share
   one in-flight fetch; 45 s per-page upstream `AbortSignal`s keep a hung
   connection from pinning the dedup slot. Fronts `/cost/live`,
   `/cost/groups`, `/cost/spend-limits` and the whole `fetchUserReport`
   family (one entry serves `/cost/users`, `/cost/user-tokens`, the
   efficiency join and the `/api/groups` spend fallback).
2. **Keep-warm loops per task** (each task warms itself — closes the
   round-robin cold-task gap and the post-deploy reset): an 8-min cost cycle
   (start-jittered ≤2 min to de-phase the tasks) re-registers the UI's four
   preset windows plus **every RBAC group's default-window scoped key**
   (group tabs answer instantly), prunes the previous UTC day's key
   generation, `topUp`s entries older than 5 min with 10 s inter-key sleeps
   (budget pacing), and expires user-driven keys after 90 min idle; a 5-min
   analytics cycle warms the engagement endpoints (`users/range` is
   day-granular, so ONE 30-day warm covers every preset sub-range on all
   pages) and the `/cost/efficiency` join.
3. **Transfer layer**: Express `compression()` (bundle 1.12 MB → ~324 KB,
   API JSON ~95 % smaller; the SSE chat stream is exempt via its existing
   `no-transform` header) and a CloudFront `/assets/*` behavior with
   `CACHING_OPTIMIZED` (brotli at the edge; content-hashed filenames make
   invalidation unnecessary; the `check-auth` viewer function still runs on
   every request, so caching never bypasses Cognito). Origin `readTimeout`
   30 → 60 s so a genuinely cold 30-day group window can finish.
4. **Client stale-while-revalidate** (`useCostData`): a same-scope refetch
   keeps rendering the last settled response under a "Refreshing…" pulse;
   scope changes keep the loading veil so another group's numbers never
   render under the wrong tab (scope trusted only when the server echoes it).

## Alternatives considered

- **Shared cache (Redis/ElastiCache)** — solves per-task divergence
  centrally, but adds a network hop, an always-on cost line, and a new
  failure domain for a 2-task service whose whole dataset fits in memory;
  per-task keep-warm achieves the same user-visible result.
- **Longer TTLs instead of keep-warm** — upstream data carries a ~4 h
  `data_refreshed_at` watermark, so long TTLs are safe for freshness, but
  they don't fix cold starts (deploys, new windows, second task) — the
  actual complaint. Keep-warm fixes cold; the 10-min TTL just bounds
  staleness between cycles.
- **CloudFront caching for API responses** — the responses are
  Cognito-gated and window-parameterized; edge-caching them would need
  per-cookie cache keys (defeats caching) or risk cross-user leakage.
  In-process caching behind the auth gate is strictly safer.

## Consequences

- Warm hits are ~1 ms vs 1.5–30 s upstream; after a deploy each task is
  fully warm ~5–6 min post-boot (paced cycle), and the default Cost view
  within ~90 s (priority-ordered registration).
- Steady-state upstream load: ~69 requests / 8-min cycle / task for cost +
  ~10 / 5-min for analytics, paced (sleeps + jitter + `topUp` skip) to
  coexist with real traffic inside the 60 rpm org budget. A 429 on a
  best-effort sub-report can blank the cost-type/cache-tier cards for one
  cycle (known, accepted).
- Data staleness is bounded and honest: ≤10 min normally (upstream watermark
  is ~4 h anyway), `stale: true` marks flap-degraded serves and lights the
  existing UI badges.
- The adversarial review of each round is the real spec: silent page-cap
  truncation must throw, expired entries must not mask outages, dedup
  requires timeouts, zombie preset generations must be pruned — see the
  review-fix commits (`e76037a`, `af279d5`, `6b54b88`).
- Known limit: a first-ever custom window/group combination still pays the
  upstream price once per task; CloudFront's 60 s origin timeout is the
  ceiling for such cold fetches.
