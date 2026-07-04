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
    // Real upstream finalization timestamp (cost_report top-level), so the UI can
    // show "data as of …" instead of the request time. Null on the CSV path.
    data_refreshed_at: costBody?.data_refreshed_at ?? null,
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

// Aggregate a single-dimension cost_report body (group_by[]=<field>) into
// per-value USD spend, sorted descending. Null key (ungrouped totals) is
// skipped to avoid double-counting. `field` becomes the output key name.
export function aggregateAmountBy(body, field) {
  const agg = new Map()
  for (const day of body?.data || []) {
    for (const r of day?.results || []) {
      const k = r?.[field]
      if (!k) continue
      agg.set(k, (agg.get(k) || 0) + (parseFloat(r?.amount ?? '0') || 0) / 100)
    }
  }
  return [...agg.entries()]
    .map(([k, spend_usd]) => ({ [field]: k, spend_usd: Number(spend_usd.toFixed(4)) }))
    .sort((a, b) => b.spend_usd - a.spend_usd)
}
// cost_report group_by=cost_type → [{cost_type, spend_usd}] (tokens/web_search/code_execution)
export const aggregateCostType = (body) => aggregateAmountBy(body, 'cost_type')
// cost_report group_by=token_type → [{token_type, spend_usd}] (uncached/cache_read/cache_creation.*/output)
export const aggregateTokenTypeCost = (body) => aggregateAmountBy(body, 'token_type')

// Aggregate usage_report token-subtype COUNTS into cache tiers + the cache-hit
// ratio (cache_read / total input tokens). Reads the SAME usage body the cost
// reshape already consumes — no extra fetch. Skips the ungrouped (null
// product&model) row to avoid double-counting.
export function aggregateTokenTiers(usageBody) {
  let uncached = 0, cache_read = 0, cache_creation = 0, output = 0
  for (const day of usageBody?.data || []) {
    for (const r of day?.results || []) {
      if (!r?.product && !r?.model) continue
      uncached += r?.uncached_input_tokens ?? 0
      cache_read += r?.cache_read_input_tokens ?? 0
      const cc = r?.cache_creation || {}
      cache_creation += (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0)
      output += r?.output_tokens ?? 0
    }
  }
  const input_total = uncached + cache_read + cache_creation
  return {
    uncached, cache_read, cache_creation, output, input_total,
    cache_hit_rate: input_total > 0 ? Number((cache_read / input_total).toFixed(4)) : null,
  }
}

// Fallback labels for opaque rbac_group ids: `grp-<last 6 of id>`, extending
// the suffix on (rare) collisions. Real names come from resolveGroupLabels +
// fetchGroupNames (Compliance groups endpoint); this is the no-names floor.
export function labelGroupIds(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))]
  for (let len = 6; ; len += 2) {
    const entries = uniq.map((id) => [id, `grp-${String(id).slice(-len)}`])
    if (new Set(entries.map(([, l]) => l)).size === uniq.length || len >= 24) {
      return Object.fromEntries(entries)
    }
  }
}

// Merge REAL group names (from the documented `GET /v1/compliance/groups`
// endpoint — scope read:compliance_org_data, which the Analytics key carries;
// verified live 2026-07-04) over the grp-<suffix> fallbacks. Two groups can
// share a display name, so duplicates get an id-suffix disambiguator to keep
// the label→id lookup invertible.
export function resolveGroupLabels(ids, nameById = {}) {
  const uniq = [...new Set((ids || []).filter(Boolean))]
  const fallback = labelGroupIds(uniq)
  const labels = {}
  const used = new Set()
  for (const id of uniq) {
    let label = (nameById && nameById[id]) || fallback[id]
    // Extend the id suffix until unique — a single fixed-width suffix can
    // itself collide when same-named groups share trailing id chars.
    for (let len = 4; used.has(label) && len <= 24; len += 2) {
      label = `${(nameById && nameById[id]) || fallback[id]} (${String(id).slice(-len)})`
    }
    used.add(label)
    labels[id] = label
  }
  return labels
}

// Aggregate a cost_report body grouped by rbac_group_id into per-group spend
// totals + a daily series. Rows with a null rbac_group_id are the genuinely
// UNGROUPED remainder (usage by users in no group) — unlike the single-dim
// cost_type/token_type rollups where a null key is a duplicate total — so
// they accumulate into `ungrouped` instead of being dropped. Amounts follow
// the cost_report convention: decimal-string minor units (cents) → /100 USD.
export function aggregateGroupCost(costBody, nameById = {}) {
  const byGroup = new Map()
  const dailyAcc = new Map()
  const ungrouped = { spend_usd: 0, requests: 0 }
  for (const day of costBody?.data || []) {
    const date = (day?.starting_at || '').slice(0, 10)
    for (const r of day?.results || []) {
      const usd = (parseFloat(r?.amount ?? '0') || 0) / 100
      const reqs = r?.requests ?? 0
      const g = r?.rbac_group_id
      if (!g) {
        ungrouped.spend_usd = Number((ungrouped.spend_usd + usd).toFixed(4))
        ungrouped.requests += reqs
        continue
      }
      const acc = byGroup.get(g) ?? { group_id: g, spend_usd: 0, requests: 0 }
      acc.spend_usd = Number((acc.spend_usd + usd).toFixed(4))
      acc.requests += reqs
      byGroup.set(g, acc)
      if (date) {
        const dkey = `${date}|${g}`
        const d = dailyAcc.get(dkey) ?? { date, group_id: g, spend: 0 }
        d.spend = Number((d.spend + usd).toFixed(4))
        dailyAcc.set(dkey, d)
      }
    }
  }
  const labels = resolveGroupLabels([...byGroup.keys()], nameById)
  const groups = [...byGroup.values()]
    .map((g) => ({ ...g, label: labels[g.group_id] }))
    .sort((a, b) => b.spend_usd - a.spend_usd)
  const daily = [...dailyAcc.values()]
    .map((d) => ({ ...d, label: labels[d.group_id] }))
    .sort((a, b) => (a.date === b.date ? a.group_id.localeCompare(b.group_id) : a.date.localeCompare(b.date)))
  return { groups, ungrouped, daily }
}

