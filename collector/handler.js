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
import { flattenUser, flattenSkill, flattenConnector, flattenProject } from './flatten.js'

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

async function fetchJson(path, params) {
  const url = new URL(path, API_URL)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const key = await resolveAnalyticsKey()
  const r = await fetch(url, {
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

export const handler = async (event = {}) => {
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

  return { ok: true, date, writes: results, counts: {
    users: users.length, summaries: summaryRows.length,
    skills: skills.length, connectors: connectors.length, projects: projects.length,
  }}
}

