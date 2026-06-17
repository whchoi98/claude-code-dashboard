# Cost Efficiency Score — v3 — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Supersedes:** v2 (`ECON_V2_DEFAULTS` / `scoreEconomicProductivity`, shipped v1.2.0)
**Version target:** **v1.3.0**

## Problem with v2

v2 builds a single `value_units` numerator by summing incommensurable surfaces with
**arbitrary fixed multipliers**:

```
value_units = max(0, loc_added − 0.5·loc_removed)
            + 2·office_messages
            + (cowork_actions + 3·cowork_file_edits)
            + (4·design_projects_created + design_messages)
```

The user correctly rejected this: a line of code, a design project, and a cowork action
are **not the same unit**, so any fixed exchange rate between them (2×, 3×, 4×) is
fiction. A team that does more design work looks "more productive" only because design
projects were assigned a high multiplier — an artifact of the constant, not the work.

## Core idea (v3)

Stop converting surfaces into a shared currency. Instead, **rank each user within their
own surface's cohort** (code vs code, design vs design, …), producing a per-surface
score in `[0,1]` where the absolute unit is irrelevant — only standing among peers on
that surface matters. Then blend only the surfaces a user is **active** in
(coverage-aware), divide by their total dollars, and re-normalize.

The 4-term score structure is **unchanged** — only the **value** numerator is rebuilt:

```
score = 100 · ( 0.55·value  +  0.25·acceptance  +  0.12·delivery  +  0.08·breadth )
```

`acceptance`, `delivery`, `breadth` were each already single-signal and absolute (not
cohort-relative); they stay exactly as in v2. Only `value` changes.

## The value term — algorithm

A pure function over the joined per-user array. Five conceptual passes:

### Pass 1 — per-surface raw output

For each user, one representative output metric per surface (no multipliers):

| Surface | Raw output | Source field(s) |
|---|---|---|
| code | `max(0, loc_added − churnDiscount·loc_removed)` | `loc_added`, `loc_removed` |
| cowork | `cowork_actions` | `cowork_actions` |
| office | `office_messages` | `office_messages` |
| design | `design_messages` | `design_messages` |

`churnDiscount = 0.5` (carried from v2). One metric per surface keeps the within-surface
ranking interpretable; the choice is documented and swappable (e.g. design could later
use `design_projects_created`). A user is **active in a surface** iff that surface's raw
output `> 0`.

**Surface-count asymmetry (intentional, do NOT "fix"):** the value blend covers **4
output surfaces** (code / cowork / office / design). The breadth term counts **5**
surfaces — those four plus general **chat-messages** (`u.messages`). Chat-messages has no
distinct productive-output metric, so it contributes to *breadth* (you used another
surface) but not to *value* (no output to rank). This mirrors v2, where `u.messages` was
never part of `value_units` but was part of the breadth `surfaces` count.

### Pass 2 — normalize each surface within its own active cohort

For each surface independently, take the raw outputs of the users **active in that
surface**, and normalize via the same **winsorized median-anchor** v2 already uses for
`value_per_dollar`:

```
sorted   = active users' raw, ascending
lo, hi   = p5, p95   (round-index percentile — a no-op clip for N ≲ 19; the median
                       anchor carries small-cohort stability, exactly as documented in v2)
wins(x)  = clamp(x, lo, hi)
median   = median of winsorized active raws
surface_score = median > 0 ? clamp01(anchorFactor · wins(raw) / median) : 0
```

`anchorFactor = 0.5` ⇒ the **median active user on a surface scores 0.5** on that surface.
Each surface is normalized against its OWN cohort, so changing code output cannot move any
design score, and vice versa. Users not active in a surface get `surface_score = 0` for
that surface (reported for transparency; **excluded** from their blend below).

### Pass 3 — coverage-aware blend → productivity_index

```
active     = surfaces where raw > 0
productivity_index = active.length > 0
                   ? sum(surface_score over active) / active.length
                   : 0
```

