import { useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupScopeNote } from '../components/GroupScopeNote'
import { GroupTabs } from '../components/GroupTabs'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { CsvUploader } from '../components/CsvUploader'
import { DateRangeControl } from '../components/DateRangeControl'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtPct, maskEmail, fmtNum } from '../lib/format'
import { useSortable } from '../lib/useSortable'
import { SortableTh } from '../components/SortableTh'

type CsvRow = {
  user_email: string
  account_uuid: string
  product: string
  model: string
  total_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_net_spend_usd: number
  total_gross_spend_usd: number
}

type DailyPoint = { date: string; model: string; spend: number; input: number; output: number; requests: number }

type CsvResp = {
  source: 'csv' | 'live'
  file: string | null
  last_modified: string
  data_refreshed_at?: string | null
  // Echo of the applied upstream rbac_group_ids[] filter — the client only
  // trusts a scope the server confirms (guards rolling-deploy skew where an
  // old task ignores the param and serves org-wide data).
  rbac_group_id?: string
  // Set when the server serves a per-(window,group) last-good payload
  // because the scoped upstream is flapping.
  stale?: boolean
  by_cost_type?: { cost_type: string; spend_usd: number }[]
  by_token_type?: { token_type: string; spend_usd: number }[]
  token_tiers?: {
    uncached: number; cache_read: number; cache_creation: number; output: number
    input_total: number; cache_hit_rate: number | null
  }
  period: { starting_date: string; ending_date: string } | null
  rows: CsvRow[]
  daily?: DailyPoint[]
  totals: {
    requests: number
    prompt_tokens: number
    completion_tokens: number
    net_spend_usd: number
    gross_spend_usd: number
    distinct_users: number
    distinct_models: number
    distinct_products: number
  }
}

const MODEL_COLORS: Record<string, string> = {
  claude_opus_4_7:            '#8E4830',
  claude_opus_4_6:            '#B75E40',
  claude_opus_4_5_20251101:   '#D97757',
  claude_sonnet_4_6:          '#E69F7F',
  claude_haiku_4_5_20251001:  '#EEBFAA',
  claude_haiku_4_5:           '#F5DCCF',
}
// Keys match the snake_case `product` values cost_report returns. The API moved
// from Title Case to snake_case, so the old Title-Case keys silently fell back
// to FALLBACK for EVERY product (and the legend showed raw "claude_in_chrome").
// Add new surfaces here as Anthropic ships them.
const PRODUCT_COLORS: Record<string, string> = {
  claude_code:      '#D97757',
  chat:             '#1F1E1D',
  cowork:           '#B75E40',
  claude_design:    '#4CA371',
  claude_in_chrome: '#8A8474',
  code_review:      '#CC7722',
  research:         '#6A8EAE',
  other:            '#D7D3C7',
}
const PRODUCT_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  chat: 'Chat',
  cowork: 'Cowork',
  claude_design: 'Claude Design',
  claude_in_chrome: 'Claude in Chrome',
  code_review: 'Code Review',
  research: 'Research',
  other: 'Other',
}
// snake_case product id → display label; Title-Cases any unknown/new id.
const productLabel = (p: string) =>
  PRODUCT_LABELS[p] || String(p).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const FALLBACK = ['#D97757', '#1F1E1D', '#8A8474', '#B75E40', '#D7D3C7', '#E69F7F', '#4CA371', '#CC7722']
// cost_report cost_type → dot color. Labels are i18n'd in the component (t('cost.type.*')).
const COST_TYPE_COLORS: Record<string, string> = {
  tokens:         '#D97757',
  web_search:     '#6A8EAE',
  code_execution: '#4CA371',
}
// usage/cost token_type → display tier (cache_creation 1h+5m fold into "cache_write").
const TOKEN_TIER_OF: Record<string, string> = {
  uncached_input_tokens: 'uncached',
  cache_read_input_tokens: 'cache_read',
  'cache_creation.ephemeral_1h_input_tokens': 'cache_write',
  'cache_creation.ephemeral_5m_input_tokens': 'cache_write',
  output_tokens: 'output',
}
const TOKEN_TIER_COLORS: Record<string, string> = {
  uncached: '#CC7722', cache_read: '#4CA371', cache_write: '#6A8EAE', output: '#1F1E1D',
}

const shortModel = (m: string) =>
  m.replace(/^claude_/, '').replace(/_v\d+:\d+$/, '').replace(/_\d{8}$/, '').replace(/_/g, ' ')
// user_cost_report returns hyphenated model ids (claude-opus-4-8); MODEL_COLORS
// keys + shortModel expect underscores. Normalize before lookup/label.
const normModel = (m: string) => String(m).replace(/-/g, '_')

function fmtUsd(v: number) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 10)   return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

type EfficiencyUser = {
  email: string
  // CSV-period totals (whole CSV period, range-agnostic):
  spend_usd: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  requests: number
  // Activity-weighted scaling to the selected range (sessions_in_range /
  // sessions_over_csv_period, capped at 1.0). If the range matches the CSV
  // period these equal the totals above.
  range_spend_usd?: number
  range_prompt_tokens?: number
  range_completion_tokens?: number
  range_total_tokens?: number
  range_requests?: number
  activity_ratio?: number
  loc_added: number
  commits: number
  prs: number
  sessions: number
  tool_acceptance_rate: number | null
  output_score: number
  cost_per_loc: number | null
  cost_per_commit: number | null
  cost_per_pr: number | null
  output_per_dollar: number | null
  tokens_per_loc: number | null
  economic_productivity_score: number
  surface_scores?: { code: number; cowork: number; office: number; design: number }
  productivity_index?: number
  efficiency_raw?: number
}

type EfficiencyResp = {
  source: string
  period: { starting_date: string; ending_date: string } | null
  user_count: number
  totals: {
    spend_usd: number; loc_added: number; commits: number; prs: number
    prompt_tokens: number; completion_tokens: number
    avg_cost_per_loc: number | null
    avg_cost_per_commit: number | null
    median_score?: number
  }
  users: EfficiencyUser[]
}

type CostSource = 'live' | 'csv'

/**
 * Composite cost data hook.
 * Tries /api/cost/live first; if it errors OR returns rows=[], silently falls
 * back to /api/cost/csv. Both queries fire in parallel (cheap due to S3+cache
 * on the CSV path); the active one is selected here.
 *
 * `rbacGroupId` (optional) scopes the live path to one RBAC group via the
 * upstream `rbac_group_ids[]` filter. While it is set, an EMPTY live result
 * is a legitimate answer (no spend attributed to that group in-window) and
 * must NOT trigger the CSV fallback — the CSV is org-wide and would silently
 * misrepresent the scope.
 *
 * `csvData` is exposed separately so the page can still render per-user TOKEN
 * widgets from CSV. Per-user USD spend is now live via `user_cost_report` (see
 * /cost/efficiency + ADR-0009); the CSV is a complementary layer for per-user
 * token counts (not exposed live) and old-date reconciliation.
 */
