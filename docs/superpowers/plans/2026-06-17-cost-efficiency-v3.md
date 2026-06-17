# Cost Efficiency Score v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v2 economic-productivity value numerator (arbitrary cross-surface multipliers) with v3 per-surface within-cohort normalization → coverage-aware blend → ÷ total $ → re-normalize, keeping the 4-term score structure and shipping it as v1.3.0.

**Architecture:** A pure function `scoreEconomicProductivity(joined, opts)` in `server/aws.js` does all scoring math; the `/cost/efficiency` route only joins data and reduces totals. v3 rewrites the `value` term inside that pure function and its unit tests, then relabels one KPI + the formula footnote on the Cost page. No collector, Glue, route-join, or schema changes — every per-surface input field is already populated.

**Tech Stack:** Node 20 ESM (`server/aws.js`), standalone `.mjs` unit tests (`node`, run via `bash tests/run-all.sh`), React 18 + TS 5 strict (`src/pages/Cost.tsx`, `src/lib/i18n.tsx`), Vite build verification.

---

## Spec

Approved design: `docs/superpowers/specs/2026-06-17-cost-efficiency-v3-design.md`. Read it once before starting — this plan implements it verbatim.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/aws.js` | `ECON_V*_DEFAULTS` + `scoreEconomicProductivity` (pure scorer); `/cost/efficiency` route response | Task 1 (scorer), Task 2 (route response) |
| `tests/server/test-econ-score.mjs` | Unit tests for the scorer | Task 1 (full rewrite) |
| `src/pages/Cost.tsx` | Cost page UI — `EfficiencyResp`/`EfficiencyUser` types, KPI #4 | Task 3 |
| `src/lib/i18n.tsx` | en/ko strings — `econ.kpi.total_output*`, `econ.formula`, `econ.subtitle` | Task 3 |
| `package.json` | App version (rendered in the sidebar badge) | Task 4 |
| `CHANGELOG.md` | Release notes (bundled into the Changelog page) | Task 4 |

---

## Task 1: v3 pure scorer + rewritten unit tests

This is TDD: rewrite the test file to assert v3 behavior (it will fail against the v2 scorer because v2 emits `value_units`/`value_per_dollar`, not `surface_scores`/`productivity_index`), then rewrite the scorer to pass.

**Files:**
- Modify: `server/aws.js:260-330` (replace `ECON_V2_DEFAULTS` + `scoreEconomicProductivity`)
- Test: `tests/server/test-econ-score.mjs` (full rewrite)

- [ ] **Step 1: Rewrite the test file with v3 assertions**

Replace the entire contents of `tests/server/test-econ-score.mjs` with:

```js
// Standalone ESM test for scoreEconomicProductivity (server/aws.js) — v3.
// node tests/server/test-econ-score.mjs — exit 0 on success, 1 on failure.
import { scoreEconomicProductivity } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Minimal per-user record the scorer consumes (the route supplies these fields).
const U = (o = {}) => ({
  email: 'a@x.com', spend_usd: 10, loc_added: 0, loc_removed: 0, commits: 0, prs: 0,
  active_days: 1, tool_accepted: 0, tool_rejected: 0, messages: 0,
  office_messages: 0, office_sessions: 0, cowork_actions: 0, cowork_file_edits: 0,
  cowork_sessions: 0, design_projects_created: 0, design_messages: 0, design_sessions: 0, ...o,
})
const byEmail = (arr) => Object.fromEntries(arr.map((u) => [u.email, u]))

// A) Coverage-aware blend: a code-only user's index IS their code surface_score (not /4).
;(() => {
  const r = byEmail(scoreEconomicProductivity([U({ email: 'c', loc_added: 100 })]))
  ok('code-only: productivity_index equals code surface_score (coverage-aware, not /4)',
     r.c.productivity_index === r.c.surface_scores.code && r.c.productivity_index > 0)
  ok('code-only: inactive surfaces score 0',
     r.c.surface_scores.design === 0 && r.c.surface_scores.office === 0 && r.c.surface_scores.cowork === 0)
})()

