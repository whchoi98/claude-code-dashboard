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

  const summaries = await fetchJson('/v1/organizations/analytics/summaries', {
    starting_date: summariesStart,
    ending_date:   summariesEnd,
  })
  // Summaries API returns {summaries: [...]} — normalize.
  results.summaries = await writePartition('summaries', date,
    toNdjson(summaries.summaries || summaries.data || []))

  const skills = await fetchAllPages('/v1/organizations/analytics/skills', { date })
  results.skills = await writePartition('skills', date,
    toNdjson(skills.map(flattenSkill), { snapshot_date: date }))

  const connectors = await fetchAllPages('/v1/organizations/analytics/connectors', { date })
  results.connectors = await writePartition('connectors', date,
    toNdjson(connectors.map(flattenConnector), { snapshot_date: date }))

  const projects = await fetchAllPages('/v1/organizations/analytics/apps/chat/projects', { date })
  results.projects = await writePartition('projects', date,
    toNdjson(projects, { snapshot_date: date }))

  return { ok: true, date, writes: results, counts: {
    users: users.length, summaries: (summaries.data||[]).length,
    skills: skills.length, connectors: connectors.length, projects: projects.length,
  }}
}

// Flatten nested records (real Analytics API schema) to a columnar shape
// that Athena/Glue can query easily, and that the server's inflateUser() can
// reconstruct into nested shape at read time.
function flattenUser(r) {
  const cc = r.claude_code_metrics || {}
  const core = cc.core_metrics || {}
  const tools = cc.tool_actions || {}
  const tool = (t) => ({
    accepted: t?.accepted_count ?? 0,
    rejected: t?.rejected_count ?? 0,
  })
  const chat = r.chat_metrics || {}
  const cowork = r.cowork_metrics || {}
  return {
    user_id:                r.user?.id,
    user_email:             r.user?.email_address,
    chat_conversations:     chat.distinct_conversation_count ?? 0,
    chat_messages:          chat.message_count ?? 0,
    chat_thinking_messages: chat.thinking_message_count ?? 0,
    chat_files_uploaded:    chat.distinct_files_uploaded_count ?? 0,
    chat_artifacts:         chat.distinct_artifacts_created_count ?? 0,
    chat_skills:            chat.distinct_skills_used_count ?? 0,
    chat_connectors:        chat.connectors_used_count ?? 0,
    cc_sessions:            core.distinct_session_count ?? 0,
    lines_of_code_added:    core.lines_of_code?.added_count ?? 0,
    lines_of_code_removed:  core.lines_of_code?.removed_count ?? 0,
    commits_by_claude_code: core.commit_count ?? 0,
    prs_by_claude_code:     core.pull_request_count ?? 0,
    edit_tool_accepted:          tool(tools.edit_tool).accepted,
    edit_tool_rejected:          tool(tools.edit_tool).rejected,
    multi_edit_tool_accepted:    tool(tools.multi_edit_tool).accepted,
    multi_edit_tool_rejected:    tool(tools.multi_edit_tool).rejected,
    write_tool_accepted:         tool(tools.write_tool).accepted,
    write_tool_rejected:         tool(tools.write_tool).rejected,
    notebook_edit_tool_accepted: tool(tools.notebook_edit_tool).accepted,
    notebook_edit_tool_rejected: tool(tools.notebook_edit_tool).rejected,
    web_search_count:       r.web_search_count ?? 0,
    cowork_sessions:        cowork.distinct_session_count ?? 0,
    cowork_messages:        cowork.message_count ?? 0,
    cowork_actions:         cowork.action_count ?? 0,
    cowork_dispatch_turns:  cowork.dispatch_turn_count ?? 0,
  }
}

function flattenSkill(s) {
  return {
    skill_name: s.skill_name,
    distinct_users: s.distinct_user_count ?? 0,
    chat_uses: s.chat_metrics?.distinct_conversation_skill_used_count ?? 0,
    claude_code_uses: s.claude_code_metrics?.distinct_session_skill_used_count ?? 0,
    cowork_uses: s.cowork_metrics?.distinct_session_skill_used_count ?? 0,
  }
}

function flattenConnector(c) {
  return {
    connector_name: c.connector_name,
    distinct_users: c.distinct_user_count ?? 0,
    chat_uses: c.chat_metrics?.distinct_conversation_connector_used_count ?? 0,
    claude_code_uses: c.claude_code_metrics?.distinct_session_connector_used_count ?? 0,
    cowork_uses: c.cowork_metrics?.distinct_session_connector_used_count ?? 0,
  }
}
