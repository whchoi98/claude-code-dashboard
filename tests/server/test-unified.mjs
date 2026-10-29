// Standalone ESM tests for server/unified.js (Chat and Cowork unified).
// Runs with: node tests/server/test-unified.mjs — exit 0 on success, 1 on failure.
import { chatMessagesOf, coworkTotalsOf } from '../../server/unified.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Shapes as served for org2 on 2026-10-25 (raw/users): chat moved entirely
// into the unified block.
const unifiedOnly = {
  chat_metrics: { message_count: 0 },
  cowork_metrics: { distinct_session_count: 0, action_count: 0, file_edit_count: null },
  chat_cowork_unified_metrics: {
    chat: { message_count: 20 },
    sessions: { distinct_session_count: 1, action_count: 9, file_edit_count: 3 },
  },
}
ok('unified-only user: chat messages come from the unified block', chatMessagesOf(unifiedOnly) === 20)
ok('unified-only user: cowork totals come from the unified block', JSON.stringify(coworkTotalsOf(unifiedOnly)) === JSON.stringify({ actions: 9, file_edits: 3, sessions: 1 }))

const split = {
  chat_metrics: { message_count: 4 },
  cowork_metrics: { distinct_session_count: 2, action_count: 5, file_edit_count: 1 },
  chat_cowork_unified_metrics: { chat: { message_count: 6 }, sessions: { distinct_session_count: 1, action_count: 1 } },
}
ok('switch-over day: per-user counters add across both blocks', chatMessagesOf(split) === 10)
ok('switch-over day: cowork counters add, a missing unified file_edit_count adds 0', JSON.stringify(coworkTotalsOf(split)) === JSON.stringify({ actions: 6, file_edits: 1, sessions: 3 }))

const legacy = { chat_metrics: { message_count: 7 }, cowork_metrics: { distinct_session_count: 1, action_count: 2, file_edit_count: null } }
ok('no unified block (deployment without the product): legacy values unchanged', chatMessagesOf(legacy) === 7 && coworkTotalsOf(legacy).sessions === 1)
ok('null feature-flag counters count as 0, never NaN', coworkTotalsOf(legacy).file_edits === 0)
ok('missing everything → zeros', chatMessagesOf({}) === 0 && coworkTotalsOf(undefined).actions === 0)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