// Derive an email→group mapping from a user_cost_report body grouped by
// rbac_group_id (one row per actor × group). The scope-filter format is ONE
// group per email (see parseGroupMap), so a multi-group user maps to their
// max-spend group — deterministic and usage-representative. Rows without an
// email (api_actor) or without a group are skipped. Returns the same
// { map, groups } shape as parseGroupMap plus `ids` (label → full group id),
// which keeps the mapping invertible for API-side follow-ups.
export function deriveGroupMap(data, nameById = {}) {
  const rows = Array.isArray(data) ? data : []
  const perEmail = new Map()   // email → Map(group_id → spend)
  for (const r of rows) {
    const email = String(r?.actor?.email || '').trim().toLowerCase()
    const g = r?.rbac_group_id
    if (!email || !g) continue
    const usd = parseFloat(r?.amount)
    const v = Number.isFinite(usd) ? usd : 0
    const m = perEmail.get(email) ?? new Map()
    m.set(g, (m.get(g) || 0) + v)
    perEmail.set(email, m)
  }
  const allIds = [...new Set([...perEmail.values()].flatMap((m) => [...m.keys()]))]
  const labels = resolveGroupLabels(allIds, nameById)
  const map = {}
  for (const [email, m] of perEmail) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0]
    map[email] = labels[top[0]]
  }
  const groups = [...new Set(Object.values(map))].sort()
  const ids = Object.fromEntries(Object.entries(labels).map(([id, label]) => [label, id]))
  return { map, groups, ids }
}

// Map a user_usage_report `data[]` array (new endpoint, probed 2026-07-04) to
// per-user TOKEN totals. Input (prompt) collapses uncached + cache_read +
// cache_creation (1h+5m) — the same convention as analyticsReportsToCostResp,
// and it reconciles with the upstream row's own total_tokens (input + output).
// This endpoint supersedes the CSV as the source of per-user token counts
// (ADR-0003's "no per-user dimension" constraint no longer holds for tokens).
// api_actor rows (no email) are excluded — email is the join/display key.
export function userUsageToUsers(data) {
  const rows = Array.isArray(data) ? data : []
  const byEmail = new Map()
  for (const r of rows) {
    const email = r?.actor?.email || ''
    if (!email) continue
    const cc = r?.cache_creation || {}
    const input = (r?.uncached_input_tokens ?? 0) +
                  (r?.cache_read_input_tokens ?? 0) +
                  (cc.ephemeral_1h_input_tokens ?? 0) +
                  (cc.ephemeral_5m_input_tokens ?? 0)
    const u = byEmail.get(email) ?? {
      email, user_id: r?.actor?.user_id || null, name: r?.actor?.name || null,
      input_tokens: 0, output_tokens: 0, total_tokens: 0, requests: 0,
    }
    u.input_tokens += input
    u.output_tokens += r?.output_tokens ?? 0
    u.total_tokens = u.input_tokens + u.output_tokens
    u.requests += Number(r?.requests || 0)
    byEmail.set(email, u)
  }
  return [...byEmail.values()].sort((a, b) => b.total_tokens - a.total_tokens)
}

// Map spend_limits/effective `data[]` (Spend Limits API, new 2026-07) to
// per-member rows. `amount` / `period_to_date_spend` are decimal strings in
// MINOR units (cents — verified against user_cost_report month-to-date,
// 2026-07-04) → /100 USD. `amount: null` = unlimited → utilization null.
// Sort: capped members by utilization desc, then unlimited by spend desc.
// NOTE: this actor carries `email_address` (not `email` like the analytics
// report actors). Rows without an email are excluded.
export function spendLimitsToMembers(data) {
  const usd = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n / 100 : 0 }
  const rows = Array.isArray(data) ? data : []
  return rows
    .filter((r) => r?.actor?.email_address)
    .map((r) => {
      const limit_usd = r.amount == null ? null : usd(r.amount)
      const spent_usd = usd(r.period_to_date_spend)
      return {
        email: r.actor.email_address,
        name: r.actor.name || null,
        limit_usd,
        spent_usd: Number(spent_usd.toFixed(2)),
        utilization: limit_usd != null && limit_usd > 0 ? Number((spent_usd / limit_usd).toFixed(4)) : null,
        period: r.period || 'monthly',
        source: r?.source?.type || 'unknown',
      }
    })
    .sort((a, b) => {
      if (a.utilization != null || b.utilization != null) {
        if (a.utilization == null) return 1
        if (b.utilization == null) return -1
        if (b.utilization !== a.utilization) return b.utilization - a.utilization
      }
      return b.spent_usd - a.spent_usd
    })
}

// Map a user_cost_report `data[]` array to the dashboard's per-user shape.
// amount/list_amount are decimal strings in fractional CENTS (same convention
// as cost_report) → /100 for USD. Emails are returned RAW for the email-keyed
// efficiency join; the frontend masks via maskEmail on render. api_actor rows
// (no email) are excluded — this endpoint is user-centric and emails are the
// join key.
export function userCostToUsers(data, { byModel = false } = {}) {
  // Cents (decimal string) → USD; non-numeric/malformed amounts coerce to 0 so a
  // bad upstream value can never inject NaN (which would corrupt the spend sort).
  const usd = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n / 100 : 0 }
  const rows = Array.isArray(data) ? data : []
  if (!byModel) {
    return rows
      .map((r) => {
        const a = r.actor || {}
        return {
          email: a.email || '',
          user_id: a.user_id || null,
          name: a.name || null,
          deleted: !!a.deleted,
          net_spend_usd: usd(r.amount),
          gross_spend_usd: usd(r.list_amount || r.amount),
          requests: Number(r.requests || 0),
        }
      })
      .filter((u) => u.email)
  }
  // byModel: the body is per-(actor, model). Aggregate per email, collecting a
  // sorted per-model spend breakdown (cost + requests only — no per-user tokens).
  const byEmail = new Map()
  for (const r of rows) {
    const a = r.actor || {}
    const email = a.email || ''
    if (!email) continue
    const u = byEmail.get(email) ?? { email, user_id: a.user_id || null, name: a.name || null, net_spend_usd: 0, requests: 0, _m: new Map() }
    const spend = usd(r.amount)
    u.net_spend_usd += spend
    u.requests += Number(r.requests || 0)
    // net_spend_usd counts every row; by_model only rows carrying a model. In
    // grouped mode the API always sends a model, so they match in practice.
    if (r.model) {
      const m = u._m.get(r.model) ?? { model: r.model, spend_usd: 0, requests: 0 }
      m.spend_usd += spend
      m.requests += Number(r.requests || 0)
      u._m.set(r.model, m)
    }
    byEmail.set(email, u)
  }
  return [...byEmail.values()].map((u) => ({
    email: u.email, user_id: u.user_id, name: u.name,
    net_spend_usd: Number(u.net_spend_usd.toFixed(4)),
    requests: u.requests,
    by_model: [...u._m.values()]
      .map((m) => ({ model: m.model, spend_usd: Number(m.spend_usd.toFixed(4)), requests: m.requests }))
      .sort((a, b) => b.spend_usd - a.spend_usd),
  }))
}