// B) Per-surface normalization is independent: changing code output cannot move design scores.
;(() => {
  const mk = (codeLoc) => [
    U({ email: 'u1', loc_added: codeLoc, design_messages: 10 }),
    U({ email: 'u2', loc_added: 200,     design_messages: 10 }),
  ]
  const lo = byEmail(scoreEconomicProductivity(mk(100)))
  const hi = byEmail(scoreEconomicProductivity(mk(1000)))
  ok('changing code output leaves design surface_scores unchanged (independent cohorts)',
     lo.u1.surface_scores.design === hi.u1.surface_scores.design &&
     lo.u2.surface_scores.design === hi.u2.surface_scores.design)
  ok('changing code output DOES change code surface_scores',
     lo.u1.surface_scores.code !== hi.u1.surface_scores.code)
})()

// C) Coverage ≠ value: a 1-surface and a 4-surface all-median user get equal index, differ only in breadth.
;(() => {
  const userA = U({ email: 'A', loc_added: 100 })  // code only
  const userB = U({ email: 'B', loc_added: 100, cowork_actions: 50, cowork_sessions: 2,
                    office_messages: 50, office_sessions: 2, design_messages: 50, design_sessions: 2 })
  const r = byEmail(scoreEconomicProductivity([userA, userB]))
  ok('1-surface vs 4-surface median users get equal productivity_index (coverage-aware)',
     r.A.productivity_index === r.B.productivity_index)
  ok('they differ only by breadth term',
     r.B.score_components.breadth > r.A.score_components.breadth)
})()

// D) Efficiency uses TOTAL $: equal output but higher spend → lower value term.
;(() => {
  const r = byEmail(scoreEconomicProductivity([
    U({ email: 'cheap',  loc_added: 100, spend_usd: 10 }),
    U({ email: 'pricey', loc_added: 100, spend_usd: 100 }),
  ]))
  ok('equal output → equal productivity_index', r.cheap.productivity_index === r.pricey.productivity_index)
  ok('higher total $ at equal index → lower value term',
     r.pricey.score_components.value < r.cheap.score_components.value)
})()

// E) Median anchor is position-based: a whale's MAGNITUDE doesn't move a median user (vs divide-by-max).
;(() => {
  const cohort = [100, 200, 300, 400, 500].map((v, i) => U({ email: `u${i}`, loc_added: v, spend_usd: 10 }))
  const w6  = byEmail(scoreEconomicProductivity([...cohort, U({ email: 'whale', loc_added: 1e6,  spend_usd: 10 })]))
  const w12 = byEmail(scoreEconomicProductivity([...cohort, U({ email: 'whale', loc_added: 1e12, spend_usd: 10 })]))
  ok('whale magnitude does not change a median user value term (median-anchored, not divide-by-max)',
     w6.u2.score_components.value === w12.u2.score_components.value)
  ok('median user not crushed toward 0 by the whale', w6.u2.score_components.value > 0.35)
})()

// F) Zero-activity user → index 0, value 0, finite score.
;(() => {
  const r = byEmail(scoreEconomicProductivity([
    U({ email: 'act', loc_added: 100 }),
    U({ email: 'idle' }),
  ]))
  ok('zero-activity user: productivity_index 0', r.idle.productivity_index === 0)
  ok('zero-activity user: value term 0', r.idle.score_components.value === 0)
  ok('zero-activity user: finite score', Number.isFinite(r.idle.economic_productivity_score))
})()

// G) $ floor: zero spend uses the 0.5 floor (finite efficiency, not Infinity).
;(() => {
  const r = byEmail(scoreEconomicProductivity([U({ email: 'z', loc_added: 50, spend_usd: 0 })]))
  ok('zero spend uses $0.5 floor (finite efficiency_raw > 0)',
     Number.isFinite(r.z.efficiency_raw) && r.z.efficiency_raw > 0)
})()

