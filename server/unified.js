// Server-side twin of src/lib/unified.ts — Chat and Cowork unified
// (product `chat_cowork_unified`, 2026-10). Users on the unified experience
// report most chat activity in chat_cowork_unified_metrics.chat and Cowork
// sessions in .sessions INSTEAD of chat_metrics / cowork_metrics. Each
// activity is reported in one place, so per-user counters ADD across the
// blocks; distinct-user counts (DAU/WAU/MAU, distinct_user_count) never do.
// Pure + dependency-free (tests/server/test-unified.mjs).

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const chatMessagesOf = (rec) =>
  n(rec?.chat_metrics?.message_count) + n(rec?.chat_cowork_unified_metrics?.chat?.message_count)

// Cowork counters the /cost/efficiency productivity join reads.
export function coworkTotalsOf(rec) {
  const c = rec?.cowork_metrics
  const u = rec?.chat_cowork_unified_metrics?.sessions
  return {
    actions:    n(c?.action_count) + n(u?.action_count),
    file_edits: n(c?.file_edit_count) + n(u?.file_edit_count),
    sessions:   n(c?.distinct_session_count) + n(u?.distinct_session_count),
  }
}
