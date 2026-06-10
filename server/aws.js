import express from 'express'
import multer from 'multer'
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import {
  MAX_TOOL_HOPS, TOOL_SPECS, CHAT_SYSTEM_PROMPT, makeToolRunner,
  historyToBedrockMessages, parseFollowups,
} from './chat-tools.js'
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena'
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3'

// ─── Reshape: Analytics cost_report + usage_report → CsvResp shape ─────────
// Joins the two Anthropic Analytics endpoints
// /v1/organizations/analytics/cost_report   (USD spend + request counts)
// /v1/organizations/analytics/usage_report  (token counts)
// on (product, model) and emits the same payload shape /api/cost/csv produces
// so the frontend's row-driven aggregation logic works unchanged.
//
// IMPORTANT:
// - `amount` from cost_report is a DECIMAL STRING in MINOR currency units
//   (cents). Divide by 100 for USD; accumulate at toFixed(4) precision.
// - These endpoints do NOT expose a per-user dimension. Rows are emitted with
//   `user_email = ''` to signal "no user attribution available". The frontend
//   hides per-user widgets in live mode (see Cost.tsx `dataSource === 'csv'`
//   gating around the Top tables).
// - `requests` is real (not approximated like the prior claude_code endpoint).
export function analyticsReportsToCostResp(costBody, usageBody, period) {
  // key: `${product}|${model}` → row aggregate (cost + tokens merged on key)
  const acc = new Map()
  // key: `${date}|${model}` → daily series for the trends chart
  const dailyAcc = new Map()
  const distinctModels = new Set()
  const distinctProducts = new Set()

  // ── Pass 1: cost_report → spend + requests ─────────────────────────────
  for (const day of costBody?.data || []) {
    const date = (day?.starting_at || '').slice(0, 10)
    for (const r of day?.results || []) {
      const product = r?.product
      const model = r?.model
      // Skip un-grouped totals (when both null) — they'd double-count
      if (!product && !model) continue
      const cents = parseFloat(r?.amount ?? '0') || 0
      const usd = cents / 100
      const reqs = r?.requests ?? 0

      const key = `${product ?? ''}|${model ?? ''}`
      const u = acc.get(key) ?? {
        user_email: '', account_uuid: '',
        product: product ?? 'Other', model: model ?? 'unspecified',
        total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0,
        total_net_spend_usd: 0, total_gross_spend_usd: 0,
      }
      u.total_net_spend_usd   = Number((u.total_net_spend_usd + usd).toFixed(4))
      u.total_gross_spend_usd = u.total_net_spend_usd
      u.total_requests       += reqs
      acc.set(key, u)
      if (model) distinctModels.add(model)
      if (product) distinctProducts.add(product)

      if (model && date) {
        const dkey = `${date}|${model}`
        const d = dailyAcc.get(dkey) ?? { date, model, spend: 0, input: 0, output: 0, requests: 0 }
        d.spend    = Number((d.spend + usd).toFixed(4))
        d.requests += reqs
        dailyAcc.set(dkey, d)
      }
    }
  }

  // ── Pass 2: usage_report → input/output tokens (joined on (product,model)) ──
  for (const day of usageBody?.data || []) {
    const date = (day?.starting_at || '').slice(0, 10)
    for (const r of day?.results || []) {
      const product = r?.product
      const model = r?.model
      if (!product && !model) continue
      const cc = r?.cache_creation || {}
      const input = (r?.uncached_input_tokens ?? 0) +
                    (r?.cache_read_input_tokens ?? 0) +
                    (cc.ephemeral_1h_input_tokens ?? 0) +
                    (cc.ephemeral_5m_input_tokens ?? 0)
      const output = r?.output_tokens ?? 0

      const key = `${product ?? ''}|${model ?? ''}`
      const u = acc.get(key) ?? {
        user_email: '', account_uuid: '',
        product: product ?? 'Other', model: model ?? 'unspecified',
        total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0,
        total_net_spend_usd: 0, total_gross_spend_usd: 0,
      }
      u.total_prompt_tokens     += input
      u.total_completion_tokens += output
      acc.set(key, u)
      if (model) distinctModels.add(model)
      if (product) distinctProducts.add(product)

      if (model && date) {
        const dkey = `${date}|${model}`
        const d = dailyAcc.get(dkey) ?? { date, model, spend: 0, input: 0, output: 0, requests: 0 }
        d.input  += input
        d.output += output
        dailyAcc.set(dkey, d)
      }
    }
  }

  const rows = [...acc.values()]
  const daily = [...dailyAcc.values()].sort((a, b) =>
    a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date),
  )
  const sumSpend  = rows.reduce((s, r) => s + r.total_net_spend_usd, 0)
  const sumPrompt = rows.reduce((s, r) => s + r.total_prompt_tokens, 0)
  const sumCompl  = rows.reduce((s, r) => s + r.total_completion_tokens, 0)
  const sumReq    = rows.reduce((s, r) => s + r.total_requests, 0)

  return {
    source: 'live',
    file: null,
    last_modified: new Date().toISOString(),
    period,
    rows,
    daily,
    totals: {
      requests:           sumReq,
      prompt_tokens:      sumPrompt,
      completion_tokens:  sumCompl,
      net_spend_usd:      Number(sumSpend.toFixed(2)),
      gross_spend_usd:    Number(sumSpend.toFixed(2)),
      // distinct_users not derivable from these endpoints — frontend uses
      // CSV's per-user data when source === 'csv' and hides per-user widgets
      // when source === 'live'.
      distinct_users:     0,
      distinct_models:    distinctModels.size,
      distinct_products:  distinctProducts.size,
    },
  }
}

