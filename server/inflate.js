// Pure read-side helper — flattened NDJSON row (collector/flatten.js flattenUser)
// → nested Analytics-API shape. Dependency-free so the flatten↔inflate contract
// is unit-testable in isolation. Field names MUST stay in lockstep with
// collector/flatten.js — a mismatch silently writes zeros (collector/CLAUDE.md).
export function inflateUser(f) {
  return {
    user: { id: f.user_id, email_address: f.user_email },
    chat_metrics: {
      distinct_conversation_count:        f.chat_conversations ?? 0,
      message_count:                      f.chat_messages ?? 0,
      thinking_message_count:             f.chat_thinking_messages ?? 0,
      distinct_projects_used_count:       0,
      distinct_projects_created_count:    0,
      distinct_artifacts_created_count:   f.chat_artifacts ?? 0,
      distinct_skills_used_count:         f.chat_skills ?? 0,
      connectors_used_count:              f.chat_connectors ?? 0,
      distinct_files_uploaded_count:      f.chat_files_uploaded ?? 0,
      shared_conversations_viewed_count:  0,
      distinct_shared_artifacts_viewed_count: 0,
    },
    claude_code_metrics: {
      core_metrics: {
        distinct_session_count: f.cc_sessions ?? 0,
        commit_count:           f.commits_by_claude_code ?? 0,
        pull_request_count:     f.prs_by_claude_code ?? 0,
        lines_of_code: {
          added_count:   f.lines_of_code_added ?? 0,
          removed_count: f.lines_of_code_removed ?? 0,
        },
      },
      tool_actions: {
        edit_tool:          { accepted_count: f.edit_tool_accepted ?? 0,          rejected_count: f.edit_tool_rejected ?? 0 },
        multi_edit_tool:    { accepted_count: f.multi_edit_tool_accepted ?? 0,    rejected_count: f.multi_edit_tool_rejected ?? 0 },
        write_tool:         { accepted_count: f.write_tool_accepted ?? 0,         rejected_count: f.write_tool_rejected ?? 0 },
        notebook_edit_tool: { accepted_count: f.notebook_edit_tool_accepted ?? 0, rejected_count: f.notebook_edit_tool_rejected ?? 0 },
      },
    },
    office_metrics: {
      excel:      { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
      powerpoint: { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
      word:       { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
    },
    cowork_metrics: {
      distinct_session_count: f.cowork_sessions ?? 0,
      action_count:           f.cowork_actions ?? 0,
      dispatch_turn_count:    f.cowork_dispatch_turns ?? 0,
      message_count:          f.cowork_messages ?? 0,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    web_search_count: f.web_search_count ?? 0,
  }
}
