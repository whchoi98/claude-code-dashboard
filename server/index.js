import express from 'express'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { generateMock } from './mock.js'
import { registerAwsRoutes } from './aws.js'
import { inflateUser } from './inflate.js'

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
const TTL_MS = 600_000  // 10 min — paired with the 5-min compliance prewarm interval below

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

// Analytics API rejects dates inside the 3-day finalization buffer with
// HTTP 400 ("Data is not yet available …"). The DateRangeControl picker
// allows today as the end date by design (the footnote spells out the
// partial-count caveat), so the proxy clamps any incoming ending_date
// to today-3 here. Callers passing `undefined` get `today-3` as the
// default (preserves prior behavior).
function clampAnalyticsEnd(raw) {
  const max = todayUtc(-3)
  if (!raw) return max
  return raw > max ? max : raw
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
  const endingDate = clampAnalyticsEnd(req.query.ending_date)
  const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-33))

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
  const date = clampAnalyticsEnd(req.query.date)
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
  const date = clampAnalyticsEnd(req.query.date)
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
  const date = clampAnalyticsEnd(req.query.date)
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
  const date = clampAnalyticsEnd(req.query.date)
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
  const endingDate = clampAnalyticsEnd(req.query.ending_date)
  const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-16))
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

// Daily-snapshot range fan-out for skills / connectors / projects.
// Anthropic's Analytics API only returns daily aggregates for these endpoints,
// so "show 14 days" means fetching 14 separate days and aggregating. We fan
// out here so the SPA only makes one round trip per page; client handles the
// aggregation since semantics differ per page (SUM for usage counts vs MAX
// for distinct_user_count which can't be deduped across days without IDs).
function makeDailyRangeRoute(upstreamPath, mockKey) {
  return async (req, res) => {
    const endingDate = clampAnalyticsEnd(req.query.ending_date)
    const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-16))
    const dates = rangeDates(startingDate, endingDate).slice(-31)

    const results = await Promise.all(dates.map(async (date) => {
      if (!ANALYTICS_KEY) {
        return { date, source: 'mock', data: generateMock[mockKey](date).data, error: null }
      }
      const upstream = await fetchJson(upstreamPath, { date, limit: 500 }, ANALYTICS_KEY)
      return {
        date,
        source: upstream.ok ? 'live' : 'upstream_error',
        data: upstream.ok ? (upstream.body?.data || []) : [],
        error: upstream.ok ? null : upstream.body,
      }
    }))

    res.json({
      range: { starting_date: startingDate, ending_date: endingDate },
      days: results,
    })
  }
}

