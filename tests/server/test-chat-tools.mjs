// Standalone ESM test for server/chat-tools.js pure helpers.
// Runs with: node tests/server/test-chat-tools.mjs
// Exit code 0 on success, 1 on any failure (TAP-like output).

import {
  maskEmail, maskEmailsDeep, historyToBedrockMessages,
  parseFollowups, rankUsers, compactOverview,
} from '../../server/chat-tools.js'

let testNum = 0
let failed = 0
function ok(name, cond) {
  testNum += 1
  if (cond) { console.log(`ok ${testNum} - ${name}`) }
  else { failed += 1; console.log(`not ok ${testNum} - ${name}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// maskEmail
ok('maskEmail keeps 2 chars + domain', maskEmail('alice.kim@acme.com') === 'al*******@acme.com')
ok('maskEmail short local untouched', maskEmail('ab@x.com') === 'ab@x.com')
ok('maskEmail null → empty', maskEmail(null) === '')

// maskEmailsDeep
ok('maskEmailsDeep masks nested', eq(
  maskEmailsDeep({ rows: [{ user_email: 'bob.lee@acme.com', n: 5 }] }),
  { rows: [{ user_email: 'bo*****@acme.com', n: 5 }] },
))
ok('maskEmailsDeep leaves non-emails', maskEmailsDeep('hello world') === 'hello world')
// percent-encoded emails inside recorded urls/bodies (compliance_daily payload)
ok('maskEmailsDeep masks %40-encoded in url', maskEmailsDeep('GET /v1/users?email=alice%40acme.com') === 'GET /v1/users?email=al***%40acme.com')
ok('maskEmailsDeep masks %40 with +tag encoding', maskEmailsDeep('email=bob%2Btag%40acme.com') === 'email=bo***%40acme.com')
ok('maskEmailsDeep leaves email-free urls alone', maskEmailsDeep('https://api.anthropic.com/v1/compliance/activities?limit=100') === 'https://api.anthropic.com/v1/compliance/activities?limit=100')

// historyToBedrockMessages
ok('history maps roles + drops empties', eq(
  historyToBedrockMessages([
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'hello' },
  ]),
  [
    { role: 'user', content: [{ text: 'hi' }] },
    { role: 'assistant', content: [{ text: 'hello' }] },
  ],
))
ok('history drops leading assistant', eq(
  historyToBedrockMessages([{ role: 'assistant', text: 'x' }, { role: 'user', text: 'q' }]),
  [{ role: 'user', content: [{ text: 'q' }] }],
))
ok('history caps to last 12 turns', historyToBedrockMessages(
  Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` })),
).length <= 12)

// parseFollowups
ok('parseFollowups reads JSON array', eq(
  parseFollowups('["Q1?","Q2?","Q3?","Q4?"]'),
  ['Q1?', 'Q2?', 'Q3?'],
))
ok('parseFollowups fenced json', eq(
  parseFollowups('```json\n["A?","B?"]\n```'),
  ['A?', 'B?'],
))
ok('parseFollowups line fallback', eq(
  parseFollowups('1. First question?\n2. Second question?'),
  ['First question?', 'Second question?'],
))
ok('parseFollowups garbage → []', eq(parseFollowups('no questions here'), []))

// rankUsers (UserRecord shape from src/types.ts)
const U = (email, loc, commits) => ({
  user: { id: email, email_address: email },
  claude_code_metrics: {
    core_metrics: { distinct_session_count: 1, commit_count: commits, pull_request_count: 0,
      lines_of_code: { added_count: loc, removed_count: 0 } },
    tool_actions: { edit_tool: { accepted_count: 8, rejected_count: 2 },
      multi_edit_tool: { accepted_count: 0, rejected_count: 0 },
      write_tool: { accepted_count: 0, rejected_count: 0 },
      notebook_edit_tool: { accepted_count: 0, rejected_count: 0 } },
  },
})
const ranked = rankUsers([U('a@x.com', 10, 1), U('bob@x.com', 500, 9)], { limit: 5 })
ok('rankUsers sorts by activity desc', ranked[0].email === 'bo*@x.com' || ranked[0].email.startsWith('bo'))
ok('rankUsers masks email', !ranked.some((r) => r.email.includes('bob@')))
ok('rankUsers honors limit', rankUsers([U('a@x.com', 1, 0), U('b@x.com', 2, 0), U('c@x.com', 3, 0)], { limit: 2 }).length === 2)
ok('rankUsers query filter', rankUsers([U('alice@x.com', 1, 0), U('bob@x.com', 2, 0)], { query: 'alice' }).length === 1)

