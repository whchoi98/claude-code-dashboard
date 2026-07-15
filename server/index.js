import express from 'express'
import compression from 'compression'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { generateMock } from './mock.js'
import { registerAwsRoutes, makeTtlCache } from './aws.js'
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
// The Analytics key carries read:compliance_activities (+ the compliance
// org/user-data read scopes) — verified live against /v1/compliance/activities
// on 2026-07-03 — so a dedicated Compliance key is optional: fall back to the
// Analytics key when ANTHROPIC_COMPLIANCE_KEY is absent. The dedicated key's
// only extra scope (delete:compliance_user_data) is never used here.
const COMPLIANCE_KEY = process.env.ANTHROPIC_COMPLIANCE_KEY || process.env.ANTHROPIC_ANALYTICS_KEY || null
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

// Compress everything compressible (API JSON + the ~1.1 MB SPA bundle →
// ~324 KB): CloudFront can't do it for us — its compression rides the cache
// policy, and every dynamic behavior here runs CACHING_DISABLED. The SSE
// chat stream is safe: it sets Cache-Control no-transform, which this
// middleware honors (no buffering of the event stream).
app.use(compression())
app.use(express.json())

// Simple in-memory cache: key → { t, data }.
// 5-minute TTL fits the Analytics API's 3-day buffer comfortably — the data
// barely changes on the day it's being pulled, so a longer cache buys repeat
// page loads at ~0ms while only costing a few minutes of freshness.
const cache = new Map()
const TTL_MS = 600_000  // 10 min — paired with the 5-min compliance prewarm interval below

