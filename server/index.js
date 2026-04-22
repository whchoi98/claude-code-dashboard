import express from 'express'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { generateMock } from './mock.js'
import { registerAwsRoutes } from './aws.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT) || 5174
const PROD = process.env.NODE_ENV === 'production'

const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY_ADMIN || (
  (process.env.ANTHROPIC_ADMIN_KEY || '').startsWith('sk-ant-admin')
    ? process.env.ANTHROPIC_ADMIN_KEY
    : null
)
const COMPLIANCE_KEY = process.env.ANTHROPIC_COMPLIANCE_KEY || null
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
const API_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01'
const UA = 'ClaudeCodeDashboard/0.1.0 (+https://github.com/whchoi98/claude-code-dashboard)'

const ARCHIVE_BUCKET = process.env.ARCHIVE_S3_BUCKET
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' })

// Flattened NDJSON row (written by collector/handler.js) → nested Analytics-API shape
function inflateUser(f) {
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

// Try to read one day of user data from S3. Returns null if the partition
// is missing (caller should fall back to Analytics API).
async function readUsersFromS3(date) {
  if (!ARCHIVE_BUCKET) return null
  const Key = `users/date=${date}/users-${date}.json`
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: ARCHIVE_BUCKET, Key }))
    const body = await resp.Body.transformToString()
    const rows = body.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return rows.map(inflateUser)
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

const keyClass = (key) =>
  !key ? 'none' : key.startsWith('sk-ant-admin') ? 'admin' : key.startsWith('sk-ant-api') ? 'analytics' : 'unknown'

app.use(express.json())

// Simple in-memory cache: key → { t, data }.
// 5-minute TTL fits the Analytics API's 3-day buffer comfortably — the data
// barely changes on the day it's being pulled, so a longer cache buys repeat
// page loads at ~0ms while only costing a few minutes of freshness.
const cache = new Map()
const TTL_MS = 300_000

