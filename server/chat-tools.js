// Pure, dependency-free helpers + tool registry for the /api/chat/stream
// tool-use chatbot. No AWS client instantiation here so this module is
// unit-testable in isolation (see tests/server/test-chat-tools.mjs).

export const MAX_TOOL_HOPS = 4
export const HISTORY_MAX_TURNS = 12
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// Percent-encoded variant (alice%40acme.com): compliance events record other
// clients' request url/request_body verbatim, where '@' arrives as %40 — a
// literal-@ regex lets those through. Mirrors src/pages/Compliance.tsx
// maskEmailsInText. Group-replace (keep 1-2 leading chars + separator+domain)
// because maskEmail() can't parse a %40 string (no literal '@').
const ENCODED_EMAIL_RE = /([A-Za-z0-9._+-]{1,2})[A-Za-z0-9._%+-]*(%40)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi

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
// results BEFORE they reach the model, so raw emails never enter the prompt —
// and on /api/archive/query rows before they reach the browser.
export function maskEmailsDeep(value) {
  if (typeof value === 'string') {
    return value
      .replace(EMAIL_RE, (m) => maskEmail(m))
      .replace(ENCODED_EMAIL_RE, '$1***$2$3')
  }
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

const ATHENA_SCHEMA_HINT_FOR_TOOL = `Athena database \`claude_code_analytics\`. Tables (partitioned by string \`date\` YYYY-MM-DD):
• claude_code_analytics (per-user-per-day): user_id, user_email, cc_sessions, lines_of_code_added, lines_of_code_removed, commits_by_claude_code, prs_by_claude_code, edit_tool_accepted, edit_tool_rejected, multi_edit_tool_accepted, multi_edit_tool_rejected, write_tool_accepted, write_tool_rejected, notebook_edit_tool_accepted, notebook_edit_tool_rejected, web_search_count, office_<surface>_<metric> (surface=excel|powerpoint|word|outlook; metric=sessions|messages|skills_used|distinct_skills|connectors_used|distinct_connectors), cowork_file_edit_count, cowork_edit_tool_count, cowork_multi_edit_tool_count, cowork_write_tool_count, cowork_notebook_edit_tool_count, cowork_sessions_with_file_edits_count (nullable), design_sessions, design_projects_used, design_projects_created, design_messages
• summaries_daily (org/day): date, daily_active_user_count, weekly_active_user_count, monthly_active_user_count, assigned_seat_count, pending_invite_count
• skills_daily: skill_name, distinct_users, chat_uses, claude_code_uses
• connectors_daily: connector_name, distinct_users, chat_uses, claude_code_uses
• projects_daily: project_id, project_name, distinct_user_count, distinct_conversation_count, message_count, created_at, created_by_id, created_by_email (created_by_* nullable)
• compliance_daily (audit events, partition day = event created_at day): id, type, created_at (ISO timestamp string), actor_type (user_actor|api_actor), actor_email, actor_user_id, actor_api_key_id, actor_ip_address, actor_user_agent, organization_id, payload (FULL original event as a JSON string — reach type-specific fields via json_extract_scalar(payload, '$.field')). Mask actor_email in any answer. compliance_daily is EVENT-TIME partitioned and current through YESTERDAY — the 3-day finalization rule below does NOT apply to it.
Partition column is varchar — do NOT wrap literals in DATE '...'. All values integers; rates are computed.`

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

export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'get_analytics_overview',
      description: 'Org-wide Claude Code adoption & productivity snapshot for the recent ~14-day window: daily/weekly/monthly active users, assigned seats, and the most-adopted skills and connectors. Use for "how are we doing overall" questions. Returns no per-user rows (use search_users or run_athena_sql for those) and no USD cost (use get_cost_summary).',
      inputSchema: { json: { type: 'object', properties: {}, additionalProperties: false } },
    },
  },
  {
    toolSpec: {
      name: 'run_athena_sql',
      description: `Run ONE read-only Athena SQL SELECT over the S3 archive for historical, time-series, or per-user questions beyond the live snapshot. Returns { columns, rows }. Emails in results are masked automatically.\n\n${ATHENA_SCHEMA_HINT_FOR_TOOL}`,
      inputSchema: {
        json: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'A single SELECT/WITH statement. Always filter the string `date` partition: WHERE date BETWEEN \'YYYY-MM-DD\' AND \'YYYY-MM-DD\'. Add ORDER BY + LIMIT.' } },
          required: ['sql'], additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_cost_summary',
      description: 'Org-wide spend in USD plus token totals, grouped by product and model, over a date range (defaults to the last ~31 days). There is NO per-user cost dimension in the live API (ADR-0003). Use for "where is the money going / spend by model" questions.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            starting_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
            ending_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          },
          additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'search_users',
      description: 'Top Claude Code contributors (or a lookup by email substring) for the recent snapshot day, ranked by lines of code + commits + PRs. Emails are masked. Use for "who are the most active users" questions.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional case-insensitive email substring filter.' },
            limit: { type: 'integer', description: 'Max rows (1-50, default 10).' },
          },
          additionalProperties: false,
        },
      },
    },
  },
]

