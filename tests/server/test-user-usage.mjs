// Standalone ESM tests for userUsageToUsers + spendLimitsToMembers (server/aws.js).
// Runs with: node tests/server/test-user-usage.mjs — exit 0 on success, 1 on failure.
import { userUsageToUsers, spendLimitsToMembers } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const eqf = (a, b) => Math.abs(a - b) < 1e-6

// ── userUsageToUsers ───────────────────────────────────────────────────────
// Real-world sample numbers (probed 2026-07-04): input collapse must equal
// the upstream row's own total_tokens minus output_tokens.
const usageRows = [
  { actor: { type: 'user_actor', user_id: 'u1', name: 'A', email: 'a@x.com' },
    uncached_input_tokens: 81265631,
    cache_creation: { ephemeral_1h_input_tokens: 185569768, ephemeral_5m_input_tokens: 70423441 },
    cache_read_input_tokens: 6933208704,
    output_tokens: 45346570, total_tokens: 7315814114, requests: 30764 },
  // Same user again (e.g. rbac-grouped rows) — must aggregate per email
  { actor: { type: 'user_actor', email: 'a@x.com' },
    uncached_input_tokens: 100, cache_creation: {}, cache_read_input_tokens: 0,
    output_tokens: 50, requests: 2 },
  { actor: { type: 'user_actor', email: 'b@x.com' },
    uncached_input_tokens: 10, cache_read_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 30 },
    output_tokens: 5, requests: 1 },
  { actor: { type: 'api_actor', api_key_id: 'k1' }, uncached_input_tokens: 999, output_tokens: 9 },  // no email → excluded
]
const users = userUsageToUsers(usageRows)
ok('excludes actors without email', users.length === 2)
const a = users.find((u) => u.email === 'a@x.com')
ok('input collapses uncached + cache_read + cache_creation(1h+5m)',
   a.input_tokens === 81265631 + 6933208704 + 185569768 + 70423441 + 100)
ok('input+output equals upstream total_tokens convention',
   81265631 + 6933208704 + 185569768 + 70423441 + 45346570 === 7315814114)
ok('output + requests accumulate per email', a.output_tokens === 45346570 + 50 && a.requests === 30766)
ok('total_tokens = input + output', a.total_tokens === a.input_tokens + a.output_tokens)
const bU = users.find((u) => u.email === 'b@x.com')
ok('missing cache tiers treated as 0', bU.input_tokens === 60 && bU.output_tokens === 5)
ok('sorted by total_tokens desc', users[0].email === 'a@x.com')
ok('empty / non-array → []', userUsageToUsers(null).length === 0 && userUsageToUsers([]).length === 0)

// ── spendLimitsToMembers ───────────────────────────────────────────────────
// amount / period_to_date_spend are decimal strings in MINOR units (cents) —
// verified against user_cost_report month-to-date 2026-07-04. amount null =
// unlimited → limit_usd null, utilization null.
const limitRows = [
  { scope: { type: 'user', user_id: 'u1' },
    actor: { type: 'user_actor', user_id: 'u1', name: 'N', email_address: 'netsgo@x.com', deleted: false },
    amount: null, currency: 'USD', period: 'monthly',
    source: { type: 'seat_tier', seat_tier: 'enterprise_usage_based' },
    spend_limit_id: 'spl_1', period_to_date_spend: '61386.884' },
  { scope: { type: 'user', user_id: 'u2' },
    actor: { type: 'user_actor', user_id: 'u2', name: 'C', email_address: 'capped@x.com' },
    amount: '100000', currency: 'USD', period: 'monthly',
    source: { type: 'user' }, spend_limit_id: 'spl_2', period_to_date_spend: '75000' },
  { scope: { type: 'user', user_id: 'u3' },
    actor: { type: 'user_actor', user_id: 'u3', name: 'G', email_address: 'grp@x.com' },
    amount: '200000', currency: 'USD', period: 'monthly',
    source: { type: 'rbac_group', rbac_group_id: 'rbac_group_x' },
    spend_limit_id: 'spl_3', period_to_date_spend: '20000' },
  { scope: { type: 'user', user_id: 'u4' }, actor: { type: 'api_actor' }, amount: '1', period_to_date_spend: '1' },  // no email → excluded
]
const members = spendLimitsToMembers(limitRows)
ok('excludes rows without an actor email', members.length === 3)
const capped = members.find((m) => m.email === 'capped@x.com')
ok('cents → USD for limit and spend', eqf(capped.limit_usd, 1000) && eqf(capped.spent_usd, 750))
ok('utilization = spent/limit', eqf(capped.utilization, 0.75))
const unlim = members.find((m) => m.email === 'netsgo@x.com')
ok('null amount → unlimited (limit_usd null, utilization null); spend rounded to cents', unlim.limit_usd === null && unlim.utilization === null && eqf(unlim.spent_usd, 613.87))
ok('source type + detail carried through', capped.source === 'user' && members.find((m) => m.email === 'grp@x.com').source === 'rbac_group')
ok('sorted: finite utilization desc first, then unlimited by spend desc',
   members[0].email === 'capped@x.com' && members[1].email === 'grp@x.com' && members[2].email === 'netsgo@x.com')
ok('malformed amount coerces to 0 spend, not NaN', (() => {
  const m = spendLimitsToMembers([{ actor: { email_address: 'x@y.com' }, amount: null, period_to_date_spend: 'abc' }])
  return m.length === 1 && m[0].spent_usd === 0
})())
ok('empty / non-array → []', spendLimitsToMembers(null).length === 0)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