// Inclusive end date (YYYY-MM-DD) → the EXCLUSIVE `ending_at` for the Analytics
// cost endpoints. The picker treats ranges as inclusive ([d, d] = that one day),
// but cost_report/user_cost_report use an exclusive ending_at — so a single-day
// range would otherwise send starting_at == ending_at (a zero-width window that
// returns zero rows). Mapping the inclusive end to the next day's 00:00 makes
// [d, d] cover the full day d, and fixes the multi-day off-by-one too.
export function utcNextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Resolve the inclusive [starting, ending] window for user_cost_report.
// The endpoint serves the recent 3-day finalization buffer with PARTIAL data
// (same semantics as cost_report; verified against the live API 2026-07-03),
// so the old `today − 3` ending clamp is gone. That clamp silently cut the
// last 3 days out of every per-user table (Top-10 cost, per-user × model)
// while the org-wide headline included them — and because `starting` was
// never clamped, a fully-recent range inverted into starting > ending, which
// upstream rejects with 400. Ending still clamps to today (future dates are
// invalid upstream) and an inverted pair pins starting back to ending.
// The default window is 31 inclusive days ([today-30, today]) — the upstream
// cost family rejects any span over 31 days ("date range must span at most
// 31 days", measured 2026-07-03 on cost_report AND user_cost_report, grouped
// or not). Longer user-selected ranges surface that 400 as a 502 and the UI
// falls back to the CSV path, which is the documented >30-day reconciliation
// story. `now` is injectable for unit tests.
export function resolveUserCostWindow({ starting_date, ending_date } = {}, now = new Date()) {
  const minus = (n) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
  const today = minus(0)
  let ending = ending_date || today
  if (ending > today) ending = today
  let starting = starting_date || minus(30)
  if (starting > ending) starting = ending
  return { starting, ending }
}

// v3 cost-efficiency scorer. Pure + exported for unit tests. Replaces v2's
// arbitrary cross-surface multipliers with per-surface within-cohort normalization.
// The value term is built in 5 passes:
//   1. per-surface raw output (one metric/surface, no multipliers)
//   2. normalize each surface within its OWN active cohort (winsorized
//      median-anchor) → surface_scores ∈ [0,1]
//   3. coverage-aware blend over ACTIVE surfaces → productivity_index ∈ [0,1]
//   4. efficiency_raw = index / max(total$, floor)  (per-surface $ unavailable)
//   5. normalize efficiency_raw across the cohort (median-anchor) → value_term
// acceptance / delivery / breadth are unchanged from v2 (single-signal, absolute).
export const ECON_V3_DEFAULTS = {
  churnDiscount: 0.5,   // code_raw = loc_added − 0.5·loc_removed
  spendFloor:    0.5,   // $ denominator floor
  deliveryIdeal: 2.0,   // delivery = (commits+prs)/active_days / 2.0
  anchorFactor:  0.5,   // median anchor → 0.5 in BOTH normalization passes
  weights: { value: 0.55, acceptance: 0.25, delivery: 0.12, breadth: 0.08 },
}
export function scoreEconomicProductivity(joined, opts = {}) {
  const C = {
    ...ECON_V3_DEFAULTS, ...opts,
    weights: { ...ECON_V3_DEFAULTS.weights, ...(opts.weights || {}) },
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

  // Winsorized median-anchor normalizer over a set of raw values. Returns a
  // function raw → [0,1] mapping the cohort median to anchorFactor (0.5).
  // Round-index percentiles make winsorize a no-op for N ≲ 19 (p5→idx0,
  // p95→idx(n-1)); the median anchor carries small-cohort stability. A
  // nonpositive median (e.g. all-zero cohort) yields a constant-0 normalizer.
  const makeNormalizer = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return () => 0
    const pctl = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
    const lo = pctl(5), hi = pctl(95)
    const wins = (x) => Math.max(lo, Math.min(hi, x))
    const w = sorted.map(wins).sort((a, b) => a - b)
    const median = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2
    return (x) => (median > 0 ? clamp01(C.anchorFactor * wins(x) / median) : 0)
  }

  // Pass 1: one raw output metric per surface for every user (no multipliers).
  const SURFACES = ['code', 'cowork', 'office', 'design']
  const rawOf = (u) => ({
    code:   Math.max(0, num(u.loc_added) - C.churnDiscount * num(u.loc_removed)),
    cowork: num(u.cowork_actions),
    office: num(u.office_messages),
    design: num(u.design_messages),
  })
  const raws = joined.map(rawOf)

  // Pass 2: one normalizer per surface, built from users ACTIVE in it (raw > 0).
  const normBySurface = {}
  for (const s of SURFACES) {
    normBySurface[s] = makeNormalizer(raws.filter((r) => r[s] > 0).map((r) => r[s]))
  }

  // Passes 3-4: surface_scores, coverage-aware blend, efficiency_raw.
  const withEff = joined.map((u, i) => {
    const raw = raws[i]
    const surface_scores = {}
    let sum = 0, active = 0
    for (const s of SURFACES) {
      const score = raw[s] > 0 ? normBySurface[s](raw[s]) : 0
      surface_scores[s] = score
      if (raw[s] > 0) { sum += score; active += 1 }
    }
    const productivity_index = active > 0 ? sum / active : 0
    const efficiency_raw = productivity_index / Math.max(num(u.spend_usd), C.spendFloor)
    return { u, surface_scores, productivity_index, efficiency_raw }
  })

  // Pass 5: normalize efficiency_raw within the ACTIVE subpopulation
  // (efficiency_raw > 0), mirroring Pass 2's per-surface treatment. Anchoring
  // over the whole cohort would let structurally-zero users — billed but with no
  // code/cowork/office/design output (e.g. chat-only seats) — drag the median: a
  // zero-dominated cohort would collapse every value term to 0, and a zero-skewed
  // one would inflate active users. Zero-output users map straight to value 0.
  const valueNorm = makeNormalizer(withEff.filter((x) => x.efficiency_raw > 0).map((x) => x.efficiency_raw))

  return withEff.map(({ u, surface_scores, productivity_index, efficiency_raw }) => {
    const valueTerm = efficiency_raw > 0 ? valueNorm(efficiency_raw) : 0
    const accTotal = num(u.tool_accepted) + num(u.tool_rejected)
    const acceptanceTerm = accTotal > 0 ? clamp01(num(u.tool_accepted) / accTotal) : 0
    const events = num(u.commits) + num(u.prs)
    const deliveryTerm = num(u.active_days) > 0 ? clamp01((events / num(u.active_days)) / C.deliveryIdeal) : 0
    const surfaces =
      (num(u.loc_added) > 0 || num(u.commits) > 0 || num(u.prs) > 0 || num(u.tool_accepted) > 0 ? 1 : 0) +
      (num(u.messages) > 0 ? 1 : 0) +
      (num(u.cowork_sessions) > 0 || num(u.cowork_actions) > 0 ? 1 : 0) +
      (num(u.office_sessions) > 0 || num(u.office_messages) > 0 ? 1 : 0) +
      (num(u.design_sessions) > 0 || num(u.design_messages) > 0 ? 1 : 0)
    const breadthTerm = surfaces / 5
    // clamp to [0,100] so a partial opts.weights override (sum ≠ 1) can never
    // emit an out-of-range score; under default weights (sum 1.0) this is a no-op.
    const economic_productivity_score = Math.max(0, Math.min(100, Math.round(100 * (
      C.weights.value * valueTerm + C.weights.acceptance * acceptanceTerm +
      C.weights.delivery * deliveryTerm + C.weights.breadth * breadthTerm))))
    return {
      ...u,
      surface_scores: {
        code:   Number(surface_scores.code.toFixed(4)),
        cowork: Number(surface_scores.cowork.toFixed(4)),
        office: Number(surface_scores.office.toFixed(4)),
        design: Number(surface_scores.design.toFixed(4)),
      },
      productivity_index: Number(productivity_index.toFixed(4)),
      efficiency_raw: Number(efficiency_raw.toFixed(6)),
      score_components: {
        value: Number(valueTerm.toFixed(4)), acceptance: Number(acceptanceTerm.toFixed(4)),
        delivery: Number(deliveryTerm.toFixed(4)), breadth: Number(breadthTerm.toFixed(4)),
      },
      economic_productivity_score,
    }
  })
}