// H) Unchanged terms: accepts touch only acceptance; commits touch only delivery.
;(() => {
  const base    = U({ email: 'base', loc_added: 100, spend_usd: 10, commits: 1, active_days: 2, tool_accepted: 8,  tool_rejected: 2 })
  const moreAcc = U({ email: 'acc',  loc_added: 100, spend_usd: 10, commits: 1, active_days: 2, tool_accepted: 80, tool_rejected: 2 })
  const r = byEmail(scoreEconomicProductivity([base, moreAcc]))
  ok('more accepts changes only acceptance (value + index unchanged)',
     r.acc.score_components.acceptance > r.base.score_components.acceptance &&
     r.acc.score_components.value === r.base.score_components.value &&
     r.acc.productivity_index === r.base.productivity_index)

  const b2 = U({ email: 'b2', loc_added: 100, spend_usd: 10, commits: 1, active_days: 2 })
  const cm = U({ email: 'cm', loc_added: 100, spend_usd: 10, commits: 9, active_days: 2 })
  const r2 = byEmail(scoreEconomicProductivity([b2, cm]))
  ok('more commits changes only delivery (value + acceptance + surface_scores unchanged)',
     r2.cm.score_components.delivery > r2.b2.score_components.delivery &&
     r2.cm.score_components.value === r2.b2.score_components.value &&
     r2.cm.surface_scores.code === r2.b2.surface_scores.code)
})()

// I) Edge cases.
;(() => {
  ok('empty cohort → []', scoreEconomicProductivity([]).length === 0)
  const rNull = byEmail(scoreEconomicProductivity([U({ email: 'nu', cowork_actions: null, design_messages: null, loc_added: null })]))
  ok('null per-surface fields handled (num→0)',
     Number.isFinite(rNull.nu.productivity_index) && Number.isFinite(rNull.nu.economic_productivity_score))
})()

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run the test to verify it FAILS against the v2 scorer**

Run: `node tests/server/test-econ-score.mjs`
Expected: FAIL — the v2 scorer returns `value_units`/`value_per_dollar` and no `surface_scores`/`productivity_index`/`efficiency_raw`, so assertion A (`r.c.surface_scores.code`) throws a TypeError or reports `not ok`. Exit code 1.

- [ ] **Step 3: Replace the scorer with the v3 implementation**

In `server/aws.js`, replace the entire block from the v2 comment above `export const ECON_V2_DEFAULTS` through the closing `}` of `scoreEconomicProductivity` (currently lines 260-330) with:

```js
// v3 cost-efficiency scorer. Pure + exported for unit tests. Replaces v2's
// arbitrary cross-surface multipliers with per-surface within-cohort normalization.
// The value term is built in 5 passes:
//   1. per-surface raw output (one metric/surface, no multipliers)
//   2. normalize each surface within its OWN active cohort (winsorized
//      median-anchor) → surface_scores ∈ [0,1]
//   3. coverage-aware blend over ACTIVE surfaces → productivity_index ∈ [0,1]
//   4. efficiency_raw = index / max(total$, floor)  (per-surface $ unavailable)
//   5. normalize efficiency_raw across the cohort (median-anchor) → value_term
// acceptance / delivery / breadth are unchanged from v2 (single-signal, absolute).
export const ECON_V3_DEFAULTS = {
  churnDiscount: 0.5,   // code_raw = loc_added − 0.5·loc_removed
  spendFloor:    0.5,   // $ denominator floor
  deliveryIdeal: 2.0,   // delivery = (commits+prs)/active_days / 2.0
  anchorFactor:  0.5,   // median anchor → 0.5 in BOTH normalization passes
  weights: { value: 0.55, acceptance: 0.25, delivery: 0.12, breadth: 0.08 },
}
export function scoreEconomicProductivity(joined, opts = {}) {
  const C = {
    ...ECON_V3_DEFAULTS, ...opts,
    weights: { ...ECON_V3_DEFAULTS.weights, ...(opts.weights || {}) },
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

  // Winsorized median-anchor normalizer over a set of raw values. Returns a
  // function raw → [0,1] mapping the cohort median to anchorFactor (0.5).
  // Round-index percentiles make winsorize a no-op for N ≲ 19 (p5→idx0,
  // p95→idx(n-1)); the median anchor carries small-cohort stability. A
  // nonpositive median (e.g. all-zero cohort) yields a constant-0 normalizer.
  const makeNormalizer = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return () => 0
    const pctl = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
    const lo = pctl(5), hi = pctl(95)
    const wins = (x) => Math.max(lo, Math.min(hi, x))
    const w = sorted.map(wins).sort((a, b) => a - b)
    const median = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2
    return (x) => (median > 0 ? clamp01(C.anchorFactor * wins(x) / median) : 0)
  }

  // Pass 1: one raw output metric per surface for every user (no multipliers).
  const SURFACES = ['code', 'cowork', 'office', 'design']
  const rawOf = (u) => ({
    code:   Math.max(0, num(u.loc_added) - C.churnDiscount * num(u.loc_removed)),
    cowork: num(u.cowork_actions),
    office: num(u.office_messages),
    design: num(u.design_messages),
  })
  const raws = joined.map(rawOf)

  // Pass 2: one normalizer per surface, built from users ACTIVE in it (raw > 0).
  const normBySurface = {}
  for (const s of SURFACES) {
    normBySurface[s] = makeNormalizer(raws.filter((r) => r[s] > 0).map((r) => r[s]))
  }

  // Passes 3-4: surface_scores, coverage-aware blend, efficiency_raw.
  const withEff = joined.map((u, i) => {
    const raw = raws[i]
    const surface_scores = {}
    let sum = 0, active = 0
    for (const s of SURFACES) {
      const score = raw[s] > 0 ? normBySurface[s](raw[s]) : 0
      surface_scores[s] = score
      if (raw[s] > 0) { sum += score; active += 1 }
    }
    const productivity_index = active > 0 ? sum / active : 0
    const efficiency_raw = productivity_index / Math.max(num(u.spend_usd), C.spendFloor)
    return { u, surface_scores, productivity_index, efficiency_raw }
  })

  // Pass 5: normalize efficiency_raw across the whole cohort → value_term.
  const valueNorm = makeNormalizer(withEff.map((x) => x.efficiency_raw))

  return withEff.map(({ u, surface_scores, productivity_index, efficiency_raw }) => {
    const valueTerm = valueNorm(efficiency_raw)
    const accTotal = num(u.tool_accepted) + num(u.tool_rejected)
    const acceptanceTerm = accTotal > 0 ? clamp01(num(u.tool_accepted) / accTotal) : 0
    const events = num(u.commits) + num(u.prs)
    const deliveryTerm = num(u.active_days) > 0 ? clamp01((events / num(u.active_days)) / C.deliveryIdeal) : 0
    const surfaces =
      (num(u.loc_added) > 0 || num(u.commits) > 0 || num(u.prs) > 0 || num(u.tool_accepted) > 0 ? 1 : 0) +
      (num(u.messages) > 0 ? 1 : 0) +
      (num(u.cowork_sessions) > 0 || num(u.cowork_actions) > 0 ? 1 : 0) +
      (num(u.office_sessions) > 0 || num(u.office_messages) > 0 ? 1 : 0) +
      (num(u.design_sessions) > 0 || num(u.design_messages) > 0 ? 1 : 0)
    const breadthTerm = surfaces / 5
    // clamp to [0,100] so a partial opts.weights override (sum ≠ 1) can never
    // emit an out-of-range score; under default weights (sum 1.0) this is a no-op.
    const economic_productivity_score = Math.max(0, Math.min(100, Math.round(100 * (
      C.weights.value * valueTerm + C.weights.acceptance * acceptanceTerm +
      C.weights.delivery * deliveryTerm + C.weights.breadth * breadthTerm))))
    return {
      ...u,
      surface_scores: {
        code:   Number(surface_scores.code.toFixed(4)),
        cowork: Number(surface_scores.cowork.toFixed(4)),
        office: Number(surface_scores.office.toFixed(4)),
        design: Number(surface_scores.design.toFixed(4)),
      },
      productivity_index: Number(productivity_index.toFixed(4)),
      efficiency_raw: Number(efficiency_raw.toFixed(6)),
      score_components: {
        value: Number(valueTerm.toFixed(4)), acceptance: Number(acceptanceTerm.toFixed(4)),
        delivery: Number(deliveryTerm.toFixed(4)), breadth: Number(breadthTerm.toFixed(4)),
      },
      economic_productivity_score,
    }
  })
}
```