Average over **only active surfaces** — a code-only developer's index is their code
surface_score, NOT that score averaged with three zeros. `productivity_index ∈ [0,1]`.

This is the key separation of concerns:
- **value** (this term) measures *quality per surface you actually use*.
- **breadth** (the 8% term, unchanged) measures *how many surfaces you use*.

Two users both sitting at the median of every surface they touch get the **same**
`productivity_index` (≈ 0.5) regardless of whether one uses 1 surface and the other uses
4 — they are differentiated by the breadth term, not by value.

### Pass 4 — efficiency = index ÷ total dollars

```
efficiency_raw = productivity_index / max(spend_usd, spendFloor)
```

`spendFloor = 0.5` (carried from v2). **Constraint:** per-surface cost attribution is NOT
available — `user_cost_report` returns only total per-user `net_spend` + a `by_model`
breakdown, never per-user-per-surface cost. So the denominator must be the user's **total**
dollars. This is the same constraint v2 lived under and is called out in CLAUDE.md / ADR-0003.

### Pass 5 — normalize efficiency within the cohort → value_term

Apply the winsorized median-anchor a second time, now across **all users'** `efficiency_raw`:

```
value_term = median(efficiency_raw) > 0
           ? clamp01(anchorFactor · wins(efficiency_raw) / median(efficiency_raw))
           : 0
```

Median user → 0.5; a lone whale barely moves it. `value_term ∈ [0,1]` feeds the 0.55 weight.

## Unchanged terms (carried verbatim from v2)

- **acceptance** = `tool_accepted / (tool_accepted + tool_rejected)`, else 0.
- **delivery** = `clamp01( ((commits + prs) / active_days) / deliveryIdeal )`, `deliveryIdeal = 2.0`; `active_days = 0` → 0.
- **breadth** = `active_surface_count / 5` where the 5 surfaces are code / chat-messages / cowork / office / design (existing v2 `surfaces` computation, unchanged).
- Final score clamped to `[0,100]` (guards partial `opts.weights` overrides).

## Defaults object

Replace `ECON_V2_DEFAULTS` with `ECON_V3_DEFAULTS`. The `surface` multiplier map is
**deleted** (that was the v2 artifact). Keep the function name `scoreEconomicProductivity`
(unit tests + the route import it).

```js
export const ECON_V3_DEFAULTS = {
  churnDiscount: 0.5,   // code_raw = loc_added − 0.5·loc_removed
  spendFloor:    0.5,   // $ denominator floor
  deliveryIdeal: 2.0,   // delivery = (commits+prs)/active_days / 2.0
  anchorFactor:  0.5,   // median anchor → 0.5 in BOTH normalization passes
  weights: { value: 0.55, acceptance: 0.25, delivery: 0.12, breadth: 0.08 },
}
```

`opts` merge keeps `weights` override; the now-removed `surface` override is dropped.

## Response shape changes (`server/aws.js`, `GET /cost/efficiency`)

**Per-user object** — drop v2's `value_units` + `value_per_dollar`; add v3 fields:

```js
{
  ...u,
  surface_scores: { code, cowork, office, design },  // each [0,1], 0 = inactive
  productivity_index,        // [0,1]
  efficiency_raw,            // productivity_index / max($, floor)  (pre-normalization, for transparency)
  score_components: { value, acceptance, delivery, breadth },   // unchanged keys
  economic_productivity_score,                                  // [0,100], unchanged key
}
```

**`totals`** — drop `value_units`; add `median_score` (the cohort median of
`economic_productivity_score`). `avg_cost_per_loc` / `avg_cost_per_commit` /
`spend_usd` / token totals stay.

**`score_version`** — `'2.0'` → `'3.0'`.

