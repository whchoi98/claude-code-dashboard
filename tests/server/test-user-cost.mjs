// Standalone ESM test for userCostToUsers (server/aws.js).
// Runs with: node tests/server/test-user-cost.mjs — exit 0 on success, 1 on failure.
import { userCostToUsers, utcNextDay, resolveUserCostWindow } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const eqf = (a, b) => Math.abs(a - b) < 1e-6

const page = [
  { actor: { type: 'user_actor', user_id: 'u1', name: 'Alice', email: 'alice@acme.com', deleted: false },
    currency: 'USD', amount: '1175883.870130', list_amount: '1175885.870130', requests: 52110 },
  { actor: { type: 'user_actor', user_id: 'u2', name: 'Bob', email: 'bob@acme.com', deleted: false },
    currency: 'USD', amount: '5000', list_amount: '5000', requests: 3 },
  // api_actor with no email — excluded (user-centric endpoint; can't join)
  { actor: { type: 'api_actor', api_key_id: 'k1' }, currency: 'USD', amount: '99', requests: 1 },
]
const users = userCostToUsers(page)
ok('excludes actors without email', users.length === 2)
ok('cents → USD net', eqf(users[0].net_spend_usd, 11758.8387013))
ok('cents → USD gross from list_amount', eqf(users[0].gross_spend_usd, 11758.8587013))
ok('gross falls back to amount when list_amount missing', eqf(userCostToUsers([{ actor: { email: 'x@y.com' }, amount: '200' }])[0].gross_spend_usd, 2))
ok('passes raw email (no masking here)', users[0].email === 'alice@acme.com')
ok('passes user_id + name', users[0].user_id === 'u1' && users[0].name === 'Alice')
ok('requests numeric', users[1].requests === 3)
ok('empty / non-array → []', userCostToUsers(null).length === 0 && userCostToUsers(undefined).length === 0)
ok('non-numeric amount → 0 (no NaN)', userCostToUsers([{ actor: { email: 'x@y.com' }, amount: 'abc' }])[0].net_spend_usd === 0)
ok('deleted actor with email is kept', userCostToUsers([{ actor: { email: 'gone@y.com', deleted: true }, amount: '500' }]).length === 1)

// utcNextDay — inclusive end → exclusive next-day bound (fixes zero-width 1d window)
ok('utcNextDay advances one day', utcNextDay('2026-06-07') === '2026-06-08')
ok('utcNextDay crosses month boundary', utcNextDay('2026-06-30') === '2026-07-01')
ok('utcNextDay crosses year boundary', utcNextDay('2026-12-31') === '2027-01-01')
ok('single inclusive day → 2-day half-open window (not zero-width)',
   utcNextDay('2026-06-07') !== '2026-06-07')

// byModel mode: aggregate per email, nested by_model sorted desc
const bm = userCostToUsers([
  { actor: { email: 'a@x.com', user_id: 'u1', name: 'A' }, model: 'claude-opus-4-8', amount: '300000', requests: 10 },
  { actor: { email: 'a@x.com' }, model: 'claude-sonnet-4-6', amount: '100000', requests: 5 },
  { actor: { email: 'b@x.com' }, model: 'claude-opus-4-8', amount: '50000', requests: 2 },
  { actor: { type: 'api_actor' }, model: 'x', amount: '999' },  // no email — excluded
], { byModel: true })
ok('byModel: aggregates per email (api_actor excluded)', bm.length === 2)
ok('byModel: net_spend summed per email ($4000)', Math.abs(bm[0].net_spend_usd - 4000) < 1e-6 && bm[0].requests === 15)
ok('byModel: by_model sorted desc (opus $3000 first)', bm[0].by_model[0].model === 'claude-opus-4-8' && Math.abs(bm[0].by_model[0].spend_usd - 3000) < 1e-6 && bm[0].by_model.length === 2)
ok('byModel=false unchanged (gross_spend present)', userCostToUsers([{ actor: { email: 'x@y.com' }, amount: '200' }])[0].gross_spend_usd === 2)

// resolveUserCostWindow — user_cost_report serves the recent 3-day buffer
// (partial data, same as cost_report), so the window must NOT be clamped to
// today-3 anymore; that clamp cut the last 3 days out of every per-user
// table while the org-wide headline included them, and (with `starting`
// left unclamped) inverted fully-recent ranges into upstream 400s.
const NOW = new Date('2026-07-03T12:00:00Z')
const w1 = resolveUserCostWindow({ starting_date: '2026-06-27', ending_date: '2026-07-03' }, NOW)
ok('window: ending inside 3-day buffer passes through un-clamped',
   w1.starting === '2026-06-27' && w1.ending === '2026-07-03')
const w2 = resolveUserCostWindow({ starting_date: '2026-07-02', ending_date: '2026-07-03' }, NOW)
ok('window: fully-recent range no longer inverts (starting ≤ ending)',
   w2.starting === '2026-07-02' && w2.ending === '2026-07-03')
const w3 = resolveUserCostWindow({ starting_date: '2026-07-03', ending_date: '2026-08-01' }, NOW)
ok('window: future ending clamps to today, starting follows (never inverted)',
   w3.ending === '2026-07-03' && w3.starting <= w3.ending)
const w4 = resolveUserCostWindow({ starting_date: '2026-07-10', ending_date: '2026-07-01' }, NOW)
ok('window: inverted input pins starting back to ending',
   w4.starting === '2026-07-01' && w4.ending === '2026-07-01')
const w5 = resolveUserCostWindow({}, NOW)
ok('window: defaults = 31 inclusive days ending today (upstream caps spans at 31d)',
   w5.ending === '2026-07-03' && w5.starting === '2026-06-03')

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