export function useCostData(range: { startingDate: string; endingDate: string }, rbacGroupId?: string | null) {
  const liveUrl = `/api/cost/live?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
    + (rbacGroupId ? `&rbac_group_id=${encodeURIComponent(rbacGroupId)}` : '')
  const live = useFetch<CsvResp>(liveUrl)
  const csv  = useFetch<CsvResp>('/api/cost/csv')

  // A requested scope counts only when the server ECHOES the id back —
  // during a rolling deploy an old task ignores the param and serves
  // org-wide data, which must not pass as "scoped" (nor may its rows=[]
  // suppress the CSV fallback).
  const scopeConfirmed = !!rbacGroupId && live.data?.rbac_group_id === rbacGroupId
  const liveUsable = !live.error && ((live.data?.rows.length ?? 0) > 0 || scopeConfirmed)
  // Fall back to CSV only once the live fetch has SETTLED — flipping while a
  // group-tab/range change is in flight flashed org-wide CSV numbers (or the
  // no-CSV empty state) for the duration of every refetch.
  const useCsv = !live.loading && !liveUsable

  // Stale-while-revalidate: useFetch keeps the previous response while a new
  // URL is in flight, so a SAME-SCOPE refetch (range change, manual refetch)
  // can keep rendering it under a "refreshing" badge instead of a full-page
  // loading veil. A SCOPE change never reuses it — old-scope numbers under a
  // new group tab would mislead — so those transitions keep the veil (the
  // server's 10-min cost cache makes returns to a recent scope near-instant).
  const swrData = live.loading && live.data != null
    && (live.data.rbac_group_id ?? null) === (rbacGroupId ?? null)
    && ((live.data.rows.length ?? 0) > 0 || !!rbacGroupId)
    ? live.data : null
  const data = live.loading ? swrData : (useCsv ? csv.data : live.data)
  const refreshing = live.loading && swrData != null
  const source: CostSource = useCsv ? 'csv' : 'live'

  // Loading: live in flight with nothing safely renderable (scope-changed
  // stale data must not render), or nothing usable yet while CSV loads.
  const loading = (live.loading && swrData == null) || (data == null && csv.loading)
  // Errors surface only after settle. With a scope requested, a live failure
  // surfaces as-is — the org-wide CSV must not silently replace a scoped
  // view. Otherwise (org-wide), CSV's error only matters once we actually
  // fell back to it; live errors just trigger the fallback.
  const error = live.loading ? null
    : (rbacGroupId && live.error ? live.error : (useCsv ? csv.error : null))

  const refetch = useCallback(
    async () => { await live.refetch(); await csv.refetch() },
    [live.refetch, csv.refetch],
  )
  return { data, loading, error, source, refetch, refreshing, csvData: csv.data }
}

export function Cost() {
  const t = useT()
  const { range } = useDateRange('1d')
  // Group scope. Per-user tables/charts filter by email (inGroup). The
  // org-level aggregates (KPIs, pies, trends) scope via the upstream
  // rbac_group_ids[] filter when the selected group's id is known (members/
  // auto mapping + live mode) — `groupScoped` below. CSV mode and UNMAPPED
  // can't be filtered upstream → partial-variant note, as before.
  const { group, groupId, setGroup, inGroup } = useGroupScope()
  // Live API (Claude Code only) with automatic CSV fallback.
  // The CSV path also handles the >30-day reconciliation use case.
  const { data, loading, error, refetch, refreshing, source: dataSource, csvData } = useCostData(range, groupId)
  // True when the org-level numbers on this page reflect ONLY the selected
  // group — requires the server's echo, not just the client's request (see
  // useCostData). False → per-user surfaces still scope, org aggregates are
  // org-wide (partial note).
  const groupScoped = dataSource === 'live' && !!groupId && data?.rbac_group_id === groupId
  const effUrl = `/api/cost/efficiency?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const eff = useFetch<EfficiencyResp>(effUrl)
  // Per-user × model spend (chargeback) — wires the /cost/users route with by=model.
  // Also the source of the Top-10 cost table (full-range spend; see liveUserRows).
  const usersByModel = useFetch<{ users: { email: string; net_spend_usd: number; requests: number; by_model: { model: string; spend_usd: number; requests: number }[] }[] }>(
    `/api/cost/users?by=model&starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  // Per-user TOKEN counts, live from user_usage_report (new upstream
  // endpoint) — replaces the CSV as the primary token source, so the token
  // Top-10 tables now follow the selected range like everything else.
  const userTokens = useFetch<{
    users: { email: string; input_tokens: number; output_tokens: number; total_tokens: number; requests: number }[]
    period: { starting_date: string; ending_date: string }
  }>(`/api/cost/user-tokens?starting_date=${range.startingDate}&ending_date=${range.endingDate}`)
  // Per-member effective spend limit + month-to-date spend (Spend Limits API).
  const spendLimits = useFetch<{
    members: { email: string; name: string | null; limit_usd: number | null; spent_usd: number; utilization: number | null; source: string }[]
  }>('/api/cost/spend-limits')
  // Spend by RBAC group (native Analytics attribution; labels resolve to real
  // group names via GET /v1/compliance/groups, grp-<id suffix> fallback).
  const groupCost = useFetch<{
    groups: { group_id: string; label: string; spend_usd: number; requests: number }[]
    ungrouped: { spend_usd: number; requests: number }
    period: { starting_date: string; ending_date: string }
    // true when the server served a last-good payload because the upstream
    // rbac_group_id dimension is flapping (503 "not ready yet").
    stale?: boolean
  }>(`/api/cost/groups?starting_date=${range.startingDate}&ending_date=${range.endingDate}`)

  // After a successful upload/delete, invalidate the live cost + efficiency
  // queries that depend on the S3 spend-reports/ prefix.
  const onUploadChange = () => { refetch(); eff.refetch() }

  // Browser-native print → "Save as PDF" in the print dialog. The
  // app-print body class swaps in @media print rules from index.css
  // that hide everything except .print-export.
  const exportPdf = useCallback(() => {
    const restore = () => document.body.classList.remove('app-print')
    document.body.classList.add('app-print')
    window.addEventListener('afterprint', restore, { once: true })
    setTimeout(() => window.print(), 50)
  }, [])

  // Derived insights — cost per active developer + 30-day projection.
  // Per-dev works in both live and CSV (uses any of: efficiency user_count,
  // CSV distinct_users, or model count as a last-resort fallback).
  // Projection only renders when live mode supplies a `daily` series.
  const insights = useMemo(() => {
    if (!data) return null
    const totalSpend = data.totals.net_spend_usd
    // Under an active upstream group scope the numerator is group-only, so
    // the denominator must be too — count the group's members from the
    // per-user efficiency rows. null = "don't know yet" (eff still loading
    // or errored): render a placeholder, never $0.00 against real spend.
    const activeDevs: number | null = groupScoped
      ? (eff.data ? eff.data.users.filter((u) => inGroup(u.email)).length : null)
      : (eff.data?.user_count ||
         csvData?.totals?.distinct_users ||
         data.totals.distinct_users)
    const costPerDev = activeDevs
      ? totalSpend / activeDevs
      : (totalSpend > 0 ? null : 0)

    let projection30d: number | null = null
    let avg7d: number | null = null
    if (data.daily?.length) {
      const byDate = new Map<string, number>()
      for (const d of data.daily) byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.spend ?? 0))
      const sortedSpend = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)
      const last7 = sortedSpend.slice(-7)
      if (last7.length > 0) {
        avg7d = last7.reduce((a, b) => a + b, 0) / last7.length
        projection30d = avg7d * 30
      }
    }
    return { costPerDev, activeDevs, projection30d, avg7d }
  }, [data, eff.data, csvData, groupScoped, inGroup])

  const agg = useMemo(() => {
    if (!data?.rows) return null
    const rows = data.rows

    // by user
    const byUser = new Map<string, { spend: number; input: number; output: number; requests: number; products: Set<string>; models: Set<string> }>()
    // by model
    const byModel = new Map<string, { spend: number; input: number; output: number; requests: number }>()
    // by product
    const byProduct = new Map<string, { spend: number; input: number; output: number; requests: number }>()
    // product × model matrix
    const matrix = new Map<string, Map<string, number>>()

    for (const r of rows) {
      // per-user rows honor the group scope; the model/product/matrix
      // aggregations below follow whatever the rows already are — org-wide
      // normally, group-only when the upstream rbac_group_ids[] filter is
      // active (groupScoped)
      if (inGroup(r.user_email)) {
        const u = byUser.get(r.user_email) ?? { spend: 0, input: 0, output: 0, requests: 0, products: new Set<string>(), models: new Set<string>() }
        u.spend += r.total_net_spend_usd; u.input += r.total_prompt_tokens; u.output += r.total_completion_tokens
        u.requests += r.total_requests; u.products.add(r.product); u.models.add(r.model)
        byUser.set(r.user_email, u)
      }

      const m = byModel.get(r.model) ?? { spend: 0, input: 0, output: 0, requests: 0 }
      m.spend += r.total_net_spend_usd; m.input += r.total_prompt_tokens; m.output += r.total_completion_tokens; m.requests += r.total_requests
      byModel.set(r.model, m)

      const p = byProduct.get(r.product) ?? { spend: 0, input: 0, output: 0, requests: 0 }
      p.spend += r.total_net_spend_usd; p.input += r.total_prompt_tokens; p.output += r.total_completion_tokens; p.requests += r.total_requests
      byProduct.set(r.product, p)

      const pm = matrix.get(r.product) ?? new Map<string, number>()
      pm.set(r.model, (pm.get(r.model) ?? 0) + r.total_net_spend_usd)
      matrix.set(r.product, pm)
    }

    const userRows = [...byUser.entries()].map(([email, u]) => ({
      email,
      masked: maskEmail(email),
      spend: u.spend, input: u.input, output: u.output, total_tokens: u.input + u.output,
      requests: u.requests,
      products: u.products.size,
      models: u.models.size,
    }))

    const totalSpend = data.totals.net_spend_usd
    const modelRows = [...byModel.entries()].map(([model, m]) => ({
      model, short: shortModel(model),
      spend: m.spend, input: m.input, output: m.output, requests: m.requests,
      share: totalSpend > 0 ? m.spend / totalSpend : 0,
    })).sort((a, b) => b.spend - a.spend)

    const productRows = [...byProduct.entries()].map(([product, p]) => ({
      product, spend: p.spend, input: p.input, output: p.output, requests: p.requests,
      share: totalSpend > 0 ? p.spend / totalSpend : 0,
    })).sort((a, b) => b.spend - a.spend)

    // Matrix for stacked bar: products × models
    const allModels = [...new Set(rows.map((r) => r.model))].sort()
    const productModelStack = productRows.map((p) => {
      const row: Record<string, any> = { product: p.product }
      for (const m of allModels) {
        row[shortModel(m)] = matrix.get(p.product)?.get(m) ?? 0
      }
      return row
    })

    return { userRows, modelRows, productRows, productModelStack, allModels }
  }, [data, inGroup])

  // Per-user aggregation: prefer the activity-weighted range_* fields from
  // /api/cost/efficiency (which scales each user's CSV-period total spend by
  // sessions_in_range/sessions_in_csv_period), so the per-user numbers
  // respond to the selected date range. Fall back to raw CSV totals
  // (range-agnostic) if eff data isn't available.
  const effUserRows = useMemo(() => {
    if (!eff.data?.users?.length) return null
    // null (not []) when the group filter empties the rows, so the ?? source
    // chains below keep their "no usable rows → next source" semantics
    const rows = eff.data.users.filter((u) => inGroup(u.email)).map((u) => ({
      email: u.email,
      masked: maskEmail(u.email),
      spend: u.range_spend_usd ?? u.spend_usd,
      input: u.range_prompt_tokens ?? u.prompt_tokens,
      output: u.range_completion_tokens ?? u.completion_tokens,
      total_tokens: u.range_total_tokens ?? u.total_tokens,
      requests: u.range_requests ?? u.requests,
      products: 0,  // not provided by eff endpoint
      models: 0,    // not provided by eff endpoint
    }))
    return rows.length ? rows : null
  }, [eff.data, inGroup])

  // Live per-user spend over the FULL selected range, reusing the
  // usersByModel fetch (user_cost_report serves the 3-day buffer with partial
  // data, so this matches the headline KPI window exactly). This — not
  // /cost/efficiency — feeds the Top-10 cost table: the efficiency route
  // deliberately clamps to today-3 to keep its spend÷productivity ratios
  // window-aligned with users/range, which would leave this table 3 days
  // short of the headline.
  const liveUserRows = useMemo(() => {
    if (!usersByModel.data?.users?.length) return null
    const rows = usersByModel.data.users.filter((u) => inGroup(u.email)).map((u) => ({
      email: u.email,
      masked: maskEmail(u.email),
      spend: u.net_spend_usd,
      input: 0, output: 0, total_tokens: 0,   // user_cost_report is cost-only
      requests: u.requests ?? 0,
      products: 0,
      models: u.by_model.length,
    }))
    return rows.length ? rows : null
  }, [usersByModel.data, inGroup])

  const csvUserRows = useMemo(() => {
    if (!csvData?.rows?.length) return null
    const byUser = new Map<string, { spend: number; input: number; output: number; requests: number; products: Set<string>; models: Set<string> }>()
    for (const r of csvData.rows) {
      if (!inGroup(r.user_email)) continue
      const u = byUser.get(r.user_email) ?? { spend: 0, input: 0, output: 0, requests: 0, products: new Set<string>(), models: new Set<string>() }
      u.spend += r.total_net_spend_usd
      u.input += r.total_prompt_tokens
      u.output += r.total_completion_tokens
      u.requests += r.total_requests
      u.products.add(r.product)
      u.models.add(r.model)
      byUser.set(r.user_email, u)
    }
    const rows = [...byUser.entries()].map(([email, u]) => ({
      email,
      masked: maskEmail(email),
      spend: u.spend,
      input: u.input,
      output: u.output,
      total_tokens: u.input + u.output,
      requests: u.requests,
      products: u.products.size,
      models: u.models.size,
    }))
    return rows.length ? rows : null
  }, [csvData, inGroup])

  // Live per-user token rows (user_usage_report). MUST stay above the early
  // returns below — hooks after a conditional return violate the Rules of
  // Hooks and crash the page on the loading→loaded transition.
  const liveTokenRows = useMemo(() => {
    if (!userTokens.data?.users?.length) return null
    const rows = userTokens.data.users.filter((u) => inGroup(u.email)).map((u) => ({
      email: u.email,
      masked: maskEmail(u.email),
      spend: 0,   // token endpoint is token-only; spend table uses liveUserRows
      input: u.input_tokens,
      output: u.output_tokens,
      total_tokens: u.total_tokens,
      requests: u.requests ?? 0,
      products: 0,
      models: 0,
    }))
    return rows.length ? rows : null
  }, [userTokens.data, inGroup])

  const trendsPivot = useMemo(() => {
    if (!data?.daily || data.daily.length === 0) return { rows: [], models: [] }
    const byDate = new Map<string, Record<string, any>>()
    const models = new Set<string>()
    for (const d of data.daily) {
      models.add(d.model)
      const row = byDate.get(d.date) ?? { date: d.date }
      row[shortModel(d.model)] = (row[shortModel(d.model)] ?? 0) + d.spend
      byDate.set(d.date, row)
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    return { rows, models: [...models].sort() }
  }, [data])

  if (loading) return <LoadingState />
  if (error) {
    // A failed GROUP-SCOPED live fetch must not degrade into the org-wide
    // CSV flow (misrepresents the scope) or the raw error page. Offer the
    // honest way out: retry later or drop back to All groups. The server
    // already absorbs flaps with a per-(window,group) last-good, so this is
    // the cold-cache-during-flap path only.
    if (groupId) {
      const label = group === UNMAPPED ? t('group.unmapped') : group
      return (
        <div>
          <PageHeader title={t('cost.title')} subtitle={t('cost.subtitle')} />
          <GroupTabs />
          <div className="p-4 lg:p-8 print:p-8">
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-[12px] text-amber-900">
              <b className="text-amber-800">{t('cost.scope.unavailable.title', { group: label })}</b>
              <p className="mt-1">{t('cost.scope.unavailable.body')}</p>
              <button
                onClick={() => setGroup('')}
                className="mt-2 rounded-full border border-amber-300 bg-white px-3 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              >
                {t('cost.scope.view_all')}
              </button>
            </div>
          </div>
        </div>
      )
    }
    // Check if it's just a missing spend report (404) — show a friendly empty state
    if (error.includes('no_spend_report') || error.includes('404')) {
      return (
        <div>
          <PageHeader title={t('cost.title')} subtitle={t('cost.subtitle')} />
          <div className="p-4 lg:p-8 print:p-8 space-y-4">
            <EmptyState title={t('cost.empty')} hint={t('cost.empty.hint')} />
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-[12px] text-amber-900">
              <b className="text-amber-800">{t('cost.csv_upload.title')}</b>
              <p className="mt-1">{t('cost.csv_upload.body')}</p>
            </div>
            <CsvUploader onChange={onUploadChange} variant="full" />
          </div>
        </div>
      )
    }
    return <ErrorState error={error} />
  }

  if (!agg || !data) {
    return (
      <div>
        <PageHeader title={t('cost.title')} subtitle={t('cost.subtitle')} />
        <EmptyState title={t('cost.empty')} hint={t('cost.empty.hint')} />
      </div>
    )
  }

  // Per-user SPEND table preference order:
  //   1. liveUserRows — user_cost_report over the FULL selected range
  //      (same window as the headline KPIs, buffer days included)
  //   2. eff.data.users — live spend clamped to today-3 (window-aligned with
  //      the productivity join) or CSV-derived scaled spend in CSV mode
  //   3. csvUserRows (raw CSV totals) when eff is loading / returns no users
  //   4. agg.userRows (live cost rows; user_email empty in live mode → unused)
  const userRowsForTop = liveUserRows ?? effUserRows ?? csvUserRows ?? agg.userRows
  // Per-user TOKEN source priority:
  //   1. liveTokenRows — user_usage_report over the FULL selected range
  //      (live; supersedes the old "tokens exist only in the CSV" constraint)
  //   2. eff's rows in CSV mode (activity-scaled range_* token fields)
  //   3. raw csvUserRows (whole-CSV-period totals — tokens_csv_caveat labels
  //      them). Never the live spend rows (their token fields are 0).
  // (liveTokenRows itself is a hook, so it lives ABOVE the early returns
  //  with the other memos — see the hook-ordering note there.)
  const tokenRows = liveTokenRows ?? (eff.data?.source?.includes('csv') ? effUserRows : null) ?? csvUserRows
  const hasPerUserTokens = !!(tokenRows && tokenRows.length > 0 && tokenRows[0].email !== '')
  const topSpend  = [...userRowsForTop].sort((a, b) => b.spend - a.spend).slice(0, 10)
  const topInput  = [...(tokenRows ?? [])].sort((a, b) => b.input - a.input).slice(0, 10)
  const topOutput = [...(tokenRows ?? [])].sort((a, b) => b.output - a.output).slice(0, 10)
  const topTotal  = [...(tokenRows ?? [])].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 10)

  return (
    <div>
      <PageHeader
        title={t('cost.title')}
        subtitle={data.period
          ? t('cost.subtitle.csv', { start: data.period.starting_date, end: data.period.ending_date })
          : t('cost.subtitle')}
        source={dataSource}
        reason={
          dataSource === 'live'
            ? t('cost.source.live')
            : data.file
              ? `CSV · ${data.file}`
              : t('cost.source.csv')
        }
      />
      <GroupTabs />
      <div className="p-4 lg:p-8 print:p-8 space-y-6 print-export">
        {/* Inside .print-export so the scope indicator survives Save-as-PDF —
            the per-user tables below ARE group-filtered and a printout must
            say so. Self-hides when no group is selected. */}
        <GroupScopeNote variant={groupScoped ? 'scoped' : 'partial'} />
        {/* Upstream cost attribution rides a slow membership SNAPSHOT — a
            newly created group (or fresh member moves) keeps attributing to
            the users' prior groups for up to ~a day (verified live
            2026-07-12: 14h-old moves still attributed to the old groups
            while data_refreshed_at was current). Say so instead of showing a
            silent $0 wall. */}
        {groupScoped && data.totals.net_spend_usd === 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
            {t('cost.scope.zero_attribution', { group: group === UNMAPPED ? t('group.unmapped') : group })}
          </div>
        )}
        {group && (usersByModel.data?.users?.length ?? 0) > 0 && liveUserRows === null && (
          <div className="rounded-lg border border-ink-100 bg-paper-muted/40 px-4 py-3 text-[12px] text-ink-500">
            {t('group.scoped_empty', { group: group === UNMAPPED ? t('group.unmapped') : group })}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 print-hide">
          {/* Real data-freshness from the API (cost_report data_refreshed_at),
              not the request time — sets expectations vs the 3-day buffer. */}
          <div className="text-[11px] text-ink-400">
            {dataSource === 'live' && data.data_refreshed_at && (
              <span title={t('cost.data_as_of.hint')}>
                {t('cost.data_as_of')}: <b className="text-ink-600 tabular-nums">{data.data_refreshed_at.replace('T', ' ').slice(0, 16)} UTC</b>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
          {/* Single page-level range control — drives ALL cost content
              (useCostData + efficiency share this URL-synced range). Default
              '1d' = the most recent finalized day (daily live). */}
          <DateRangeControl defaultPreset="1d" />
          <button
            onClick={exportPdf}
            title={t('cost.export.pdf.hint')}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5"
          >
            <span aria-hidden>🖨</span>
            {t('cost.export.pdf')}
          </button>
          </div>
        </div>
        {dataSource === 'live' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
            {t('cost.live.caveat.30day')}
          </div>
        )}
        {refreshing && (
          <div className="text-[10px] text-ink-400 animate-pulse">{t('cost.refreshing')}</div>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard
            accent
            label={t('cost.kpi.total')}
            value={fmtUsd(data.totals.net_spend_usd)}
            hint={
              // Per-user attribution now comes from live user_cost_report
              // (eff.user_count); CSV's distinct_users is the fallback. Under
              // an active group scope the count must be the GROUP's members —
              // insights.activeDevs is already group-aware (null = unknown).
              groupScoped
                ? (insights?.activeDevs != null
                    ? `${fmtNum(insights.activeDevs)} users · ${data.totals.distinct_models} models`
                    : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`)
                : ((eff.data?.user_count || csvData?.totals?.distinct_users)
                    ? `${fmtNum(eff.data?.user_count || csvData?.totals?.distinct_users)} users · ${data.totals.distinct_models} models`
                    : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`)
            }
          />
          <KpiCard label={t('cost.kpi.input')}  value={fmtCompact(data.totals.prompt_tokens)}     hint="prompt tokens" />
          <KpiCard label={t('cost.kpi.output')} value={fmtCompact(data.totals.completion_tokens)} hint="completion tokens" />
          <KpiCard
            label={t('cost.kpi.requests')}
            value={fmtCompact(data.totals.requests)}
            hint={`${data.totals.distinct_models} models · ${data.totals.distinct_products} products`}
          />
        </div>

        {/* Forecast / per-developer KPIs (always shown; forecast columns
            only render when live mode supplies a daily series). */}
        {insights && (
          <div className={`grid gap-4 ${insights.projection30d != null ? 'grid-cols-1 sm:grid-cols-3 print:grid-cols-3' : 'grid-cols-1'}`}>
            <KpiCard
              label={t('cost.kpi.per_dev')}
              value={insights.costPerDev != null ? fmtUsd(insights.costPerDev) : '—'}
              hint={insights.activeDevs != null
                ? t('cost.kpi.per_dev.hint', { n: fmtNum(insights.activeDevs) })
                : t('cost.kpi.per_dev.hint.pending')}
            />
            {insights.projection30d != null && insights.avg7d != null && (
              <>
                <KpiCard
                  label={t('cost.kpi.projection_30d')}
                  value={fmtUsd(insights.projection30d)}
                  hint={t('cost.kpi.projection_30d.hint')}
                />
                <KpiCard
                  label={t('cost.kpi.avg7d')}
                  value={fmtUsd(insights.avg7d)}
                  hint={t('cost.kpi.avg7d.hint')}
                />
              </>
            )}
          </div>
        )}

        {/* Prompt-cache efficiency — cache-hit ratio (the biggest Claude Code cost
            lever) + token-tier $ breakdown (cache_creation 1h+5m folded). The
            current input-token collapse in the cost reshape hides this. */}
        {dataSource === 'live' && data.token_tiers?.cache_hit_rate != null && (
          <div className="rounded-xl border border-ink-100 bg-white p-4 print-export">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-3">{t('cost.cache.title')}</div>
            <div className="flex items-center gap-6">
              <div className="shrink-0">
                <div className="text-3xl font-semibold text-claude-600 tabular-nums">{(data.token_tiers.cache_hit_rate * 100).toFixed(1)}%</div>
                <div className="text-[11px] text-ink-400">{t('cost.cache.hit_rate')}</div>
              </div>
              <div className="flex-1 min-w-0 space-y-0.5">
                {(() => {
                  const folded = new Map<string, number>()
                  for (const r of data.by_token_type ?? []) {
                    const tier = TOKEN_TIER_OF[r.token_type] || 'other'
                    folded.set(tier, (folded.get(tier) || 0) + r.spend_usd)
                  }
                  const tierRows = [...folded.entries()].sort((a, b) => b[1] - a[1])
                  const tierTot = tierRows.reduce((s, [, v]) => s + v, 0) || 1
                  return tierRows.map(([tier, usd]) => {
                    const pct = (usd / tierTot) * 100
                    const label = t(`cost.tier.${tier}` as any)
                    return (
                      <div key={tier} className="flex items-center justify-between text-sm py-0.5">
                        <span className="flex items-center gap-2 text-ink-600">
                          <span className="inline-block w-2 h-2 rounded-full" style={{ background: TOKEN_TIER_COLORS[tier] || '#8A8474' }} />
                          {label === `cost.tier.${tier}` ? tier.replace(/_/g, ' ') : label}
                        </span>
                        <span className="tabular-nums text-ink-700">{fmtUsd(usd)} <span className="text-ink-400">({pct > 0 && pct < 0.1 ? pct.toFixed(2) : pct.toFixed(0)}%)</span></span>
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Spend by cost type (tokens vs metered server tools). A card, not a
            donut: tokens are ~100% so a pie hides web_search/code_execution —
            this keeps the small-but-growing metered-tool spend explicit. */}
        {dataSource === 'live' && (data.by_cost_type?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-ink-100 bg-white p-4 max-w-md print-export">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">{t('cost.by_type')}</div>
            {(() => {
              const items = data.by_cost_type!
              const tot = items.reduce((s, c) => s + c.spend_usd, 0) || 1
              return items.map((c) => {
                const pct = (c.spend_usd / tot) * 100
                const label = t(`cost.type.${c.cost_type}` as any)
                return (
                  <div key={c.cost_type} className="flex items-center justify-between text-sm py-0.5">
                    <span className="flex items-center gap-2 text-ink-600">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: COST_TYPE_COLORS[c.cost_type] || '#8A8474' }} />
                      {label === `cost.type.${c.cost_type}` ? c.cost_type.replace(/_/g, ' ') : label}
                    </span>
                    <span className="tabular-nums text-ink-700">
                      {fmtUsd(c.spend_usd)} <span className="text-ink-400">({pct > 0 && pct < 0.1 ? pct.toFixed(2) : pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                )
              })
            })()}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6">
          <ChartCard title={t('cost.product_share')} subtitle={t('cost.product_share.sub')}>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={agg.productRows} dataKey="spend" nameKey="product"
                     innerRadius={50} outerRadius={90}
                     label={(e: any) => `${productLabel(e.product)} ${(e.share * 100).toFixed(0)}%`}>
                  {agg.productRows.map((p, i) => (
                    <Cell key={p.product} fill={PRODUCT_COLORS[p.product] || FALLBACK[i % FALLBACK.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t('cost.model_share')} subtitle={t('cost.model_share.sub')}>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={agg.modelRows} dataKey="spend" nameKey="short"
                     innerRadius={50} outerRadius={90}
                     label={(e: any) => `${e.short} ${(e.share * 100).toFixed(0)}%`}>
                  {agg.modelRows.map((m, i) => (
                    <Cell key={m.model} fill={MODEL_COLORS[m.model] || FALLBACK[i % FALLBACK.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title={t('cost.product_model_stack')} subtitle={t('cost.product_model_stack.sub')}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={agg.productModelStack} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="product" tickFormatter={productLabel} />
              <YAxis tickFormatter={(v: number) => fmtUsd(v)} />
              <Tooltip formatter={(v: number) => fmtUsd(v)} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              {agg.allModels.map((m, i) => (
                <Bar key={m} dataKey={shortModel(m)} stackId="m" fill={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]} radius={i === agg.allModels.length - 1 ? [4, 4, 0, 0] : 0} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('cost.model_cost')} subtitle={t('cost.model_cost.sub')}>
          <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3">
            <table className="w-full text-sm">
              <thead className="bg-paper-muted/60 text-ink-500">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Model</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Spend</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Share</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Requests</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Input</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Output</th>
                </tr>
              </thead>
              <tbody>
                {agg.modelRows.map((m) => (
                  <tr key={m.model} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 font-medium text-ink-700">{m.short}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-claude-600 font-medium">{fmtUsd(m.spend)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-600">{fmtPct(m.share)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtNum(m.requests)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtCompact(m.input)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtCompact(m.output)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        {dataSource === 'live' && trendsPivot.rows.length > 0 && (
          <ChartCard title={t('cost.trends.title')} subtitle={t('cost.trends.subtitle')}>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trendsPivot.rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tickFormatter={(v: number) => fmtUsd(v)} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                {trendsPivot.models.map((m, i) => (
                  <Area
                    key={m}
                    type="monotone"
                    dataKey={shortModel(m)}
                    stackId="m"
                    stroke={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]}
                    fill={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]}
                    fillOpacity={0.6}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Top-N per-user tables. Sourced (in priority order) from
            eff.data.users (live user_cost_report spend in live mode, or
            CSV-derived spend+tokens in CSV mode), csvUserRows, or agg.userRows.
            The "by Cost" table works live; token-ranked tables need per-user
            tokens (CSV only) — see hasPerUserTokens gating below. */}
        {userRowsForTop && userRowsForTop.length > 0 && userRowsForTop[0].email !== '' && (
          <div>
            {/* Caveats state exactly where each table's numbers come from:
                - live spend (liveUserRows or eff live+analytics) → cost table
                  is range-exact live; the token tables (if a CSV exists) are
                  whole-CSV-period totals that do NOT follow the range.
                - eff source csv+analytics → spend AND tokens are activity-
                  scaled from the CSV period to the selected range.
                The old single range_caveat mislabeled live spend as
                "scaled CSV data" and showed the CSV period for it. */}
            {!liveUserRows && effUserRows && eff.data?.source === 'csv+analytics' && csvData?.period && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">
                {t('cost.top.range_caveat', {
                  start: csvData.period.starting_date,
                  end:   csvData.period.ending_date,
                })}
              </p>
            )}
            {!liveTokenRows && (liveUserRows || eff.data?.source === 'live+analytics') && hasPerUserTokens && csvData?.period && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">
                {t('cost.top.tokens_csv_caveat', {
                  start: csvData.period.starting_date,
                  end:   csvData.period.ending_date,
                })}
              </p>
            )}
            {!liveUserRows && !effUserRows && csvUserRows && dataSource === 'live' && csvData?.period && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">
                {t('cost.top.csv_caveat', {
                  start: csvData.period.starting_date,
                  end:   csvData.period.ending_date,
                })}
              </p>
            )}
            {!hasPerUserTokens && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">{t('cost.top.live_caveat')}</p>
            )}
            <div className={hasPerUserTokens ? 'grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6' : 'grid grid-cols-1 gap-6 max-w-md'}>
              <TopTable title={t('cost.top_cost')} rows={topSpend} metric="spend" formatter={fmtUsd} accent t={t} />
              {hasPerUserTokens && (
                <>
                  <TopTable title={t('cost.top_total')}  rows={topTotal}  metric="total_tokens" formatter={fmtCompact} t={t} />
                  <TopTable title={t('cost.top_input')}  rows={topInput}  metric="input"        formatter={fmtCompact} t={t} />
                  <TopTable title={t('cost.top_output')} rows={topOutput} metric="output"       formatter={fmtCompact} t={t} />
                </>
              )}
            </div>
          </div>
        )}

        {/* Per-user × model spend (chargeback): top-10 users stacked by model.
            Live user_cost_report?by=model — cost + requests only (no per-user
            tokens). Models normalized (hyphen→underscore) for color/label. */}
        {dataSource === 'live' && (usersByModel.data?.users?.length ?? 0) > 0 && (() => {
          const top = usersByModel.data!.users.filter((u) => inGroup(u.email)).slice(0, 10)
          if (top.length === 0) return null
          const modelTotals = new Map<string, number>()
          for (const u of top) for (const m of u.by_model) {
            const id = normModel(m.model)
            modelTotals.set(id, (modelTotals.get(id) || 0) + m.spend_usd)
          }
          const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
          const chartData = top.map((u) => {
            const row: Record<string, number | string> = { name: maskEmail(u.email) }
            for (const m of u.by_model) {
              const id = normModel(m.model)
              row[id] = ((row[id] as number) || 0) + m.spend_usd
            }
            return row
          })
          return (
            <ChartCard title={t('cost.user_model.title')} subtitle={t('cost.user_model.sub')}>
              <ResponsiveContainer width="100%" height={Math.max(220, top.length * 32 + 64)}>
                <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v)} />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => fmtUsd(v)} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  {models.map((m, i) => (
                    <Bar key={m} dataKey={m} name={shortModel(m)} stackId="u"
                         fill={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]}
                         radius={i === models.length - 1 ? [0, 4, 4, 0] : 0} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )
        })()}

        {/* ── Spend by RBAC group ──────────────────────────────────────────
            Native group attribution from cost_report × rbac_group_id (shipped
            upstream 2026-07). Labels are REAL group names resolved server-side
            via the Compliance groups endpoint (grp-<id suffix> fallback). The
            dimension FLAPS upstream (503 "not ready yet") — on error show an
            explanatory note instead of silently omitting the card. */}
        {dataSource === 'live' && groupCost.error && (
          <div className="rounded-lg border border-ink-100 bg-paper-muted/40 px-4 py-3 text-[12px] text-ink-500 print-hide">
            {t('cost.groups.unavailable')}
          </div>
        )}
        {dataSource === 'live' && (groupCost.data?.groups?.length ?? 0) > 0 && (() => {
          const gs = groupCost.data!.groups
          const ung = groupCost.data!.ungrouped
          const total = gs.reduce((s, g) => s + g.spend_usd, 0) + ung.spend_usd
          const chartData = gs.map((g) => ({
            name: g.label,
            spend: g.spend_usd,
            share: total > 0 ? g.spend_usd / total : 0,
          }))
          return (
            <ChartCard
              title={t('cost.groups.title')}
              subtitle={groupCost.data!.stale
                ? `${t('cost.groups.sub')} · ${t('cost.groups.stale')}`
                : t('cost.groups.sub')}
            >
              <ResponsiveContainer width="100%" height={Math.max(160, gs.length * 40 + 56)}>
                <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v)} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => fmtUsd(v)} />
                  <Bar dataKey="spend" fill="#D97757" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="px-4 pb-2 space-y-0.5">
                {chartData.map((g) => (
                  <div key={g.name} className="flex items-center justify-between text-[11px] text-ink-500">
                    <span>{g.name}</span>
                    <span className="tabular-nums">{fmtUsd(g.spend)} · {fmtPct(g.share)}</span>
                  </div>
                ))}
                {ung.spend_usd > 0 && (
                  <p className="text-[11px] text-ink-400 pt-1">
                    {t('cost.groups.ungrouped', { usd: fmtUsd(ung.spend_usd) })}
                  </p>
                )}
              </div>
            </ChartCard>
          )
        })()}

        {/* ── Spend limits (monthly, live from the Spend Limits API) ──────
            Month-to-date spend vs each member's effective limit. Independent
            of the page date range AND of the /cost/live path — so no
            dataSource gate: its own fetch succeeding is the only condition
            (a cost_report fallback to CSV shouldn't hide available limits). */}
        {(spendLimits.data?.members?.length ?? 0) > 0 && (() => {
          const members = spendLimits.data!.members.filter((m) => inGroup(m.email)).slice(0, 10)
          if (members.length === 0) return null
          return (
            <ChartCard title={t('cost.limits.title')} subtitle={t('cost.limits.sub')}>
              <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3">
                <table className="w-full text-sm">
                  <thead className="bg-paper-muted/60 text-ink-500">
                    <tr>
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('user_prod.col.user')}</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('cost.limits.col.spent')}</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('cost.limits.col.limit')}</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('cost.limits.col.util')}</th>
                      <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('cost.limits.col.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.email} className="border-t border-ink-100">
                        <td className="px-3 py-1.5 font-medium text-ink-700">{maskEmail(m.email)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-claude-600 font-medium">{fmtUsd(m.spent_usd)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-600">
                          {m.limit_usd != null ? fmtUsd(m.limit_usd) : t('cost.limits.unlimited')}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${
                          m.utilization != null && m.utilization >= 0.9 ? 'text-claude-700' : 'text-ink-600'
                        }`}>
                          {m.utilization != null ? fmtPct(m.utilization) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-[11px] text-ink-400">{m.source.replace(/_/g, ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>
          )
        })()}

        {/* ── Cost Efficiency ──────────────────────────────────────────── */}
        {eff.data && eff.data.users.length > 0 && (() => {
          const scopedUsers = eff.data!.users.filter((u) => inGroup(u.email))
          if (scopedUsers.length === 0) return null
          // Server totals are org-wide; under a group scope every cohort KPI
          // (median score AND the avg $/LOC / $/Commit ratios) must reflect
          // the scoped cohort, so recompute them client-side. Spend uses
          // range_spend_usd ?? spend_usd — the same precedence the per-user
          // rows use — to stay consistent with the server's method.
          let totals = eff.data!.totals
          if (group) {
            const scores = scopedUsers.map((u) => u.economic_productivity_score).sort((a, b) => a - b)
            const mid = scores.length >> 1
            const median = scores.length % 2 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2)
            const spendSum = scopedUsers.reduce((a, u) => a + (u.range_spend_usd ?? u.spend_usd), 0)
            const locSum = scopedUsers.reduce((a, u) => a + (u.loc_added || 0), 0)
            const commitSum = scopedUsers.reduce((a, u) => a + (u.commits || 0), 0)
            totals = {
              ...totals,
              median_score: median,
              avg_cost_per_loc: locSum > 0 ? spendSum / locSum : null,
              avg_cost_per_commit: commitSum > 0 ? spendSum / commitSum : null,
            }
          }
          return <EconomicProductivitySection data={{ ...eff.data!, users: scopedUsers, totals }} t={t} range={range} scoped={!!group} />
        })()}

        {/* ── CSV management (auto-expanded in CSV mode) ────────────── */}
        <details
          open={dataSource === 'csv'}
          className="pt-6 border-t border-ink-100 group print-hide"
        >
          <summary className="cursor-pointer text-sm font-semibold text-ink-700 hover:text-ink-900 select-none">
            {t('cost.recon.expander')}
          </summary>
          <div className="mt-4">
            <h3 className="text-base font-semibold text-ink-800 mb-1">{t('cost.upload.replace')}</h3>
            <p className="text-xs text-ink-500 mb-4">{t('cost.csv_upload.body')}</p>
            <CsvUploader onChange={onUploadChange} variant="full" />
          </div>
        </details>
      </div>
    </div>
  )
}

