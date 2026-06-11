// Round-trip test for the collector flatten ↔ server inflate contract.
// node tests/server/test-flatten-inflate.mjs — exit 0 on success, 1 on failure.
import { flattenUser } from '../../collector/flatten.js'
import { inflateUser } from '../../server/inflate.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// A synthetic Analytics-API user record covering every metric group.
const record = {
  user: { id: 'u1', email_address: 'a@acme.com' },
  chat_metrics: { distinct_conversation_count: 3, message_count: 40, thinking_message_count: 5, distinct_files_uploaded_count: 2, distinct_artifacts_created_count: 1, distinct_skills_used_count: 4, connectors_used_count: 2 },
  claude_code_metrics: {
    core_metrics: { distinct_session_count: 7, commit_count: 9, pull_request_count: 2, lines_of_code: { added_count: 100, removed_count: 20 } },
    tool_actions: {
      edit_tool: { accepted_count: 10, rejected_count: 1 },
      multi_edit_tool: { accepted_count: 5, rejected_count: 0 },
      write_tool: { accepted_count: 3, rejected_count: 2 },
      notebook_edit_tool: { accepted_count: 1, rejected_count: 0 },
    },
  },
  web_search_count: 8,
  cowork_metrics: {
    distinct_session_count: 2, action_count: 11, dispatch_turn_count: 4, message_count: 6,
    file_edit_count: 3, edit_tool_count: 2, multi_edit_tool_count: null,
    write_tool_count: 0, notebook_edit_tool_count: null, sessions_with_file_edits_count: 1,
  },
  office_metrics: {
    excel:      { distinct_session_count: 1, message_count: 2, skills_used_count: 3, distinct_skills_used_count: 4, connectors_used_count: 5, distinct_connectors_used_count: 6 },
    powerpoint: { distinct_session_count: 7, message_count: 8, skills_used_count: 9, distinct_skills_used_count: 10, connectors_used_count: 11, distinct_connectors_used_count: 12 },
    word:       { distinct_session_count: 13, message_count: 14, skills_used_count: 15, distinct_skills_used_count: 16, connectors_used_count: 17, distinct_connectors_used_count: 18 },
    outlook:    { distinct_session_count: 19, message_count: 20, skills_used_count: 21, distinct_skills_used_count: 22, connectors_used_count: 23, distinct_connectors_used_count: 24 },
  },
  design_metrics: { distinct_session_count: 30, distinct_projects_used_count: 31, distinct_projects_created_count: 32, message_count: 33 },
}

const flat = flattenUser(record)
const round = inflateUser(flat)
const empty = flattenUser({ user: { id: 'x', email_address: 'x@y.com' } })

// --- Task 1: existing-field characterization (behavior preserved by extraction) ---
ok('flatten keeps user id/email', flat.user_id === 'u1' && flat.user_email === 'a@acme.com')
ok('round-trip chat messages', round.chat_metrics.message_count === 40)
ok('round-trip cc loc added', round.claude_code_metrics.core_metrics.lines_of_code.added_count === 100)
ok('round-trip edit_tool accepted', round.claude_code_metrics.tool_actions.edit_tool.accepted_count === 10)
ok('round-trip cowork existing', round.cowork_metrics.distinct_session_count === 2 && round.cowork_metrics.action_count === 11)
ok('round-trip web_search_count', round.web_search_count === 8)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
