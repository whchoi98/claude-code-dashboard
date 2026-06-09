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

console.log(`\n1..${testNum}`)
process.exit(failed === 0 ? 0 : 1)
