// Pure, dependency-free helpers + tool registry for the /api/chat/stream
// tool-use chatbot. No AWS client instantiation here so this module is
// unit-testable in isolation (see tests/server/test-chat-tools.mjs).

export const MAX_TOOL_HOPS = 4
export const HISTORY_MAX_TURNS = 12
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// Mirror of src/lib/format.ts maskEmail — keep the two in sync.
export function maskEmail(email) {
  if (!email) return ''
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return email
  return local.slice(0, 2) + '*'.repeat(Math.max(3, local.length - 2)) + domain
}

// Recursively mask any email-shaped string anywhere in a value. Used on tool
// results BEFORE they reach the model, so raw emails never enter the prompt.
export function maskEmailsDeep(value) {
  if (typeof value === 'string') return value.replace(EMAIL_RE, (m) => maskEmail(m))
  if (Array.isArray(value)) return value.map(maskEmailsDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = maskEmailsDeep(v)
    return out
  }
  return value
}

// Client sends [{role,text}]; build Bedrock messages[], dropping empty turns,
// capping to the last HISTORY_MAX_TURNS, and ensuring it does not start with
// an assistant turn (Bedrock requires the first message to be from the user).
export function historyToBedrockMessages(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-HISTORY_MAX_TURNS)
  while (turns.length && turns[0].role === 'assistant') turns.shift()
  return turns.map((t) => ({ role: t.role, content: [{ text: t.text }] }))
}

// Extract up to 3 follow-up questions. Prefer a JSON array (optionally fenced);
// fall back to numbered/bulleted question lines. Returns [] on anything unusable.
export function parseFollowups(text) {
  const raw = String(text || '')
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : raw
  const arrMatch = candidate.match(/\[[\s\S]*\]/)
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0])
      if (Array.isArray(arr)) {
        const out = arr.map((s) => String(s).trim()).filter(Boolean)
        if (out.length) return out.slice(0, 3)
      }
    } catch { /* fall through to line parsing */ }
  }
  const lines = raw.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.endsWith('?'))
  return lines.slice(0, 3)
}

const cc = (u) => u?.claude_code_metrics?.core_metrics || {}
const locTotal = (u) => (cc(u).lines_of_code?.added_count || 0) + (cc(u).lines_of_code?.removed_count || 0)
const userScore = (u) => locTotal(u) + (cc(u).commit_count || 0) * 20 + (cc(u).pull_request_count || 0) * 50

// Rank UserRecord[] by Claude Code activity, mask emails, return compact rows.
export function rankUsers(users, { query, limit = 10 } = {}) {
  const q = (query || '').toLowerCase().trim()
  const list = (Array.isArray(users) ? users : [])
    .filter((u) => !q || (u?.user?.email_address || '').toLowerCase().includes(q))
    .sort((a, b) => userScore(b) - userScore(a))
    .slice(0, Math.max(1, Math.min(50, limit)))
  return list.map((u) => {
    const ta = u?.claude_code_metrics?.tool_actions || {}
    const acc = Object.values(ta).reduce((s, t) => s + (t?.accepted_count || 0), 0)
    const rej = Object.values(ta).reduce((s, t) => s + (t?.rejected_count || 0), 0)
    return {
      email: maskEmail(u?.user?.email_address || ''),
      lines_of_code: locTotal(u),
      commits: cc(u).commit_count || 0,
      prs: cc(u).pull_request_count || 0,
      sessions: cc(u).distinct_session_count || 0,
      tool_acceptance_rate: acc + rej === 0 ? null : Number((acc / (acc + rej)).toFixed(3)),
    }
  })
}

// Strip the heavy per-user array from the snapshot to keep tokens low; keep the
// org summaries, seat counts, and top skills/connectors by reach.
export function compactOverview(snapshot) {
  const s = snapshot || {}
  const topBy = (arr, key) => (Array.isArray(arr) ? arr : [])
    .slice().sort((a, b) => (b.distinct_user_count || 0) - (a.distinct_user_count || 0))
    .slice(0, 10).map((x) => ({ [key]: x[key], distinct_user_count: x.distinct_user_count || 0 }))
  return {
    window: s.window,
    summaries: s.summaries || [],
    active_user_count: (s.users_today || []).length,
    top_skills: topBy(s.skills, 'skill_name'),
    top_connectors: topBy(s.connectors, 'connector_name'),
  }
}
