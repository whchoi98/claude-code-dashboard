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

console.log(`\n1..${testNum}`)
process.exit(failed === 0 ? 0 : 1)