- [ ] **Step 4: Validate ESM syntax**

Run: `node --check server/aws.js`
Expected: no output, exit 0.

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `node tests/server/test-econ-score.mjs`
Expected: all `ok` lines, final `1..18`, exit 0.

- [ ] **Step 6: Run the full server test suite (no regressions)**

Run: `bash tests/run-all.sh`
Expected: every `.mjs` under `tests/server/` passes. (The route still returns `economic_productivity_score`, so the cost-reshape tests are unaffected.)

- [ ] **Step 7: Commit**

```bash
git add server/aws.js tests/server/test-econ-score.mjs
git commit -m "feat(econ): v3 cost-efficiency scorer — surface별 코호트 정규화 + coverage-aware 블렌드"
```

---

## Task 2: `/cost/efficiency` route response (score_version 3.0, totals.median_score)

The pure scorer now emits v3 fields. The route must stop summing the removed `value_units`, compute the cohort `median_score`, and bump `score_version`. There is no route-level test harness (the route needs the live Analytics API), so verification is `node --check` plus re-running the scorer unit tests — consistent with repo convention (only pure helpers are unit-tested).

**Files:**
- Modify: `server/aws.js` — the `/cost/efficiency` response block (currently lines 1293-1323, immediately after the `joined` array is built)

- [ ] **Step 1: Replace the scoring + totals + response block**

Find this block (the `value_units` references pinpoint it):

```js
    // v2 "Value per Dollar" scoring — pure, unit-tested. See scoreEconomicProductivity.
    const scored = scoreEconomicProductivity(joined)

    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
      value_units:       t.value_units + (u.value_units ?? 0),
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0, value_units: 0 })

    res.json({
      score_version: '2.0',
      source,
      period: csvPeriod,
      user_count: scored.length,
      totals: {
        spend_usd: Number(totals.spend_usd.toFixed(2)),
        loc_added: totals.loc_added,
        commits:   totals.commits,
        prs:       totals.prs,
        prompt_tokens:     totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        value_units: Number(totals.value_units.toFixed(2)),
        avg_cost_per_loc:    totals.loc_added > 0 ? Number((totals.spend_usd / totals.loc_added).toFixed(4)) : null,
        avg_cost_per_commit: totals.commits   > 0 ? Number((totals.spend_usd / totals.commits).toFixed(2))   : null,
      },
      users: scored.sort((a, b) => b.economic_productivity_score - a.economic_productivity_score),
    })
```

Replace it with:

```js
    // v3 cost-efficiency scoring — pure, unit-tested. See scoreEconomicProductivity.
    const scored = scoreEconomicProductivity(joined)

    // Cohort median of the final score — the org-level headline KPI for v3.
    const scoreVals = scored.map((u) => u.economic_productivity_score).sort((a, b) => a - b)
    const median_score = scoreVals.length
      ? (scoreVals.length % 2
          ? scoreVals[(scoreVals.length - 1) / 2]
          : Math.round((scoreVals[scoreVals.length / 2 - 1] + scoreVals[scoreVals.length / 2]) / 2))
      : 0

    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0 })

    res.json({
      score_version: '3.0',
      source,
      period: csvPeriod,
      user_count: scored.length,
      totals: {
        spend_usd: Number(totals.spend_usd.toFixed(2)),
        loc_added: totals.loc_added,
        commits:   totals.commits,
        prs:       totals.prs,
        prompt_tokens:     totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        median_score,
        avg_cost_per_loc:    totals.loc_added > 0 ? Number((totals.spend_usd / totals.loc_added).toFixed(4)) : null,
        avg_cost_per_commit: totals.commits   > 0 ? Number((totals.spend_usd / totals.commits).toFixed(2))   : null,
      },
      users: scored.sort((a, b) => b.economic_productivity_score - a.economic_productivity_score),
    })
```

- [ ] **Step 2: Validate ESM syntax**

Run: `node --check server/aws.js`
Expected: no output, exit 0.

- [ ] **Step 3: Confirm no stale `value_units` references remain in the route**

