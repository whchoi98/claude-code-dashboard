/**
 * Daily analytics collector — Lambda handler.
 *
 * Runs on an EventBridge schedule (typically 14:00 UTC), fetches the previous
 * N-3 day window from the Analytics API, and writes NDJSON partitions to S3
 * so Glue/Athena can query history beyond the 90-day API lookback.
 *
 * Env:
 *   ANTHROPIC_ANALYTICS_KEY   — required (primary org; or ..._SECRET_ARN)
 *   ANTHROPIC_ANALYTICS_KEY_2 — optional second org (or ..._2_SECRET_ARN);
 *                               when set, every run repeats for org2 and
 *                               writes S3 keys under the org2/ prefix
 *   ARCHIVE_S3_BUCKET         — required
 *   ANTHROPIC_API_URL         — default https://api.anthropic.com
 *   ANTHROPIC_VERSION         — default 2023-06-01
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { flattenUser, flattenSkill, flattenConnector, flattenProject, flattenPlugin, flattenActivity } from './flatten.js'

const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
const API_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01'
const BUCKET = process.env.ARCHIVE_S3_BUCKET
const UA = 'ClaudeCodeDashboard-Collector/0.1.0'

const s3 = new S3Client({})
const sm = new SecretsManagerClient({})

// ── Multi-org config (contract 2026-07-21) ─────────────────────────────────
// Two orgs max: 'primary' keeps today's env names and legacy S3 paths
// EXACTLY; 'org2' exists only when its key env is configured and mirrors the
// whole layout under the org2/ S3 prefix (org2/users/, org2/raw/users/, ...).
const ORG_ENV = {
  primary: { key: 'ANTHROPIC_ANALYTICS_KEY',   arn: 'ANTHROPIC_ANALYTICS_KEY_SECRET_ARN' },
  org2:    { key: 'ANTHROPIC_ANALYTICS_KEY_2', arn: 'ANTHROPIC_ANALYTICS_KEY_2_SECRET_ARN' },
}
const ORG_S3_PREFIX = { primary: '', org2: 'org2/' }

export function orgS3Prefix(org) {
  return ORG_S3_PREFIX[org] ?? ''
}

export function orgConfigured(org) {
  const env = ORG_ENV[org]
  return Boolean(env && (process.env[env.key] || process.env[env.arn]))
}

// Which orgs does this invoke run? Payload `org` limits a manual run to one
// org (unknown values throw — failing loud beats archiving under the wrong
// prefix); default is primary plus org2 when org2's key env is present.
// Primary is always attempted so an unconfigured primary still fails fast
// with the legacy "Neither ... nor ... is set" error below.
export function orgsForRun(event = {}) {
  if (event.org != null) {
    if (!ORG_ENV[event.org]) {
      throw new Error(`unknown org '${event.org}' (expected 'primary' or 'org2')`)
    }
    return [event.org]
  }
  return orgConfigured('org2') ? ['primary', 'org2'] : ['primary']
}

// results/counts key convention: primary keeps the legacy unprefixed keys
// (writes.users, counts.compliance_events, ...); every org2 key carries an
// `org2_` prefix (writes.org2_users, counts.org2_compliance_events, ...).
export function orgKeyPrefix(org) {
  return org === 'primary' ? '' : `${org}_`
}

const cachedKeys = new Map() // org id → resolved API key
async function resolveAnalyticsKey(org = 'primary') {
  if (cachedKeys.has(org)) return cachedKeys.get(org)
  const env = ORG_ENV[org]
  if (process.env[env.key]) {
    cachedKeys.set(org, process.env[env.key])
    return process.env[env.key]
  }
  const arn = process.env[env.arn]
  if (!arn) throw new Error(`Neither ${env.key} nor ..._SECRET_ARN is set`)
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
  cachedKeys.set(org, SecretString)
  return SecretString
}

function dateMinusDays(d, n) {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() - n)
  return x.toISOString().slice(0, 10)
}

async function fetchJson(path, params, { signal, org = 'primary' } = {}) {
  const url = new URL(path, API_URL)
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const key = await resolveAnalyticsKey(org)
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

async function fetchAllPages(path, params, org = 'primary') {
  const out = []
  let page
  for (let i = 0; i < 50; i++) {
    // 20s per-page abort: the analytics phase has no remaining-time
    // checkpoint, so one hung socket must not eat the whole Lambda budget
    // (the compliance walk has its own 15s per-page signal).
    const body = await fetchJson(path, { ...params, limit: 1000, ...(page ? { page } : {}) },
      { org, signal: AbortSignal.timeout(20_000) })
    if (Array.isArray(body.data)) out.push(...body.data)
    // Envelope drift: analytics/plugins returns next_page WITHOUT has_more
    // (probed 2026-08-27) — treat a missing has_more as "trust next_page".
    // Endpoints that do send has_more keep their exact prior behavior.
    if (!(body.has_more ?? true) || !body.next_page) break
    page = body.next_page
  }
  return out
}

function toNdjson(records, extras = {}) {
  return records.map((r) => JSON.stringify({ ...r, ...extras })).join('\n') + '\n'
}

async function writePartition(prefix, date, body, orgPrefix = '') {
  const key = `${orgPrefix}${prefix}/date=${date}/${prefix}-${date}.json`
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
// org2 sidecars live under org2/raw/<table>/ (org prefix outermost).
async function writeRaw(prefix, date, records, orgPrefix = '') {
  const key = `${orgPrefix}raw/${prefix}/date=${date}/${prefix}-${date}.json`
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
  let orgs = orgsForRun(event)
  // Fail fast on the PRIMARY secret only — an org2 misconfiguration (typo'd
  // secret name, lost grant, deleted secret; fromSecretNameV2 never verifies
  // existence at deploy) must degrade to "org2 skipped this run", never sink
  // the primary org's daily snapshot and audit archive.
  const orgErrors = {}
  for (const org of orgs) {
    try {
      await resolveAnalyticsKey(org)
    } catch (err) {
      if (org === 'primary') throw err
      orgErrors[org] = String(err?.message || err)
      console.error(`[collector] org '${org}' key unavailable — excluded from this run:`, orgErrors[org])
    }
  }
  orgs = orgs.filter((o) => !(o in orgErrors))

  const today = new Date()
  const date = event.date || dateMinusDays(today, 3) // respect 3-day data buffer
  // summaries endpoint: ending_date is EXCLUSIVE, so "one day's summary" needs
  // starting = date, ending = date + 1. By default we pull the last 14 days.
  const summariesStart = event.summariesStart || dateMinusDays(today, 16)
  const summariesEnd   = event.summariesEnd   || dateMinusDays(today, 2)

  const results = {}
  const counts = {}

  // Org loop: primary first (legacy prefixes/keys unchanged), then org2 when
  // configured. Orgs run sequentially — each has its own upstream 60 rpm
  // budget, but they share this one Lambda's time budget.
  for (let orgIdx = 0; orgIdx < orgs.length; orgIdx++) {
    const org = orgs[orgIdx]
    const s3Prefix = orgS3Prefix(org)
    const keyPrefix = orgKeyPrefix(org)

    // The remaining-time guard protects the WHOLE multi-org run: the
    // compliance walk checks it per page (same `context` clock for every
    // org), but the analytics snapshot has no internal checkpoint — so if
    // the earlier orgs left too little budget, skip this org outright
    // instead of risking a hard timeout mid-write.
    const remaining = context?.getRemainingTimeInMillis?.()
    if (orgIdx > 0 && typeof remaining === 'number' && remaining < 90_000) {
      results[`${keyPrefix}skipped`] = 'time'
      console.error(`[collector] skipping org '${org}': ${remaining}ms left in the Lambda budget`)
      continue
    }

    const orgResults = {}
    const orgCounts = {}

    // Non-primary failures (401 on a rotated key, upstream 5xx) must not
    // fail the whole invocation after primary already archived — catch and
    // report instead. Primary keeps today's throw-through behavior so the
    // EventBridge retry still fires for genuine primary outages.
    try {

    // complianceOnly: the dedicated 00:30 UTC EventBridge rule archives audit
    // events right after midnight (today's feed is minutes deep → the backward
    // walk reaches yesterday almost immediately). The 14:00 UTC analytics rule
    // passes complianceDays:0 and skips the walk entirely.
    if (!event.complianceOnly) {
      const users = await fetchAllPages('/v1/organizations/analytics/users', { date }, org)
      orgResults.users = await writePartition('users', date,
        toNdjson(users.map(flattenUser), { snapshot_date: date }), s3Prefix)
      orgResults.users_raw = await writeRaw('users', date, users, s3Prefix)

      const summaries = await fetchJson('/v1/organizations/analytics/summaries', {
        starting_date: summariesStart,
        ending_date:   summariesEnd,
      }, { org, signal: AbortSignal.timeout(20_000) })
      // Summaries API returns {summaries: [...]} — normalize.
      const summaryRows = summaries.summaries || summaries.data || []
      orgResults.summaries = await writePartition('summaries', date, toNdjson(summaryRows), s3Prefix)
      orgResults.summaries_raw = await writeRaw('summaries', date, summaryRows, s3Prefix)

      const skills = await fetchAllPages('/v1/organizations/analytics/skills', { date }, org)
      orgResults.skills = await writePartition('skills', date,
        toNdjson(skills.map(flattenSkill), { snapshot_date: date }), s3Prefix)
      orgResults.skills_raw = await writeRaw('skills', date, skills, s3Prefix)

      const connectors = await fetchAllPages('/v1/organizations/analytics/connectors', { date }, org)
      orgResults.connectors = await writePartition('connectors', date,
        toNdjson(connectors.map(flattenConnector), { snapshot_date: date }), s3Prefix)
      orgResults.connectors_raw = await writeRaw('connectors', date, connectors, s3Prefix)

      const projects = await fetchAllPages('/v1/organizations/analytics/apps/chat/projects', { date }, org)
      orgResults.projects = await writePartition('projects', date,
        toNdjson(projects.map(flattenProject), { snapshot_date: date }), s3Prefix)
      orgResults.projects_raw = await writeRaw('projects', date, projects, s3Prefix)

      // Sixth analytics endpoint (v2.2): plugin install/invocation usage.
      // Envelope has next_page but NO has_more — covered by the ?? true
      // fallback in fetchAllPages (probed 2026-08-27).
      const plugins = await fetchAllPages('/v1/organizations/analytics/plugins', { date }, org)
      orgResults.plugins = await writePartition('plugins', date,
        toNdjson(plugins.map(flattenPlugin), { snapshot_date: date }), s3Prefix)
      orgResults.plugins_raw = await writeRaw('plugins', date, plugins, s3Prefix)

      orgCounts.users = users.length
      orgCounts.summaries = summaryRows.length
      orgCounts.skills = skills.length
      orgCounts.connectors = connectors.length
      orgCounts.projects = projects.length
      orgCounts.plugins = plugins.length
    }

    const compliance = await archiveComplianceEvents(event, context, today, orgResults, org)
    orgCounts.compliance_events = compliance.events
    orgCounts.compliance_days = compliance.days

    } catch (err) {
      if (org === 'primary') throw err
      orgResults.error = String(err?.message || err)
      console.error(`[collector] org '${org}' run failed (primary unaffected):`, orgResults.error)
    }

    // Merge under the org key convention (see orgKeyPrefix): primary keeps
    // the legacy unprefixed keys, org2's are org2_* — e.g. writes.org2_users,
    // counts.org2_compliance_events, writes.org2_compliance_error.
    for (const [k, v] of Object.entries(orgResults)) results[keyPrefix + k] = v
    for (const [k, v] of Object.entries(orgCounts)) counts[keyPrefix + k] = v
  }

  for (const [org, msg] of Object.entries(orgErrors)) results[`${orgKeyPrefix(org)}error`] = msg

  return { ok: true, date, orgs, writes: results, counts }
}

// ── Compliance audit archival ────────────────────────────────────────────
// Each UTC day in the capture window is fetched as its OWN bounded query —
// documented `created_at.gte/lt` (RFC 3339) + `limit` up to 5000 + the
// response's opaque `last_id` as the next `after_id` — so a day's events are
// complete exactly when a page answers `has_more: false`. The previous design
// walked the unfiltered feed backward from "now" (110-150 pages of 100 per
// run, each request itself a `compliance_api_accessed` event); bounded days
// take ~3 requests each and no longer traverse "today" first.
// Default window: the last 2 COMPLETE UTC days (yesterday + the day before —
// the overlap re-write is idempotent insurance, same-key PutObject).
// Compliance is real-time: no 3-day finalization buffer applies.
// Payload overrides: complianceStart / complianceEnd (inclusive YYYY-MM-DD),
// complianceDays (window size when no explicit start; analytics BACKFILL
// invokes — any payload with an explicit `date` — default to 0 so a 30-day
// backfill loop doesn't re-archive the same window 30 times),
// compliancePages (per-DAY page cap, default 50 = 100k events/day), and
// allowRedactedOverwrite (see COMPLIANCE_REDACTION_GUARD_BEFORE).
// Only a COMPLETE day is written: a page/time cap, an empty page that still
// claims has_more, or a zero-event result never overwrites a partition
// (same-key PutObject would silently shrink the archive).
// Failures here must NOT sink the analytics snapshot — errors are reported
// in results.compliance_error + console.error (the CloudWatch signal)
// instead of thrown. The Analytics key carries read:compliance_activities.
// Multi-org: runs once per org (results is the caller's PER-ORG object —
// keys land unprefixed here and get the org2_ prefix at merge time); org2's
// partitions go under org2/compliance/ + org2/raw/compliance/.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const COMPLIANCE_ARCHIVE_PAGE = 2000
// 2026-09-24: the Activity Feed stopped returning file names, project
// document names and artifact titles — retroactively, for every stored
// activity. A day's partition is last written at the 00:30 run two days
// later, so partitions up to 2026-09-22 may still hold the names (the exact
// cut-over time on 09-24 is unknown); re-archiving one would replace them
// with the redacted feed. Days before this date are skipped unless the
// payload sets allowRedactedOverwrite: true. Normal runs only touch T-1/T-2.
export const COMPLIANCE_REDACTION_GUARD_BEFORE = '2026-09-24'

const nextUtcDay = (day) => dateMinusDays(new Date(`${day}T00:00:00Z`), -1)

// Fetch ONE UTC day as a bounded query. fetchPage(params) → response body.
// Returns { events, complete, stop, pages }. Complete = an EMPTY page that
// doesn't claim has_more:true, or a SHORT page (fewer events than requested)
// with an explicit has_more:false. Anything else is confirmed with one more
// request: a full page whose flag says false (a flag glitch), and a page
// whose flag is missing (an envelope once dropped has_more, and a silently
// lowered server-side limit would make a truncated page look short).
// Trusting either could overwrite a complete partition with its first page.
// Exported for tests/server/test-collector-compliance.mjs.
export async function collectComplianceDay(day, fetchPage, { pagesCap = 50, pageSize = COMPLIANCE_ARCHIVE_PAGE, timeLeft, pauseMs = 0 } = {}) {
  const events = []
  const windowParams = {
    limit: pageSize,
    'created_at.gte': `${day}T00:00:00Z`,
    'created_at.lt': `${nextUtcDay(day)}T00:00:00Z`,
  }
  let afterId
  for (let i = 0; i < pagesCap; i++) {
    // Leave a Lambda-budget margin: an incomplete day is simply not written.
    if (typeof timeLeft === 'function' && timeLeft() < 60_000) return { events, complete: false, stop: 'time', pages: i }
    const body = await fetchPage({ ...windowParams, ...(afterId ? { after_id: afterId } : {}) })
    // A 200 without a data array is a malformed/degraded response, NOT an
    // empty day — treating it as empty would let a partial capture
    // overwrite a complete partition.
    if (!Array.isArray(body?.data)) throw new Error('malformed activities response (no data array)')
    for (const ev of body.data) {
      if ((ev?.created_at || '').slice(0, 10) === day) events.push(ev)
    }
    const empty = body.data.length === 0
    if (empty && body.has_more !== true) return { events, complete: true, stop: 'end_of_window', pages: i + 1 }
    if (empty) return { events, complete: false, stop: 'empty_page', pages: i + 1 }
    if (body.has_more === false && body.data.length < pageSize) return { events, complete: true, stop: 'end_of_window', pages: i + 1 }
    afterId = (typeof body.last_id === 'string' && body.last_id) || body.data[body.data.length - 1]?.id
    if (pauseMs) await sleep(pauseMs)
  }
  return { events, complete: false, stop: 'pages', pages: pagesCap }
}

async function archiveComplianceEvents(event, context, today, results, org = 'primary') {
  const s3Prefix = orgS3Prefix(org)
  const out = { events: 0, days: 0 }
  const pagesCap = Number(event.compliancePages ?? 50)
  const days = Number(event.complianceDays ?? (event.date ? 0 : 2))
  if (days <= 0 && !event.complianceStart) return out
  try {
    const endDay = event.complianceEnd || dateMinusDays(today, 1) // newest complete day
    const startDay = event.complianceStart
      || dateMinusDays(new Date(`${endDay}T00:00:00Z`), days - 1)

    // Bounded retry on 429/5xx/network — one throttle must not abort the
    // day. Per-page abort keeps one hung socket from eating the Lambda
    // budget (2000-event pages are a few MB).
    const fetchPage = async (params) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fetchJson('/v1/compliance/activities', params, { signal: AbortSignal.timeout(30_000), org })
        } catch (err) {
          if (attempt >= 3) throw err
          await sleep(5000 * attempt * attempt) // 5s, 20s
        }
      }
    }
    const timeLeft = () => context?.getRemainingTimeInMillis?.() ?? Infinity

    // Registered up front so progress survives a mid-loop throw.
    const summary = {}
    results.compliance_day_status = summary
    // Newest first: a Lambda-budget cut drops the overlap day (T-2), which
    // yesterday's run already archived as ITS T-1.
    for (let day = endDay; day >= startDay; day = dateMinusDays(new Date(`${day}T00:00:00Z`), 1)) {
      if (day < COMPLIANCE_REDACTION_GUARD_BEFORE && event.allowRedactedOverwrite !== true) {
        summary[day] = 'skipped_redaction_guard'
        continue
      }
      const r = await collectComplianceDay(day, fetchPage, { pagesCap, timeLeft, pauseMs: 1000 })
      if (!r.complete) { summary[day] = `incomplete_${r.stop}`; continue }
      // Zero events for a whole day is implausible while the dashboard
      // itself reads the feed; never let it replace a stored partition.
      if (r.events.length === 0) { summary[day] = 'empty_not_written'; continue }
      results[`compliance_${day}`] = await writePartition('compliance', day,
        toNdjson(r.events.map(flattenActivity)), s3Prefix)
      await writeRaw('compliance', day, r.events, s3Prefix)
      summary[day] = `ok_${r.pages}p`
      out.events += r.events.length
      out.days += 1
    }
  } catch (err) {
    results.compliance_error = String(err?.message || err)
    console.error('[collector] compliance archival failed:', results.compliance_error)
  }
  return out
}

