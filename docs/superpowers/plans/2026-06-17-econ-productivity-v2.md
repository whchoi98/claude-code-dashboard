# Economic Productivity v2 ("Value per Dollar") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-user Economic Productivity score with v2 "Value per Dollar": no double-counting, multi-surface output, net-LOC, robust (winsorized median-anchored) normalization, plus honest reframing.

**Architecture:** Extract a pure, exported `scoreEconomicProductivity(joined, opts?)` in `server/aws.js` (unit-tested), wire `GET /cost/efficiency` to populate office/cowork/design aggregates + call it, then reframe `Cost.tsx`/i18n. No new API calls (all metrics ride on `users/range`); cost denominator is the paginated per-user spend (correct post-v1.1.1).

**Tech Stack:** Node ESM server + React/TS frontend. Verify with `node tests/...` + `bash tests/run-all.sh` + `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-17-econ-productivity-v2-design.md`

---

## File structure

| File | Change | Task |
|---|---|---|
| `server/aws.js` | add exported pure `scoreEconomicProductivity` | 1 |
| `tests/server/test-econ-score.mjs` | **create** — unit tests | 1 |
| `server/aws.js` | `/cost/efficiency`: office/cowork/design accumulators + call scorer + `score_version` + `totals.value_units` | 2 |
| `src/pages/Cost.tsx` | relabel + disclaimer + footnote + fix the hardcoded old-formula KPI (line ~831) | 3 |
| `src/lib/i18n.tsx` | `econ.*` relabel + disclaimer + formula (en+ko) | 3 |
| `package.json`, `CHANGELOG.md` | v1.2.0 | 3 |

Test runner: `tests/run-all.sh` globs `tests/server/*.mjs`.

---

## Task 1: pure `scoreEconomicProductivity` + unit tests

**Files:** `server/aws.js` (add export), `tests/server/test-econ-score.mjs` (create).

- [ ] **Step 1: Write the failing test** `tests/server/test-econ-score.mjs`:

```js
// Standalone ESM test for scoreEconomicProductivity (server/aws.js).
// node tests/server/test-econ-score.mjs — exit 0 on success, 1 on failure.
import { scoreEconomicProductivity } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Minimal per-user record the scorer consumes (route supplies these fields).
const U = (o = {}) => ({
  email: 'a@x.com', spend_usd: 10, loc_added: 0, loc_removed: 0, commits: 0, prs: 0,
  active_days: 1, tool_accepted: 0, tool_rejected: 0, messages: 0,
  office_messages: 0, office_sessions: 0, cowork_actions: 0, cowork_file_edits: 0,
  cowork_sessions: 0, design_projects_created: 0, design_messages: 0, design_sessions: 0, ...o,
})
const byEmail = (arr) => Object.fromEntries(arr.map((u) => [u.email, u]))

// No double-count: more commits change delivery but NOT value_per_dollar; more accepts change only acceptance.
;(() => {
  const base = U({ email: 'base', loc_added: 100, commits: 1, prs: 0, active_days: 2, tool_accepted: 8, tool_rejected: 2 })
  const moreCommits = U({ email: 'mc', loc_added: 100, commits: 9, prs: 0, active_days: 2, tool_accepted: 8, tool_rejected: 2 })
  const r = byEmail(scoreEconomicProductivity([base, moreCommits]))
  ok('commits do not change value_per_dollar (no double-count)', r.base.value_per_dollar === r.mc.value_per_dollar)
  ok('commits raise delivery term', r.mc.score_components.delivery > r.base.score_components.delivery)
  ok('commits do not change acceptance term', r.mc.score_components.acceptance === r.base.score_components.acceptance)
  const moreAcc = U({ email: 'ma', loc_added: 100, commits: 1, prs: 0, active_days: 2, tool_accepted: 80, tool_rejected: 2 })
  const r2 = byEmail(scoreEconomicProductivity([base, moreAcc]))
  ok('accepts change only acceptance term', r2.ma.score_components.acceptance > r2.base.score_components.acceptance && r2.ma.value_per_dollar === r2.base.value_per_dollar)
})()

// Net-LOC churn: loc_added 200, loc_removed 800 → code value 0, not 200.
;(() => {
  const churned = U({ email: 'c', loc_added: 200, loc_removed: 800, spend_usd: 10 })
  const r = byEmail(scoreEconomicProductivity([churned]))
  ok('net-LOC: code value floored at 0 when removed > 2×added', r.c.value_units === 0)
})()

// Multi-surface: cowork/office/design only (no code) → value_units > 0 and score > 0.
;(() => {
  const surf = U({ email: 's', loc_added: 0, office_messages: 50, office_sessions: 5, cowork_actions: 30, cowork_file_edits: 4, cowork_sessions: 3, design_projects_created: 2, design_messages: 10, design_sessions: 2, spend_usd: 5 })
  const r = byEmail(scoreEconomicProductivity([surf]))
  ok('multi-surface value_units > 0 for non-code user', r.s.value_units > 0)
  ok('non-code surface user gets a non-zero score (surface-bias fix)', r.s.economic_productivity_score > 0)
})()

// Winsorized median-anchor stability: a whale barely moves a median user's value term.
;(() => {
  const cohort = [10, 20, 30, 40, 50].map((v, i) => U({ email: `u${i}`, loc_added: v * 10, spend_usd: 10 })) // vpd = v
  const before = byEmail(scoreEconomicProductivity(cohort))
  const withWhale = byEmail(scoreEconomicProductivity([...cohort, U({ email: 'whale', loc_added: 100000, spend_usd: 10 })]))
  const med = before.u2.score_components.value // median user (vpd=30) ≈ 0.5
  ok('median user value term ≈ 0.5', Math.abs(med - 0.5) < 0.12)
  ok('whale barely moves median user (winsorized + median-anchored)', Math.abs(withWhale.u2.score_components.value - med) < 0.1)
})()

// Edge cases
;(() => {
  const r0 = byEmail(scoreEconomicProductivity([U({ email: 'z', loc_added: 50, spend_usd: 0 })]))
  ok('zero spend uses $0.5 floor (finite, not penalized)', Number.isFinite(r0.z.value_per_dollar) && r0.z.value_per_dollar > 0)
  const rNoDays = byEmail(scoreEconomicProductivity([U({ email: 'nd', commits: 5, active_days: 0 })]))
  ok('active_days 0 → delivery term 0', rNoDays.nd.score_components.delivery === 0)
  const rAllZero = byEmail(scoreEconomicProductivity([U({ email: 'a0' }), U({ email: 'b0' })]))
  ok('all-zero cohort → finite scores (median guard)', Number.isFinite(rAllZero.a0.economic_productivity_score))
  const rNull = byEmail(scoreEconomicProductivity([U({ email: 'nu', cowork_file_edits: null })]))
  ok('null cowork_file_edits handled (?? 0)', Number.isFinite(rNull.nu.value_units))
  ok('empty cohort → []', scoreEconomicProductivity([]).length === 0)
})()

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run to verify it fails** — `node tests/server/test-econ-score.mjs` → fails (`scoreEconomicProductivity` not exported).

- [ ] **Step 3: Add the exported function to `server/aws.js`** (module scope, near `analyticsReportsToCostResp`/`utcNextDay`):

```js
// v2 "Value per Dollar" economic-productivity scorer. Pure + exported for unit
// tests. Each raw signal lives in exactly ONE term (no double-counting): LOC +
// surface output → value_per_dollar; commits/PRs → delivery; accepts →
// acceptance; surfaces → breadth. value_per_dollar is the only cohort-relative
// term, normalized winsorized + median-anchored (outlier-immune, not divide-by-max).
export const ECON_V2_DEFAULTS = {
  surface: { office: 2, coworkAction: 1, coworkFileEdit: 3, designProject: 4, designMessage: 1 },
  churnDiscount: 0.5, spendFloor: 0.5, deliveryIdeal: 2.0, anchorFactor: 0.5,
  weights: { value: 0.55, acceptance: 0.25, delivery: 0.12, breadth: 0.08 },
}
export function scoreEconomicProductivity(joined, opts = {}) {
  const C = {
    ...ECON_V2_DEFAULTS, ...opts,
    surface: { ...ECON_V2_DEFAULTS.surface, ...(opts.surface || {}) },
    weights: { ...ECON_V2_DEFAULTS.weights, ...(opts.weights || {}) },
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

  const withVpd = joined.map((u) => {
    const codeVU   = Math.max(0, num(u.loc_added) - C.churnDiscount * num(u.loc_removed))
    const officeVU = C.surface.office * num(u.office_messages)
    const coworkVU = C.surface.coworkAction * num(u.cowork_actions) + C.surface.coworkFileEdit * num(u.cowork_file_edits)
    const designVU = C.surface.designProject * num(u.design_projects_created) + C.surface.designMessage * num(u.design_messages)
    const value_units = codeVU + officeVU + coworkVU + designVU
    const vpd = value_units / Math.max(num(u.spend_usd), C.spendFloor)
    return { u, value_units, vpd }
  })

  // winsorize vpd at p5/p95, then anchor to the cohort median
  const sorted = withVpd.map((x) => x.vpd).sort((a, b) => a - b)
  const pctl = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] : 0)
  const lo = pctl(5), hi = pctl(95)
  const wins = (x) => Math.max(lo, Math.min(hi, x))
  const w = withVpd.map((x) => wins(x.vpd)).sort((a, b) => a - b)
  const median = w.length ? (w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2) : 0

  return withVpd.map(({ u, value_units, vpd }) => {
    const valueTerm = median > 0 ? clamp01(C.anchorFactor * wins(vpd) / median) : 0
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
    const economic_productivity_score = Math.round(100 * (
      C.weights.value * valueTerm + C.weights.acceptance * acceptanceTerm +
      C.weights.delivery * deliveryTerm + C.weights.breadth * breadthTerm))
    return {
      ...u,
      value_units: Number(value_units.toFixed(2)),
      value_per_dollar: Number(vpd.toFixed(2)),
      score_components: {
        value: Number(valueTerm.toFixed(4)), acceptance: Number(acceptanceTerm.toFixed(4)),
        delivery: Number(deliveryTerm.toFixed(4)), breadth: Number(breadthTerm.toFixed(4)),
      },
      economic_productivity_score,
    }
  })
}
```

- [ ] **Step 4: Run tests** — `node tests/server/test-econ-score.mjs` → all `ok`; `node --check server/aws.js`; `bash tests/run-all.sh` → `failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/aws.js tests/server/test-econ-score.mjs
git commit -m "feat(cost): scoreEconomicProductivity v2 순수 함수 + 단위 테스트 (이중계산 제거·멀티surface·중앙값앵커)"
```

---

## Task 2: Wire `/cost/efficiency` to v2 — surface accumulators + call scorer + `score_version` + `totals.value_units`

**Files:** `server/aws.js` (the `/cost/efficiency` route, ~1095-1243).

- [ ] **Step 1: Add surface fields to the `byProdUser` accumulator default** (currently `{ sessions, loc_added, loc_removed, commits, prs, accepted, rejected, messages, active_days }`, ~line 1104-1107). Add:

```js
        const u = byProdUser.get(email) ?? {
          sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0,
          accepted: 0, rejected: 0, messages: 0, active_days: 0,
          office_messages: 0, office_sessions: 0,
          cowork_actions: 0, cowork_file_edits: 0, cowork_sessions: 0,
          design_projects_created: 0, design_messages: 0, design_sessions: 0,
        }
