// Pure flatten helpers — Analytics API nested records → columnar NDJSON rows
// that Athena/Glue can query and server/inflate.js inflateUser() can reconstruct.
// Dependency-free so the flatten↔inflate contract is unit-testable in isolation
// (tests/server/test-flatten-inflate.mjs). Field names MUST stay in lockstep with
// server/inflate.js — a mismatch silently writes zeros (see collector/CLAUDE.md).

export function flattenUser(r) {
  const cc = r.claude_code_metrics || {}
  const core = cc.core_metrics || {}
  const tools = cc.tool_actions || {}
  const tool = (t) => ({
    accepted: t?.accepted_count ?? 0,
    rejected: t?.rejected_count ?? 0,
  })
  const chat = r.chat_metrics || {}
  const cowork = r.cowork_metrics || {}
  return {
    user_id:                r.user?.id,
    user_email:             r.user?.email_address,
    chat_conversations:     chat.distinct_conversation_count ?? 0,
    chat_messages:          chat.message_count ?? 0,
    chat_thinking_messages: chat.thinking_message_count ?? 0,
    chat_files_uploaded:    chat.distinct_files_uploaded_count ?? 0,
    chat_artifacts:         chat.distinct_artifacts_created_count ?? 0,
    chat_skills:            chat.distinct_skills_used_count ?? 0,
    chat_connectors:        chat.connectors_used_count ?? 0,
    cc_sessions:            core.distinct_session_count ?? 0,
    lines_of_code_added:    core.lines_of_code?.added_count ?? 0,
    lines_of_code_removed:  core.lines_of_code?.removed_count ?? 0,
    commits_by_claude_code: core.commit_count ?? 0,
    prs_by_claude_code:     core.pull_request_count ?? 0,
    edit_tool_accepted:          tool(tools.edit_tool).accepted,
    edit_tool_rejected:          tool(tools.edit_tool).rejected,
    multi_edit_tool_accepted:    tool(tools.multi_edit_tool).accepted,
    multi_edit_tool_rejected:    tool(tools.multi_edit_tool).rejected,
    write_tool_accepted:         tool(tools.write_tool).accepted,
    write_tool_rejected:         tool(tools.write_tool).rejected,
    notebook_edit_tool_accepted: tool(tools.notebook_edit_tool).accepted,
    notebook_edit_tool_rejected: tool(tools.notebook_edit_tool).rejected,
    web_search_count:       r.web_search_count ?? 0,
    cowork_sessions:        cowork.distinct_session_count ?? 0,
    cowork_messages:        cowork.message_count ?? 0,
    cowork_actions:         cowork.action_count ?? 0,
    cowork_dispatch_turns:  cowork.dispatch_turn_count ?? 0,
  }
}

export function flattenSkill(s) {
  return {
    skill_name: s.skill_name,
    distinct_users: s.distinct_user_count ?? 0,
    chat_uses: s.chat_metrics?.distinct_conversation_skill_used_count ?? 0,
    claude_code_uses: s.claude_code_metrics?.distinct_session_skill_used_count ?? 0,
    cowork_uses: s.cowork_metrics?.distinct_session_skill_used_count ?? 0,
  }
}

export function flattenConnector(c) {
  return {
    connector_name: c.connector_name,
    distinct_users: c.distinct_user_count ?? 0,
    chat_uses: c.chat_metrics?.distinct_conversation_connector_used_count ?? 0,
    claude_code_uses: c.claude_code_metrics?.distinct_session_connector_used_count ?? 0,
    cowork_uses: c.cowork_metrics?.distinct_session_connector_used_count ?? 0,
  }
}