// Map a user_cost_report `data[]` array to the dashboard's per-user shape.
// amount/list_amount are decimal strings in fractional CENTS (same convention
// as cost_report) → /100 for USD. Emails are returned RAW for the email-keyed
// efficiency join; the frontend masks via maskEmail on render. api_actor rows
// (no email) are excluded — this endpoint is user-centric and emails are the
// join key.
export function userCostToUsers(data) {
  return (Array.isArray(data) ? data : [])
    .map((r) => {
      const a = r.actor || {}
      return {
        email: a.email || '',
        user_id: a.user_id || null,
        name: a.name || null,
        deleted: !!a.deleted,
        net_spend_usd: parseFloat(r.amount || '0') / 100,
        gross_spend_usd: parseFloat(r.list_amount || r.amount || '0') / 100,
        requests: Number(r.requests || 0),
      }
    })
    .filter((u) => u.email)
}

// ─── Athena SQL Sanitizer (defense in depth) ────────────────────────────────
// Athena's IAM policy already restricts this task to the ccd workgroup, and
// CDK grants glue:GetTable only on the ccd database. Even so, a naive regex
// check on the `query` body lets an attacker:
//   - chain a DDL after a semicolon (even if Athena rejects, UI errors leak)
//   - hide intent inside block/line comments
//   - read unlisted tables the Glue catalog would happily expose
//
// sanitizeAthenaQuery enforces:
//   1. Strip `--` line and `/* */` block comments, then reject any remaining `;`.
//   2. Must start with SELECT or WITH (AST-shape guard).
//   3. Reject any forbidden keyword anywhere in the cleaned body.
//   4. Every FROM/JOIN target must be in ALLOWED_TABLES.
//
// Throws Error with a user-friendly `message` on any violation; callers
// should translate to HTTP 400.
const ATHENA_ALLOWED_TABLES = new Set([
  'claude_code_analytics',
  'summaries_daily',
  'skills_daily',
  'connectors_daily',
])
const ATHENA_FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|CALL|EXECUTE|EXEC|MSCK|REPAIR|USE|COPY|UNLOAD|DESCRIBE|SHOW|EXPLAIN|INTO\s+OUTFILE|LOAD\s+DATA)\b/i

export function sanitizeAthenaQuery(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Query must be a non-empty string.')
  }

  // 1) Strip comments (do this BEFORE semicolon check so "SELECT 1 -- ; DROP" is caught)
  const stripped = raw
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()

  // 2) Collapse a single trailing semicolon, reject any other
  const normalized = stripped.replace(/;\s*$/, '')
  if (/;/.test(normalized)) {
    throw new Error('Multi-statement queries are not allowed. Remove intermediate semicolons.')
  }

  // 3) Must start with SELECT or WITH
  if (!/^\s*(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error('Only SELECT or WITH...SELECT statements are permitted.')
  }

  // 4) Reject forbidden keywords anywhere in the body
  const forbiddenMatch = normalized.match(ATHENA_FORBIDDEN_KEYWORDS)
  if (forbiddenMatch) {
    throw new Error(`Forbidden SQL keyword: "${forbiddenMatch[0]}". This endpoint is read-only over the approved tables.`)
  }

  // 5) Collect CTE (WITH name AS (...)) aliases — they are local and should
  //    satisfy the allowlist check for any subsequent FROM/JOIN reference.
  const cteNames = new Set()
  if (/^\s*WITH\b/i.test(normalized)) {
    for (const m of normalized.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi)) {
      cteNames.add(m[1].toLowerCase())
    }
  }

  // 6) Every FROM/JOIN target must be in ATHENA_ALLOWED_TABLES or in cteNames.
  //    Schema-qualified (db.table) falls back to the final identifier. A
  //    subquery like `FROM (SELECT ...)` has no identifier immediately after
  //    FROM and is therefore NOT captured — but any inner FROM inside that
  //    subquery IS captured by matchAll() and checked independently.
  const tableRefs = [...normalized.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_."]*)/gi)]
    .map((m) => m[1].replace(/"/g, '').split('.').pop().toLowerCase())
    .filter(Boolean)

  if (tableRefs.length === 0) {
    throw new Error('Query must reference at least one FROM/JOIN table.')
  }
  for (const t of tableRefs) {
    if (!ATHENA_ALLOWED_TABLES.has(t) && !cteNames.has(t)) {
      throw new Error(
        `Table not allowed: "${t}". Permitted tables: ${[...ATHENA_ALLOWED_TABLES].join(', ')}.`,
      )
    }
  }

  return normalized
}

const ATHENA_SCHEMA_HINT = `
Available Athena database: \`claude_code_analytics\`
Tables (all partitioned by string \`date\` in YYYY-MM-DD, projection enabled from 2026-01-01):

• claude_code_analytics (per-user-per-day, one row per active user):
  user_id, user_email, chat_conversations, chat_messages, chat_thinking_messages,
  chat_files_uploaded, chat_artifacts, chat_skills, chat_connectors,
  cc_sessions, lines_of_code_added, lines_of_code_removed,
  commits_by_claude_code, prs_by_claude_code,
  edit_tool_accepted, edit_tool_rejected,
  multi_edit_tool_accepted, multi_edit_tool_rejected,
  write_tool_accepted, write_tool_rejected,
  notebook_edit_tool_accepted, notebook_edit_tool_rejected,
  web_search_count,
  cowork_sessions, cowork_messages, cowork_actions, cowork_dispatch_turns

• summaries_daily (one row per day, org-wide):
  date, daily_active_user_count, weekly_active_user_count, monthly_active_user_count,
  assigned_seat_count, pending_invite_count,
  cowork_daily_active_user_count, cowork_weekly_active_user_count, cowork_monthly_active_user_count

• skills_daily:   skill_name, distinct_users, chat_uses, claude_code_uses, cowork_uses
• connectors_daily: connector_name, distinct_users, chat_uses, claude_code_uses, cowork_uses

Always filter by partition: WHERE date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.
The partition column is varchar — do NOT wrap the literals in DATE '...';
Athena will throw TYPE_MISMATCH because Trino won't auto-cast varchar to date.
All values are integers; rates are computed, not stored.
`.trim()

// maskEmailSrv duplicates the helper in chat-tools.js intentionally — keeps this
// client-echo path free of a chat-tools.js import and avoids a circular concern.
// Trim + mask tool-call inputs echoed to the client (SQL truncated, emails masked).
function redactToolInput(input) {
  const out = {}
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmailSrv(m))
      if (out[k].length > 280) out[k] = out[k].slice(0, 280) + '…'
    } else out[k] = v
  }
  return out
}
function maskEmailSrv(e) { const at = e.lastIndexOf('@'); if (at < 1) return e; const l = e.slice(0, at); return l.length <= 2 ? e : l.slice(0, 2) + '*'.repeat(Math.max(3, l.length - 2)) + e.slice(at) }

