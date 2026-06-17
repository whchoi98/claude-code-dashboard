# Economic Productivity Score v2 ("Value per Dollar") — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Scope:** Rewrite the per-user score in `server/aws.js` `GET /cost/efficiency` + honest reframing in `src/pages/Cost.tsx` + i18n. Interim v2 (no per-user cache term).

## Goal

Replace the current Economic Productivity score, which (verified in code) double-counts
commits/PRs/accepts across terms, carries a 20%-weighted `1/tokens_per_LOC` term that is
`0` for everyone on the live default path and directionally backwards, ignores the
newly-captured cowork/office/design surfaces, games on gross LOC, and uses zero-sum
`divide-by-max`/`divide-by-min` normalization. v2 puts each signal in exactly one term,
counts multi-surface output, uses robust normalization, and reframes the UI away from
ranking individuals on "productivity."

## Decisions (locked)

| Decision | Choice |
|---|---|
| Cache term | **Excluded (interim)** — per-user token/cache data unverified; add later as a separate increment. |
| Framing | **Keep per-user, reframe honestly** — relabel "Cost Efficiency", add "not a performance metric" note, tone down the #1-user emphasis. |
| Coefficients/anchor | Proposed defaults below, **tunable**. |

## Term vector (interim, weights sum to 1.0)

| Term | Weight | Definition | Normalization |
|---|---|---|---|
| `value_per_dollar` | 0.55 | `value_units / max(spend_usd, 0.5)` | winsorized (p5/p95) + cohort-**median** anchor |
| `acceptance_rate` | 0.25 | `accepted / (accepted + rejected)` | absolute `[0,1]` (null → 0) |
| `delivery_velocity` | 0.12 | `(commits + prs) / active_days` vs absolute ideal | absolute |
| `breadth` | 0.08 | distinct surfaces used / 5 | absolute |

**No double-counting** — each raw signal appears in exactly ONE term:
- LOC + surface output → `value_units` (the `value_per_dollar` numerator) only.
- `commits`/`prs` → `delivery_velocity` only (removed from the output/value numerator).
- `tool_accepted` → `acceptance_rate` only (removed from the value numerator).
- surfaces → `value_units` (magnitude) + `breadth` (count) — intentionally distinct signals (output volume vs adoption breadth); `breadth` is the only deliberate overlap, weighted 8%.

## `value_units` (multi-surface output)

```
code_VU   = max(0, loc_added - 0.5 * loc_removed)            // net LOC, churn-discounted (loc_removed now used)
office_VU = 2 * (excel + powerpoint + word + outlook).message_count       // summed across the 4 surfaces
cowork_VU = cowork.action_count + 3 * (cowork.file_edit_count ?? 0)       // file_edit_count is number|null
design_VU = 4 * design.distinct_projects_created_count + design.message_count
value_units = code_VU + office_VU + cowork_VU + design_VU
value_per_dollar = value_units / max(spend_usd, 0.5)        // $0.50 floor removes the zero-cost-penalty + div-by-zero
```

Cross-surface multipliers (2 / 1 / 3 / 4 / 1) are starting calibration constants, **tunable**;
they make non-code surfaces commensurable with a net line of code. They are documented in
code constants (not magic literals) so they can be adjusted without hunting through logic.

## Normalization (robust, mostly absolute)

Three of four terms are **absolute** (stable over time, not zero-sum):
- `acceptance_rate`: already `[0,1]`.
- `delivery_velocity`: `clamp(0, 1, ((commits + prs) / max(active_days,1)) / 2.0)` — `2.0` events/active-day = full marks (tunable absolute target). `active_days = 0` → 0.
- `breadth`: `used_surfaces / 5`, where a surface counts as used when its activity > 0. Surfaces = `code` (loc_added>0 ∨ commits>0 ∨ prs>0 ∨ accepted>0), `chat` (messages>0), `cowork` (cowork sessions ∨ actions > 0), `office` (any office sessions ∨ messages > 0), `design` (design sessions ∨ messages > 0).

Only `value_per_dollar` is cohort-relative, normalized robustly (replaces `divide-by-max`):
1. Compute each user's raw `value_per_dollar`.
2. Winsorize the cohort distribution at p5/p95 (clip outliers; degrades to ~min/max for tiny cohorts — harmless).
3. `median_vpd` = median of the winsorized values.
4. `term = median_vpd > 0 ? clamp(0, 1, 0.5 * winsorized_vpd / median_vpd) : 0`.

