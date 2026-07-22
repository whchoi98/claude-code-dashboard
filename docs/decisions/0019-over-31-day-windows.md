# ADR-0019: Serving >31-day windows — chunked cost reports + archive-first engagement ranges

- **Status**: Accepted
- **Date**: 2026-07-22
- **Context**: user report "30일 이상 조회 수치가 맞지 않습니다"

## Problem

Every date window longer than 31 days returned wrong numbers, through two
independent mechanisms:

1. **Engagement ranges silently truncated.** `/api/analytics/users/range` and
   the skills/connectors/projects `/range` fan-outs clamped every request to
   its most recent 31 days (`rangeDates(...).slice(-31)`) while the response's
   `range` field echoed the full requested window. Eleven pages label their
   windows from URL state, so a 90-day request rendered last-31-day totals
   under a 90-day label. `/api/admin/claude-code/range` shares the clamp but
   has no frontend consumers (left as-is).
2. **The cost family hard-fails.** The upstream Analytics cost endpoints
   (`cost_report`, `usage_report`, `user_cost_report`, `user_usage_report`)
   reject any span over 31 days with 400; the server surfaced 502 and the Cost
   page silently substituted the whole-CSV-period org-wide numbers (primary) or
   collapsed to the no-CSV empty state (org2). Executive rendered the failed
   fetch as **$0 spend**.

Adjacent defect found during the audit: on any upstream failure (e.g. the 429
that a 31-wide parallel live fan-out itself provokes), `summaries` and the
single-day analytics routes returned deterministic **mock rows** even on keyed
deployments — fake numbers rendered as real.

## Decision

### Cost family: chunk, merge, cap

`splitCostWindow(starting, ending)` splits a window into consecutive ≤31-day
inclusive chunks (oldest first), capped at **6 chunks = 186 days**; longer
requests clamp to the newest 186 days and set `window_clamped: true` (the
response `period` always reflects what was served; the Cost page shows an
amber banner). All four report fetchers ride it:

- `fetchCostSummary` and `fetchGroupCost` fetch chunks two-at-a-time via
  `fetchReportPagesChunked` and **concatenate daily buckets** — every consumer
  (`analyticsReportsToCostResp`, `aggregateGroupCost`) aggregates via Maps, so
  disjoint-chunk concatenation is exact. Verified live: a 64-day chunked total
  equals the sum of three independent ≤31-day windows to the cent.
- The `cost_type`/`token_type` rollups are fetched **only for single-chunk
  windows** — on a 6-chunk query they would double the upstream bill for two
  best-effort cards. Multi-chunk responses omit them; the UI hides the cards.
- `fetchUserReportUncached` walks each chunk's pagination, then
  `mergeUserReportRows` re-aggregates rows per (user × dim) — without this the
  UNGROUPED `userCostToUsers` path (a 1:1 mapper) would render one row per
  chunk per user. Cents survive as decimal strings (float-sum → re-string).

### Engagement ranges: archive-first over the whole window

`serveArchiveRange` (server/index.js) replaces the per-route fan-outs:

- **S3 first for every requested day** (pool of 24; S3 reads are KB-scale and
  effectively free). `users/range` keeps the columnar+`inflateUser` path;
  skills/connectors/projects read the **raw sidecar** (`raw/<table>/date=D/`)
  — exact unflattened live-API-shape rows, no inflate step, no field loss
  (the columnar tables drop `invocation_count`, nested `*_metrics`,
  `attributed_list_price` that Adoption/UserDetailPanel consume).
- **Live fallback only for the newest ≤31 missing days**, pool of 5 — an
  unbounded 90-day parallel burst was measured to exhaust the shared 60 rpm
  org budget and 429 the requests behind it. Older misses return
  `source: 'unarchived'` with empty data.
- Every response carries `coverage { requested_days, s3_days, live_days,
  unarchived_days, error_days }`; a shared `RangeCoverageNote` banner (wired
  into 12 pages) surfaces windows the archive couldn't fully cover.
- Hard cap `MAX_RANGE_DAYS = 366` (UI floor is 2026-01-01, so unreachable
  today — a guard, not a policy).

### No mock on keyed failures

`summaries` + the single-day users/skills/connectors/projects routes now
return `{ source: 'upstream_error', data: [] }` on keyed upstream failure.
Mock stays for keyless local dev only.

### Frontend honesty

Executive renders spend `'—'` (never $0) when the cost fetch failed;
UserDetailPanel's `days <= 31` cost-card gating is removed (superseded by
chunking); Users' cache-hit column and the Cost Top tables now follow >31-day
windows for real.

## Consequences

- A cold 186-day `/cost/live` costs ~60 upstream requests (2 reports × 6
  chunks × ~5 pages) spread over waves — one such query can consume most of a
  minute's budget. Windows ≤31 days are byte-identical to before. The 10-min
  SWR cost cache + keep-warm absorb repeats; user-driven long-window keys idle
  out of keep-warm after 90 min.
- `users/range` at ~200 days ≈ ~200 parallel S3 GETs per uncached page view
  (tens of ms each, pooled) — measured <2s total. No server-side response
  cache was added; the per-day upstream `fetchJson` cache (10 min) still
  bounds live-call repeats.
- The archive is now **load-bearing for history**: days missing from S3 and
  older than the live budget window render as zeros (flagged). Archive gaps
  found by the audit (org2: 25 scattered days; primary: 2026-06-07) were
  backfilled the same day while still inside the API's 90-day lookback.
- Raw sidecar (`raw/<table>/`) is now a **read path**, not just a recovery
  net — keep writing it for every partition (collector) and keep its key
  format stable (`raw/<table>/date=D/<table>-D.json`).

## Rejected alternatives

- **Athena for long windows**: correct but 3-10s query latency per page view
  and a second read path to keep consistent; S3 GetObject serves the same
  NDJSON in tens of ms.
- **Raising the upstream span cap**: not ours to change (documented upstream
  behavior, measured 2026-07-03).
- **Frontend-side chunking**: would fix one page at a time and leak the
  upstream cap into every consumer; the server is the single place all six
  cost routes share.