export function registerAwsRoutes(app, { fetchAnalytics }) {
  const REGION = process.env.AWS_REGION || 'us-east-1'
  const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6'

  const bedrock = new BedrockRuntimeClient({ region: REGION })
  const athena = new AthenaClient({ region: REGION })
  const s3 = new S3Client({ region: REGION })

  const router = express.Router()

  // ── Helpers ──────────────────────────────────────────────────────────────
  async function runAthena(query) {
    const WG = process.env.ATHENA_WORKGROUP
    const DB = process.env.ATHENA_DATABASE
    const OUT = process.env.ATHENA_OUTPUT_LOCATION
    if (!WG || !DB || !OUT) throw new Error('Athena env not configured')

    const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: WG,
      QueryExecutionContext: { Database: DB },
      ResultConfiguration: { OutputLocation: OUT },
    }))
    // 60s budget — 30-day partition scans regularly take 10–30 s on the
    // shared workgroup. The previous 20 s ceiling silently fell through to
    // GetQueryResultsCommand on a still-RUNNING query, which surfaced as a
    // generic athena_error. Now we wait longer and throw a clear timeout
    // error if the query is still in flight.
    let finalState = null
    for (let i = 0; i < 120; i++) {
      const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }))
      const state = QueryExecution?.Status?.State
      if (state === 'SUCCEEDED') { finalState = state; break }
      if (state === 'FAILED' || state === 'CANCELLED') {
        throw new Error(`Athena ${state}: ${QueryExecution?.Status?.StateChangeReason || 'query failed'}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (finalState !== 'SUCCEEDED') {
      throw new Error(`Athena query did not finish within 60 s (id=${QueryExecutionId}). Try a narrower date range.`)
    }
    const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId, MaxResults: 500 }))
    const raw = results.ResultSet?.Rows ?? []
    if (raw.length === 0) return { columns: [], rows: [] }
    const columns = raw[0].Data?.map((d) => d.VarCharValue || '') ?? []
    const rows = raw.slice(1).map((r) => {
      const out = {}
      r.Data?.forEach((d, i) => { out[columns[i]] = d.VarCharValue ?? null })
      return out
    })
    return { columns, rows }
  }

  function sseInit(res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
  }
  function sseSend(res, event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Execute an Athena SQL that has already passed sanitizeAthenaQuery.
  async function runAthenaSafe(rawQuery) {
    const safe = sanitizeAthenaQuery(rawQuery)
    return runAthena(safe)
  }

  // Fetch + reshape org cost (used by GET /cost/live and the chat cost tool).
  async function fetchCostSummary({ starting_date, ending_date } = {}) {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) {
      const e = new Error('ANTHROPIC_ANALYTICS_KEY (sk-ant-api01-...) is required for live cost data.')
      e.code = 'analytics_key_required'
      throw e
    }
    const today = new Date()
    const minus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
    const startingDate = starting_date || minus(31)
    const endingDate = ending_date || minus(0)
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const buildUrl = (p) => {
      const params = new URLSearchParams({ starting_at: `${startingDate}T00:00:00Z`, ending_at: `${endingDate}T00:00:00Z`, bucket_width: '1d' })
      params.append('group_by[]', 'product'); params.append('group_by[]', 'model')
      return `${apiUrl}${p}?${params.toString()}`
    }
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }
    const [costRes, usageRes] = await Promise.all([
      fetch(buildUrl('/v1/organizations/analytics/cost_report'), { headers }),
      fetch(buildUrl('/v1/organizations/analytics/usage_report'), { headers }),
    ])
    const costBody = await costRes.json().catch(() => ({}))
    const usageBody = await usageRes.json().catch(() => ({}))
    if (!costRes.ok) {
      const e = new Error(`cost_report ${costRes.status}`)
      e.code = 'upstream_error'; e.upstream = costBody
      throw e
    }
    if (!usageRes.ok) {
      const e = new Error(`usage_report ${usageRes.status}`)
      e.code = 'upstream_error'; e.upstream = usageBody
      throw e
    }
    return analyticsReportsToCostResp(costBody, usageBody, { starting_date: startingDate, ending_date: endingDate })
  }

  // Paginate user_cost_report for [starting, ending] and return RAW merged
  // data[] (emails unmasked — needed for the email-keyed efficiency join;
  // the frontend masks on render). Caps pages to stay within the 60/min budget.
  async function fetchUserCostReport({ starting_date, ending_date } = {}) {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) { const e = new Error('ANTHROPIC_ANALYTICS_KEY is required for per-user cost.'); e.code = 'analytics_key_required'; throw e }
    // Clamp ending to today-3 (Analytics 3-day buffer); default to a 31-day window.
    const today = new Date()
    const minus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
    const maxEnd = minus(3)
    let ending = ending_date || maxEnd
    if (ending > maxEnd) ending = maxEnd
    const starting = starting_date || minus(34)
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }

    const all = []
    let page = null
    let refreshedAt = null
    const MAX_PAGES = 50
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({ starting_at: `${starting}T00:00:00Z`, ending_at: `${ending}T00:00:00Z`, limit: '1000' })
      if (page) params.set('page', page)
      const res = await fetch(`${apiUrl}/v1/organizations/analytics/user_cost_report?${params.toString()}`, { headers })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { const e = new Error(`user_cost_report ${res.status}`); e.code = 'upstream_error'; e.upstream = body; throw e }
      if (Array.isArray(body.data)) all.push(...body.data)
      refreshedAt = body.data_refreshed_at ?? refreshedAt
      if (!body.has_more || !body.next_page) break
      page = body.next_page
      if (i === MAX_PAGES - 1) console.warn(`[cost/users] hit ${MAX_PAGES}-page cap; results truncated`)
    }
    return { data: all, period: { starting_date: starting, ending_date: ending }, data_refreshed_at: refreshedAt }
  }

  async function generateFollowups(userMsg, answer, locale) {
    const langName = locale === 'ko' ? 'Korean' : 'English'
    const prompt = [
      'Given this analytics Q&A, propose exactly 3 short, specific follow-up questions a user would naturally ask next.',
      `Write them in ${langName}. Reference concrete entities (model names, metrics, time windows) where possible.`,
      'Return ONLY a JSON array of 3 strings, nothing else.',
      '', `QUESTION: ${userMsg}`, '', `ANSWER: ${answer.slice(0, 2000)}`,
    ].join('\n')
    try {
      const out = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0.4 },
      }))
      const text = out.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') || ''
      return parseFollowups(text)
    } catch { return [] }
  }

  // ── /api/chat/stream — multi-turn tool-use chatbot (SSE) ──────────────────
  router.post('/chat/stream', async (req, res) => {
    const { message, history = [], locale = 'en' } = req.body || {}
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }
    sseInit(res)
    const runTool = makeToolRunner({ fetchAnalytics, runAthenaSafe, fetchCostSummary })
    const today = new Date().toISOString().slice(0, 10)
    const messages = historyToBedrockMessages(history)
    messages.push({ role: 'user', content: [{ text: message }] })

    let finalText = ''
    try {
      let stopReason = null
      let hop = 0
      for (; hop <= MAX_TOOL_HOPS; hop++) {
        const stream = await bedrock.send(new ConverseStreamCommand({
          modelId: MODEL_ID,
          system: [{ text: CHAT_SYSTEM_PROMPT(locale, today) }],
          messages,
          toolConfig: { tools: TOOL_SPECS },
          inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
        }))

        // Reconstruct assistant content blocks (text + toolUse) from the stream.
        const blocks = []          // index → { type, text } | { type:'tool', toolUseId, name, json }
        for await (const ev of stream.stream) {
          const i = ev.contentBlockStart?.contentBlockIndex ?? ev.contentBlockDelta?.contentBlockIndex
          if (ev.contentBlockStart?.start?.toolUse) {
            const { toolUseId, name } = ev.contentBlockStart.start.toolUse
            blocks[i] = { type: 'tool', toolUseId, name, json: '' }
          }
          if (ev.contentBlockDelta?.delta?.text) {
            const t = ev.contentBlockDelta.delta.text
            if (!blocks[i]) blocks[i] = { type: 'text', text: '' }
            blocks[i].text += t
            finalText += t
            sseSend(res, 'text', { text: t })
          }
          if (ev.contentBlockDelta?.delta?.toolUse?.input != null) {
            blocks[i].json += ev.contentBlockDelta.delta.toolUse.input
          }
          if (ev.messageStop) stopReason = ev.messageStop.stopReason
        }

        const assistantContent = blocks.filter(Boolean).map((b) =>
          b.type === 'text'
            ? { text: b.text }
            : { toolUse: { toolUseId: b.toolUseId, name: b.name, input: b.json ? JSON.parse(b.json) : {} } })
        messages.push({ role: 'assistant', content: assistantContent })

        if (stopReason !== 'tool_use') break
        // At the hop limit we stop without dispatching the pending toolUse. The
        // assistant turn with unresolved toolUse stays in this request's local
        // `messages` array, which is then discarded — client history only ever
        // resends {role,text} pairs, so this is never replayed to Bedrock.
        if (hop === MAX_TOOL_HOPS) {
          sseSend(res, 'status', { message: locale === 'ko' ? '도구 호출 한도에 도달해 현재까지의 답변으로 마무리합니다.' : 'Tool-call limit reached; finishing with the answer so far.' })
          break
        }

        const toolUses = blocks.filter((b) => b && b.type === 'tool')
        const toolResults = []
        for (const tu of toolUses) {
          const input = tu.json ? JSON.parse(tu.json) : {}
          sseSend(res, 'tool_call', { id: tu.toolUseId, name: tu.name, input: redactToolInput(input) })
          const out = await runTool(tu.name, input)
          sseSend(res, 'tool_result', { id: tu.toolUseId, name: tu.name, ok: out.ok, rowCount: out.rowCount ?? null })
          toolResults.push({ toolResult: {
            toolUseId: tu.toolUseId,
            content: [{ json: out.data }],
            status: out.ok ? 'success' : 'error',
          } })
        }
        messages.push({ role: 'user', content: toolResults })
      }

      const followups = await generateFollowups(message, finalText, locale)
      sseSend(res, 'followups', { suggestions: followups })
      sseSend(res, 'done', { ok: true, modelId: MODEL_ID, hops: hop })
    } catch (err) {
      sseSend(res, 'error', {
        message: err?.message || String(err),
        hint: 'Ensure the ECS task role has bedrock:InvokeModelWithResponseStream + athena/s3 for run_athena_sql.',
      })
    } finally {
      res.end()
    }
  })

  // ── /api/archive/query — sanitized synchronous Athena SELECT ────────────
  // Defence in depth against SQL injection: sanitizer rejects multi-statement,
  // forbidden keywords, and any table not in the explicit allowlist. Athena IAM
  // policy restricts the task role further, but we never rely on IAM alone —
  // a bad query still leaks intent via error messages.
  router.post('/archive/query', async (req, res) => {
    const { query } = req.body || {}
    try {
      const { rows } = await runAthenaSafe(query)
      res.json({ rows })
    } catch (err) {
      // sanitizeAthenaQuery throws Error with a helpful message — surface as 400.
      const msg = err?.message || String(err)
      const isValidation =
        msg.startsWith('Query must') ||
        msg.startsWith('Multi-statement') ||
        msg.startsWith('Only SELECT') ||
        msg.startsWith('Forbidden') ||
        msg.startsWith('Table not allowed')
      if (isValidation) {
        return res.status(400).json({ error: 'query_rejected', message: msg })
      }
      res.status(500).json({ error: 'athena_error', message: msg })
    }
  })

  // ── CSV Spend Report (from S3) ──────────────────────────────────────────
  // Returns the latest spend-report CSV from s3://<archive>/spend-reports/
  // parsed into a structured JSON with aggregations.
  router.get('/cost/csv', async (_req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    try {
      // List objects under spend-reports/ and pick the latest by LastModified
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'spend-reports/',
      }))
      const objects = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
      if (objects.length === 0) {
        return res.status(404).json({
          error: 'no_spend_report',
          message: `Upload a CSV to s3://${BUCKET}/spend-reports/`,
        })
      }
      const latest = objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      const { rows, columns } = parseCsv(body)

      // Normalize numeric fields
      const records = rows.map((r) => ({
        user_email:              r.user_email,
        account_uuid:            r.account_uuid,
        product:                 r.product,
        model:                   r.model,
        total_requests:          Number(r.total_requests || 0),
        total_prompt_tokens:     Number(r.total_prompt_tokens || 0),
        total_completion_tokens: Number(r.total_completion_tokens || 0),
        total_net_spend_usd:     Number(r.total_net_spend_usd || 0),
        total_gross_spend_usd:   Number(r.total_gross_spend_usd || 0),
      }))

      // Derive period from filename like spend-report-2026-04-01-to-2026-04-21.csv
      const name = latest.Key.split('/').pop() || ''
      const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
      const period = m ? { starting_date: m[1], ending_date: m[2] } : null

      res.json({
        source: 'csv',
        file: name,
        size_bytes: latest.Size,
        last_modified: latest.LastModified,
        period,
        columns,
        rows: records,
        totals: {
          requests:          records.reduce((s, r) => s + r.total_requests, 0),
          prompt_tokens:     records.reduce((s, r) => s + r.total_prompt_tokens, 0),
          completion_tokens: records.reduce((s, r) => s + r.total_completion_tokens, 0),
          net_spend_usd:     Number(records.reduce((s, r) => s + r.total_net_spend_usd, 0).toFixed(2)),
          gross_spend_usd:   Number(records.reduce((s, r) => s + r.total_gross_spend_usd, 0).toFixed(2)),
          distinct_users:    new Set(records.map((r) => r.user_email)).size,
          distinct_models:   new Set(records.map((r) => r.model)).size,
          distinct_products: new Set(records.map((r) => r.product)).size,
        },
      })
    } catch (err) {
      res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
    }
  })

  // GET /api/cost/live?starting_date=YYYY-MM-DD&ending_date=YYYY-MM-DD
  //
  // Delegates to fetchCostSummary() which calls the Analytics API endpoints
  // (cost_report + usage_report) and reshapes them into CsvResp shape.
  // Errors:
  //   400 analytics_key_required    → ANTHROPIC_ANALYTICS_KEY missing
  //   502 upstream_error            → either upstream endpoint returned non-2xx
  //   200 source=live, rows=[]      → empty period (UI handles → CSV fallback)
  router.get('/cost/live', async (req, res) => {
    try {
      const out = await fetchCostSummary({ starting_date: req.query.starting_date, ending_date: req.query.ending_date })
      res.json(out)
    } catch (err) {
      if (err?.code === 'analytics_key_required') {
        return res.status(400).json({ error: 'analytics_key_required', message: err.message })
      }
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err), upstream: err?.upstream })
    }
  })

  // GET /api/cost/users — per-user USD spend (user_cost_report), sorted by spend.
  // Raw emails; the frontend masks via maskEmail. No per-user token counts exist
  // in this endpoint (cost + requests only).
  router.get('/cost/users', async (req, res) => {
    try {
      const { data, period, data_refreshed_at } = await fetchUserCostReport({
        starting_date: req.query.starting_date, ending_date: req.query.ending_date,
      })
      const users = userCostToUsers(data).sort((a, b) => b.net_spend_usd - a.net_spend_usd)
      res.json({ source: 'live', period, data_refreshed_at, users })
    } catch (err) {
      if (err?.code === 'analytics_key_required') {
        return res.status(400).json({ error: 'analytics_key_required', message: err.message })
      }
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err), upstream: err?.upstream })
    }
  })

  // ── CSV Spend Report Uploads (management) ───────────────────────────────
  // Lets authenticated dashboard users upload / list / delete Spend Report
  // CSVs without needing AWS CLI access. All requests already pass through
  // Cognito (Lambda@Edge), so anyone reaching these endpoints is authorized.

  // 25 MB covers ~20k rows (several years of a mid-size org's activity).
  // Anthropic's actual export for 300 users × 30 days is ~1 MB, so this is
  // generous. Raising further would require matching tweaks to ALB/CloudFront.
  const CSV_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CSV_UPLOAD_LIMIT_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const okMime = /csv|excel|octet-stream|plain/i.test(file.mimetype || '')
      const okExt  = /\.csv$/i.test(file.originalname || '')
      if (okMime || okExt) return cb(null, true)
      cb(new Error('Only .csv files are accepted.'))
    },
  })

  // Multer error handler — multer emits errors via `next(err)` and without an
  // explicit JSON handler Express falls back to its default HTML 500 page.
  // That is exactly the "Unexpected token '<'" JSON-parse failure users see
  // in the browser. Wrap multer so *every* failure path returns JSON.
  function uploadSingle(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next()
      const status =
        err.code === 'LIMIT_FILE_SIZE' ? 413 :
        err.code === 'LIMIT_UNEXPECTED_FILE' ? 400 :
        err.code === 'LIMIT_FILE_COUNT' ? 400 : 400
      res.status(status).json({
        error: err.code || 'multer_error',
        message: err.message || 'Upload failed.',
      })
    })
  }

  // Columns the existing /cost/csv + /cost/efficiency pipelines depend on.
  const REQUIRED_CSV_COLUMNS = [
    'user_email', 'product', 'model',
    'total_requests', 'total_prompt_tokens', 'total_completion_tokens',
    'total_net_spend_usd',
  ]

  // Sanitize filename:
  //   - accept `spend-report-YYYY-MM-DD-to-YYYY-MM-DD.csv` (our canonical form)
  //   - also accept `spend-report--YYYY-...` (Anthropic Console's actual export
  //     inserts an empty segment between "report" and the date, producing a
  //     double dash). We preserve the period in this case.
  //   - anything else: derive a safe name from today's date.
  function safeSpendReportKey(originalName) {
    const base = String(originalName || '').split(/[/\\]/).pop() || ''
    // One-or-more dashes between "report" and the first date.
    if (/^spend-report-+\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/i.test(base)) {
      return `spend-reports/${base}`
    }
    const d = new Date().toISOString().slice(0, 10)
    return `spend-reports/spend-report-${d}-uploaded.csv`
  }

  // POST /api/cost/upload (multipart, field name "file")
  router.post('/cost/upload', uploadSingle, async (req, res) => {
    // Diagnostic: confirms the request reached the container. Seen in CW logs.
    console.log(`[cost/upload] received: file=${req.file?.originalname ?? '(none)'} size=${req.file?.size ?? 0}`)
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Attach a CSV file under field name "file".' })

    try {
      const body = req.file.buffer.toString('utf8')
      const { rows, columns } = parseCsv(body)
      const missing = REQUIRED_CSV_COLUMNS.filter((c) => !columns.includes(c))
      if (missing.length) {
        return res.status(400).json({
          error: 'schema_mismatch',
          message: `CSV is missing required columns: ${missing.join(', ')}`,
          expected: REQUIRED_CSV_COLUMNS,
          found: columns,
        })
      }
      if (rows.length === 0) {
        return res.status(400).json({ error: 'empty_csv', message: 'CSV has no data rows.' })
      }

      const key = safeSpendReportKey(req.file.originalname)
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: 'text/csv',
        Metadata: { uploadedVia: 'dashboard', originalName: req.file.originalname.slice(0, 250) },
      }))

      const m = key.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
      res.json({
        ok: true,
        file: key.split('/').pop(),
        key,
        size_bytes: req.file.size,
        rows: rows.length,
        distinct_users: new Set(rows.map((r) => r.user_email)).size,
        period: m ? { starting_date: m[1], ending_date: m[2] } : null,
      })
    } catch (err) {
      console.error('[cost/upload] error:', err?.message || err)
      res.status(500).json({ error: 'upload_failed', message: err?.message || String(err) })
    }
  })

  // GET /api/cost/uploads — list all spend-report CSVs with parsed period.
  router.get('/cost/uploads', async (_req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'spend-reports/' }))
      const items = (list.Contents || [])
        .filter((o) => o.Key?.endsWith('.csv'))
        .map((o) => {
          const name = o.Key.split('/').pop()
          const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
          return {
            file: name,
            key: o.Key,
            size_bytes: o.Size,
            last_modified: o.LastModified,
            period: m ? { starting_date: m[1], ending_date: m[2] } : null,
          }
        })
        .sort((a, b) => (b.last_modified?.getTime?.() ?? 0) - (a.last_modified?.getTime?.() ?? 0))
      res.json({ count: items.length, items })
    } catch (err) {
      res.status(500).json({ error: 's3_list_failed', message: err?.message || String(err) })
    }
  })

  // DELETE /api/cost/uploads/:file — remove a single CSV from spend-reports/.
  router.delete('/cost/uploads/:file', async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    const file = String(req.params.file || '')
    // Reject path traversal or any filename that isn't a plain CSV.
    if (!/^[A-Za-z0-9._-]+\.csv$/i.test(file)) {
      return res.status(400).json({ error: 'bad_filename', message: 'Filename must match [A-Za-z0-9._-]+.csv' })
    }
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `spend-reports/${file}` }))
      res.json({ ok: true, deleted: file })
    } catch (err) {
      res.status(500).json({ error: 'delete_failed', message: err?.message || String(err) })
    }
  })

  // ── Economic Productivity (CSV spend × Analytics API productivity join) ──
  // Joins the uploaded Spend Report CSV (per-user spend/tokens) with the live
  // Analytics API users/range (per-user LOC, commits, PRs, tool acceptance),
  // then computes cost-efficiency metrics per user.
  router.get('/cost/efficiency', async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })

    // 1) Pull the latest spend CSV
    let csvRows = []
    let csvPeriod = null
    try {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: 'spend-reports/',
      }))
      const objs = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
      if (objs.length === 0) {
        return res.status(404).json({
          error: 'no_spend_report',
          message: 'Upload a Claude Console Spend Report CSV first.',
        })
      }
      const latest = objs.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const name = latest.Key.split('/').pop() || ''
      const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
      csvPeriod = m ? { starting_date: m[1], ending_date: m[2] } : null
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      csvRows = parseCsv(body).rows
    } catch (err) {
      return res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
    }

    // 2) Aggregate CSV by user
    const bySpendUser = new Map()
    for (const r of csvRows) {
      const u = bySpendUser.get(r.user_email) ?? {
        spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0,
        models: new Set(), products: new Set(),
      }
      u.spend            += Number(r.total_net_spend_usd || 0)
      u.prompt_tokens    += Number(r.total_prompt_tokens || 0)
      u.completion_tokens+= Number(r.total_completion_tokens || 0)
      u.requests         += Number(r.total_requests || 0)
      u.models.add(r.model)
      u.products.add(r.product)
      bySpendUser.set(r.user_email, u)
    }

    // 3) Pull matching Analytics productivity via server self-call.
    //    Clamp ending date to today - 3 (Analytics API buffer) so we don't
    //    trigger mock fallbacks on very recent days that aren't yet aggregated.
    const today = new Date()
    today.setUTCDate(today.getUTCDate() - 3)
    const maxEnd = today.toISOString().slice(0, 10)
    const starting = req.query.starting_date || csvPeriod?.starting_date
    let   ending   = req.query.ending_date   || csvPeriod?.ending_date
    if (ending && ending > maxEnd) ending = maxEnd
    const PORT = Number(process.env.PORT) || 5174
    const rangeResp = await fetch(
      `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${starting}&ending_date=${ending}`,
    ).then((r) => r.json()).catch(() => ({ days: [] }))

    // 3a) Activity-weighted scaling support: also fetch analytics over the
    //     CSV's full period to compute each user's total activity in CSV
    //     scope. The CSV gives us TOTAL spend per user across the CSV
    //     period — to derive per-user spend within the requested sub-range
    //     we need a denominator. Sessions per user is the activity proxy.
    //     Fetch only if (a) CSV period exists and (b) it differs from the
    //     selected range (otherwise the ratio is trivially 1.0 and we skip
    //     the round trip).
    const sessionsByUserInCsvPeriod = new Map()
    const csvPeriodStart = csvPeriod?.starting_date
    let   csvPeriodEnd   = csvPeriod?.ending_date
    if (csvPeriodEnd && csvPeriodEnd > maxEnd) csvPeriodEnd = maxEnd
    const sameRange = csvPeriodStart === starting && csvPeriodEnd === ending
    const csvAnalyticsResp = (csvPeriodStart && csvPeriodEnd && !sameRange)
      ? await fetch(
          `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${csvPeriodStart}&ending_date=${csvPeriodEnd}`,
        ).then((r) => r.json()).catch(() => ({ days: [] }))
      : { days: rangeResp.days || [] }
    for (const d of csvAnalyticsResp.days || []) {
      if (d.source === 'mock') continue
      for (const rec of d.data || []) {
        const sess = rec.claude_code_metrics?.core_metrics?.distinct_session_count ?? 0
        const email = rec.user?.email_address
        if (!email) continue
        sessionsByUserInCsvPeriod.set(email, (sessionsByUserInCsvPeriod.get(email) ?? 0) + sess)
      }
    }

    // 4) Aggregate productivity per user. Skip mock-fallback days so bogus
    //    @acme.com records from the mock generator never contaminate results.
    const byProdUser = new Map()
    for (const d of rangeResp.days || []) {
      if (d.source === 'mock') continue
      for (const rec of d.data || []) {
        const cc   = rec.claude_code_metrics?.core_metrics
        const ta   = rec.claude_code_metrics?.tool_actions
        if (!cc) continue
        const email = rec.user?.email_address
        if (!email) continue
        const u = byProdUser.get(email) ?? {
          sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0,
          accepted: 0, rejected: 0, messages: 0, active_days: 0,
        }
        if (cc.distinct_session_count > 0 || rec.chat_metrics?.message_count > 0) u.active_days += 1
        u.sessions   += cc.distinct_session_count ?? 0
        u.loc_added  += cc.lines_of_code?.added_count ?? 0
        u.loc_removed+= cc.lines_of_code?.removed_count ?? 0
        u.commits    += cc.commit_count ?? 0
        u.prs        += cc.pull_request_count ?? 0
        u.messages   += rec.chat_metrics?.message_count ?? 0
        u.accepted   += (ta?.edit_tool?.accepted_count ?? 0) + (ta?.multi_edit_tool?.accepted_count ?? 0) +
                        (ta?.write_tool?.accepted_count ?? 0) + (ta?.notebook_edit_tool?.accepted_count ?? 0)
        u.rejected   += (ta?.edit_tool?.rejected_count ?? 0) + (ta?.multi_edit_tool?.rejected_count ?? 0) +
                        (ta?.write_tool?.rejected_count ?? 0) + (ta?.notebook_edit_tool?.rejected_count ?? 0)
        byProdUser.set(email, u)
      }
    }

    // 5) Join + compute efficiency metrics
    const allEmails = new Set([...bySpendUser.keys(), ...byProdUser.keys()])
    const joined = [...allEmails].map((email) => {
      const s = bySpendUser.get(email) ?? { spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0, models: new Set(), products: new Set() }
      const p = byProdUser.get(email)   ?? { sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0, accepted: 0, rejected: 0, messages: 0, active_days: 0 }

      // Output score: weighted sum of productivity outcomes
      const output_score = p.loc_added + (100 * p.commits) + (1000 * p.prs) + (0.5 * p.accepted)
      const total_tokens = s.prompt_tokens + s.completion_tokens
      const tool_total = p.accepted + p.rejected

      // Activity-weighted scaling: distribute the user's CSV-period total
      // spend across days proportional to their session count. The CSV is a
      // single-period aggregate; this lets the per-user numbers respond to
      // the user's date-range selection.
      //
      //   ratio = sessions_in_selected_range / sessions_over_csv_period
      //
      // Capped at 1.0 so a range wider than the CSV period (or noisy session
      // counts) cannot inflate spend beyond what the CSV actually charged.
      // When sameRange is true, ratio is 1.0 and range_* values equal totals.
      const sessionsCsv = sessionsByUserInCsvPeriod.get(email) ?? 0
      const ratio = sameRange ? 1
        : sessionsCsv > 0 ? Math.min(1, p.sessions / sessionsCsv)
        : 0
      const range_spend_usd        = Number((s.spend * ratio).toFixed(2))
      const range_prompt_tokens    = Math.round(s.prompt_tokens * ratio)
      const range_completion_tokens = Math.round(s.completion_tokens * ratio)
      const range_total_tokens     = range_prompt_tokens + range_completion_tokens
      const range_requests         = Math.round(s.requests * ratio)

      return {
        email,
        spend_usd: Number(s.spend.toFixed(2)),
        requests: s.requests,
        prompt_tokens: s.prompt_tokens,
        completion_tokens: s.completion_tokens,
        total_tokens,
        models: s.models.size,
        products: s.products.size,
        loc_added: p.loc_added,
        loc_removed: p.loc_removed,
        commits: p.commits,
        prs: p.prs,
        sessions: p.sessions,
        active_days: p.active_days,
        tool_accepted: p.accepted,
        tool_rejected: p.rejected,
        tool_acceptance_rate: tool_total === 0 ? null : p.accepted / tool_total,
        output_score,
        cost_per_loc:      p.loc_added > 0 ? Number((s.spend / p.loc_added).toFixed(4)) : null,
        cost_per_commit:   p.commits   > 0 ? Number((s.spend / p.commits).toFixed(2))   : null,
        cost_per_pr:       p.prs       > 0 ? Number((s.spend / p.prs).toFixed(2))       : null,
        cost_per_session:  p.sessions  > 0 ? Number((s.spend / p.sessions).toFixed(2))  : null,
        output_per_dollar: s.spend > 0 ? Number((output_score / s.spend).toFixed(2))    : null,
        tokens_per_loc:    p.loc_added > 0 ? Math.round(total_tokens / p.loc_added)     : null,
        // Activity-weighted, range-aware values:
        range_spend_usd,
        range_prompt_tokens,
        range_completion_tokens,
        range_total_tokens,
        range_requests,
        sessions_in_csv_period: sessionsCsv,
        activity_ratio: Number(ratio.toFixed(4)),
      }
    })

    // 6) Normalize to 0-100 economic productivity score
    //    0.35 * output_per_dollar (higher is better)
    //    0.20 * tool_acceptance_rate
    //    0.20 * inverse(tokens_per_loc)
    //    0.15 * normalized(commits per 10 active days)
    //    0.10 * normalized(prs per 10 active days)
    const cap = (x) => Math.max(0, Math.min(1, x))
    const maxOPD = Math.max(1, ...joined.map((j) => j.output_per_dollar ?? 0))
    const minTPL = joined.filter((j) => j.tokens_per_loc != null).reduce((a, b) => Math.min(a, b.tokens_per_loc), Infinity)
    const scored = joined.map((j) => {
      const opd = (j.output_per_dollar ?? 0) / maxOPD
      const acc = j.tool_acceptance_rate ?? 0
      // Lower tokens/LOC = better; normalize with min of cohort as 1
      const tokRatio = j.tokens_per_loc && isFinite(minTPL) ? cap(minTPL / j.tokens_per_loc) : 0
      const commitsPer10d = j.active_days > 0 ? (j.commits / j.active_days) * 10 / 15 : 0 // 15 commits/10days = ideal
      const prsPer10d     = j.active_days > 0 ? (j.prs     / j.active_days) * 10 / 5  : 0 // 5 PRs/10days = ideal
      const economic_productivity_score = Math.round((
        0.35 * cap(opd) +
        0.20 * cap(acc) +
        0.20 * cap(tokRatio) +
        0.15 * cap(commitsPer10d) +
        0.10 * cap(prsPer10d)
      ) * 100)
      return { ...j, economic_productivity_score }
    })

    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0 })

    res.json({
      source: 'csv+analytics',
      period: csvPeriod,
      user_count: scored.length,
      totals: {
        spend_usd: Number(totals.spend_usd.toFixed(2)),
        loc_added: totals.loc_added,
        commits:   totals.commits,
        prs:       totals.prs,
        prompt_tokens:     totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        avg_cost_per_loc:    totals.loc_added > 0 ? Number((totals.spend_usd / totals.loc_added).toFixed(4)) : null,
        avg_cost_per_commit: totals.commits   > 0 ? Number((totals.spend_usd / totals.commits).toFixed(2))   : null,
      },
      users: scored.sort((a, b) => b.economic_productivity_score - a.economic_productivity_score),
    })
  })

  app.use('/api', router)
}

// Minimal CSV parser that handles quoted fields and commas inside quotes.
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return { columns: [], rows: [] }
  const split = (line) => {
    const out = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inQuote) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') inQuote = false
        else cur += c
      } else {
        if (c === '"') inQuote = true
        else if (c === ',') { out.push(cur); cur = '' }
        else cur += c
      }
    }
    out.push(cur)
    return out
  }
  const columns = split(lines[0])
  const rows = lines.slice(1).map((l) => {
    const cols = split(l)
    const obj = {}
    columns.forEach((c, i) => { obj[c] = cols[i] ?? '' })
    return obj
  })
  return { columns, rows }
}