Run: `grep -n "value_units" server/aws.js`
Expected: no matches (the scorer no longer emits it and the route no longer sums it). If any match remains, it is a leftover — remove it.

- [ ] **Step 4: Re-run the scorer unit tests (route uses the same pure function)**

Run: `node tests/server/test-econ-score.mjs`
Expected: `1..18`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/aws.js
git commit -m "feat(cost): /cost/efficiency emits score_version 3.0 + totals.median_score"
```

---

## Task 3: Cost page UI — types, KPI, i18n relabel

The per-user headline field (`economic_productivity_score`) is unchanged, so the scatter, Top-10 bar, and full table keep working untouched. Only the one KPI sourced from `value_units` and the descriptive strings change.

**Files:**
- Modify: `src/pages/Cost.tsx` — `EfficiencyUser` type (~line 153), `EfficiencyResp.totals` type (~line 165), KPI #4 (~line 832)
- Modify: `src/lib/i18n.tsx` — `econ.kpi.total_output`, `econ.kpi.total_output.hint`, `econ.formula`, `econ.subtitle` (en ~250-265, ko ~764-779)

- [ ] **Step 1: Update the `EfficiencyUser` type to carry the v3 per-user fields**

In `src/pages/Cost.tsx`, find:

```ts
  economic_productivity_score: number
}
```

Replace with:

```ts
  economic_productivity_score: number
  surface_scores?: { code: number; cowork: number; office: number; design: number }
  productivity_index?: number
  efficiency_raw?: number
}
```

- [ ] **Step 2: Update `EfficiencyResp.totals` — `value_units` → `median_score`**

In `src/pages/Cost.tsx`, find (inside `type EfficiencyResp`):

```ts
    avg_cost_per_loc: number | null
    avg_cost_per_commit: number | null
    value_units?: number
  }
```

Replace with:

```ts
    avg_cost_per_loc: number | null
    avg_cost_per_commit: number | null
    median_score?: number
  }
```

- [ ] **Step 3: Point KPI #4 at `median_score`**

In `src/pages/Cost.tsx`, find:

```tsx
          <KpiCard       label={t('econ.kpi.total_output')} value={fmtCompact(data.totals.value_units ?? 0)} hint={t('econ.kpi.total_output.hint')} />
```

Replace with:

```tsx
          <KpiCard       label={t('econ.kpi.total_output')} value={data.totals.median_score ?? '—'} hint={t('econ.kpi.total_output.hint')} />
```

(`KpiCard.value` is `React.ReactNode`, so a number or the `'—'` string both render. `fmtCompact` stays imported — it is used in ~12 other places in this file.)

- [ ] **Step 4: Relabel the English `econ.*` strings**

In `src/lib/i18n.tsx`, in the `en` dict, replace these four lines:

```ts
    'econ.subtitle': 'Value produced per dollar across all Claude surfaces (code · cowork · Office · design). A cost-efficiency signal — NOT a performance evaluation.',
```
```ts
    'econ.kpi.total_output':'Org Value Units',
    'econ.kpi.total_output.hint': 'net-LOC + multi-surface output',
```
```ts
    'econ.formula':          'Cost Efficiency (v2) — value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08; value_units = net-LOC + Office/cowork/design output (each signal counted once).',
```

with:

```ts
    'econ.subtitle': 'Per-surface productivity (each normalized within its own cohort), blended over the surfaces a user is active in, divided by total spend — across all Claude surfaces (code · cowork · Office · design). A cost-efficiency signal — NOT a performance evaluation.',
```
```ts
    'econ.kpi.total_output':'Median Cost-Efficiency',
    'econ.kpi.total_output.hint': 'cohort median score',
```
```ts
    'econ.formula':          'Cost Efficiency (v3) — value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08; value = each surface’s output normalized within its own cohort, blended over active surfaces (coverage-aware), divided by total $, then re-normalized (median-anchored).',
```

- [ ] **Step 5: Relabel the Korean `econ.*` strings**

In `src/lib/i18n.tsx`, in the `ko` dict, replace these four lines:

```ts
    'econ.subtitle': '모든 Claude surface(코드·cowork·Office·design)에서 $ 한 단위당 산출 가치. 비용 효율 신호이며 성과 평가가 아닙니다.',