// compactOverview
const snap = {
  window: { starting_date: '2026-05-20', ending_date: '2026-06-03' },
  summaries: [{ daily_active_user_count: 40, weekly_active_user_count: 90, assigned_seat_count: 120 }],
  users_today: [U('a@x.com', 1, 0), U('b@x.com', 2, 0)],
  skills: [{ skill_name: 'pdf', distinct_user_count: 12 }, { skill_name: 'sql', distinct_user_count: 3 }],
  connectors: [{ connector_name: 'github', distinct_user_count: 30 }],
}
const ov = compactOverview(snap)
ok('compactOverview drops raw user list', ov.users_today === undefined && ov.active_user_count === 2)
ok('compactOverview keeps summaries + seats', ov.summaries.length === 1)
ok('compactOverview top skills sorted', ov.top_skills[0].skill_name === 'pdf')

import { TOOL_SPECS, CHAT_SYSTEM_PROMPT, makeToolRunner } from '../../server/chat-tools.js'

ok('TOOL_SPECS has 4 tools', TOOL_SPECS.length === 4)
ok('TOOL_SPECS names', eq(
  TOOL_SPECS.map((t) => t.toolSpec.name).sort(),
  ['get_analytics_overview', 'get_cost_summary', 'run_athena_sql', 'search_users'],
))
ok('system prompt localized ko', CHAT_SYSTEM_PROMPT('ko', '2026-06-09').includes('한국어'))
// Multi-org: the optional 3rd arg pins the session to one org; omitting it
// (legacy callers / single-org deployments) leaves the prompt org-free.
ok('system prompt org-free by default', !CHAT_SYSTEM_PROMPT('en', '2026-07-21').includes('scoped to the organization'))
const org2Prompt = CHAT_SYSTEM_PROMPT('en', '2026-07-21', { id: 'org2', label: 'Acme EU' })
ok('system prompt names the org2 label', org2Prompt.includes('"Acme EU"') && org2Prompt.includes('(org2)'))
ok('system prompt routes org2 to *_org2 tables', org2Prompt.includes('claude_code_analytics_org2'))
const primaryPrompt = CHAT_SYSTEM_PROMPT('en', '2026-07-21', { id: 'primary', label: 'Org 1' })
ok('system prompt routes primary to unsuffixed tables', primaryPrompt.includes('use the unsuffixed tables'))
ok('athena tool hint mentions the *_org2 twins', TOOL_SPECS.find((t) => t.toolSpec.name === 'run_athena_sql').toolSpec.description.includes('summaries_daily_org2'))

// makeToolRunner with stubbed deps
const runner = makeToolRunner({
  fetchAnalytics: async () => snap,
  runAthenaSafe: async (sql) => ({ columns: ['user_email'], rows: [{ user_email: 'xyz@y.com' }] }),
  fetchCostSummary: async () => ({ totals: { net_spend_usd: 5 } }),
})
ok('runner overview ok', (await runner('get_analytics_overview', {})).data.active_user_count === 2)
ok('runner athena masks emails', (await runner('run_athena_sql', { sql: 'SELECT 1' })).data.rows[0].user_email.includes('*'))
ok('runner unknown tool → error', (await runner('nope', {})).ok === false)

console.log(`\n1..${testNum}`)
process.exit(failed === 0 ? 0 : 1)