export function CHAT_SYSTEM_PROMPT(locale, today) {
  const lang = locale === 'ko'
    ? '답변은 반드시 한국어로, 간결한 마크다운(필요 시 ## 헤더·`-` 목록·표)으로 작성하세요.'
    : 'Answer in clear English as concise Markdown (use ## headings, "-" lists, and GFM tables where they help).'
  return [
    'You are an enterprise analytics assistant for Claude Code Enterprise. This is a multi-turn conversation — use the prior turns for context.',
    'Use the provided tools to fetch real data before answering; never invent numbers. Cite exact figures and compute rates/growth explicitly.',
    'Pick the right tool: get_analytics_overview for org-level adoption; search_users for per-user rankings; run_athena_sql for historical/time-series/custom aggregations; get_cost_summary for USD spend.',
    'Data caveats to respect: a 3-day finalization buffer on the analytics tables, a 90-day live lookback, and no Bedrock usage in cost.',
    'PRIVACY: emails returned by tools are already masked (e.g. al*****@acme.com). Echo them exactly as given; never reconstruct or guess a full address. Do not escape the asterisks with backslashes.',
    `Today is ${today} (UTC). When writing Athena date filters on the analytics tables, end ranges no later than 3 days ago. EXCEPTION: compliance_daily is event-time partitioned and current through yesterday — end its ranges at yesterday.`,
    lang,
  ].join('\n')
}

// Build a tool dispatcher from injected async deps. Memoizes the analytics
// snapshot so overview + search_users in one turn share a single fetch.
export function makeToolRunner({ fetchAnalytics, runAthenaSafe, fetchCostSummary }) {
  let snapPromise = null
  const snap = () => (snapPromise ||= fetchAnalytics())
  return async function runTool(name, input = {}) {
    try {
      if (name === 'get_analytics_overview') {
        return { ok: true, data: compactOverview(await snap()) }
      }
      if (name === 'search_users') {
        const rows = rankUsers((await snap()).users_today, input)
        return { ok: true, data: { users: rows }, rowCount: rows.length }
      }
      if (name === 'run_athena_sql') {
        const { columns, rows } = await runAthenaSafe(String(input.sql || ''))
        const capped = rows.slice(0, 200)
        return { ok: true, data: maskEmailsDeep({ columns, rows: capped, row_count: rows.length }), rowCount: rows.length }
      }
      if (name === 'get_cost_summary') {
        // Allowlist the schema-declared fields — fetchCostSummary now also
        // accepts rbac_group_id (the /cost/live route shape-validates it),
        // and the model-controlled input must not reach that filter: this
        // tool's contract is unconditionally org-wide.
        const { starting_date, ending_date } = input || {}
        return { ok: true, data: maskEmailsDeep(await fetchCostSummary({ starting_date, ending_date })) }
      }
      return { ok: false, data: { error: `Unknown tool: ${name}` } }
    } catch (err) {
      return { ok: false, data: { error: err?.message || String(err) } }
    }
  }
}
