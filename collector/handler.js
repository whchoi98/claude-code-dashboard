/**
 * Daily analytics collector — Lambda handler.
 *
 * Runs on an EventBridge schedule (typically 14:00 UTC), fetches the previous
 * N-3 day window from the Analytics API, and writes NDJSON partitions to S3
 * so Glue/Athena can query history beyond the 90-day API lookback.
 *
 * Env:
 *   ANTHROPIC_ANALYTICS_KEY   — required
 *   ARCHIVE_S3_BUCKET         — required
 *   ANTHROPIC_API_URL         — default https://api.anthropic.com
 *   ANTHROPIC_VERSION         — default 2023-06-01
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { flattenUser, flattenSkill, flattenConnector, flattenProject, flattenActivity } from './flatten.js'

const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
const API_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01'
const BUCKET = process.env.ARCHIVE_S3_BUCKET
const UA = 'ClaudeCodeDashboard-Collector/0.1.0'

const s3 = new S3Client({})
const sm = new SecretsManagerClient({})

let cachedKey = null
async function resolveAnalyticsKey() {
  if (cachedKey) return cachedKey
  if (process.env.ANTHROPIC_ANALYTICS_KEY) {
    cachedKey = process.env.ANTHROPIC_ANALYTICS_KEY
    return cachedKey
  }
  const arn = process.env.ANTHROPIC_ANALYTICS_KEY_SECRET_ARN
  if (!arn) throw new Error('Neither ANTHROPIC_ANALYTICS_KEY nor ..._SECRET_ARN is set')
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
  cachedKey = SecretString
  return cachedKey
}

function dateMinusDays(d, n) {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() - n)
  return x.toISOString().slice(0, 10)
}

async function fetchJson(path, params, { signal } = {}) {
  const url = new URL(path, API_URL)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const key = await resolveAnalyticsKey()
  const r = await fetch(url, {
    signal,
    headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'User-Agent': UA },
  })
  if (!r.ok) {
    const body = await r.text()
    throw new Error(`upstream ${r.status} ${path}: ${body.slice(0, 200)}`)
  }
  return r.json()
}

async function fetchAllPages(path, params) {
  const out = []
  let page
  for (let i = 0; i < 50; i++) {
    const body = await fetchJson(path, { ...params, limit: 1000, ...(page ? { page } : {}) })
    if (Array.isArray(body.data)) out.push(...body.data)
    if (!body.has_more || !body.next_page) break
    page = body.next_page
  }
  return out
}

function toNdjson(records, extras = {}) {
  return records.map((r) => JSON.stringify({ ...r, ...extras })).join('\n') + '\n'
}

async function writePartition(prefix, date, body) {
  const key = `${prefix}/date=${date}/${prefix}-${date}.json`
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/x-ndjson',
  }))
  return `s3://${BUCKET}/${key}`
}

// Raw sidecar: alongside every flattened partition, archive the UNFLATTENED
// upstream records under raw/<table>/. flatten.js maps fields explicitly, so
// anything the Analytics API adds later is silently dropped from the columnar
// tables — the sidecar makes those fields recoverable retroactively (add the
// column, re-flatten from raw) instead of depending on the API's ~365-day
// lookback. Deliberately NO Glue table points at raw/ — it is a recovery
// safety net, not a query surface. Pristine records: no snapshot_date stamp.
async function writeRaw(prefix, date, records) {
  const key = `raw/${prefix}/date=${date}/${prefix}-${date}.json`
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: toNdjson(records),
    ContentType: 'application/x-ndjson',
  }))
  return `s3://${BUCKET}/${key}`
}

export const handler = async (event = {}, context = {}) => {
  if (!BUCKET) throw new Error('ARCHIVE_S3_BUCKET is not configured')
  await resolveAnalyticsKey() // fail fast if the secret is not reachable

  const today = new Date()
  const date = event.date || dateMinusDays(today, 3) // respect 3-day data buffer
  // summaries endpoint: ending_date is EXCLUSIVE, so "one day's summary" needs
  // starting = date, ending = date + 1. By default we pull the last 14 days.
  const summariesStart = event.summariesStart || dateMinusDays(today, 16)
  const summariesEnd   = event.summariesEnd   || dateMinusDays(today, 2)

  const results = {}

  const users = await fetchAllPages('/v1/organizations/analytics/users', { date })
  results.users = await writePartition('users', date,
    toNdjson(users.map(flattenUser), { snapshot_date: date }))
  results.users_raw = await writeRaw('users', date, users)

  const summaries = await fetchJson('/v1/organizations/analytics/summaries', {
    starting_date: summariesStart,
    ending_date:   summariesEnd,
  })
  // Summaries API returns {summaries: [...]} — normalize.
  const summaryRows = summaries.summaries || summaries.data || []
  results.summaries = await writePartition('summaries', date, toNdjson(summaryRows))
  results.summaries_raw = await writeRaw('summaries', date, summaryRows)

  const skills = await fetchAllPages('/v1/organizations/analytics/skills', { date })
  results.skills = await writePartition('skills', date,
    toNdjson(skills.map(flattenSkill), { snapshot_date: date }))
  results.skills_raw = await writeRaw('skills', date, skills)

  const connectors = await fetchAllPages('/v1/organizations/analytics/connectors', { date })
  results.connectors = await writePartition('connectors', date,
    toNdjson(connectors.map(flattenConnector), { snapshot_date: date }))
  results.connectors_raw = await writeRaw('connectors', date, connectors)

  const projects = await fetchAllPages('/v1/organizations/analytics/apps/chat/projects', { date })
  results.projects = await writePartition('projects', date,
    toNdjson(projects.map(flattenProject), { snapshot_date: date }))
  results.projects_raw = await writeRaw('projects', date, projects)

  const compliance = await archiveComplianceEvents(event, context, today, results)

  return { ok: true, date, writes: results, counts: {
    users: users.length, summaries: summaryRows.length,
    skills: skills.length, connectors: connectors.length, projects: projects.length,
    compliance_events: compliance.events, compliance_days: compliance.days,
  }}
}

// ── Compliance audit archival ────────────────────────────────────────────
// /v1/compliance/activities only walks backward via after_id (newest-first,
// no timestamp filter), so each run walks from "now" until it crosses the
// capture window's lower bound and buckets events by their created_at day.
// Default window: the last 2 COMPLETE UTC days (yesterday + the day before —
// the overlap re-write is idempotent insurance, same-key PutObject).
// Compliance is real-time: no 3-day finalization buffer applies.
// Payload overrides: complianceStart / complianceEnd (inclusive YYYY-MM-DD),
// complianceDays (window size when no explicit start; analytics BACKFILL
// invokes — any payload with an explicit `date` — default to 0 so a 30-day
// backfill loop doesn't re-walk the same live window 30 times against the
// shared 60 rpm budget), compliancePages (walk cap, default 60).
// Failures here must NOT sink the analytics snapshot — errors are reported
// in results.compliance_error + console.error (the CloudWatch signal)
// instead of thrown. The Analytics key carries read:compliance_activities.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function archiveComplianceEvents(event, context, today, results) {
  const out = { events: 0, days: 0 }
  const pagesCap = Number(event.compliancePages ?? 60)
  const days = Number(event.complianceDays ?? (event.date ? 0 : 2))
  if (days <= 0 && !event.complianceStart) return out
  try {
    const endDay = event.complianceEnd || dateMinusDays(today, 1) // newest complete day
    const startDay = event.complianceStart
      || dateMinusDays(new Date(`${endDay}T00:00:00Z`), days - 1)

    const byDay = new Map()
    let afterId
    let stop = 'pages'
    let oldestDay = null
    for (let i = 0; i < pagesCap; i++) {
      // Leave a Lambda-budget margin: stopping here (stop='pages') engages
      // the partial-day drop below instead of a hard timeout mid-write.
      const remaining = context?.getRemainingTimeInMillis?.()
      if (typeof remaining === 'number' && remaining < 60_000) { stop = 'time'; break }

      // Bounded retry on 429/5xx/network — the walk shares the org-wide
      // 60 rpm budget with the dashboard's keep-warm schedulers, so a
      // single throttle must not abort the whole day's archive. Per-page
      // abort keeps one hung socket from eating the Lambda budget.
      let body
      for (let attempt = 1; ; attempt++) {
        try {
          body = await fetchJson('/v1/compliance/activities', {
            limit: 100, ...(afterId ? { after_id: afterId } : {}),
          }, { signal: AbortSignal.timeout(15_000) })
          break
        } catch (err) {
          if (attempt >= 3) throw err
          await sleep(5000 * attempt * attempt) // 5s, 20s
        }
      }
      // A 200 without a data array is a malformed/degraded response, NOT
      // the end of the feed — treating it as empty would let a partial
      // capture overwrite a complete partition below.
      if (!Array.isArray(body.data)) throw new Error('malformed activities response (no data array)')
      const page = body.data
      if (page.length === 0) { stop = 'empty'; break }
      for (const ev of page) {
        const day = (ev.created_at || '').slice(0, 10)
        if (day >= startDay && day <= endDay) {
          if (!byDay.has(day)) byDay.set(day, [])
          byDay.get(day).push(ev)
        }
      }
      oldestDay = (page[page.length - 1].created_at || '').slice(0, 10)
      if (oldestDay < startDay) { stop = 'window'; break }
      if (!body.has_more) { stop = 'end_of_feed'; break }
      afterId = page[page.length - 1].id
      await sleep(1200) // pace the shared 60 rpm budget (~50 pages/min ceiling)
    }

    // Only a walk that crossed BELOW startDay ('window') proves the oldest
    // captured day is complete. Any other stop (page/time cap, an 'empty'
    // page, a has_more=false glitch) may have cut mid-day — writing that
    // day would OVERWRITE a previously complete partition with a shorter
    // one (same-key PutObject), silently shrinking the audit archive.
    if (stop !== 'window' && oldestDay && byDay.has(oldestDay)) {
      byDay.delete(oldestDay)
      results.compliance_dropped_partial_day = oldestDay
    }

    for (const [day, evs] of [...byDay.entries()].sort()) {
      results[`compliance_${day}`] = await writePartition('compliance', day,
        toNdjson(evs.map(flattenActivity)))
      await writeRaw('compliance', day, evs)
      out.events += evs.length
      out.days += 1
    }
    results.compliance_stop = stop
  } catch (err) {
    results.compliance_error = String(err?.message || err)
    console.error('[collector] compliance archival failed:', results.compliance_error)
  }
  return out
}