```

- [ ] **Step 2: Accumulate the surfaces in the loop body** — insert after the `u.rejected += …` block (~line 1118), before `byProdUser.set(email, u)`:

```js
        const off = rec.office_metrics
        if (off) for (const k of ['excel', 'powerpoint', 'word', 'outlook']) {
          u.office_messages += off[k]?.message_count ?? 0
          u.office_sessions += off[k]?.distinct_session_count ?? 0
        }
        const cw = rec.cowork_metrics
        if (cw) {
          u.cowork_actions    += cw.action_count ?? 0
          u.cowork_file_edits += cw.file_edit_count ?? 0
          u.cowork_sessions   += cw.distinct_session_count ?? 0
        }
        const dz = rec.design_metrics
        if (dz) {
          u.design_projects_created += dz.distinct_projects_created_count ?? 0
          u.design_messages         += dz.message_count ?? 0
          u.design_sessions         += dz.distinct_session_count ?? 0
        }
```

- [ ] **Step 3: Mirror the new fields in the `byProdUser` fallback default inside the join** (the `?? { sessions: 0, … }` at ~line 1127) so users with spend but no productivity record still have the fields:

```js
      const p = byProdUser.get(email) ?? { sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0, accepted: 0, rejected: 0, messages: 0, active_days: 0, office_messages: 0, office_sessions: 0, cowork_actions: 0, cowork_file_edits: 0, cowork_sessions: 0, design_projects_created: 0, design_messages: 0, design_sessions: 0 }
