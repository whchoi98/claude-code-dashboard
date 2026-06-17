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

// J) Idle billed users (positive spend, ZERO output on every surface) must not
//    distort active users' value term — Pass 5 anchors on the ACTIVE subpopulation,
//    not the whole cohort. Regression test for the v3 final-review Critical defect.
;(() => {
  const active = [100, 200, 300, 400, 500].map((loc, i) => U({ email: `a${i}`, loc_added: loc, spend_usd: 10 }))
  const baseline = byEmail(scoreEconomicProductivity(active))           // no idle users
  const idle = Array.from({ length: 30 }, (_, i) => U({ email: `idle${i}`, spend_usd: 5 }))
  const withIdle = byEmail(scoreEconomicProductivity([...active, ...idle]))  // idle-majority cohort
  ok('idle-majority cohort does NOT change an active user value term',
     withIdle.a2.score_components.value === baseline.a2.score_components.value)
  ok('idle-majority active user value term stays positive (not collapsed to 0)',
     withIdle.a2.score_components.value > 0)
  ok('idle billed user gets value term 0', withIdle.idle0.score_components.value === 0)
  ok('idle billed user score ≤ a median active user score',
     withIdle.idle0.economic_productivity_score <= withIdle.a2.economic_productivity_score)
})()

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
