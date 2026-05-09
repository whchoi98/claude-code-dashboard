import { useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { CsvUploader } from '../components/CsvUploader'
import { DateRangeControl } from '../components/DateRangeControl'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtPct, maskEmail, fmtNum } from '../lib/format'

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
const PRODUCT_COLORS: Record<string, string> = {
  'Claude Code':       '#D97757',
  'Chat':              '#1F1E1D',
  'Cowork':            '#B75E40',
  'Browser Extension': '#8A8474',
  'Excel':             '#4CA371',
  'PowerPoint':        '#CC7722',
}
const FALLBACK = ['#D97757', '#1F1E1D', '#8A8474', '#B75E40', '#D7D3C7', '#E69F7F', '#4CA371', '#CC7722']

const shortModel = (m: string) =>
  m.replace(/^claude_/, '').replace(/_v\d+:\d+$/, '').replace(/_\d{8}$/, '').replace(/_/g, ' ')

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
 * `csvData` is exposed separately so the page can render per-user widgets
 * from CSV even when live API is the active main source. The Anthropic
 * Analytics endpoints don't expose per-user attribution, but the uploaded
 * Spend Report CSV does — so we use it as a complementary data layer.
 */
export function useCostData(range: { startingDate: string; endingDate: string }) {
  const liveUrl = `/api/cost/live?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const live = useFetch<CsvResp>(liveUrl)
  const csv  = useFetch<CsvResp>('/api/cost/csv')

  const liveOk = !live.loading && !live.error && (live.data?.rows.length ?? 0) > 0
  const useCsv = !liveOk
  const data = useCsv ? csv.data : live.data
  const source: CostSource = useCsv ? 'csv' : 'live'

  // Loading: at least one channel is loading and no usable data yet
  const loading = data == null && (live.loading || csv.loading)
  // Error: only surface CSV's error if we've actually fallen back to CSV.
  // Live errors are silent — they trigger the fallback, not a user-visible error.
  const error = useCsv ? csv.error : null

  const refetch = useCallback(
    async () => { await live.refetch(); await csv.refetch() },
    [live.refetch, csv.refetch],
  )
  return { data, loading, error, source, refetch, csvData: csv.data }
}

export function Cost() {
  const t = useT()
  const { range } = useDateRange('30d')
  // Live API (Claude Code only) with automatic CSV fallback.
  // The CSV path also handles the >30-day reconciliation use case.
  const { data, loading, error, refetch, source: dataSource, csvData } = useCostData(range)
  const effUrl = `/api/cost/efficiency?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const eff = useFetch<EfficiencyResp>(effUrl)

  // After a successful upload/delete, invalidate the live cost + efficiency
  // queries that depend on the S3 spend-reports/ prefix.
  const onUploadChange = () => { refetch(); eff.refetch() }

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
      const u = byUser.get(r.user_email) ?? { spend: 0, input: 0, output: 0, requests: 0, products: new Set<string>(), models: new Set<string>() }
      u.spend += r.total_net_spend_usd; u.input += r.total_prompt_tokens; u.output += r.total_completion_tokens
      u.requests += r.total_requests; u.products.add(r.product); u.models.add(r.model)
      byUser.set(r.user_email, u)

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
  }, [data])

  // Per-user aggregation: prefer the activity-weighted range_* fields from
  // /api/cost/efficiency (which scales each user's CSV-period total spend by
  // sessions_in_range/sessions_in_csv_period), so the per-user numbers
  // respond to the selected date range. Fall back to raw CSV totals
  // (range-agnostic) if eff data isn't available.
  const effUserRows = useMemo(() => {
    if (!eff.data?.users?.length) return null
    return eff.data.users.map((u) => ({
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
  }, [eff.data])

  const csvUserRows = useMemo(() => {
    if (!csvData?.rows?.length) return null
    const byUser = new Map<string, { spend: number; input: number; output: number; requests: number; products: Set<string>; models: Set<string> }>()
    for (const r of csvData.rows) {
      const u = byUser.get(r.user_email) ?? { spend: 0, input: 0, output: 0, requests: 0, products: new Set<string>(), models: new Set<string>() }
      u.spend += r.total_net_spend_usd
      u.input += r.total_prompt_tokens
      u.output += r.total_completion_tokens
      u.requests += r.total_requests
      u.products.add(r.product)
      u.models.add(r.model)
      byUser.set(r.user_email, u)
    }
    return [...byUser.entries()].map(([email, u]) => ({
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
  }, [csvData])

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
    // Check if it's just a missing spend report (404) — show a friendly empty state
    if (error.includes('no_spend_report') || error.includes('404')) {
      return (
        <div>
          <PageHeader title={t('cost.title')} subtitle={t('cost.subtitle')} />
          <div className="p-8 space-y-4">
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

  // Per-user Top-N tables. Preference order:
  //   1. eff.data.users (activity-weighted, range-aware)  ← most accurate
  //   2. csvUserRows (raw CSV totals, range-agnostic)
  //   3. agg.userRows (live data; in live mode user_email is empty so unused)
  // The eff path requires both a CSV upload AND analytics activity data;
  // csvUserRows is the safe baseline when eff is loading or returns no users.
  const userRowsForTop = effUserRows ?? csvUserRows ?? agg.userRows
  const topSpend  = [...userRowsForTop].sort((a, b) => b.spend - a.spend).slice(0, 10)
  const topInput  = [...userRowsForTop].sort((a, b) => b.input - a.input).slice(0, 10)
  const topOutput = [...userRowsForTop].sort((a, b) => b.output - a.output).slice(0, 10)
  const topTotal  = [...userRowsForTop].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 10)

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
      <div className="p-8 space-y-6">
        {dataSource === 'live' && (
          <>
            <div className="flex items-center justify-end">
              <DateRangeControl />
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
              {t('cost.live.caveat.30day')}
            </div>
          </>
        )}
        <div className="grid grid-cols-4 gap-4">
          <KpiCard
            accent
            label={t('cost.kpi.total')}
            value={fmtUsd(data.totals.net_spend_usd)}
            hint={
              // Prefer CSV's per-user count when available (it's the only
              // source that has user attribution today). Fall back to
              // models·products in live-only mode.
              csvData?.totals?.distinct_users
                ? `${fmtNum(csvData.totals.distinct_users)} users · ${data.totals.distinct_models} models`
                : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`
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

        <div className="grid grid-cols-2 gap-6">
          <ChartCard title={t('cost.product_share')} subtitle={t('cost.product_share.sub')}>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={agg.productRows} dataKey="spend" nameKey="product"
                     innerRadius={50} outerRadius={90}
                     label={(e: any) => `${e.product} ${(e.share * 100).toFixed(0)}%`}>
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
              <XAxis dataKey="product" />
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
          <div className="rounded-lg border border-ink-100 overflow-hidden mx-3">
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
            eff.data.users (activity-weighted, range-aware), csvUserRows
            (CSV-period totals), or agg.userRows. The Anthropic Analytics
            cost_report/usage_report endpoints don't expose user attribution,
            so all three paths trace back to the uploaded CSV. */}
        {userRowsForTop && userRowsForTop.length > 0 && userRowsForTop[0].email !== '' && (
          <div>
            {effUserRows && csvData?.period && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">
                {t('cost.top.range_caveat', {
                  start: csvData.period.starting_date,
                  end:   csvData.period.ending_date,
                })}
              </p>
            )}
            {!effUserRows && csvUserRows && dataSource === 'live' && csvData?.period && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">
                {t('cost.top.csv_caveat', {
                  start: csvData.period.starting_date,
                  end:   csvData.period.ending_date,
                })}
              </p>
            )}
            <div className="grid grid-cols-2 gap-6">
              <TopTable title={t('cost.top_cost')}   rows={topSpend}  metric="spend"        formatter={fmtUsd}     accent t={t} />
              <TopTable title={t('cost.top_total')}  rows={topTotal}  metric="total_tokens" formatter={fmtCompact} t={t} />
              <TopTable title={t('cost.top_input')}  rows={topInput}  metric="input"        formatter={fmtCompact} t={t} />
              <TopTable title={t('cost.top_output')} rows={topOutput} metric="output"       formatter={fmtCompact} t={t} />
            </div>
          </div>
        )}

        {/* ── Economic Productivity ────────────────────────────────────── */}
        {eff.data && eff.data.users.length > 0 && (
          <EconomicProductivitySection data={eff.data} t={t} range={range} />
        )}

        {/* ── CSV management (auto-expanded in CSV mode) ────────────── */}
        <details
          open={dataSource === 'csv'}
          className="pt-6 border-t border-ink-100 group"
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

function EconomicProductivitySection({ data, t, range }: {
  data: EfficiencyResp;
  t: (k: any, p?: any) => string;
  range: { startingDate: string; endingDate: string };
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
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="text-lg font-semibold text-ink-800">{t('econ.title')}</h2>
        <DateRangeControl />
      </div>
      <p className="text-[11px] text-ink-400 mb-1">
        {t('econ.active_range', { start: effective.starting_date, end: effective.ending_date })}
      </p>
      <p className="text-xs text-ink-500 mb-4">{t('econ.subtitle')}</p>

        <div className="grid grid-cols-4 gap-4 mb-5">
          <KpiCard accent label={t('econ.kpi.score')}      value={topScore[0]?.economic_productivity_score ?? '—'}  hint={maskEmail(topScore[0]?.email ?? '')} />
          <KpiCard       label={t('econ.kpi.cost_loc')}    value={data.totals.avg_cost_per_loc != null ? `$${data.totals.avg_cost_per_loc.toFixed(4)}` : '—'}    hint="avg org" />
          <KpiCard       label={t('econ.kpi.cost_commit')} value={data.totals.avg_cost_per_commit != null ? fmtUsd(data.totals.avg_cost_per_commit) : '—'} hint="avg org" />
          <KpiCard       label={t('econ.kpi.total_output')} value={fmtCompact(data.totals.loc_added + 100 * data.totals.commits + 1000 * data.totals.prs)} hint="LOC + 100×commits + 1000×PRs" />
        </div>

        <ChartCard title={t('econ.scatter')} subtitle={t('econ.scatter.sub')}>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" dataKey="x" name="Spend" unit="$" tickFormatter={(v: number) => `$${v}`} />
              <YAxis type="number" dataKey="y" name="Output" tickFormatter={(v: number) => fmtCompact(v)} />
              <ZAxis type="number" dataKey="z" range={[40, 400]} name="Score" />
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

        <div className="grid grid-cols-2 gap-6 mt-6">
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
            <div className="rounded-lg border border-ink-100 overflow-hidden mx-3 max-h-72 overflow-y-auto">
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
          <div className="rounded-lg border border-ink-100 overflow-auto mx-3 max-h-[500px]">
            <table className="w-full text-xs">
              <thead className="bg-paper-muted/60 text-ink-500 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 uppercase tracking-wider">User</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Score</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Spend</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">LOC</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Commits</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">PRs</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">$/LOC</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">$/Commit</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Out/$</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Tok/LOC</th>
                  <th className="text-right px-3 py-2 uppercase tracking-wider">Accept</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
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
        </ChartCard>

        <div className="mt-4 rounded-xl border border-ink-100 bg-paper-muted/40 px-5 py-3 text-[11px] text-ink-500 leading-relaxed">
          <b className="text-ink-700">{t('econ.formula')}</b>
          <br />
          Score = 35% · normalized(output/$) + 20% · tool_acceptance + 20% · normalized(1/tokens_per_LOC) + 15% · commit_velocity + 10% · PR_velocity.
          Output score = LOC + 100·commits + 1000·PRs + 0.5·tool_accepted.
        </div>
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
      <div className="rounded-lg border border-ink-100 overflow-hidden mx-3">
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