async function fetchJson(path, params, key, { signal } = {}) {
  const url = new URL(path, API_URL)
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, String(vv)))
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const cacheKey = `${key?.slice(-8)}:${url.toString()}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return { ...hit.data, _cached: true }

  const res = await fetch(url, {
    signal,
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
    // 'compliance' = dedicated key · 'analytics-fallback' = riding the
    // Analytics key's read:compliance_activities scope · 'none' = audit off.
    complianceKey: process.env.ANTHROPIC_COMPLIANCE_KEY
      ? 'compliance'
      : COMPLIANCE_KEY ? 'analytics-fallback' : 'none',
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
//
// The walk is wrapped in a RESPONSE-level SWR cache (auditCache): the 5-min
// prewarm below top-ups the four preset windows DIRECTLY (same cache-key
// formula as the frontend presets — 1d/7d/14d/30d ending today) with a
// generous background budget, so user requests are served from memory and
// never wait on the sequential after_id walk. Without this, any request
// landing on a task whose 10-min page cache had just expired re-paginated
// the live API in the foreground — with audit volume past 2000 events/window
// that walk takes 30-75s, which blows through the CloudFront 60s origin
// timeout and the Audit page never loads (regression observed 2026-07-15).
const auditCache = makeTtlCache({ ttlMs: TTL_MS, cap: 24 })
// Foreground walks must finish inside the CloudFront/ALB 60s window; return
// what we have past this budget instead of timing out with nothing.
// Background walks (prewarm top-ups, partial-completion retries) get the
// longer budget so they can actually finish the window and replace partial
// entries with complete ones — foreground and page TTLs are equal, so a
// budget-capped refresh would otherwise re-truncate at the same depth
// forever.
const AUDIT_WALK_BUDGET_MS = 45_000
const AUDIT_BG_BUDGET_MS = 240_000
const AUDIT_PAGE_TIMEOUT_MS = 15_000

// One canonical key per walk-parameter tuple — shared by the route and the
// prewarm so the prewarm genuinely warms the keys real requests use.
function auditKey(p) {
  return [
    p.startingDate || '', p.endingDate || '',
    p.maxRecords, p.pagesCap, p.limit,
    p.eventType || '', p.initialAfterId || '',
  ].join('|')
}

// Sequential after_id walk over /v1/compliance/activities. Returns the
// response body; NEVER throws once at least one page has been aggregated —
// mid-walk failures (429 under the shared 60 rpm budget, upstream 5xx,
// network errors/timeouts) and budget exhaustion degrade to a partial
// result instead. A first-page failure throws (status attached) so the
// cache can serve stale or the route can surface the real upstream error.
async function walkActivities({ pagesCap, limit, eventType, maxRecords, startingDate, endingDate, initialAfterId }, budgetMs = AUDIT_WALK_BUDGET_MS) {
  const aggregated = []
  let afterId = initialAfterId
  let lastBody
  let stopReason = 'cap'  // cap | empty | has_more=false | starting_date | max | upstream_<status> | upstream_network | time_budget
  let partial = false
  const t0 = Date.now()
  for (let i = 0; i < pagesCap; i++) {
    // Budget check BEFORE each page, and a per-page abort capped to the
    // remaining budget — a hung upstream socket must not push a foreground
    // response past the CloudFront 60s window (undici's default timeout is
    // minutes, and the in-flight dedup would pin every follower to it).
    const left = budgetMs - (Date.now() - t0)
    if (left < 2000 && aggregated.length > 0) { stopReason = 'time_budget'; partial = true; break }
    const params = {
      limit,
      ...(afterId ? { after_id: afterId } : {}),
    }
    let upstream
    try {
      const signal = AbortSignal.timeout(Math.min(AUDIT_PAGE_TIMEOUT_MS, Math.max(2000, left)))
      upstream = await fetchJson('/v1/compliance/activities', params, COMPLIANCE_KEY, { signal })
    } catch (err) {
      if (aggregated.length === 0) throw err
      stopReason = 'upstream_network'
      partial = true
      break
    }
    if (!upstream.ok) {
      if (aggregated.length === 0) {
        const err = new Error(`compliance activities upstream ${upstream.status}`)
        err.status = upstream.status
        err.body = upstream.body
        throw err
      }
      stopReason = `upstream_${upstream.status}`
      partial = true
      break
    }
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

  return {
    source: 'live',
    data: filtered.slice(0, maxRecords),
    has_more: lastBody?.has_more ?? false,
    total_fetched: aggregated.length,
    in_window: filtered.length,
    stop_reason: stopReason,
    ...(partial ? { partial: true } : {}),
  }
}

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
  const walkParams = {
    pagesCap: Math.min(Number(req.query.pages || 50), 200),
    limit: Math.min(Number(req.query.limit || 100), 100),
    eventType: req.query.type, // single type filter (client-side after fetch)
    maxRecords: Number(req.query.max || 5000),
    startingDate: req.query.starting_date, // YYYY-MM-DD; older events stop pagination
    endingDate: req.query.ending_date,     // YYYY-MM-DD; newer events filtered out
    initialAfterId: req.query.after_id,    // cursor passthrough for incremental fetches
  }
  const cacheKey = auditKey(walkParams)
  try {
    const out = await auditCache(cacheKey, () => walkActivities(walkParams))
    // A budget/failure-truncated result is served immediately (fast, banner
    // explains the truncation) while a background walk with the long budget
    // finishes the window and replaces the cached entry — otherwise the
    // partial would be latched for the whole TTL. Throttled per key so
    // repeat visitors don't stack walks.
    if (out.partial) scheduleAuditCompletion(cacheKey, walkParams)
    res.json(out)
  } catch (err) {
    res.status(err.status || 502).json(err.body || { error: 'compliance_upstream_failed', message: err.message })
  }
})

const auditCompletionAt = new Map() // cacheKey → last background-completion attempt ms
function scheduleAuditCompletion(cacheKey, walkParams) {
  const last = auditCompletionAt.get(cacheKey) || 0
  if (Date.now() - last < 60_000) return
  auditCompletionAt.set(cacheKey, Date.now())
  if (auditCompletionAt.size > 64) auditCompletionAt.delete(auditCompletionAt.keys().next().value)
  auditCache.topUp(cacheKey, () => walkActivities(walkParams, AUDIT_BG_BUDGET_MS))
    .catch((err) => console.warn(`[audit] background completion failed for ${cacheKey}:`, err?.message || err))
}

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
  // Background prewarm for the Compliance audit feed. Top-ups the
  // response-level auditCache DIRECTLY for the four DateRangeControl preset
  // windows — the key formula MUST match what the frontend sends
  // (useDateRange presets: start = today-(days-1), 1d = the finalized
  // today-3 day, upper bound = today; Compliance.tsx/Executive.tsx send
  // max=2000&pages=20), otherwise the prewarm warms keys nobody requests
  // and every real request foreground-walks (the first version of this
  // prewarm used the engagement-buffer offsets -9/-16/-32 and never matched).
  // Background walks use the long budget so entries are COMPLETE — a
  // 45s-capped refresh would re-truncate at the same depth forever since
  // the page cache expires in lockstep with the response cache.
  if (COMPLIANCE_KEY) {
    const prewarm = async () => {
      const today = todayUtc(0)
      const windows = [
        { label: '1d',  starting_date: todayUtc(-3) },   // '1d' preset = finalized day, clamped to end
        { label: '7d',  starting_date: todayUtc(-6) },
        { label: '14d', starting_date: todayUtc(-13) },
        { label: '30d', starting_date: todayUtc(-29) },
      ]
      for (const w of windows) {
        const params = {
          pagesCap: 20, limit: 100, eventType: undefined,
          maxRecords: 2000, startingDate: w.starting_date, endingDate: today,
          initialAfterId: undefined,
        }
        try {
          const t0 = Date.now()
          // minAge 4 min: each 5-min tick refreshes, so entries never age
          // past ~5 min and user requests always fresh-hit (no SWR
          // foreground-budget refresh that could re-truncate them).
          const body = await auditCache.topUp(auditKey(params), () => walkActivities(params, AUDIT_BG_BUDGET_MS), 240_000)
          const ms = Date.now() - t0
          console.log(`\x1b[36m[prewarm]\x1b[0m audit ${w.label}: ${body?.in_window ?? 'fail'} events in ${ms}ms (${body?.stop_reason ?? '?'})`)
        } catch (err) {
          console.warn(`[prewarm] audit ${w.label} failed:`, err?.message || err)
        }
      }
    }
    setTimeout(() => { prewarm().catch(() => {}) }, 1000)
    setInterval(() => { prewarm().catch(() => {}) }, 300_000)
  }
  // Analytics prewarm: every menu boots on the same engagement endpoints
  // (users/range powers 11 pages, summaries 4, the other /range fan-outs the
  // rest) behind the 10-min fetchJson cache. The range routes are
  // DAY-granular (S3-first + per-day upstream cache), so ONE 30d warm covers
  // every preset sub-range (1d/7d/14d/30d) on every page. 2s gaps pace the
  // shared 60 rpm org budget; refresh every 5 min (TTL 10 min — one window
  // of overlap, same math as the audit prewarm above).
  if (ANALYTICS_KEY) {
    const analyticsPrewarm = async () => {
      const startedAt = Date.now()
      const end = todayUtc(0)
      const d30 = todayUtc(-29)
      const targets = [
        `/api/analytics/users/range?starting_date=${d30}&ending_date=${end}`,
        `/api/analytics/skills/range?starting_date=${d30}&ending_date=${end}`,
        `/api/analytics/connectors/range?starting_date=${d30}&ending_date=${end}`,
        `/api/analytics/projects/range?starting_date=${d30}&ending_date=${end}`,
        `/api/analytics/users?date=${todayUtc(-3)}`,
        `/api/analytics/summaries?starting_date=${todayUtc(-6)}&ending_date=${end}`,
        `/api/analytics/summaries?starting_date=${todayUtc(-13)}&ending_date=${end}`,
        `/api/analytics/summaries?starting_date=${todayUtc(-29)}&ending_date=${end}`,
      ]
      let ok = 0, failed = 0
      for (const path of targets) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(60_000) })
          r.ok ? ok++ : failed++
        } catch {
          failed++
        }
        await new Promise((r2) => setTimeout(r2, 2_000).unref?.())
      }
      console.log(`\x1b[36m[prewarm]\x1b[0m analytics: ${ok} warmed, ${failed} failed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    }
    setTimeout(() => { analyticsPrewarm().catch(() => {}) }, 3_000)
    setInterval(() => { analyticsPrewarm().catch(() => {}) }, 300_000)
  }
})