// Paginate an Analytics report (cost_report / usage_report) by following
// has_more/next_page and merging every page's `data[]`. The API caps daily
// buckets at ~7 per page, so a window > 7 days spans multiple pages — fetching
// only page 1 silently truncates a 30-day total to its first week (the bug this
// fixes). Mirrors fetchUserReport's pagination loop. `fetchImpl` is
// injectable for unit tests. Never throws on a network error: returns
// `{ ok:false }` so best-effort callers (cost_type/token_type) degrade and
// primary callers (cost/usage) can surface the HTTP status.
export async function fetchAllReportPages(baseUrl, headers, fetchImpl = fetch, maxPages = 24) {
  const data = []
  let page = null, refreshedAt = null, status = 0
  for (let i = 0; i < maxPages; i++) {
    const url = page ? `${baseUrl}&page=${encodeURIComponent(page)}` : baseUrl
    let res
    try {
      res = await fetchImpl(url, { headers })
    } catch {
      return { ok: false, status: 0, body: { data, data_refreshed_at: refreshedAt } }
    }
    status = res.status
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status, body }
    if (Array.isArray(body.data)) data.push(...body.data)
    refreshedAt = body.data_refreshed_at ?? refreshedAt
    if (!body.has_more || !body.next_page) break
    page = body.next_page
    if (i === maxPages - 1) console.warn(`[cost/live] fetchAllReportPages hit ${maxPages}-page cap; total may be truncated`)
  }
  return { ok: true, status, body: { data, data_refreshed_at: refreshedAt } }
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
  'projects_daily',
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

// Human-readable schema reference for code readers — NOT injected into any prompt.
// The live chatbot tool spec uses ATHENA_SCHEMA_HINT_FOR_TOOL in server/chat-tools.js
// (that is the source of truth the model actually sees); keep this copy only as docs.
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
  cowork_sessions, cowork_messages, cowork_actions, cowork_dispatch_turns,
  office_excel_*, office_powerpoint_*, office_word_*, office_outlook_*
    (per surface: _sessions, _messages, _skills_used, _distinct_skills, _connectors_used, _distinct_connectors),
  cowork_file_edit_count, cowork_edit_tool_count, cowork_multi_edit_tool_count,
  cowork_write_tool_count, cowork_notebook_edit_tool_count, cowork_sessions_with_file_edits_count
    (cowork tool-edit counts are NULL until the org enables cowork file-editing),
  design_sessions, design_projects_used, design_projects_created, design_messages

• summaries_daily (one row per day, org-wide):
  date, daily_active_user_count, weekly_active_user_count, monthly_active_user_count,
  assigned_seat_count, pending_invite_count,
  cowork_daily_active_user_count, cowork_weekly_active_user_count, cowork_monthly_active_user_count

• skills_daily:   skill_name, distinct_users, chat_uses, claude_code_uses, cowork_uses
• connectors_daily: connector_name, distinct_users, chat_uses, claude_code_uses, cowork_uses

