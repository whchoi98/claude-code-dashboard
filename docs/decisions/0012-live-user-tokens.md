# ADR-0012: Live per-user tokens via user_usage_report (CSV fully demoted to fallback)

- **Status**: Accepted
- **Date**: 2026-07-04
- **Deciders**: @whchoi98
- **Resolves**: the per-user **token** limitation left open by [ADR-0009](0009-live-user-cost.md)

## Context

ADR-0009 moved per-user *spend* to the live `user_cost_report` but noted
"per-user token granularity remains CSV-only (no live source exists)" — the
token-ranked Top-10 tables therefore showed whole-CSV-period totals that
ignored the selected date range (part of the 2026-07 Cost-page inaccuracy
report). Verified live 2026-07-04: the Analytics family now exposes
`GET /v1/organizations/analytics/user_usage_report` — per-actor
`uncached_input_tokens`, `cache_creation{1h,5m}`, `cache_read_input_tokens`,
`output_tokens`, `total_tokens`, `requests`, same envelope/window rules as
`user_cost_report`.

## Decision

Add `GET /api/cost/user-tokens` (shared `fetchUserReport` pagination +
`resolveUserCostWindow` per ADR-0010). `userUsageToUsers` collapses input as
uncached + cache_read + cache_creation(1h+5m) — the same convention as the
org-wide reshape, reconciling exactly with the upstream row's `total_tokens`.
The token Top-10 tables source this live data first (range-following), then
the efficiency payload's activity-scaled values in CSV mode, then raw CSV
totals — the CSV case alone carries the "does not follow the selected range"
caption. The Spend Report CSV is thereby demoted to fallback-only: >31-day
reconciliation windows (ADR-0010's span cap) and live-report outages.

## Consequences

- Closes ADR-0009's remaining negative — the Cost page's per-user analysis is
  fully live, and every per-user table follows the selected range.
- One more paginated upstream call per Cost-page load against the org-level
  60 rpm budget (shared, not per key) — acceptable today; revisit with
  server-side caching if viewer concurrency grows.
- The CSV upload/reconciliation UI stays (still the only >31-day and
  outage path), so no user-facing removal.
- ADR-0003's original "no per-user dimension" constraint is now fully
  superseded (spend by 0009, tokens by this ADR).