```

- [ ] **Step 4: Expose the new fields on each `joined` object** so the scorer can read them. In the `return { … }` of the `.map` (~line 1154-1189), add (keep all existing fields incl. `output_score`/`output_per_dollar` for backward-compat):

```js
        messages: p.messages,
        office_messages: p.office_messages,
        office_sessions: p.office_sessions,
        cowork_actions: p.cowork_actions,
        cowork_file_edits: p.cowork_file_edits,
        cowork_sessions: p.cowork_sessions,
        design_projects_created: p.design_projects_created,
        design_messages: p.design_messages,
        design_sessions: p.design_sessions,
```

- [ ] **Step 5: Replace the inline scoring block** — delete the entire v1 scoring block (the `const cap = …`, `maxOPD`, `minTPL`, and the `const scored = joined.map((j) => { … economic_productivity_score … })` at ~lines 1198-1216) and replace with:

```js
    // v2 "Value per Dollar" scoring — pure, unit-tested. See scoreEconomicProductivity.
    const scored = scoreEconomicProductivity(joined)
```

- [ ] **Step 6: Add `value_units` to `totals` + `score_version` to the response.** In the `totals` reduce (~1218-1225) add `value_units`:

```js
    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
      value_units:       t.value_units + (u.value_units ?? 0),
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0, value_units: 0 })
```

In `res.json({ … })` add `score_version: '2.0'` (top level) and `value_units: Number(totals.value_units.toFixed(2))` inside the `totals: { … }` object.

- [ ] **Step 7: Verify** — `node --check server/aws.js`; `node tests/server/test-econ-score.mjs` (still green); `bash tests/run-all.sh` → `failed: 0`. (Optional: start the local server and `GET /api/cost/efficiency?starting_date=…&ending_date=…` to confirm `score_version:"2.0"`, per-user `value_units`/`score_components`, and `totals.value_units` appear.)

- [ ] **Step 8: Commit**

```bash
git add server/aws.js
git commit -m "feat(cost): /cost/efficiency v2 배선 — office/cowork/design 누산 + scoreEconomicProductivity 호출 + score_version + totals.value_units"
```

---

## Task 3: Frontend reframing + i18n + v1.2.0

**Files:** `src/pages/Cost.tsx`, `src/lib/i18n.tsx`, `package.json`, `CHANGELOG.md`.

- [ ] **Step 1: Relabel + reframe `econ.*` i18n keys** in BOTH `en` and `ko` (`src/lib/i18n.tsx` ~250-264 en, ~763-777 ko). Replace these values:

en:
```ts
    'econ.title':    'Cost Efficiency',
    'econ.subtitle': 'Value produced per dollar across all Claude surfaces (code · cowork · Office · design). A cost-efficiency signal — NOT a performance evaluation.',
    'econ.kpi.score':       'Top Cost-Efficiency',
    'econ.kpi.total_output':'Org Value Units',
    'econ.formula':          'Cost Efficiency (v2) — value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08; value_units = net-LOC + Office/cowork/design output (each signal counted once):',
```
ko:
```ts
    'econ.title':    '비용 효율',
    'econ.subtitle': '모든 Claude surface(코드·cowork·Office·design)에서 $ 한 단위당 산출 가치. 비용 효율 신호이며 성과 평가가 아닙니다.',
    'econ.kpi.score':       '최고 비용효율',
    'econ.kpi.total_output':'조직 Value Units',
    'econ.formula':          '비용 효율 (v2) — value/$ 0.55 · 수락률 0.25 · delivery 0.12 · breadth 0.08; value_units = 순-LOC + Office/cowork/design 산출 (각 신호 1회만 계산):',
