import { useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtNum, fmtDate, fmtPct, acceptRate } from '../lib/format'
import type { Summary, UserRecord } from '../types'

type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }
type UsersResp = { source: 'live' | 'mock'; reason?: string; date: string; data: UserRecord[] }
type DailyCost = { date: string; model: string; spend: number }
type CostResp = {
  source: 'csv' | 'live'
  totals: {
    requests: number
    prompt_tokens: number
    completion_tokens: number
    net_spend_usd: number
    distinct_models: number
    distinct_users: number
  }
  daily?: DailyCost[]
}
type ComplianceResp = { data: { id: string; type: string; created_at: string }[]; total_fetched: number }

// Same risk classification used by the Compliance page — keep this aligned.
const RISK_TYPES = new Set([
  'claude_user_role_updated',
  'org_user_invite_sent', 'org_user_invite_deleted', 'org_user_deleted',
  'org_sso_toggled', 'org_sso_connection_deleted',
  'org_data_export_started', 'org_data_export_completed',
  'org_domain_verified', 'project_deleted',
])

function fmtUsd(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
}

export function Executive() {
  const t = useT()
  const { range } = useDateRange('7d')

  const summaries = useFetch<SummariesResp>(
    `/api/analytics/summaries?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const users = useFetch<UsersResp>(`/api/analytics/users?date=${range.endingDate}`)
  const cost = useFetch<CostResp>(
    `/api/cost/live?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const today = new Date().toISOString().slice(0, 10)
  const upper = range.preset === 'custom' ? range.endingDate : today
  const compliance = useFetch<ComplianceResp>(
    `/api/compliance/activities?max=2000&pages=20&starting_date=${range.startingDate}&ending_date=${upper}`,
  )

  const exportPdf = useCallback(() => {
    const restore = () => document.body.classList.remove('app-print')
    document.body.classList.add('app-print')
    window.addEventListener('afterprint', restore, { once: true })
    setTimeout(() => window.print(), 50)
  }, [])

  const snapshot = useMemo(() => {
    const sum = summaries.data?.data ?? []
    const recs = users.data?.data ?? []
    const daily = cost.data?.daily ?? []
    const events = compliance.data?.data ?? []

    const latest = sum[sum.length - 1]
    const prev = sum[sum.length - 2]

    const loc = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
    const accepted = recs.reduce((s, r) => {
      const ta = r.claude_code_metrics.tool_actions
      return s + ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count
        + ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
    }, 0)
    const rejected = recs.reduce((s, r) => {
      const ta = r.claude_code_metrics.tool_actions
      return s + ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count
        + ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
    }, 0)
    const accept = acceptRate(accepted, rejected)

    // Cost projection — same formula the Cost page uses (last-7-day daily
    // average × 30). Returns null if the live API didn't deliver a daily
    // series (e.g., CSV-only mode).
    let proj30d: number | null = null
    if (daily.length > 0) {
      const byDate = new Map<string, number>()
      for (const d of daily) byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.spend ?? 0))
      const sortedSpend = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)
      const last7 = sortedSpend.slice(-7)
      if (last7.length > 0) proj30d = (last7.reduce((a, b) => a + b, 0) / last7.length) * 30
    }

    const riskEvents = events.filter((e) => RISK_TYPES.has(e.type)).length

    // Pick the dominant model in the window (highest spend) — surfaced as
    // a single executive-friendly line item below the headline KPIs.
    const byModel = new Map<string, number>()
    for (const d of daily) byModel.set(d.model, (byModel.get(d.model) ?? 0) + (d.spend ?? 0))
    const topModel = [...byModel.entries()].sort(([, a], [, b]) => b - a)[0]

    const dauTrend = !latest?.daily_active_user_count || !prev?.daily_active_user_count
      ? undefined
      : { pct: ((latest.daily_active_user_count - prev.daily_active_user_count) / Math.max(1, prev.daily_active_user_count)) * 100 }

    const dauSeries = sum.map((s) => ({ date: fmtDate(s.starting_at), DAU: s.daily_active_user_count }))
    const spendSeries = (() => {
      const byDate = new Map<string, number>()
      for (const d of daily) byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.spend ?? 0))
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, spend]) => ({ date: fmtDate(date), Spend: Number(spend.toFixed(2)) }))
    })()

    return {
      dau: latest?.daily_active_user_count,
      dauTrend,
      adoption: latest?.monthly_adoption_rate != null ? latest.monthly_adoption_rate / 100 : undefined,
      seats: latest?.assigned_seat_count,
      loc,
      accept,
      spend: cost.data?.totals.net_spend_usd,
      proj30d,
      activeDevs: cost.data?.totals.distinct_users,
      riskEvents,
      totalEvents: events.length,
      topModel,
      dauSeries,
      spendSeries,
    }
  }, [summaries.data, users.data, cost.data, compliance.data])

  const loading = summaries.loading || users.loading || cost.loading || compliance.loading
  if (loading && !snapshot.dau) return <LoadingState />

  return (
    <div>
      <div className="print-hide">
        <PageHeader
          title={t('exec.title')}
          subtitle={t('exec.subtitle', { start: range.startingDate, end: upper })}
          right={<DateRangeControl />}
        />
      </div>
      <div className="p-8 space-y-6 print-export">
        <div className="flex items-center justify-end gap-2 print-hide">
          <button
            onClick={exportPdf}
            title={t('cost.export.pdf.hint')}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5"
          >
            <span aria-hidden>🖨</span>
            {t('cost.export.pdf')}
          </button>
        </div>

        {/* Headline KPI grid — 6 numbers a CFO/CTO actually cares about */}
        <div className="grid grid-cols-3 gap-4">
          <KpiCard accent label={t('exec.kpi.dau')} value={fmtNum(snapshot.dau)} trend={snapshot.dauTrend} hint={t('exec.kpi.dau.hint', { n: fmtNum(snapshot.seats) })} />
          <KpiCard label={t('exec.kpi.adoption')} value={fmtPct(snapshot.adoption)} hint={t('exec.kpi.adoption.hint')} />
          <KpiCard label={t('exec.kpi.loc')} value={fmtCompact(snapshot.loc)} hint={t('exec.kpi.loc.hint')} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <KpiCard accent label={t('exec.kpi.spend')} value={snapshot.spend != null ? fmtUsd(snapshot.spend) : '—'} hint={t('exec.kpi.spend.hint', { n: fmtNum(snapshot.activeDevs ?? 0) })} />
          <KpiCard label={t('exec.kpi.proj30d')} value={snapshot.proj30d != null ? fmtUsd(snapshot.proj30d) : '—'} hint={t('exec.kpi.proj30d.hint')} />
          <KpiCard label={t('exec.kpi.risk')} value={fmtNum(snapshot.riskEvents)} hint={t('exec.kpi.risk.hint', { total: fmtNum(snapshot.totalEvents) })} />
        </div>

        {/* One-liner summary */}
        <div className="rounded-xl border border-ink-100 bg-paper-muted/30 p-4 text-sm text-ink-700 leading-relaxed">
          <span className="font-semibold text-ink-800">{t('exec.headline.label')}:</span>{' '}
          {t('exec.headline.body', {
            devs: fmtNum(snapshot.activeDevs ?? snapshot.dau ?? 0),
            spend: snapshot.spend != null ? fmtUsd(snapshot.spend) : '—',
            loc: fmtCompact(snapshot.loc),
            accept: snapshot.accept != null ? fmtPct(snapshot.accept) : '—',
            risk: fmtNum(snapshot.riskEvents),
            top: snapshot.topModel ? `${snapshot.topModel[0]} (${fmtUsd(snapshot.topModel[1])})` : '—',
          })}
        </div>

        <div className="grid grid-cols-2 gap-6">
          <ChartCard title={t('exec.chart.dau')} subtitle={t('exec.chart.dau.sub')}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={snapshot.dauSeries} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <defs>
                  <linearGradient id="execDau" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#D97757" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#D97757" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="DAU" stroke="#D97757" strokeWidth={2} fill="url(#execDau)" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title={t('exec.chart.spend')} subtitle={t('exec.chart.spend.sub')}>
            {snapshot.spendSeries.length === 0 ? (
              <div className="px-4 py-8 text-sm text-ink-400 text-center">{t('exec.chart.spend.empty')}</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={snapshot.spendSeries} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <defs>
                    <linearGradient id="execSpend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1F1E1D" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#1F1E1D" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                  <Tooltip formatter={(v: number) => fmtUsd(v)} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="Spend" stroke="#1F1E1D" strokeWidth={2} fill="url(#execSpend)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>
      </div>
    </div>
  )
}
