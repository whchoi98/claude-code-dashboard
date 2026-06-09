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
