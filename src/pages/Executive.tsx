import { useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupScopeNote } from '../components/GroupScopeNote'
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
type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
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

// Same composite-score weights/targets the Productivity page uses — keep
// these aligned so the Executive snapshot doesn't drift from the detail
// page.
const PROD_WEIGHTS = { loc: 0.30, accept: 0.25, commits: 0.20, activity: 0.15, sessions: 0.10 }
const PROD_TARGETS = {
  locPerDevPerDay:      200,
  commitsPerDevPerDay:  1.5,
  sessionsPerDevPerDay: 3,
  activityFloor:        0.5,
}

function fmtUsd(v: number, frac = 0) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: frac }).format(v)
}

export function Executive() {
  const t = useT()
  const { range } = useDateRange('7d')

  const summaries = useFetch<SummariesResp>(
    `/api/analytics/summaries?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  // Window-wide users (was: single-day `?date=...` which never re-fired on
  // range change). users/range returns per-day records so we can compute
  // window totals + distinct active devs across the whole period.
  const usersRange = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
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
    const days = usersRange.data?.days ?? []
    const dailyCost = cost.data?.daily ?? []
    const events = compliance.data?.data ?? []

    // Window-wide aggregates from users/range. Walk every day, collect:
    //   - distinct user identities that had any CC session (active devs)
    //   - daily LOC/commit/PR/session totals (for org-wide rollups)
    //   - daily active dev count (for the productivity score's
    //     activity-share input + the avg-DAU KPI)
    const activeUserIds = new Set<string>()
    let totalLoc = 0, totalCommits = 0, totalPrs = 0, totalSessions = 0
    let totalAccepted = 0, totalRejected = 0
    let activeDevDays = 0
    let maxAssignedSeats = 0
    const sessionsPerDay: number[] = []

    for (const day of days) {
      let dayActive = 0
      for (const u of day.data) {
        const cm = u.claude_code_metrics.core_metrics
        const ta = u.claude_code_metrics.tool_actions
        const hasSessions = cm.distinct_session_count > 0
        if (hasSessions) {
          activeUserIds.add(u.user.id || u.user.email_address || '')
          dayActive += 1
        }
        totalLoc += cm.lines_of_code.added_count
        totalCommits += cm.commit_count
        totalPrs += cm.pull_request_count
        totalSessions += cm.distinct_session_count
        totalAccepted += ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count
          + ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
        totalRejected += ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count
          + ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }
      activeDevDays += dayActive
      sessionsPerDay.push(dayActive)
    }
    activeUserIds.delete('') // drop placeholder for missing-id users
    const activeDevs = activeUserIds.size
    const acceptanceRate = acceptRate(totalAccepted, totalRejected)
    const nDays = Math.max(1, days.length)
    const avgDevsPerDay = activeDevDays / nDays
    const locPerDevPerDay = avgDevsPerDay > 0 ? totalLoc / nDays / avgDevsPerDay : 0
    const commitsPerDevPerDay = avgDevsPerDay > 0 ? totalCommits / nDays / avgDevsPerDay : 0
    const sessionsPerDevPerDay = avgDevsPerDay > 0 ? totalSessions / nDays / avgDevsPerDay : 0

    // Productivity score (same composite formula as the Productivity page)
    const cap = (x: number) => Math.max(0, Math.min(1, x))
    for (const s of sum) maxAssignedSeats = Math.max(maxAssignedSeats, s.assigned_seat_count ?? 0)
    const activityShare = maxAssignedSeats === 0 ? 0 : avgDevsPerDay / maxAssignedSeats
    const score = Math.round(100 * (
      PROD_WEIGHTS.loc      * cap(locPerDevPerDay      / PROD_TARGETS.locPerDevPerDay) +
      PROD_WEIGHTS.accept   * cap(acceptanceRate ?? 0) +
      PROD_WEIGHTS.commits  * cap(commitsPerDevPerDay  / PROD_TARGETS.commitsPerDevPerDay) +
      PROD_WEIGHTS.activity * cap(activityShare        / PROD_TARGETS.activityFloor) +
      PROD_WEIGHTS.sessions * cap(sessionsPerDevPerDay / PROD_TARGETS.sessionsPerDevPerDay)
    ))

    // DAU stats from summaries (avg + peak across the window)
    const dauSeriesRaw = sum.map((s) => s.daily_active_user_count ?? 0)
    const avgDau = dauSeriesRaw.length ? dauSeriesRaw.reduce((a, b) => a + b, 0) / dauSeriesRaw.length : 0
    const peakDau = dauSeriesRaw.length ? Math.max(...dauSeriesRaw) : 0
    const latest = sum[sum.length - 1]
    const prev = sum[sum.length - 2]
    const dauTrend = !latest?.daily_active_user_count || !prev?.daily_active_user_count
      ? undefined
      : { pct: ((latest.daily_active_user_count - prev.daily_active_user_count) / Math.max(1, prev.daily_active_user_count)) * 100 }

    // Cost-side derived metrics
    const spend = cost.data?.totals.net_spend_usd ?? 0
    const costPerKLoc = totalLoc > 0 ? spend / (totalLoc / 1000) : null
    const costPerDevPerDay = activeDevs > 0 && nDays > 0 ? spend / activeDevs / nDays : null

    // 30-day rolling projection from data.daily (live mode only).
    let proj30d: number | null = null
    let avg7d: number | null = null
    if (dailyCost.length > 0) {
      const byDate = new Map<string, number>()
      for (const d of dailyCost) byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.spend ?? 0))
      const sortedSpend = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)
      const last7 = sortedSpend.slice(-7)
      if (last7.length > 0) {
        avg7d = last7.reduce((a, b) => a + b, 0) / last7.length
        proj30d = avg7d * 30
      }
    }

    // Top model by spend in the window
    const byModel = new Map<string, number>()
    for (const d of dailyCost) byModel.set(d.model, (byModel.get(d.model) ?? 0) + (d.spend ?? 0))
    const topModel = [...byModel.entries()].sort(([, a], [, b]) => b - a)[0]

    const riskEvents = events.filter((e) => RISK_TYPES.has(e.type)).length
    const dauSeries = sum.map((s) => ({ date: fmtDate(s.starting_at), DAU: s.daily_active_user_count }))
    const spendSeries = (() => {
      const byDate = new Map<string, number>()
      for (const d of dailyCost) byDate.set(d.date, (byDate.get(d.date) ?? 0) + (d.spend ?? 0))
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, s]) => ({ date: fmtDate(date), Spend: Number(s.toFixed(2)) }))
    })()

    return {
      // People
      activeDevs,
      seats: maxAssignedSeats,
      avgDau,
      peakDau,
      dauTrend,
      adoption: latest?.monthly_adoption_rate != null ? latest.monthly_adoption_rate / 100 : undefined,
      // Productivity
      totalLoc,
      totalCommits,
      totalPrs,
      acceptanceRate,
      sessionsPerDevPerDay,
      score,
      // Cost
      spend,
      proj30d,
      avg7d,
      costPerKLoc,
      costPerDevPerDay,
      topModel,
      // Risk
      riskEvents,
      totalEvents: events.length,
      // Trends
      dauSeries,
      spendSeries,
      // Window meta
      nDays,
    }
  }, [summaries.data, usersRange.data, cost.data, compliance.data])

  const loading = summaries.loading || usersRange.loading || cost.loading || compliance.loading
  if (loading && snapshot.activeDevs === 0 && snapshot.totalLoc === 0) return <LoadingState />

  return (
    <div>
      <div className="print-hide">
        <PageHeader
          title={t('exec.title')}
          subtitle={t('exec.subtitle', { start: range.startingDate, end: upper, days: snapshot.nDays })}
          right={<DateRangeControl />}
        />
      </div>
      <GroupScopeNote />
      <div className="p-4 lg:p-8 print:p-8 space-y-6 print-export">
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

        {/* Row 1 — People */}
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ink-400 font-medium mb-2">{t('exec.section.people')}</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
            <KpiCard accent label={t('exec.kpi.active_devs')} value={fmtNum(snapshot.activeDevs)}
              hint={t('exec.kpi.active_devs.hint', { n: fmtNum(snapshot.seats), days: snapshot.nDays })} />
            <KpiCard label={t('exec.kpi.dau_avg')} value={fmtNum(Math.round(snapshot.avgDau))}
              trend={snapshot.dauTrend}
              hint={t('exec.kpi.dau_avg.hint', { peak: fmtNum(snapshot.peakDau) })} />
            <KpiCard label={t('exec.kpi.adoption')} value={fmtPct(snapshot.adoption)}
              hint={t('exec.kpi.adoption.hint')} />
            <KpiCard label={t('exec.kpi.seats')} value={fmtNum(snapshot.seats)}
              hint={t('exec.kpi.seats.hint')} />
          </div>
        </div>

        {/* Row 2 — Productivity */}
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ink-400 font-medium mb-2">{t('exec.section.productivity')}</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
            <KpiCard label={t('exec.kpi.loc')} value={fmtCompact(snapshot.totalLoc)}
              hint={t('exec.kpi.loc.hint', { commits: fmtNum(snapshot.totalCommits), prs: fmtNum(snapshot.totalPrs) })} />
            <KpiCard label={t('exec.kpi.accept')} value={snapshot.acceptanceRate != null ? fmtPct(snapshot.acceptanceRate) : '—'}
              hint={t('exec.kpi.accept.hint')} />
            <KpiCard label={t('exec.kpi.sessions_per_dev')} value={snapshot.sessionsPerDevPerDay.toFixed(1)}
              hint={t('exec.kpi.sessions_per_dev.hint')} />
            <ScoreCard score={snapshot.score} t={t} />
          </div>
        </div>

        {/* Row 3 — Cost & Risk */}
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ink-400 font-medium mb-2">{t('exec.section.cost')}</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
            <KpiCard accent label={t('exec.kpi.spend')} value={fmtUsd(snapshot.spend)}
              hint={t('exec.kpi.spend.hint', { perDev: snapshot.costPerDevPerDay != null ? fmtUsd(snapshot.costPerDevPerDay, 2) + '/dev/day' : '—' })} />
            <KpiCard label={t('exec.kpi.proj30d')} value={snapshot.proj30d != null ? fmtUsd(snapshot.proj30d) : '—'}
              hint={snapshot.avg7d != null ? t('exec.kpi.proj30d.hint', { avg: fmtUsd(snapshot.avg7d, 2) }) : t('exec.kpi.proj30d.hint.empty')} />
            <KpiCard label={t('exec.kpi.cost_per_kloc')} value={snapshot.costPerKLoc != null ? fmtUsd(snapshot.costPerKLoc, 2) : '—'}
              hint={t('exec.kpi.cost_per_kloc.hint')} />
            <KpiCard label={t('exec.kpi.risk')} value={fmtNum(snapshot.riskEvents)}
              hint={t('exec.kpi.risk.hint', { total: fmtNum(snapshot.totalEvents) })} />
          </div>
        </div>

        {/* One-line headline summary — every value is window-aware */}
        <div className="rounded-xl border border-ink-100 bg-paper-muted/30 p-4 text-sm text-ink-700 leading-relaxed">
          <span className="font-semibold text-ink-800">{t('exec.headline.label')}:</span>{' '}
          {t('exec.headline.body', {
            days: snapshot.nDays,
            devs: fmtNum(snapshot.activeDevs),
            seats: fmtNum(snapshot.seats),
            loc: fmtCompact(snapshot.totalLoc),
            commits: fmtNum(snapshot.totalCommits),
            accept: snapshot.acceptanceRate != null ? fmtPct(snapshot.acceptanceRate) : '—',
            spend: fmtUsd(snapshot.spend),
            proj: snapshot.proj30d != null ? fmtUsd(snapshot.proj30d) : '—',
            score: snapshot.score,
            risk: fmtNum(snapshot.riskEvents),
            top: snapshot.topModel ? `${snapshot.topModel[0]} (${fmtUsd(snapshot.topModel[1])})` : '—',
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6">
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
                  <Tooltip formatter={(v: number) => fmtUsd(v, 2)} />
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

// Mirrors the Productivity page's ScoreCard so the Executive snapshot
// renders the composite score with the same color ramp + arc gauge.
function ScoreCard({ score, t }: { score: number; t: (k: any, p?: any) => string }) {
  const hue = score >= 70 ? 145 : score >= 40 ? 35 : 10
  const circumference = 2 * Math.PI * 22
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100)
  return (
    <div className="relative rounded-xl border border-claude-200 bg-white px-5 py-4 shadow-card overflow-hidden">
      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('exec.kpi.score')}</div>
      <div className="mt-2 flex items-center gap-3">
        <svg width="56" height="56" viewBox="0 0 56 56">
          <circle cx="28" cy="28" r="22" fill="none" stroke="#EDEBE4" strokeWidth="6" />
          <circle
            cx="28" cy="28" r="22" fill="none"
            stroke={`hsl(${hue}, 60%, 50%)`}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 28 28)"
          />
          <text x="28" y="32" textAnchor="middle" className="font-semibold" fontSize="14" fill="#1F1E1D">
            {score}
          </text>
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-ink-500 leading-tight">{t('exec.kpi.score.hint')}</div>
        </div>
      </div>
    </div>
  )
}