`source`, `period`, `user_count`, and the `users` array (still sorted by score desc) are
unchanged. The route already populates every per-surface input field (v2 Task 2), so the
join/aggregation code above the scorer call does **not** change — only the scorer call's
output handling and the `totals` reduce (median instead of summing `value_units`).

## Frontend changes (`src/pages/Cost.tsx` + `src/lib/i18n.tsx`)

Minimal — the per-user headline field (`economic_productivity_score`) is unchanged, so the
scatter, Top-10 bar, and full table keep working. Only the one KPI sourced from
`value_units` + the footnote move:

- `EfficiencyResp.totals`: `value_units?: number` → `median_score?: number`.
- `EfficiencyUser`: add optional `surface_scores`, `productivity_index`, `efficiency_raw` (render not required; typed for completeness).
- KPI #4 (`econ.kpi.total_output`, ~Cost.tsx:832): value `fmtCompact(data.totals.value_units ?? 0)` → `data.totals.median_score ?? '—'`.
- i18n relabel (en + ko):
  - `econ.kpi.total_output`: "Org Value Units" / "조직 Value Units" → **"Median Cost-Efficiency"** / **"중앙값 비용효율"**.
  - `econ.kpi.total_output.hint`: "net-LOC + multi-surface output" / "순-LOC + 멀티 surface 산출" → **"cohort median score"** / **"코호트 중앙값 점수"**.
  - `econ.formula`: rewrite to the v3 description (per-surface within-cohort normalization → coverage-aware blend ÷ total $ → re-normalized; acceptance 0.25 · delivery 0.12 · breadth 0.08).
  - `econ.subtitle`: adjust "Value produced per dollar…" wording to reflect the normalized-index-per-dollar method (minor copy edit, en + ko).

## Testing (`tests/server/test-econ-score.mjs` — rewrite for v3)

The v2 assertions reference `value_units` / `value_per_dollar` (removed), so the file is
rewritten. v3 assertions:

1. **Coverage-aware (not penalized for absent surfaces):** a user active only in code has `productivity_index === surface_scores.code` (not divided by 4).
2. **Per-surface normalization independence:** in a cohort, changing one user's `loc_added` changes code `surface_scores` but leaves every user's `design` `surface_scores` byte-identical.
3. **Coverage ≠ value:** a 1-surface median user and a 4-surface all-median user get equal `productivity_index`; they differ only in `score_components.breadth`.
4. **Efficiency uses total $:** at equal `productivity_index`, higher `spend_usd` ⇒ lower `efficiency_raw` ⇒ `value` term not higher.
5. **Median stability:** adding a whale (huge code output) barely moves a median user's `score_components.value` (< 0.1 drift).
6. **Zero-activity user:** no activity on any surface ⇒ `productivity_index === 0` and `score_components.value === 0`, score finite.
7. **$ floor:** `spend_usd = 0` ⇒ finite `efficiency_raw > 0` (0.5 floor).
8. **Unchanged terms:** more `tool_accepted` raises only `acceptance`; more `commits` raises only `delivery`; an extra active surface raises only `breadth` — none of these change `surface_scores`/`productivity_index`.
9. **Edge:** empty cohort → `[]`; `null` per-surface fields handled via the `num(x) → 0` guard.

Frontend: `npx tsc --noEmit` + `npx vite build` (no frontend harness, per repo convention).
Full suite (`bash tests/run-all.sh`) green.

## Versioning note

The PAUSED group-visibility Foundation spec (`2026-06-17-group-visibility-foundation-design.md`)
also pencils in **v1.3.0**. v3 ships first and **takes v1.3.0**; when the group Foundation
resumes it becomes **v1.4.0** (update that spec's version line at resume time).

## Out of scope

- Per-surface cost attribution (API does not expose it; denominator stays total $).
- Changing the acceptance / delivery / breadth terms or their weights.
- New surface output metrics beyond the one-per-surface chosen here (swappable later).
- Any change to the `/cost/efficiency` join, the collector, or Glue schemas.