async function fetchJson(path, params, key) {
  const url = new URL(path, API_URL)
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, String(vv)))
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const cacheKey = `${key?.slice(-8)}:${url.toString()}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return { ...hit.data, _cached: true }

  const res = await fetch(url, {
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'User-Agent': UA,
    },
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  const result = { ok: res.ok, status: res.status, body: json }
  if (res.ok) cache.set(cacheKey, { t: Date.now(), data: result })
  return result
}

function todayUtc(offsetDays = 0) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

function rangeDates(startingDate, endingDate) {
  const out = []
  const start = new Date(`${startingDate}T00:00:00Z`)
  const end = new Date(`${endingDate}T00:00:00Z`)
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    analyticsKey: keyClass(ANALYTICS_KEY),
    adminKey: keyClass(ADMIN_KEY),
    complianceKey: COMPLIANCE_KEY ? 'compliance' : 'none',
    apiUrl: API_URL,
    apiVersion: API_VERSION,
    dataConstraints: {
      firstAvailableDate: '2026-01-01',
      bufferDays: 3,
      maxLookbackDays: 90,
      summariesMaxRangeDays: 31,
      rateLimitPerMinute: 60,
    },
  })
})

// ─── Analytics API ──────────────────────────────────────────────────────────

app.get('/api/analytics/summaries', async (req, res) => {
  const endingDate = req.query.ending_date || todayUtc(-3)
  const startingDate = req.query.starting_date || todayUtc(-33)

  if (!ANALYTICS_KEY) {
    return res.json({ source: 'mock', ...generateMock.summaries(startingDate, endingDate) })
  }
  const upstream = await fetchJson(
    '/v1/organizations/analytics/summaries',
    { starting_date: startingDate, ending_date: endingDate },
    ANALYTICS_KEY,
  )
  if (!upstream.ok) {
    return res.json({
      source: 'mock',
      reason: `upstream ${upstream.status}: ${JSON.stringify(upstream.body).slice(0, 240)}`,
      ...generateMock.summaries(startingDate, endingDate),
    })
  }
  // Upstream returns `{summaries: [...]}`; normalize to `{data: [...]}` to match the dashboard contract.
  res.json({ source: 'live', data: upstream.body?.summaries || [] })
})

app.get('/api/analytics/users', async (req, res) => {
  const date = req.query.date || todayUtc(-3)
  const limit = Number(req.query.limit || 1000)

  if (!ANALYTICS_KEY) {
    return res.json({ source: 'mock', date, ...generateMock.users(date) })
  }

  // Paginate through all pages to get full org snapshot
  const aggregated = []
  let page
  for (let i = 0; i < 20; i++) {
    const upstream = await fetchJson(
      '/v1/organizations/analytics/users',
      { date, limit, ...(page ? { page } : {}) },
      ANALYTICS_KEY,
    )
    if (!upstream.ok) {
      return res.json({
        source: 'mock',
        date,
        reason: `upstream ${upstream.status}: ${JSON.stringify(upstream.body).slice(0, 240)}`,
        ...generateMock.users(date),
      })
    }
    if (Array.isArray(upstream.body?.data)) aggregated.push(...upstream.body.data)
    if (!upstream.body?.has_more || !upstream.body?.next_page) break
    page = upstream.body.next_page
  }
  res.json({ source: 'live', date, data: aggregated })
})

app.get('/api/analytics/skills', async (req, res) => {
  const date = req.query.date || todayUtc(-3)
  if (!ANALYTICS_KEY) {
    return res.json({ source: 'mock', date, ...generateMock.skills(date) })
  }
  const upstream = await fetchJson(
    '/v1/organizations/analytics/skills',
    { date, limit: 500 },
    ANALYTICS_KEY,
  )
  if (!upstream.ok) {
    return res.json({
      source: 'mock',
      date,
      reason: `upstream ${upstream.status}`,
      ...generateMock.skills(date),
    })
  }
  res.json({ source: 'live', date, data: upstream.body?.data || [] })
})

app.get('/api/analytics/connectors', async (req, res) => {
  const date = req.query.date || todayUtc(-3)
  if (!ANALYTICS_KEY) {
    return res.json({ source: 'mock', date, ...generateMock.connectors(date) })
  }
  const upstream = await fetchJson(
    '/v1/organizations/analytics/connectors',
    { date, limit: 500 },
    ANALYTICS_KEY,
  )
  if (!upstream.ok) {
    return res.json({
      source: 'mock',
      date,
      reason: `upstream ${upstream.status}`,
      ...generateMock.connectors(date),
    })
  }
  res.json({ source: 'live', date, data: upstream.body?.data || [] })
})

app.get('/api/analytics/projects', async (req, res) => {
  const date = req.query.date || todayUtc(-3)
  if (!ANALYTICS_KEY) {
    return res.json({ source: 'mock', date, ...generateMock.projects(date) })
  }
  const upstream = await fetchJson(
    '/v1/organizations/analytics/apps/chat/projects',
    { date, limit: 500 },
    ANALYTICS_KEY,
  )
  if (!upstream.ok) {
    return res.json({
      source: 'mock',
      date,
      reason: `upstream ${upstream.status}`,
      ...generateMock.projects(date),
    })
  }
  res.json({ source: 'live', date, data: upstream.body?.data || [] })
})

// Users across a date range — S3-first archive, Analytics API fallback.
// For each day: check S3 (collector writes here daily) first, then fall back
// to the Analytics API only when the partition is missing. All days run in
// parallel. Fully-archived windows return in <500ms total.
app.get('/api/analytics/users/range', async (req, res) => {
  const endingDate = req.query.ending_date || todayUtc(-3)
  const startingDate = req.query.starting_date || todayUtc(-16)
  const dates = rangeDates(startingDate, endingDate).slice(-31)

  const results = await Promise.all(dates.map(async (date) => {
    // 1) Try S3 archive first
    try {
      const s3rows = await readUsersFromS3(date)
      if (s3rows) return { date, source: 's3', data: s3rows, error: null }
    } catch { /* fall through */ }

    // 2) Fallback: Analytics API (or mock only when no key is configured).
    //    When a real key is set, missing days return empty data rather than
    //    mock placeholders — this prevents @acme.com mock emails from polluting
    //    aggregations on recent days that fall inside the 3-day API buffer.
    if (!ANALYTICS_KEY) {
      return { date, source: 'mock', data: generateMock.users(date).data, error: null }
    }
    const upstream = await fetchJson(
      '/v1/organizations/analytics/users',
      { date, limit: 1000 },
      ANALYTICS_KEY,
    )
    return {
      date,
      source: upstream.ok ? 'live' : 'upstream_error',
      data: upstream.ok ? (upstream.body?.data || []) : [],
      error: upstream.ok ? null : upstream.body,
    }
  }))

  const s3Hits = results.filter((r) => r.source === 's3').length
  res.json({
    range: { starting_date: startingDate, ending_date: endingDate },
    cache: { s3_hits: s3Hits, live_calls: results.length - s3Hits },
    days: results,
  })
})

// ─── Admin API (optional — requires sk-ant-admin key) ───────────────────────

app.get('/api/admin/claude-code', async (req, res) => {
  const startingAt = req.query.starting_at || todayUtc(-3)
  if (!ADMIN_KEY) {
    return res.status(400).json({
      error: 'admin_key_required',
      message: 'This endpoint requires ANTHROPIC_ADMIN_KEY_ADMIN (sk-ant-admin...) to be configured. The Analytics key cannot access per-user cost data.',
    })
  }

  // Paginate through all users for that day
  const data = []
  let page
  for (let i = 0; i < 50; i++) {
    const upstream = await fetchJson(
      '/v1/organizations/usage_report/claude_code',
      { starting_at: startingAt, limit: 1000, ...(page ? { page } : {}) },
      ADMIN_KEY,
    )
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    if (Array.isArray(upstream.body?.data)) data.push(...upstream.body.data)
    if (!upstream.body?.has_more || !upstream.body?.next_page) break
    page = upstream.body.next_page
  }
  res.json({ source: 'live', starting_at: startingAt, data })
})

// Fan-out: Claude Code usage across a date range
app.get('/api/admin/claude-code/range', async (req, res) => {
  if (!ADMIN_KEY) return res.status(400).json({ error: 'admin_key_required' })
  const endingDate   = req.query.ending_date   || todayUtc(-3)
  const startingDate = req.query.starting_date || todayUtc(-16)
  const dates = rangeDates(startingDate, endingDate).slice(-31)

  const results = []
  for (const date of dates) {
    const data = []
    let page
    for (let i = 0; i < 50; i++) {
      const upstream = await fetchJson(
        '/v1/organizations/usage_report/claude_code',
        { starting_at: date, limit: 1000, ...(page ? { page } : {}) },
        ADMIN_KEY,
      )
      if (!upstream.ok) {
        results.push({ date, source: 'error', error: upstream.body, data: [] })
        break
      }
      if (Array.isArray(upstream.body?.data)) data.push(...upstream.body.data)
      if (!upstream.body?.has_more || !upstream.body?.next_page) {
        results.push({ date, source: 'live', data })
        break
      }
      page = upstream.body.next_page
    }
  }
  res.json({ range: { starting_date: startingDate, ending_date: endingDate }, days: results })
})

// Usage API — token consumption grouped by model
app.get('/api/admin/usage', async (req, res) => {
  if (!ADMIN_KEY) return res.status(400).json({ error: 'admin_key_required' })
  const endingDate   = req.query.ending_date   || todayUtc(-1)
  const startingDate = req.query.starting_date || todayUtc(-15)
  const params = {
    starting_at:  `${startingDate}T00:00:00Z`,
    ending_at:    `${endingDate}T00:00:00Z`,
    bucket_width: req.query.bucket_width || '1d',
    'group_by[]': req.query.group_by || 'model',
  }
  const upstream = await fetchJson('/v1/organizations/usage_report/messages', params, ADMIN_KEY)
  if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
  res.json({ source: 'live', ...upstream.body })
})

// ─── Compliance API ─────────────────────────────────────────────────────────
// Activity (audit) feed. Passes through most query params, auto-paginates.
app.get('/api/compliance/activities', async (req, res) => {
  if (!COMPLIANCE_KEY) {
    return res.status(400).json({
      error: 'compliance_key_required',
      message: 'Set ANTHROPIC_COMPLIANCE_KEY (Enterprise Compliance API scope).',
    })
  }
  const pagesCap = Number(req.query.pages || 5) // server-side cap on pages
  const limit = Math.min(Number(req.query.limit || 100), 100)
  const before = req.query.before
  const after = req.query.after
  const eventType = req.query.type // single type filter (client-side after fetch)
  const maxRecords = Number(req.query.max || 500)

  const aggregated = []
  let page = req.query.page
  let lastBody
  for (let i = 0; i < pagesCap; i++) {
    const params = {
      limit,
      ...(page ? { page } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    }
    const upstream = await fetchJson('/v1/compliance/activities', params, COMPLIANCE_KEY)
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    lastBody = upstream.body
    if (Array.isArray(upstream.body?.data)) aggregated.push(...upstream.body.data)
    if (aggregated.length >= maxRecords) break
    if (!upstream.body?.has_more || !upstream.body?.next_page) break
    page = upstream.body.next_page
  }

  const filtered = eventType
    ? aggregated.filter((a) => a.type === eventType)
    : aggregated
  res.json({
    source: 'live',
    data: filtered.slice(0, maxRecords),
    has_more: lastBody?.has_more ?? false,
    next_page: lastBody?.next_page ?? null,
    total_fetched: aggregated.length,
  })
})

// Cost API — daily cost breakdown (USD cents)
app.get('/api/admin/cost', async (req, res) => {
  if (!ADMIN_KEY) return res.status(400).json({ error: 'admin_key_required' })
  const endingDate   = req.query.ending_date   || todayUtc(-1)
  const startingDate = req.query.starting_date || todayUtc(-31)
  const params = {
    starting_at:  `${startingDate}T00:00:00Z`,
    ending_at:    `${endingDate}T00:00:00Z`,
    'group_by[]': req.query.group_by || 'description',
  }
  const upstream = await fetchJson('/v1/organizations/cost_report', params, ADMIN_KEY)
  if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
  res.json({ source: 'live', ...upstream.body })
})

// Compact snapshot used to ground the AI analyze endpoint
async function fetchAnalyticsSnapshot() {
  const endingDate = todayUtc(-3)
  const startingDate = todayUtc(-16) // 14-day window
  const snap = { window: { starting_date: startingDate, ending_date: endingDate } }

  const callOrMock = async (path, params, mock) => {
    if (!ANALYTICS_KEY) return mock
    const r = await fetchJson(path, params, ANALYTICS_KEY)
    return r.ok ? r.body : mock
  }

  const summaries = await callOrMock(
    '/v1/organizations/analytics/summaries',
    { starting_date: startingDate, ending_date: endingDate },
    generateMock.summaries(startingDate, endingDate),
  )
  const users = await callOrMock(
    '/v1/organizations/analytics/users',
    { date: endingDate, limit: 1000 },
    generateMock.users(endingDate),
  )
  const skills = await callOrMock(
    '/v1/organizations/analytics/skills',
    { date: endingDate, limit: 200 },
    generateMock.skills(endingDate),
  )
  const connectors = await callOrMock(
    '/v1/organizations/analytics/connectors',
    { date: endingDate, limit: 200 },
    generateMock.connectors(endingDate),
  )

  return {
    ...snap,
    // Upstream shape: summaries API returns `{summaries: [...]}`; users/skills/connectors return `{data: [...]}`.
    summaries:   summaries.summaries ?? summaries.data ?? [],
    users_today: users.data ?? [],
    skills:      skills.data ?? [],
    connectors:  connectors.data ?? [],
  }
}

registerAwsRoutes(app, { fetchAnalytics: fetchAnalyticsSnapshot })

// In production, serve the built Vite SPA and fall back to index.html for client routing.
if (PROD) {
  const dist = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(dist, { maxAge: '1h', index: false }))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`\x1b[36m[api]\x1b[0m Claude Code Dashboard proxy on http://localhost:${PORT}`)
  console.log(`\x1b[36m[api]\x1b[0m Analytics key: ${keyClass(ANALYTICS_KEY)} | Admin key: ${keyClass(ADMIN_KEY)}`)
})