• projects_daily (one row per chat project per day):
  project_id, project_name, distinct_user_count, distinct_conversation_count,
  message_count, created_at, created_by_id, created_by_email
  (created_by_* are NULL for partitions collected before this column existed)

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
    // 31 inclusive days max — the upstream cost family rejects spans > 31
    // days (see resolveUserCostWindow). minus(31) was one day over the cap:
    // a date-less call (chat get_cost_summary, bare /cost/live) hit a 400.
    const startingDate = starting_date || minus(30)
    const endingDate = ending_date || minus(0)
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const buildUrl = (p, dims = ['product', 'model']) => {
      const params = new URLSearchParams({ starting_at: `${startingDate}T00:00:00Z`, ending_at: `${utcNextDay(endingDate)}T00:00:00Z`, bucket_width: '1d' })
      for (const dim of dims) params.append('group_by[]', dim)
      return `${apiUrl}${p}?${params.toString()}`
    }
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }
    // Each report is PAGINATED via fetchAllReportPages: the Analytics API caps
    // daily buckets at ~7/page, so a 30-day window spans ~5 pages — fetching page 1
    // only truncated the month to its first week. cost_type/token_type are
    // best-effort rollups: fetchAllReportPages returns { ok:false } (never rejects)
    // on a network error, so a failure leaves them empty without breaking the
    // primary product×model cost view.
    const [cost, usage, ct, tt] = await Promise.all([
      fetchAllReportPages(buildUrl('/v1/organizations/analytics/cost_report'), headers),
      fetchAllReportPages(buildUrl('/v1/organizations/analytics/usage_report'), headers),
      fetchAllReportPages(buildUrl('/v1/organizations/analytics/cost_report', ['cost_type']), headers),
      fetchAllReportPages(buildUrl('/v1/organizations/analytics/cost_report', ['token_type']), headers),
    ])
    if (!cost.ok) {
      const e = new Error(`cost_report ${cost.status}`)
      e.code = 'upstream_error'; e.upstream = cost.body
      throw e
    }
    if (!usage.ok) {
      const e = new Error(`usage_report ${usage.status}`)
      e.code = 'upstream_error'; e.upstream = usage.body
      throw e
    }
    const costBody = cost.body
    const usageBody = usage.body
    const ctBody = ct.ok ? ct.body : {}
    const ttBody = tt.ok ? tt.body : {}
    const out = analyticsReportsToCostResp(costBody, usageBody, { starting_date: startingDate, ending_date: endingDate })
    out.by_cost_type = aggregateCostType(ctBody)
    out.by_token_type = aggregateTokenTypeCost(ttBody)
    out.token_tiers = aggregateTokenTiers(usageBody)
    return out
  }

  // Paginate user_cost_report for [starting, ending] and return RAW merged
  // data[] (emails unmasked — needed for the email-keyed efficiency join;
  // the frontend masks on render). Caps pages to stay within the 60/min budget.
  // Paginates a per-user analytics report. `report` picks the endpoint:
  // 'user_cost_report' (USD spend) or 'user_usage_report' (token counts —
  // new upstream endpoint, probed 2026-07-04). `groupBy` appends a group_by[]
  // dimension: 'model' (per-user × model chargeback) or 'rbac_group_id'
  // (per-user group membership derivation).
  async function fetchUserReport({ report = 'user_cost_report', starting_date, ending_date, groupBy = null } = {}) {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) { const e = new Error('ANTHROPIC_ANALYTICS_KEY is required for per-user cost.'); e.code = 'analytics_key_required'; throw e }
    // Window resolution (incl. why there is NO today-3 clamp anymore) lives in
    // resolveUserCostWindow — pure + unit-tested in tests/server/test-user-cost.mjs.
    const { starting, ending } = resolveUserCostWindow({ starting_date, ending_date })
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }

    const all = []
    let page = null
    let refreshedAt = null
    const MAX_PAGES = 50
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({ starting_at: `${starting}T00:00:00Z`, ending_at: `${utcNextDay(ending)}T00:00:00Z`, limit: '1000' })
      if (groupBy) params.append('group_by[]', groupBy)
      if (page) params.set('page', page)
      const res = await fetch(`${apiUrl}/v1/organizations/analytics/${report}?${params.toString()}`, { headers })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { const e = new Error(`${report} ${res.status}`); e.code = 'upstream_error'; e.upstream = body; throw e }
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
      const byModel = req.query.by === 'model'
      const { data, period, data_refreshed_at } = await fetchUserReport({
        starting_date: req.query.starting_date, ending_date: req.query.ending_date, groupBy: byModel ? 'model' : null,
      })
      const users = userCostToUsers(data, { byModel }).sort((a, b) => b.net_spend_usd - a.net_spend_usd)
      res.json({ source: 'live', period, data_refreshed_at, grouped: byModel ? 'model' : null, users })
    } catch (err) {
      if (err?.code === 'analytics_key_required') {
        return res.status(400).json({ error: 'analytics_key_required', message: err.message })
      }
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err), upstream: err?.upstream })
    }
  })

  // The upstream rbac_group_id dimension FLAPS: it intermittently returns
  // 503 overloaded_error "Team membership data is not ready yet; RBAC group
  // breakdowns and filters are temporarily unavailable" (observed live
  // 2026-07-03 — worked in the morning, 503 in the afternoon). Last-good
  // responses are kept per window key so a flap serves the most recent
  // successful payload (`stale: true`) instead of blanking the group card.
  const groupLastGood = new Map()
  const GROUP_LAST_GOOD_CAP = 20
  function rememberGroupResult(key, payload) {
    groupLastGood.delete(key)                       // refresh insertion order
    groupLastGood.set(key, payload)
    if (groupLastGood.size > GROUP_LAST_GOOD_CAP) {
      groupLastGood.delete(groupLastGood.keys().next().value)  // evict oldest
    }
  }
  const isRbacUnavailable = (body) =>
    body?.error?.type === 'overloaded_error' ||
    /RBAC group breakdowns .* temporarily unavailable|Team membership data is not ready/i.test(body?.error?.message || '')

  // RBAC group id → display name via the DOCUMENTED Compliance groups
  // endpoint (GET /v1/compliance/groups — scope read:compliance_org_data,
  // carried by the Analytics key; verified live 2026-07-04: Security/CXO/
  // Engineering/Marketing). NOT the undocumented /v1/organizations/rbac_groups
  // (needs an unprovisionable scope). Cached 1h + last-good: group renames are
  // rare and every listing emits a group_list_viewed audit event — don't spam
  // the org's own audit feed.
  let groupNamesCache = { at: 0, byId: null }
  async function fetchGroupNames() {
    const KEY = process.env.ANTHROPIC_COMPLIANCE_KEY || process.env.ANTHROPIC_ANALYTICS_KEY
    if (!KEY) return {}
    if (groupNamesCache.byId && Date.now() - groupNamesCache.at < 3_600_000) return groupNamesCache.byId
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const headers = { 'x-api-key': KEY, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01' }
    try {
      const byId = {}
      let page = null
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({ limit: '100' })
        if (page) params.set('page', page)
        const res = await fetch(`${apiUrl}/v1/compliance/groups?${params.toString()}`, { headers })
        if (!res.ok) throw new Error(`compliance/groups ${res.status}`)
        const body = await res.json()
        for (const g of body?.data || []) if (g?.id && g?.name) byId[g.id] = g.name
        if (!body?.next_page) break
        page = body.next_page
      }
      groupNamesCache = { at: Date.now(), byId }
      return byId
    } catch (err) {
      console.warn('[groups] name lookup unavailable, using id-suffix labels:', err?.message || err)
      return groupNamesCache.byId || {}   // stale names beat no names; {} → grp- fallback
    }
  }

  // GET /api/cost/groups — org spend by RBAC group over the selected range.
  // cost_report × rbac_group_id shipped upstream (probed 2026-07-03; was 400
  // "not yet supported" before). Labels are REAL group names via
  // fetchGroupNames (grp-<id suffix> fallback when the lookup is down).
  // Window matches /cost/live semantics (full range, buffer days included).
  router.get('/cost/groups', async (req, res) => {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) {
      return res.status(400).json({ error: 'analytics_key_required', message: 'ANTHROPIC_ANALYTICS_KEY is required for group cost.' })
    }
    const { starting, ending } = resolveUserCostWindow({
      starting_date: req.query.starting_date, ending_date: req.query.ending_date,
    })
    const cacheKey = `cost/groups:${starting}:${ending}`
    try {
      const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
      const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
      const params = new URLSearchParams({
        starting_at: `${starting}T00:00:00Z`, ending_at: `${utcNextDay(ending)}T00:00:00Z`, bucket_width: '1d',
      })
      params.append('group_by[]', 'rbac_group_id')
      const r = await fetchAllReportPages(
        `${apiUrl}/v1/organizations/analytics/cost_report?${params.toString()}`,
        { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion },
      )
      if (!r.ok) {
        const stale = groupLastGood.get(cacheKey)
        if (stale) {
          console.warn(`[cost/groups] upstream ${r.status}; serving last-good for ${cacheKey}`)
          return res.json({ ...stale, stale: true })
        }
        if (isRbacUnavailable(r.body)) {
          return res.status(503).json({ error: 'rbac_groups_unavailable', message: r.body?.error?.message || 'RBAC group data temporarily unavailable upstream.' })
        }
        return res.status(502).json({ error: 'upstream_error', message: `cost_report(rbac_group_id) ${r.status}`, upstream: r.body })
      }
      const out = {
        source: 'live',
        period: { starting_date: starting, ending_date: ending },
        data_refreshed_at: r.body.data_refreshed_at ?? null,
        ...aggregateGroupCost(r.body, await fetchGroupNames()),
      }
      rememberGroupResult(cacheKey, out)
      res.json(out)
    } catch (err) {
      const stale = groupLastGood.get(cacheKey)
      if (stale) return res.json({ ...stale, stale: true })
      res.status(502).json({ error: 'upstream_error', message: err?.message || String(err) })
    }
  })

  // GET /api/cost/user-tokens — per-user TOKEN counts over the selected range,
  // live from user_usage_report (new upstream endpoint, probed 2026-07-04).
  // Replaces the CSV as the primary source of the token-ranked Top tables;
  // same window rules as /cost/users (31-day span cap, buffer served partial).
  router.get('/cost/user-tokens', async (req, res) => {
    try {
      const { data, period, data_refreshed_at } = await fetchUserReport({
        report: 'user_usage_report',
        starting_date: req.query.starting_date, ending_date: req.query.ending_date,
      })
      res.json({ source: 'live', period, data_refreshed_at, users: userUsageToUsers(data) })
    } catch (err) {
      if (err?.code === 'analytics_key_required') {
        return res.status(400).json({ error: 'analytics_key_required', message: err.message })
      }
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err), upstream: err?.upstream })
    }
  })

  // GET /api/cost/spend-limits — per-member effective spend limit + month-to-
  // date spend from the Spend Limits API (new 2026-07; GET needs the
  // read:spend_limits scope, which the provisioned key carries). No date
  // params: `period_to_date_spend` is always the current monthly period
  // (resets 00:00 UTC on the 1st). Cursor pagination via next_page.
  router.get('/cost/spend-limits', async (_req, res) => {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) {
      return res.status(400).json({ error: 'analytics_key_required', message: 'ANTHROPIC_ANALYTICS_KEY (with read:spend_limits) is required.' })
    }
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01' }
    try {
      const all = []
      let page = null
      for (let i = 0; i < 20; i++) {
        const params = new URLSearchParams({ limit: '100' })
        if (page) params.set('page', page)
        const r = await fetch(`${apiUrl}/v1/organizations/spend_limits/effective?${params.toString()}`, { headers })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) {
          return res.status(502).json({ error: 'upstream_error', message: `spend_limits/effective ${r.status}`, upstream: body })
        }
        if (Array.isArray(body.data)) all.push(...body.data)
        if (!body.next_page) break
        page = body.next_page
      }
      res.json({ source: 'live', period: 'monthly', members: spendLimitsToMembers(all) })
    } catch (err) {
      res.status(502).json({ error: 'upstream_error', message: err?.message || String(err) })
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
    // This route DELIBERATELY clamps its whole window to today-3, unlike
    // /cost/users: every metric here is a ratio of spend ÷ productivity, and
    // the productivity source (users/range) is hard-clamped to the Analytics
    // 3-day buffer upstream (clampAnalyticsEnd). Letting spend run to `today`
    // while LOC/commits stop at today-3 inflates $/LOC, $/Commit and skews
    // the economic-productivity score — both windows must match. Full-range
    // per-user spend (headline-consistent Top-10) comes from /cost/users,
    // which user_cost_report serves buffer days included. The starting guard
    // prevents an inverted window (fully-recent range → upstream 400).
    const today = new Date(); today.setUTCDate(today.getUTCDate() - 3)
    const maxEnd = today.toISOString().slice(0, 10)

    // ── Spend source: prefer LIVE user_cost_report for the exact selected
    //    range; fall back to the uploaded Spend Report CSV (per-user tokens +
    //    old-date reconciliation). The productivity join below keys on email
    //    either way. ───────────────────────────────────────────────────────
    const bySpendUser = new Map()
    let csvPeriod = null
    let source = 'live+analytics'
    let starting = req.query.starting_date
    let ending = req.query.ending_date || maxEnd
    if (ending > maxEnd) ending = maxEnd
    if (starting && starting > ending) starting = ending

    let liveUsers = []
    try {
      const live = await fetchUserReport({ starting_date: starting, ending_date: ending })
      liveUsers = userCostToUsers(live.data)
      starting = live.period.starting_date
      ending = live.period.ending_date
      csvPeriod = { starting_date: starting, ending_date: ending }
    } catch (err) {
      console.warn(`[cost/efficiency] user_cost_report unavailable, falling back to CSV: ${err?.message || err}`)
      liveUsers = []   // fall through to CSV
    }

    if (liveUsers.length > 0) {
      for (const u of liveUsers) {
        bySpendUser.set(u.email, {
          spend: u.net_spend_usd, prompt_tokens: 0, completion_tokens: 0,
          requests: u.requests, models: new Set(), products: new Set(),
        })
      }
    } else {
      // ── CSV fallback (prior behaviour) ─────────────────────────────────
      source = 'csv+analytics'
      if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
      let csvRows = []
      try {
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'spend-reports/' }))
        const objs = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
        if (objs.length === 0) {
          return res.status(404).json({ error: 'no_spend_report', message: 'No live per-user cost available and no Spend Report CSV uploaded.' })
        }
        const latest = objs.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
        const name = latest.Key.split('/').pop() || ''
        const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
        csvPeriod = m ? { starting_date: m[1], ending_date: m[2] } : null
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
        csvRows = parseCsv(await obj.Body.transformToString()).rows
      } catch (err) {
        return res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
      }
      for (const r of csvRows) {
        const u = bySpendUser.get(r.user_email) ?? { spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0, models: new Set(), products: new Set() }
        u.spend += Number(r.total_net_spend_usd || 0)
        u.prompt_tokens += Number(r.total_prompt_tokens || 0)
        u.completion_tokens += Number(r.total_completion_tokens || 0)
        u.requests += Number(r.total_requests || 0)
        u.models.add(r.model); u.products.add(r.product)
        bySpendUser.set(r.user_email, u)
      }
      starting = starting || csvPeriod?.starting_date
      ending = ending || csvPeriod?.ending_date
      if (ending && ending > maxEnd) ending = maxEnd
      // Re-guard: starting was just re-derived from the CSV period and can
      // land after `ending` again (empty users/range → silent zero scores).
      if (starting && ending && starting > ending) starting = ending
    }

    const isLive = source === 'live+analytics'
    const PORT = Number(process.env.PORT) || 5174

    // Productivity over the selected range (same self-call as before).
    const rangeResp = await fetch(
      `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${encodeURIComponent(starting)}&ending_date=${encodeURIComponent(ending)}`,
    ).then((r) => r.json()).catch(() => ({ days: [] }))

    // Activity-weighted scaling applies ONLY to the CSV path (a fixed-period
    // total). The live path is already range-exact → sameRange=true → ratio 1.
    const sessionsByUserInCsvPeriod = new Map()
    const csvPeriodStart = csvPeriod?.starting_date
    let   csvPeriodEnd   = csvPeriod?.ending_date
    if (csvPeriodEnd && csvPeriodEnd > maxEnd) csvPeriodEnd = maxEnd
    const sameRange = isLive ? true : (csvPeriodStart === starting && csvPeriodEnd === ending)
    if (!isLive && !sameRange && csvPeriodStart && csvPeriodEnd) {
      const csvAnalyticsResp = await fetch(
        `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${encodeURIComponent(csvPeriodStart)}&ending_date=${encodeURIComponent(csvPeriodEnd)}`,
      ).then((r) => r.json()).catch(() => ({ days: [] }))
      for (const d of csvAnalyticsResp.days || []) {
        if (d.source === 'mock') continue
        for (const rec of d.data || []) {
          const sess = rec.claude_code_metrics?.core_metrics?.distinct_session_count ?? 0
          const email = rec.user?.email_address
          if (!email) continue
          sessionsByUserInCsvPeriod.set(email, (sessionsByUserInCsvPeriod.get(email) ?? 0) + sess)
        }
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
          office_messages: 0, office_sessions: 0,
          cowork_actions: 0, cowork_file_edits: 0, cowork_sessions: 0,
          design_projects_created: 0, design_messages: 0, design_sessions: 0,
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
        const off = rec.office_metrics
        if (off) for (const k of ['excel', 'powerpoint', 'word', 'outlook']) {
          u.office_messages += off[k]?.message_count ?? 0
          u.office_sessions += off[k]?.distinct_session_count ?? 0
        }
        const cw = rec.cowork_metrics
        if (cw) {
          u.cowork_actions    += cw.action_count ?? 0
          u.cowork_file_edits += cw.file_edit_count ?? 0
          u.cowork_sessions   += cw.distinct_session_count ?? 0
        }
        const dz = rec.design_metrics
        if (dz) {
          u.design_projects_created += dz.distinct_projects_created_count ?? 0
          u.design_messages         += dz.message_count ?? 0
          u.design_sessions         += dz.distinct_session_count ?? 0
        }
        byProdUser.set(email, u)
      }
    }

    // 5) Join + compute efficiency metrics
    const allEmails = new Set([...bySpendUser.keys(), ...byProdUser.keys()])
    const joined = [...allEmails].map((email) => {
      const s = bySpendUser.get(email) ?? { spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0, models: new Set(), products: new Set() }
      const p = byProdUser.get(email)   ?? { sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0, accepted: 0, rejected: 0, messages: 0, active_days: 0, office_messages: 0, office_sessions: 0, cowork_actions: 0, cowork_file_edits: 0, cowork_sessions: 0, design_projects_created: 0, design_messages: 0, design_sessions: 0 }

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
        // null (not 0) when tokens are unavailable — e.g. the live path has no
        // per-user token counts — so the UI shows "—" rather than a false 0.
        tokens_per_loc:    (p.loc_added > 0 && total_tokens > 0) ? Math.round(total_tokens / p.loc_added) : null,
        // Activity-weighted, range-aware values:
        range_spend_usd,
        range_prompt_tokens,
        range_completion_tokens,
        range_total_tokens,
        range_requests,
        messages: p.messages,
        office_messages: p.office_messages,
        office_sessions: p.office_sessions,
        cowork_actions: p.cowork_actions,
        cowork_file_edits: p.cowork_file_edits,
        cowork_sessions: p.cowork_sessions,
        design_projects_created: p.design_projects_created,
        design_messages: p.design_messages,
        design_sessions: p.design_sessions,
        sessions_in_csv_period: sessionsCsv,
        activity_ratio: Number(ratio.toFixed(4)),
      }
    })

    // v3 cost-efficiency scoring — pure, unit-tested. See scoreEconomicProductivity.
    const scored = scoreEconomicProductivity(joined)

    // Cohort median of the final score — the org-level headline KPI for v3.
    const scoreVals = scored.map((u) => u.economic_productivity_score).sort((a, b) => a - b)
    const median_score = scoreVals.length
      ? (scoreVals.length % 2
          ? scoreVals[(scoreVals.length - 1) / 2]
          : Math.round((scoreVals[scoreVals.length / 2 - 1] + scoreVals[scoreVals.length / 2]) / 2))
      : 0

    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0 })

    res.json({
      score_version: '3.0',
      source,
      period: csvPeriod,
      user_count: scored.length,
      totals: {
        spend_usd: Number(totals.spend_usd.toFixed(2)),
        loc_added: totals.loc_added,
        commits:   totals.commits,
        prs:       totals.prs,
        prompt_tokens:     totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        median_score,
        avg_cost_per_loc:    totals.loc_added > 0 ? Number((totals.spend_usd / totals.loc_added).toFixed(4)) : null,
        avg_cost_per_commit: totals.commits   > 0 ? Number((totals.spend_usd / totals.commits).toFixed(2))   : null,
      },
      users: scored.sort((a, b) => b.economic_productivity_score - a.economic_productivity_score),
    })
  })

  // ── Group mapping (admin email→group CSV in S3) ─────────────────────────
  // The Analytics API's rbac_group_id / claude_project_id group dimensions
  // return HTTP 400 ("not yet supported") and user records carry no group
  // field, so groups come from an admin-uploaded `email,group` CSV stored
  // latest-wins at s3://<archive>/group-map/. Reuses the spend-report upload
  // infra (uploadSingle multer wrapper, s3 client, parseCsv, parseGroupMap).
  const GROUP_MAP_REQUIRED_COLUMNS = ['email', 'group']

  // POST /api/groups/upload (multipart, field "file") — validate + store latest-wins.
  router.post('/groups/upload', uploadSingle, async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Attach a CSV file under field name "file".' })
    try {
      const body = req.file.buffer.toString('utf8')
      const { columns } = parseCsv(body)
      const missing = GROUP_MAP_REQUIRED_COLUMNS.filter((c) => !columns.includes(c))
      if (missing.length) {
        return res.status(400).json({
          error: 'schema_mismatch',
          message: `CSV is missing required columns: ${missing.join(', ')}`,
          expected: GROUP_MAP_REQUIRED_COLUMNS, found: columns,
        })
      }
      const { map, groups } = parseGroupMap(body)
      if (groups.length === 0) {
        return res.status(400).json({ error: 'empty_mapping', message: 'CSV has no valid email,group rows.' })
      }
      const d = new Date().toISOString().slice(0, 10)
      const key = `group-map/group-map-${d}.csv`
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: 'text/csv',
        Metadata: { uploadedVia: 'dashboard', originalName: req.file.originalname.slice(0, 250) },
      }))
      res.json({ ok: true, file: key.split('/').pop(), rows: Object.keys(map).length, groups })
    } catch (err) {
      console.error('[groups/upload] error:', err?.message || err)
      res.status(500).json({ error: 'upload_failed', message: err?.message || String(err) })
    }
  })

  // GET /api/groups — latest mapping under group-map/ → { source, file, groups, map }.
  // No CSV uploaded → AUTO-DERIVE the mapping from live user_cost_report ×
  // rbac_group_id (default 31-day window): each user maps to their max-spend
  // RBAC group, labeled with REAL names via fetchGroupNames (grp- fallback).
  // An uploaded CSV still wins — it carries admin-chosen names and intent.
  // Nothing derivable either → { source:'empty', groups:[], map:{} } (200).
  router.get('/groups', async (_req, res) => {
    // The bucket is only needed for the CSV path — auto-derive works without
    // it (local dev has no ARCHIVE_S3_BUCKET but does have the Analytics key).
    // An S3 listing failure also degrades to auto-derive instead of a 500.
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    try {
      let objects = []
      if (BUCKET) {
        try {
          const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'group-map/' }))
          objects = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
        } catch (err) {
          console.warn('[groups] S3 list failed, trying auto-derive:', err?.message || err)
        }
      }
      if (objects.length === 0) {
        try {
          const live = await fetchUserReport({ groupBy: 'rbac_group_id' })
          const derived = deriveGroupMap(live.data, await fetchGroupNames())
          if (derived.groups.length > 0) {
            const out = {
              source: 'auto', file: null, period: live.period,
              groups: derived.groups, map: derived.map, group_ids: derived.ids,
            }
            rememberGroupResult('groups:auto', out)
            return res.json(out)
          }
        } catch (err) {
          // rbac_group_id flaps upstream (503 "Team membership data is not
          // ready yet") — serve the last successful derivation if we have one.
          const stale = groupLastGood.get('groups:auto')
          if (stale) {
            console.warn('[groups] auto-derive upstream failure; serving last-good map:', err?.message || err)
            return res.json({ ...stale, stale: true })
          }
          console.warn('[groups] auto-derive unavailable, falling back to empty:', err?.message || err)
        }
        return res.json({ source: 'empty', file: null, groups: [], map: {} })
      }
      const latest = objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      const { map, groups } = parseGroupMap(body)
      res.json({ source: 'live', file: latest.Key.split('/').pop(), groups, map })
    } catch (err) {
      console.error('[groups] error:', err?.message || err)
      res.status(500).json({ error: 'groups_read_failed', message: err?.message || String(err) })
    }
  })

  app.use('/api', router)
}

// Minimal CSV parser that handles quoted fields and commas inside quotes.
function parseCsv(text) {
  // Strip a leading UTF-8 BOM (Excel / Google Sheets prepend one on CSV export);
  // left in place it fuses onto the first header cell ("﻿user_email") and
  // every column lookup silently misses. Then normalize CRLF → LF.
  const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.length > 0)
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

// Pure: parse an `email,group` CSV into a lookup map + sorted unique group list.
// Emails are lowercased for case-insensitive matching. Rows missing either field
// (or with empty values) are skipped; duplicate emails take the last row. Returns
// { map:{}, groups:[] } when the CSV lacks the required columns or is empty.
// Exported for unit tests; the upload route validates column presence separately.
export function parseGroupMap(csvText) {
  const { columns, rows } = parseCsv(String(csvText ?? ''))
  if (!columns.includes('email') || !columns.includes('group')) return { map: {}, groups: [] }
  const map = {}
  const groupSet = new Set()
  for (const r of rows) {
    const email = String(r.email ?? '').trim().toLowerCase()
    const group = String(r.group ?? '').trim()
    if (!email || !group) continue
    map[email] = group
    groupSet.add(group)
  }
  return { map, groups: [...groupSet].sort() }
}