So a median user scores 0.5 on this term, 2× median scores 1.0 (capped), below median scales down. Median + winsorize make it outlier-immune (one whale no longer compresses everyone toward 0) and explainable ("you're at 1.7× the team median value/$").

```
economic_productivity_score = round(100 * (
  0.55 * value_per_dollar_term +
  0.25 * acceptance_term +
  0.12 * delivery_term +
  0.08 * breadth_term ))
```

## Architecture / components

- **`server/aws.js` aggregation loop** (currently ~1098-1119, reads only `claude_code_metrics`): add per-user accumulators for office (`office_metrics.{excel,powerpoint,word,outlook}.{message_count, distinct_session_count}`), cowork (`cowork_metrics.{action_count, file_edit_count, distinct_session_count}`), design (`design_metrics.{distinct_projects_created_count, message_count, distinct_session_count}`). No new API call — all fields ride on the existing `users/range` records.
- **Extract a pure, exported `scoreEconomicProductivity(joined, opts?)`** (module scope, like `analyticsReportsToCostResp`): input = the per-user `joined` objects (each carrying `spend_usd`, `loc_added`, `loc_removed`, `commits`, `prs`, `active_days`, `accepted`/`rejected` or `tool_acceptance_rate`, `messages`, and the new office/cowork/design aggregates); output = the same array with `value_units`, the four component terms (`value_per_dollar_term` etc. for UI/debug), and `economic_productivity_score`. The route replaces its inline scoring block (1198-1216) with a call to this function. Pure → unit-testable; constants (multipliers, ideal cadence, anchor factor) are parameters/defaults.
- **Response**: add `score_version: "2.0"`; keep the field name `economic_productivity_score` (avoid breaking the frontend binding); optionally expose the component terms + `value_units` per user for a future breakdown column (carried in the response; UI use optional).
- Cost denominator = the paginated per-user `s.spend` (correct for live ranges post-v1.1.1).

## Reframing (UI)

- Relabel the section "Economic Productivity" → "Cost Efficiency"; add a one-line note "신호용 비용 효율 지표 · 성과 평가 아님 / cost-efficiency signal, not a performance metric".
- Tone down any "#1 user" hero emphasis (keep the sortable table; soften the framing copy).
- Update the formula footnote in BOTH `src/lib/i18n.tsx` `econ.formula` (~:264) AND the hardcoded English literal in `Cost.tsx` (~:909-910) — the literal bypasses i18n (the repo's known JSX-prop trap); both must reflect the v2 formula + the disclaimer. Add/adjust i18n keys (en+ko) for the new label + disclaimer.

## Error handling / edge cases

- `spend_usd = 0` → `max(spend, 0.5)` floor → finite, no penalty (a high-output zero-cost user ranks well; winsorize p95 caps any extreme); no div-by-zero.
- `active_days = 0` → `delivery_term = 0`.
- `loc_removed > 2 * loc_added` → `code_VU` clamped to 0 (no negative).
- `median_vpd ≤ 0` (all users zero value) → `value_per_dollar_term = 0` for all (guarded).
- Empty cohort → `[]` (no crash).
- `cowork.file_edit_count` null → `?? 0`.

## Testing

Unit-test the extracted `scoreEconomicProductivity` in `tests/server/` (standalone `.mjs`, like the cost-reshape tests):
- **No double-counting**: increasing a user's `commits` changes `delivery_term` but leaves `value_per_dollar` unchanged; increasing `accepted` changes only `acceptance_term`.
- **Net-LOC churn**: a user with `loc_added=200, loc_removed=800` has `code_VU = max(0, 200-400) = 0`, not 200.
- **Multi-surface value**: a user with only cowork/office/design activity (no code) gets `value_units > 0` and a non-zero score (the surface-bias fix).
- **Winsorized median-anchor stability**: adding one extreme whale to the cohort barely moves a median user's `value_per_dollar_term` (contrast: `divide-by-max` would tank it). Median user ≈ 0.5 on the term.
- **Edge cases**: zero spend (floor), zero active_days, all-zero cohort (median guard), null cowork file-edit.
- `npx tsc --noEmit` (frontend i18n/label changes) + full suite green.

## Out of scope

`cache_efficiency` term (needs verified per-user token/cache data — separate increment); the CSV-path range-vs-spend mismatch (pre-existing); per-user score-breakdown UI columns (optional polish); the unrelated `UserProductivity.tsx` score (different feature).