function EconomicProductivitySection({ data, t, range, scoped = false }: {
  data: EfficiencyResp;
  t: (k: any, p?: any) => string;
  range: { startingDate: string; endingDate: string };
  scoped?: boolean;   // true → totals were recomputed for the selected group
}) {
  const topScore  = [...data.users].sort((a, b) => b.economic_productivity_score - a.economic_productivity_score).slice(0, 10)
  const mostEff   = [...data.users].filter((u) => u.cost_per_loc != null && u.loc_added > 50).sort((a, b) => (a.cost_per_loc ?? Infinity) - (b.cost_per_loc ?? Infinity)).slice(0, 10)
  const scatter   = data.users.filter((u) => u.spend_usd > 0 && u.output_score > 0).map((u) => ({
    x: u.spend_usd,
    y: u.output_score,
    z: u.economic_productivity_score,
    name: maskEmail(u.email),
    acceptance: u.tool_acceptance_rate ?? 0,
  }))

  // Period the server actually joined on — it clamps to the Analytics API's
  // 3-day buffer, so what the user picked may differ from what landed.
  const effective = data.period ?? { starting_date: range.startingDate, ending_date: range.endingDate }

  return (
    <div className="pt-4 border-t border-ink-100">
      {/* Range is controlled by the single page-level picker at the top —
          this section just reflects the period the server joined on. */}
      <h2 className="text-lg font-semibold text-ink-800 mb-1">{t('econ.title')}</h2>
      <p className="text-[11px] text-ink-400 mb-1">
        {t('econ.active_range', { start: effective.starting_date, end: effective.ending_date })}
      </p>
      <p className="text-xs text-ink-500 mb-4">{t('econ.subtitle')}</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4 mb-5">
          <KpiCard accent label={t('econ.kpi.score')}      value={topScore[0]?.economic_productivity_score ?? '—'}  hint={maskEmail(topScore[0]?.email ?? '')} />
          <KpiCard       label={t('econ.kpi.cost_loc')}    value={data.totals.avg_cost_per_loc != null ? `$${data.totals.avg_cost_per_loc.toFixed(4)}` : '—'}    hint={t(scoped ? 'econ.kpi.avg_group' : 'econ.kpi.avg_org')} />
          <KpiCard       label={t('econ.kpi.cost_commit')} value={data.totals.avg_cost_per_commit != null ? fmtUsd(data.totals.avg_cost_per_commit) : '—'} hint={t(scoped ? 'econ.kpi.avg_group' : 'econ.kpi.avg_org')} />
          <KpiCard       label={t('econ.kpi.total_output')} value={data.totals.median_score ?? '—'} hint={t('econ.kpi.total_output.hint')} />
        </div>

        <ChartCard title={t('econ.scatter')} subtitle={t('econ.scatter.sub')}>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" dataKey="x" name={t('econ.axis.spend')} unit="$" tickFormatter={(v: number) => `$${v}`} />
              <YAxis type="number" dataKey="y" name={t('econ.axis.output')} tickFormatter={(v: number) => fmtCompact(v)} />
              <ZAxis type="number" dataKey="z" range={[40, 400]} name={t('econ.axis.score')} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null
                  const p = payload[0].payload
                  return (
                    <div className="bg-ink-800 text-paper rounded-lg px-3 py-2 text-xs">
                      <div className="font-semibold">{p.name}</div>
                      <div>Spend: ${p.x.toFixed(2)}</div>
                      <div>Output: {fmtCompact(p.y)}</div>
                      <div>Score: {p.z}/100</div>
                      <div>Accept: {(p.acceptance * 100).toFixed(1)}%</div>
                    </div>
                  )
                }}
              />
              <Scatter data={scatter} fill="#D97757" fillOpacity={0.75} />
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6 mt-6">
          <ChartCard title={t('econ.top_score')}>
            <ResponsiveContainer width="100%" height={Math.max(260, topScore.length * 26)}>
              <BarChart data={topScore.map((u) => ({ name: maskEmail(u.email), score: u.economic_productivity_score }))}
                        layout="vertical" margin={{ top: 8, right: 16, left: 80, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" domain={[0, 100]} />
                <YAxis dataKey="name" type="category" width={170} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => `${v}/100`} />
                <Bar dataKey="score" fill="#D97757" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t('econ.most_efficient')} subtitle={t('econ.most_efficient.sub')}>
            <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3 max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-paper-muted/60 text-ink-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">User</th>
                    <th className="text-right px-3 py-2 uppercase tracking-wider">$/LOC</th>
                    <th className="text-right px-3 py-2 uppercase tracking-wider">LOC</th>
                    <th className="text-right px-3 py-2 uppercase tracking-wider">Accept</th>
                  </tr>
                </thead>
                <tbody>
                  {mostEff.map((u) => (
                    <tr key={u.email} className="border-t border-ink-100">
                      <td className="px-3 py-1.5 text-ink-700">{maskEmail(u.email)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 font-medium">${u.cost_per_loc?.toFixed(4)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtCompact(u.loc_added)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtPct(u.tool_acceptance_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </div>

        <ChartCard title={t('econ.full_table')} subtitle={t('econ.full_table.sub')} className="mt-6">
          <FullEfficiencyTable users={data.users} />
        </ChartCard>

        <div className="mt-4 rounded-xl border border-ink-100 bg-paper-muted/40 px-5 py-3 text-[11px] text-ink-500 leading-relaxed">
          <b className="text-ink-700">{t('econ.formula')}</b>
        </div>
      </div>
  )
}

// Sortable per-user efficiency table. Every column is clickable; the User
// column sorts as a string, every other column sorts numerically with
// nulls (cost_per_loc / output_per_dollar / tokens_per_loc / accept) pinned
// to the bottom regardless of direction.
function FullEfficiencyTable({ users }: { users: EfficiencyUser[] }) {
  type K = 'user' | 'score' | 'spend' | 'loc' | 'commits' | 'prs'
        | 'cost_per_loc' | 'cost_per_commit' | 'output_per_dollar'
        | 'tokens_per_loc' | 'accept'
  const accessors: Record<K, (u: EfficiencyUser) => string | number | null | undefined> = {
    user:    (u) => u.email,
    score:   (u) => u.economic_productivity_score,
    spend:   (u) => u.spend_usd,
    loc:     (u) => u.loc_added,
    commits: (u) => u.commits,
    prs:     (u) => u.prs,
    cost_per_loc:    (u) => u.cost_per_loc,
    cost_per_commit: (u) => u.cost_per_commit,
    output_per_dollar: (u) => u.output_per_dollar,
    tokens_per_loc:  (u) => u.tokens_per_loc,
    accept:  (u) => u.tool_acceptance_rate,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<EfficiencyUser, K>(users, accessors, {
    initialKey: 'score', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K>
      label={props.label}
      k={props.k}
      sortKey={sortKey}
      sortDir={sortDir}
      onClick={toggle}
      align={props.align}
    />
  )
  return (
    <div className="rounded-lg border border-ink-100 overflow-auto mx-3 max-h-[500px]">
      <table className="w-full text-xs">
        <thead className="bg-paper-muted/60 sticky top-0">
          <tr>
            <Th label="User" k="user" align="left" />
            <Th label="Score" k="score" />
            <Th label="Spend" k="spend" />
            <Th label="LOC" k="loc" />
            <Th label="Commits" k="commits" />
            <Th label="PRs" k="prs" />
            <Th label="$/LOC" k="cost_per_loc" />
            <Th label="$/Commit" k="cost_per_commit" />
            <Th label="Out/$" k="output_per_dollar" />
            <Th label="Tok/LOC" k="tokens_per_loc" />
            <Th label="Accept" k="accept" />
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.email} className="border-t border-ink-100">
              <td className="px-3 py-1.5 font-medium text-ink-700">{maskEmail(u.email)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-claude-600 font-semibold">{u.economic_productivity_score}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtUsd(u.spend_usd)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtCompact(u.loc_added)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.commits}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.prs}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.cost_per_loc != null ? `$${u.cost_per_loc.toFixed(4)}` : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.cost_per_commit != null ? fmtUsd(u.cost_per_commit) : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.output_per_dollar != null ? u.output_per_dollar.toFixed(1) : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{u.tokens_per_loc != null ? fmtCompact(u.tokens_per_loc) : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{fmtPct(u.tool_acceptance_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TopTable({
  title, rows, metric, formatter, accent, t,
}: {
  title: string
  rows: { masked: string; spend: number; input: number; output: number; total_tokens: number; requests: number; products: number; models: number }[]
  metric: 'spend' | 'input' | 'output' | 'total_tokens'
  formatter: (n: number) => string
  accent?: boolean
  t: (k: any, p?: any) => string
}) {
  return (
    <ChartCard title={title}>
      <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3">
        <table className="w-full text-sm">
          <thead className="bg-paper-muted/60 text-ink-500">
            <tr>
              <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">#</th>
              <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">{t('user_prod.col.user')}</th>
              <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Value</th>
              <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">Req</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.masked + i} className="border-t border-ink-100">
                <td className="px-3 py-1.5 text-ink-400 tabular-nums">{i + 1}</td>
                <td className="px-3 py-1.5 font-medium text-ink-700">{r.masked}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${accent ? 'text-claude-600' : 'text-ink-700'}`}>
                  {formatter(r[metric] ?? 0)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-400">{fmtNum(r.requests)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  )
}