```
(Leave the other `econ.*` keys — scatter/top_score/most_efficient/full_table/active_range/kpi.cost_* — as-is; they still describe valid widgets.)

- [ ] **Step 2: Fix the hardcoded old-formula KPI** in `src/pages/Cost.tsx` (~line 831). It currently computes the v1 output formula client-side:
```tsx
<KpiCard label={t('econ.kpi.total_output')} value={fmtCompact(data.totals.loc_added + 100 * data.totals.commits + 1000 * data.totals.prs)} hint="LOC + 100×commits + 1000×PRs" />
```
Replace with the server-provided v2 value_units (no client-side formula):
```tsx
<KpiCard label={t('econ.kpi.total_output')} value={fmtCompact(data.totals.value_units ?? 0)} hint={t('econ.kpi.total_output.hint')} />
```
Add the hint key in i18n (en: `'econ.kpi.total_output.hint': 'net-LOC + multi-surface output'`, ko: `'econ.kpi.total_output.hint': '순-LOC + 멀티 surface 산출'`).

- [ ] **Step 3: Add `value_units` to the efficiency response type** in `src/pages/Cost.tsx`. Find the type for the `/cost/efficiency` response `totals` (the `data.totals` shape, near the `EffResp`/`CsvResp` type ~line 130-155) and add `value_units?: number` to the `totals` object type. (Per-user `value_units`/`score_components`/`score_version` may also be added to the user type if you surface them, but that's optional.)

- [ ] **Step 4: Render the "not a performance metric" disclaimer.** In `EconomicProductivitySection` (after the `econ.subtitle` line ~825), the reframed `econ.subtitle` already carries the disclaimer text — confirm it renders. No extra element needed if the subtitle conveys it; otherwise add a muted line `<p className="text-xs text-ink-400">{t('econ.subtitle')}</p>` is already present. (The subtitle relabel in Step 1 IS the disclaimer.)

- [ ] **Step 5: Update the formula footnote literal.** In `src/pages/Cost.tsx` (~line 905-911), the footnote renders `<b>{t('econ.formula')}</b>` followed by a HARDCODED English formula string (the v1 formula — `LOC + 100·commits + 1000·PRs …`). Read those lines and replace the hardcoded literal so it states the v2 formula (or, preferred, move the whole formula into `t('econ.formula')` from Step 1 and delete the redundant hardcoded literal). Ensure no hardcoded v1 formula text remains in the JSX (the repo's known JSX-prop i18n-bypass trap).

- [ ] **Step 6: Version + CHANGELOG.** `package.json` `"version"` → `1.2.0`. Add a top `CHANGELOG.md` entry (after `## [Unreleased]`, before `## [1.1.1]`), today `2026-06-17`, en `### Changed` + ko `### 변경`:

```markdown
## [1.2.0] - 2026-06-17

Economic Productivity score v2 ("Value per Dollar").

### Changed

- **Rewrote the per-user economic-productivity score** as cost-efficiency v2. Each signal now counts once (no more commits/PRs/accepts double-counting); output is multi-surface (net-LOC churn-discounted + cowork/Office/design), replacing gross-LOC; dropped the `1/tokens_per_LOC` term (was silently 0 on the live path and rewarded under-use); normalization is winsorized + cohort-median-anchored (outlier-immune, not divide-by-max). Weights value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08. Response carries `score_version:"2.0"`, per-user `value_units`/`score_components`, and `totals.value_units`. Reframed the UI as "Cost Efficiency — not a performance metric."

### 변경

- **사용자별 경제 생산성 점수를 비용 효율 v2로 재작성.** 각 신호를 한 번만 계산(commits/PRs/accepts 이중계산 제거), 산출을 멀티 surface(순-LOC churn 할인 + cowork/Office/design)로 확장(총 LOC 대체), `1/tokens_per_LOC` 항 제거(라이브에서 0·과소사용 보상), 정규화를 winsorized + 코호트 중앙값 앵커로(아웃라이어 면역, divide-by-max 아님). 가중치 value/$ 0.55 · 수락 0.25 · delivery 0.12 · breadth 0.08. 응답에 `score_version`·per-user `value_units`/`score_components`·`totals.value_units`. UI를 "비용 효율 — 성과 지표 아님"으로 리프레이밍.
```

- [ ] **Step 7: Verify** — `npx tsc --noEmit`; `npx vite build`; `bash tests/run-all.sh` (`failed: 0`); grep `src/pages/Cost.tsx` for any leftover `1000 *`/`100 *` v1-formula literal → none.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Cost.tsx src/lib/i18n.tsx package.json CHANGELOG.md
git commit -m "feat(cost): Cost Efficiency v2 리프레이밍 — 라벨·면책·공식 footnote·value_units KPI + v1.2.0"
```

---

## Post-implementation (controller)

`finishing-a-development-branch` → merge to main → push → `/deploy` (ccd-compute: server + frontend) → CloudFront `/*` invalidation → confirm `/api/cost/efficiency` carries `score_version:"2.0"` and the Cost page shows the reframed section.

## Out of scope

`cache_efficiency` term; CSV-path range-vs-spend mismatch; per-user score-breakdown UI columns; the unrelated `UserProductivity.tsx` score.