```
```ts
    'econ.kpi.total_output':'조직 Value Units',
    'econ.kpi.total_output.hint': '순-LOC + 멀티 surface 산출',
```
```ts
    'econ.formula':          '비용 효율 (v2) — value/$ 0.55 · 수락률 0.25 · delivery 0.12 · breadth 0.08; value_units = 순-LOC + Office/cowork/design 산출 (각 신호 1회만 계산).',
```

with:

```ts
    'econ.subtitle': 'surface별 생산성(각 surface 코호트 내에서 정규화)을 사용자가 활성인 surface만 블렌드하고 총 지출로 나눈 값 — 모든 Claude surface(코드·cowork·Office·design). 비용 효율 신호이며 성과 평가가 아닙니다.',
```
```ts
    'econ.kpi.total_output':'중앙값 비용효율',
    'econ.kpi.total_output.hint': '코호트 중앙값 점수',
```
```ts
    'econ.formula':          '비용 효율 (v3) — value/$ 0.55 · 수락률 0.25 · delivery 0.12 · breadth 0.08; value = 각 surface 산출을 자기 코호트 내에서 정규화 → 활성 surface만 블렌드(coverage-aware) → 총 $로 나눔 → 재정규화(중앙값 기준).',
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms `value_units` is gone from the type and `median_score` renders fine.)

- [ ] **Step 7: Production build**

Run: `npx vite build`
Expected: build succeeds, `dist/` written.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Cost.tsx src/lib/i18n.tsx
git commit -m "feat(cost): v3 UI — Median Cost-Efficiency KPI + v3 formula/subtitle (en+ko)"
```

---

## Task 4: Version bump to v1.3.0 + CHANGELOG

**Files:**
- Modify: `package.json:4` (version)
- Modify: `CHANGELOG.md` (new top entry under `## [Unreleased]`)

- [ ] **Step 1: Bump the version**

In `package.json`, change:

```json
  "version": "1.2.0",
```

to:

```json
  "version": "1.3.0",
```

- [ ] **Step 2: Add the CHANGELOG entry (English section)**

In `CHANGELOG.md`, the `## [Unreleased]` block currently reads:

```markdown
## [Unreleased]

_No changes yet — next entries land here._
```

Replace that block with:

```markdown
## [Unreleased]

_No changes yet — next entries land here._

## [1.3.0] - 2026-06-17

Cost Efficiency score v3 — per-surface within-cohort normalization.

### Changed

- **Rebuilt the cost-efficiency value term (v3).** v2 summed surfaces with arbitrary multipliers (a design project ≡ 4 LOC), which is fiction — a LOC, a design project, and a cowork action aren't the same unit. v3 instead normalizes each surface's per-user output **within that surface's own cohort** (code vs code, design vs design, …) to `[0,1]` via the winsorized median-anchor, blends only the surfaces a user is **active** in (coverage-aware, so a code-only dev isn't penalized for design = 0), divides by total spend (per-surface cost attribution is unavailable), then re-normalizes. The 4-term structure is unchanged (value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08); only the value numerator changed. `value` now measures quality-per-surface-used while `breadth` measures how-many-surfaces — separated concerns. Response carries `score_version:"3.0"`, per-user `surface_scores`/`productivity_index`/`efficiency_raw`, and `totals.median_score` (replacing `totals.value_units`); the headline KPI is now the cohort median score.
```

- [ ] **Step 3: Add the CHANGELOG entry (Korean section)**

In `CHANGELOG.md`, find the Korean `## [Unreleased]` block (under the `# 한국어` heading) — it reads the same `_No changes yet_` placeholder in Korean or English. Insert immediately below it a matching Korean entry:

```markdown
## [1.3.0] - 2026-06-17

비용 효율 점수 v3 — surface별 코호트 내 정규화.

### 변경

- **비용 효율 value 항을 v3로 재작성.** v2는 surface들을 임의 배율(디자인 프로젝트 ≡ 4 LOC)로 합쳤는데, LOC·디자인 프로젝트·cowork 액션은 같은 단위가 아니므로 허구입니다. v3는 각 surface의 사용자별 산출을 **해당 surface 자기 코호트 내에서**(코드는 코드끼리, 디자인은 디자인끼리) winsorized 중앙값 앵커로 `[0,1]` 정규화하고, 사용자가 **활성**인 surface만 블렌드(coverage-aware — 코드만 쓰는 개발자가 design = 0 으로 손해 보지 않음)하며, 총 지출로 나눈 뒤(surface별 비용 귀속 불가) 재정규화합니다. 4항 구조는 유지(value/$ 0.55 · 수락 0.25 · delivery 0.12 · breadth 0.08), value 분자만 교체. 이제 `value`는 "쓰는 surface별 품질", `breadth`는 "쓰는 surface 개수"로 관심사를 분리합니다. 응답에 `score_version:"3.0"`, per-user `surface_scores`/`productivity_index`/`efficiency_raw`, `totals.median_score`(기존 `totals.value_units` 대체). 헤드라인 KPI는 코호트 중앙값 점수.
```

(If the Korean `[Unreleased]` placeholder text differs, keep that placeholder intact and insert the `## [1.3.0]` block directly beneath it, matching the existing `## [1.2.0]` Korean entry's position.)

- [ ] **Step 4: Verify the version badge build picks up 1.3.0**

Run: `npx vite build`
Expected: build succeeds. (`Layout.tsx` imports `package.json` for the badge; `Changelog.tsx` imports `CHANGELOG.md` via `?raw`, so the build also validates the Markdown resolves.)

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v1.3.0 — 비용 효율 점수 v3"
```

---

## After all tasks

Per `subagent-driven-development`, dispatch a final holistic code review across the whole branch, then use `superpowers:finishing-a-development-branch` to present merge/deploy options. Note: deploy is the `/deploy` fast-path (`ccd-compute`) **plus a CloudFront invalidation of `/*`** (CloudFront dist `EAKHVAM1T8MX8`) — the frontend strings + KPI changed, and `/deploy` does not invalidate the CDN on its own.

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- v3 value algorithm (Passes 1-5), `ECON_V3_DEFAULTS`, deleted surface multipliers → Task 1, Step 3.
- Surface-count asymmetry (value 4 / breadth 5, chat-messages breadth-only) → preserved verbatim in the unchanged `surfaces` computation (Task 1, Step 3) — chat-messages (`u.messages`) is not in `rawOf`/`SURFACES` but is in the breadth count.
- acceptance/delivery/breadth unchanged → carried verbatim in Task 1, Step 3.
- Per-user response (`surface_scores`/`productivity_index`/`efficiency_raw`, drop `value_units`/`value_per_dollar`) → Task 1, Step 3 return object; types in Task 3, Step 1.
- `totals.median_score` (drop `value_units`), `score_version '3.0'` → Task 2.
- Frontend KPI relabel + `econ.formula`/`econ.subtitle` (en+ko) → Task 3.
- v1.3.0 + CHANGELOG → Task 4.
- Tests (9 spec cases) → Task 1, Step 1 (assertions A-I cover all; the spec's "extra surface raises only breadth" wording is intentionally narrowed — adding an active surface DOES change `productivity_index` by design, so coverage-vs-value is asserted via case C instead; the single-signal invariants that genuinely hold (accepts→acceptance, commits→delivery) are case H).

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code; every command shows expected output. The Task 4 Step 3 parenthetical about the Korean placeholder is a conditional instruction with a concrete fallback, not a placeholder.

**3. Type/name consistency** — `surface_scores` keys `{code,cowork,office,design}` identical in scorer return (Task 1), TS type (Task 3 Step 1), and tests (Task 1 Step 1). `median_score` identical in route (Task 2), TS type (Task 3 Step 2), KPI (Task 3 Step 3). `efficiency_raw`/`productivity_index` consistent across scorer, type, and tests. Function name `scoreEconomicProductivity` and constant `ECON_V3_DEFAULTS` consistent. `score_version '3.0'` (string) matches the `'2.0'` precedent.