app.get('/api/analytics/skills/range',     makeDailyRangeRoute('/v1/organizations/analytics/skills',             'skills'))
app.get('/api/analytics/connectors/range', makeDailyRangeRoute('/v1/organizations/analytics/connectors',         'connectors'))
app.get('/api/analytics/projects/range',   makeDailyRangeRoute('/v1/organizations/analytics/apps/chat/projects', 'projects'))

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
  const endingDate   = clampAnalyticsEnd(req.query.ending_date)
  const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-16))
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
  const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-15))
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
  // The Compliance API uses cursor pagination via `after_id` (the last event
  // id of the previous page) to walk *backward* in time. It does NOT return a
  // `next_page` token and does NOT accept timestamp-based filters. To honor a
  // requested date window we paginate page by page and break out as soon as
  // we cross the lower bound — for noisy orgs this prevents pulling tens of
  // thousands of events when the user only asked for the last 14 days.
  const pagesCap = Math.min(Number(req.query.pages || 50), 200)
  const limit = Math.min(Number(req.query.limit || 100), 100)
  const eventType = req.query.type // single type filter (client-side after fetch)
  const maxRecords = Number(req.query.max || 5000)
  const startingDate = req.query.starting_date // YYYY-MM-DD; older events stop pagination
  const endingDate = req.query.ending_date     // YYYY-MM-DD; newer events filtered out
  const initialAfterId = req.query.after_id     // cursor passthrough for incremental fetches

  const aggregated = []
  let afterId = initialAfterId
  let lastBody
  let stopReason = 'cap'  // why pagination stopped: cap | empty | has_more=false | starting_date
  for (let i = 0; i < pagesCap; i++) {
    const params = {
      limit,
      ...(afterId ? { after_id: afterId } : {}),
    }
    const upstream = await fetchJson('/v1/compliance/activities', params, COMPLIANCE_KEY)
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    lastBody = upstream.body
    const pageData = Array.isArray(upstream.body?.data) ? upstream.body.data : []
    if (pageData.length === 0) { stopReason = 'empty'; break }
    aggregated.push(...pageData)

    // Stop walking back once the oldest event on this page predates the
    // requested starting_date. Events come newest-first within a page, so
    // pageData[length-1] is the oldest in the page.
    if (startingDate) {
      const oldestDay = (pageData[pageData.length - 1].created_at || '').slice(0, 10)
      if (oldestDay < startingDate) { stopReason = 'starting_date'; break }
    }
    if (aggregated.length >= maxRecords) { stopReason = 'max'; break }
    if (!upstream.body?.has_more) { stopReason = 'has_more=false'; break }
    afterId = pageData[pageData.length - 1].id
  }

  // Apply date and type filters. Date filtering is required because the
  // *last* page we fetched may straddle the boundary (some events older,
  // some newer than starting_date).
  const inWindow = (a) => {
    if (!startingDate && !endingDate) return true
    const day = (a.created_at || '').slice(0, 10)
    if (startingDate && day < startingDate) return false
    if (endingDate && day > endingDate) return false
    return true
  }
  let filtered = aggregated.filter(inWindow)
  if (eventType) filtered = filtered.filter((a) => a.type === eventType)

  res.json({
    source: 'live',
    data: filtered.slice(0, maxRecords),
    has_more: lastBody?.has_more ?? false,
    total_fetched: aggregated.length,
    in_window: filtered.length,
    stop_reason: stopReason,
  })
})

// Cost API — daily cost breakdown (USD cents)
app.get('/api/admin/cost', async (req, res) => {
  if (!ADMIN_KEY) return res.status(400).json({ error: 'admin_key_required' })
  const endingDate   = req.query.ending_date   || todayUtc(-1)
  const startingDate = clampAnalyticsEnd(req.query.starting_date || todayUtc(-31))
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
  // Background prewarm for the Compliance audit feed. The Compliance API
  // pagination is sequential (after_id cursor, ~1.5s/page) and a 14d window
  // on noisy orgs takes 30+s — long enough to risk an ALB/CloudFront
  // timeout on cold first request. Pre-populate the upstream cache for the
  // three common preset windows so the user-facing fetch hits the in-memory
  // cache and returns in <1s.
  if (COMPLIANCE_KEY) {
    const prewarm = async () => {
      const today = todayUtc(0)
      const windows = [
        { label: '7d',  starting_date: todayUtc(-9) },   // BUFFER_DAYS+7-1
        { label: '14d', starting_date: todayUtc(-16) },
        { label: '30d', starting_date: todayUtc(-32) },
      ]
      for (const w of windows) {
        try {
          const url = `http://127.0.0.1:${PORT}/api/compliance/activities?max=2000&pages=20&starting_date=${w.starting_date}&ending_date=${today}`
          const t0 = Date.now()
          const r = await fetch(url)
          const body = await r.json().catch(() => ({}))
          const ms = Date.now() - t0
          console.log(`\x1b[36m[prewarm]\x1b[0m audit ${w.label}: ${body?.in_window ?? 'fail'} events in ${ms}ms (${body?.stop_reason ?? '?'})`)
        } catch (err) {
          console.warn(`[prewarm] audit ${w.label} failed:`, err?.message || err)
        }
      }
    }
    // Initial run after a brief delay (so the server is ready to accept
    // self-calls), then refresh every 5 minutes (TTL is 10 min, so the
    // cache stays warm with one window of overlap).
    setTimeout(() => { prewarm().catch(() => {}) }, 1000)
    setInterval(() => { prewarm().catch(() => {}) }, 300_000)
  }
})
