// Usage and Cost Analytics API adapter (ADR-0023).
//
// Upstream launched GET /v1/organizations/analytics/{usage,cost} in beta on
// 2026-10-29 and demoted the four report endpoints this dashboard was built
// on (cost_report, usage_report, user_cost_report, user_usage_report) to
// legacy. The new endpoints return ROWS ({ starting_at, ending_at, group,
// cost | usage }) instead of time buckets holding `results[]`; the dimension
// and metric fields inside are the same ones the legacy rows carry (probed
// live 2026-11-13: identical totals to 6 decimals, identical per-user rows).
//
// Everything here converts new-API rows back into the legacy body shapes, so
// the reshapers, chunking, caches and routes in aws.js stay untouched. Pure
// and dependency-free (no aws.js import) — unit-tested in
// tests/server/test-cost-api-v2.mjs.

export const COST_API_BETA = 'analytics-usage-cost-2026-08-24'

// Rows per page. The new `limit` counts ROWS (1–1000), not day buckets.
export const V2_ROW_LIMIT = 1000

const V2_ENDPOINT = {
  cost_report: 'cost',
  usage_report: 'usage',
  user_cost_report: 'cost',
  user_usage_report: 'usage',
}
export const v2PathFor = (report) => `/v1/organizations/analytics/${V2_ENDPOINT[report]}`

// 'v2' (default) reads the new endpoints and falls back per call;
// CCD_COST_API=legacy pins the legacy reports.
export function costApiMode(env = process.env) {
  return String(env.CCD_COST_API || '').trim().toLowerCase() === 'legacy' ? 'legacy' : 'v2'
}

const nextDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Daily-bucket query for cost/usage. `endExclusive` is the day AFTER the last
// wanted day (callers pass utcNextDay(e)). `ending_at` is mandatory once
// time_bucket_width is set, and there is no default bucket width.
export function dailyReportParamsV2(s, endExclusive, dims = [], { rbacGroupId = null } = {}) {
  const params = new URLSearchParams({
    starting_at: `${s}T00:00:00Z`,
    ending_at: `${endExclusive}T00:00:00Z`,
    time_bucket_width: '1d',
    order_by: 'time',
    order: 'asc',
    limit: String(V2_ROW_LIMIT),
  })
  for (const dim of dims) params.append('group_by[]', dim)
  if (rbacGroupId) params.append('rbac_group_ids[]', rbacGroupId)
  return params
}

// Per-user query: the legacy user_*_report "one row per user (× dim)" is
// group_by[]=actor narrowed to user actors. Without the filter the response
// also carries service-account / API-key identities and an `actor: null` row.
export function userReportParamsV2(s, endExclusive, groupBy = null) {
  const params = new URLSearchParams({
    starting_at: `${s}T00:00:00Z`,
    ending_at: `${endExclusive}T00:00:00Z`,
    limit: String(V2_ROW_LIMIT),
  })
  params.append('group_by[]', 'actor')
  if (groupBy) params.append('group_by[]', groupBy)
  params.append('actor_types[]', 'user_actor')
  return params
}

// { group: {dims}, cost|usage: {metrics} } → { ...dims, ...metrics } — the
// shape of a legacy `results[]` entry / legacy per-user row. The one value
// that differs between the families is Claude Tag's product id: the legacy
// reports spell it `claude-tag`, the new API `claude_tag`. Rows keep the
// legacy spelling so a product never splits into two series when an org
// moves between the APIs (fallback, cached windows, CSV history).
export function flattenV2Row(row) {
  const flat = { ...(row?.group || {}), ...(row?.cost || row?.usage || {}) }
  if (flat.product === 'claude_tag') flat.product = 'claude-tag'
  return flat
}

// New-API rows → legacy `data[]`: one bucket per UTC day in [s, endExclusive),
// oldest first. The new API emits no row for an empty bucket, while the
// legacy reports listed every bucket (with `results: []`). Days without rows
// are filled in so the converted body is the body a legacy report would have
// returned — today's reshapers skip empty buckets, so this is shape parity
// for anything that walks `data[]`, not something their output depends on.
// A row dated outside the window is kept in its own bucket rather than dropped.
export function rowsToDailyBuckets(rows, s, endExclusive) {
  const byDay = new Map()
  for (let d = s; d < endExclusive; d = nextDay(d)) byDay.set(d, [])
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = String(row?.starting_at || '').slice(0, 10)
    if (!day) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(flattenV2Row(row))
  }
  return [...byDay.keys()].sort().map((day) => ({
    starting_at: `${day}T00:00:00Z`,
    ending_at: `${nextDay(day)}T00:00:00Z`,
    results: byDay.get(day),
  }))
}

// Failures that say "this endpoint/query is not served" (beta withdrawn or
// renamed, scope missing, parameter rejected) — worth one retry on the legacy
// report. Transient failures are NOT retried there: 429 (both APIs draw on
// the same 60 rpm org budget), 5xx (the rbac dimension runs 12–30s upstream,
// so a second walk would cross the CloudFront 60s origin timeout — the
// routes' last-good/stale paths already cover an upstream flap) and network
// errors/timeouts (status 0 / none).
export function isV2FallbackError(err) {
  const s = err?.status
  return s === 400 || s === 403 || s === 404
}

// Per-org v2 → legacy switch. `run(org, attempt)` calls `attempt(true)` (new
// API); on a fallback-class failure it calls `attempt(false)` (legacy) once.
// The org then stays on legacy for `cooldownMs` unless legacy REJECTED the
// call the same way (400/403/404): a query both families reject (bad window)
// is the query's fault and must not turn the new API off. A legacy call that
// only failed transiently (429/5xx/network) did not reject the query, so the
// new API's rejection stands — without the cooldown every call would pay for
// both families until legacy recovered, deepening a rate-limit saturation.
// The legacy error is the one that propagates, so routes keep their existing
// failure handling.
export function makeCostApiSwitch({ mode = costApiMode(), now = Date.now, cooldownMs = 30 * 60_000, log = console.warn } = {}) {
  const downUntil = new Map()   // org → epoch ms
  const active = (org) => (mode === 'v2' && !(downUntil.get(org) > now()) ? 'v2' : 'legacy')
  async function run(org, attempt) {
    if (active(org) === 'legacy') return attempt(false)
    try {
      return await attempt(true)
    } catch (err) {
      if (!isV2FallbackError(err)) throw err
      const stayOnLegacy = () => {
        downUntil.set(org, now() + cooldownMs)
        log(`[cost-api] ${org}: new usage/cost API failed (${err?.message || err}); serving the legacy reports for ${Math.round(cooldownMs / 60_000)} min`)
      }
      let out
      try {
        out = await attempt(false)
      } catch (legacyErr) {
        if (!isV2FallbackError(legacyErr)) stayOnLegacy()
        throw legacyErr
      }
      stayOnLegacy()
      return out
    }
  }
  return { run, active, mode }
}
