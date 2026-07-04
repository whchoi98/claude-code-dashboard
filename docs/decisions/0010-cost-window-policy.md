# ADR-0010: Cost-family date windows — serve the buffer, cap at 31 days, keep /cost/efficiency aligned to today−3

- **Status**: Accepted
- **Date**: 2026-07-03
- **Deciders**: @whchoi98
- **Amends**: the date-clamping convention assumed since [ADR-0003](0003-hybrid-live-cost.md)/[ADR-0009](0009-live-user-cost.md)

## Context

The proxy historically clamped every Analytics date to `today − 3` because the
API returned HTTP 400 inside the 3-day finalization buffer. Verified live on
2026-07-03: the **cost family** (`cost_report`, `usage_report`,
`user_cost_report`, `user_usage_report`) now serves buffer days with *partial*
data under a `data_refreshed_at` watermark (docs later confirmed: ~4 h refresh,
final ~30 days), while the **engagement family** (`users`, `users/range`,
`summaries`, …) still 400s inside the buffer. The stale clamp made the Cost
page's per-user sections cover 3 fewer days than the headline KPIs, and the
one-sided clamp (ending only) inverted fully-recent ranges into upstream 400s.
Separately, the whole cost family rejects request spans over **31 days**
("date range must span at most 31 days") — our 32-day defaults were one day
over.

## Options considered

1. **Unclamp everything uniformly** — simplest, but `/cost/efficiency` joins
   spend with `users/range` productivity, which stays buffer-clamped upstream;
   a full-range spend window divided by a shorter productivity window inflates
   $/LOC, $/commit and skews the economic score (caught by adversarial review
   of the first attempt).
2. **Keep everything clamped to today−3** — windows stay aligned but the
   per-user tables permanently disagree with the headline KPIs (the original
   user-reported inaccuracy).
3. **Split policy (chosen)** — headline + per-user spend/tokens/groups cover
   the full selected range; only the ratio-producing efficiency join stays
   aligned to the productivity source's buffer.

## Decision

`resolveUserCostWindow` (pure, unit-tested) resolves cost-family windows:
ending clamps to **today** only, inverted pairs pin starting back to ending,
defaults are `[today−30, today]` (31 inclusive days — the upstream span cap).
`/api/cost/users`, `/api/cost/user-tokens`, `/api/cost/groups`, and
`fetchCostSummary` (`/api/cost/live` + the chatbot cost tool) use it.
`/api/cost/efficiency` **deliberately** clamps its whole window to `today − 3`
and pins starting ≤ ending, so every spend÷productivity ratio compares like
windows; the headline-consistent Top-10 cost table therefore sources
`/api/cost/users`, not the efficiency payload. Ranges over 31 days surface the
upstream 400 as a 502 and the UI falls back to the Spend Report CSV — the
documented >30-day reconciliation story.

## Consequences

- The user-reported inaccuracy is gone: per-user cost/model/token sections
  match the headline window exactly (verified live: $12,705 vs $12,702 over
  the same 7-day window; ~0.03 % refresh-timing skew).
- Recent-only ranges no longer 400/vanish.
- `/cost/efficiency` totals intentionally cover up to 3 fewer days than the
  headline — the Econ section's `active_range` caption states the joined
  period, and this gap is by design, not drift.
- Two window semantics coexist in `server/aws.js`; the route comments carry
  the rationale so the today−3 clamp is not "fixed" away again.
- Buffer-day figures are partial by upstream definition; `data_refreshed_at`
  is surfaced in the UI ("data as of …").
