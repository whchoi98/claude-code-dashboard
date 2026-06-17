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
