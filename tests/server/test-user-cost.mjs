// Standalone ESM test for userCostToUsers (server/aws.js).
// Runs with: node tests/server/test-user-cost.mjs — exit 0 on success, 1 on failure.
import { userCostToUsers, utcNextDay } from '../../server/aws.js'

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

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
