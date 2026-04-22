// Schemas mirror the live Claude Enterprise Analytics API shapes
// (verified against api.anthropic.com/v1/organizations/analytics/* in 2026-04).

export type Actor = { id: string; email_address: string }

export type ChatMetrics = {
  distinct_conversation_count: number
  message_count: number
  thinking_message_count: number
  distinct_projects_used_count: number
  distinct_projects_created_count: number
  distinct_artifacts_created_count: number
  distinct_skills_used_count: number
  connectors_used_count: number
  distinct_files_uploaded_count: number
  shared_conversations_viewed_count?: number
  distinct_shared_artifacts_viewed_count?: number
}

export type ToolAction = { accepted_count: number; rejected_count: number }

export type ClaudeCodeMetrics = {
  core_metrics: {
    distinct_session_count: number
    commit_count: number
    pull_request_count: number
    lines_of_code: { added_count: number; removed_count: number }
  }
  tool_actions: {
    edit_tool: ToolAction
    multi_edit_tool: ToolAction
    write_tool: ToolAction
    notebook_edit_tool: ToolAction
  }
}

export type OfficeAppMetrics = {
  distinct_session_count: number
  message_count: number
  skills_used_count: number
  distinct_skills_used_count: number
  connectors_used_count: number
  distinct_connectors_used_count: number
}

export type CoworkMetrics = {
  distinct_session_count: number
  action_count: number
  dispatch_turn_count: number
  message_count: number
  skills_used_count: number
  distinct_skills_used_count: number
  connectors_used_count: number
  distinct_connectors_used_count: number
}

export type UserRecord = {
  user: Actor
  chat_metrics: ChatMetrics
  claude_code_metrics: ClaudeCodeMetrics
  office_metrics: {
    excel: OfficeAppMetrics
    powerpoint: OfficeAppMetrics
    word?: OfficeAppMetrics
  }
  cowork_metrics: CoworkMetrics
  web_search_count: number
}

export type Summary = {
  starting_at: string
  ending_at: string
  daily_active_user_count: number
  weekly_active_user_count: number
  monthly_active_user_count: number
  cowork_daily_active_user_count: number
  cowork_weekly_active_user_count: number
  cowork_monthly_active_user_count: number
  assigned_seat_count: number
  pending_invite_count: number
  daily_adoption_rate: number
  weekly_adoption_rate: number
  monthly_adoption_rate: number
}

export type Skill = {
  skill_name: string
  distinct_user_count: number
  chat_metrics: { distinct_conversation_skill_used_count: number }
  claude_code_metrics: { distinct_session_skill_used_count: number }
  office_metrics: {
    excel: { distinct_session_skill_used_count: number }
    powerpoint: { distinct_session_skill_used_count: number }
    word?: { distinct_session_skill_used_count: number }
  }
  cowork_metrics: { distinct_session_skill_used_count: number }
}

export type Connector = {
  connector_name: string
  distinct_user_count: number
  chat_metrics: { distinct_conversation_connector_used_count: number }
  claude_code_metrics: { distinct_session_connector_used_count: number }
  office_metrics: {
    excel: { distinct_session_connector_used_count: number }
    powerpoint: { distinct_session_connector_used_count: number }
    word?: { distinct_session_connector_used_count: number }
  }
  cowork_metrics: { distinct_session_connector_used_count: number }
}

export type ChatProject = {
  project_id: string
  project_name: string
  distinct_user_count: number
  distinct_conversation_count: number
  message_count: number
  created_at: string
  created_by: Actor
}
