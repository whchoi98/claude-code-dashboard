import type { ChatMetrics, CoworkMetrics, UserRecord, Skill, Connector, Plugin } from '../types'

// Chat and Cowork unified (product `chat_cowork_unified`, 2026-10). On
// deployments that offer it, most claude.ai chat and Cowork activity of a
// user on the unified experience is reported in
// chat_cowork_unified_metrics.{chat,sessions} INSTEAD of chat_metrics /
// cowork_metrics — usage moves, org totals don't change. Each activity is
// reported in one place, so per-user counters ADD across the blocks; the Chat
// and Cowork pages read the sums, or they would fall to zero as users migrate
// (org2 did in 2026-10). Distinct-USER counts (summaries DAU/WAU/MAU, rows'
// distinct_user_count) do NOT add — a user can be counted on both sides on a
// switch-over day — so those stay separate series.

// Plain counters: absent → 0.
const sum = (a?: number | null, b?: number | null) => (a ?? 0) + (b ?? 0)
// Feature-flag counters: null means "not reported for the org", never zero
// activity — the result stays null only when BOTH sides are null.
const sumNullable = (a?: number | null, b?: number | null): number | null =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0)

/** chat_metrics plus the unified experience's chat block. */
export function chatOf(r: UserRecord): ChatMetrics {
  const c = r.chat_metrics
  const u = r.chat_cowork_unified_metrics?.chat
  if (!u) return c
  return {
    distinct_conversation_count:      sum(c?.distinct_conversation_count, u.distinct_conversation_count),
    message_count:                    sum(c?.message_count, u.message_count),
    thinking_message_count:           sum(c?.thinking_message_count, u.thinking_message_count),
    distinct_projects_used_count:     sum(c?.distinct_projects_used_count, u.distinct_projects_used_count),
    distinct_projects_created_count:  sum(c?.distinct_projects_created_count, u.distinct_projects_created_count),
    distinct_artifacts_created_count: sum(c?.distinct_artifacts_created_count, u.distinct_artifacts_created_count),
    distinct_skills_used_count:       sum(c?.distinct_skills_used_count, u.distinct_skills_used_count),
    connectors_used_count:            sum(c?.connectors_used_count, u.connectors_used_count),
    distinct_files_uploaded_count:    sum(c?.distinct_files_uploaded_count, u.distinct_files_uploaded_count),
    shared_conversations_viewed_count: sum(c?.shared_conversations_viewed_count, u.shared_conversations_viewed_count),
    // Documented as always null upstream; keep whatever chat_metrics carried.
    distinct_shared_artifacts_viewed_count: c?.distinct_shared_artifacts_viewed_count,
  }
}

/** cowork_metrics plus the unified experience's sessions block. */
export function coworkOf(r: UserRecord): CoworkMetrics {
  const c = r.cowork_metrics
  const u = r.chat_cowork_unified_metrics?.sessions
  if (!u) return c
  return {
    distinct_session_count:         sum(c?.distinct_session_count, u.distinct_session_count),
    action_count:                   sum(c?.action_count, u.action_count),
    dispatch_turn_count:            sum(c?.dispatch_turn_count, u.dispatch_turn_count),
    message_count:                  sum(c?.message_count, u.message_count),
    file_edit_count:                sumNullable(c?.file_edit_count, u.file_edit_count),
    edit_tool_count:                sumNullable(c?.edit_tool_count, u.edit_tool_count),
    multi_edit_tool_count:          sumNullable(c?.multi_edit_tool_count, u.multi_edit_tool_count),
    write_tool_count:               sumNullable(c?.write_tool_count, u.write_tool_count),
    notebook_edit_tool_count:       sumNullable(c?.notebook_edit_tool_count, u.notebook_edit_tool_count),
    sessions_with_file_edits_count: sumNullable(c?.sessions_with_file_edits_count, u.sessions_with_file_edits_count),
    skills_used_count:              sum(c?.skills_used_count, u.skills_used_count),
    distinct_skills_used_count:     sum(c?.distinct_skills_used_count, u.distinct_skills_used_count),
    connectors_used_count:          sum(c?.connectors_used_count, u.connectors_used_count),
    distinct_connectors_used_count: sum(c?.distinct_connectors_used_count, u.distinct_connectors_used_count),
    plugins_used_count:             sumNullable(c?.plugins_used_count, u.plugins_used_count),
    distinct_plugins_used_count:    sumNullable(c?.distinct_plugins_used_count, u.distinct_plugins_used_count),
    artifacts_created_count:        sumNullable(c?.artifacts_created_count, u.artifacts_created_count),
  }
}

/** The unified share of one record's chat messages / Cowork sessions (for the "via unified" notes). */
export const unifiedChatMessages = (r: UserRecord) => r.chat_cowork_unified_metrics?.chat?.message_count ?? 0
export const unifiedSessions = (r: UserRecord) => r.chat_cowork_unified_metrics?.sessions?.distinct_session_count ?? 0

/** Per-surface uses for an adoption row: unified chat folds into Chat, unified sessions into Cowork. */
export function skillUses(s: Skill) {
  const u = s.chat_cowork_unified_metrics
  return {
    chat:   sum(s.chat_metrics?.distinct_conversation_skill_used_count, u?.chat?.distinct_conversation_skill_used_count),
    cowork: sum(s.cowork_metrics?.distinct_session_skill_used_count, u?.sessions?.distinct_session_skill_used_count),
  }
}

export function connectorUses(c: Connector) {
  const u = c.chat_cowork_unified_metrics
  return {
    chat:   sum(c.chat_metrics?.distinct_conversation_connector_used_count, u?.chat?.distinct_conversation_connector_used_count),
    cowork: sum(c.cowork_metrics?.distinct_session_connector_used_count, u?.sessions?.distinct_session_connector_used_count),
  }
}

export const pluginCoworkUses = (p: Plugin) =>
  sum(p.cowork_metrics?.distinct_session_plugin_used_count, p.chat_cowork_unified_metrics?.distinct_session_plugin_used_count)
