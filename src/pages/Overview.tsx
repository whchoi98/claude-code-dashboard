import { useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtNum, fmtDate, acceptRate, fmtPct } from '../lib/format'
import type { Summary, UserRecord } from '../types'

type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }
type UsersResp = { source: 'live' | 'mock'; reason?: string; date: string; data: UserRecord[] }

export function Overview() {
  const t = useT()
  const { range } = useDateRange('14d')

  const summaries = useFetch<SummariesResp>(
    `/api/analytics/summaries?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const users = useFetch<UsersResp>(`/api/analytics/users?date=${range.endingDate}`)

  const kpis = useMemo(() => {
    const sum = summaries.data?.data ?? []
    const recs = users.data?.data ?? []
    const latest = sum[sum.length - 1]
    const prev = sum[sum.length - 2]
    const trend = (a?: number, b?: number) =>
      !a || !b ? undefined : { pct: ((a - b) / Math.max(1, b)) * 100 }

    const loc = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
    const commits = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.commit_count, 0)
    const prs = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.pull_request_count, 0)
    const ccSessions = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.distinct_session_count, 0)

    const totalAccepted = recs.reduce((s, r) => {
      const ta = r.claude_code_metrics.tool_actions
      return s + ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
             ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
    }, 0)
    const totalRejected = recs.reduce((s, r) => {
      const ta = r.claude_code_metrics.tool_actions
      return s + ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
             ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
    }, 0)

    return {
      dau: latest?.daily_active_user_count,
      dauTrend: trend(latest?.daily_active_user_count, prev?.daily_active_user_count),
      wau: latest?.weekly_active_user_count,
      mau: latest?.monthly_active_user_count,
      seats: latest?.assigned_seat_count,
      adoption: latest?.monthly_adoption_rate != null ? latest.monthly_adoption_rate / 100 : undefined,
      loc, commits, prs, ccSessions,
      accept: acceptRate(totalAccepted, totalRejected),
    }
  }, [summaries.data, users.data])

  if (summaries.loading || users.loading) return <LoadingState />
  if (summaries.error) return <ErrorState error={summaries.error} />
  if (users.error) return <ErrorState error={users.error} />

  const chartData = (summaries.data?.data ?? []).map((s) => ({
    date: fmtDate(s.starting_at),
    DAU: s.daily_active_user_count,
    WAU: s.weekly_active_user_count,
    MAU: s.monthly_active_user_count,
  }))

  const toolData = (() => {
    const recs = users.data?.data ?? []
    const tools = ['edit_tool', 'multi_edit_tool', 'write_tool', 'notebook_edit_tool'] as const
    return tools.map((tool) => {
      const accepted = recs.reduce((s, r) => s + r.claude_code_metrics.tool_actions[tool].accepted_count, 0)
      const rejected = recs.reduce((s, r) => s + r.claude_code_metrics.tool_actions[tool].rejected_count, 0)
      return { tool: tool.replace('_tool', '').replace('_', ' '), Accepted: accepted, Rejected: rejected }
    })
  })()

  return (
    <div>
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        source={summaries.source}
        reason={summaries.reason}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('kpi.dau')} value={fmtNum(kpis.dau)} trend={kpis.dauTrend} hint={t('kpi.seats', { n: fmtNum(kpis.seats) })} />
          <KpiCard label={t('kpi.wau')}  value={fmtNum(kpis.wau)} hint={t('kpi.rolling7')} />
          <KpiCard label={t('kpi.mau')}  value={fmtNum(kpis.mau)} hint={t('kpi.rolling30')} />
          <KpiCard label={t('kpi.adoption')} value={fmtPct(kpis.adoption)} hint={t('kpi.monthly_api')} />
        </div>
        <div className="grid grid-cols-4 gap-4">
          <KpiCard label={t('kpi.loc')}         value={fmtCompact(kpis.loc)}      hint={t('kpi.added_today')} />
          <KpiCard label={t('kpi.cc_sessions')} value={fmtNum(kpis.ccSessions)}   hint={t('kpi.distinct_sess')} />
          <KpiCard label={t('kpi.commits_prs')} value={`${fmtNum(kpis.commits)} / ${fmtNum(kpis.prs)}`} hint={t('kpi.by_cc')} />
          <KpiCard label={t('kpi.tool_accept')} value={fmtPct(kpis.accept)}        hint={t('kpi.all_cc_tools')} />
        </div>

        <ChartCard title={t('chart.active_users')} subtitle={t('chart.active_users.sub')}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <defs>
                <linearGradient id="dauGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#D97757" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#D97757" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="DAU" stroke="#D97757" strokeWidth={2} fill="url(#dauGrad)" />
              <Area type="monotone" dataKey="WAU" stroke="#8A8474" strokeWidth={1.5} fillOpacity={0} />
              <Area type="monotone" dataKey="MAU" stroke="#1F1E1D" strokeWidth={1.5} fillOpacity={0} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('chart.tool_acceptance')} subtitle={t('chart.tool_acceptance.sub')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={toolData} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="tool" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Accepted" stackId="a" fill="#D97757" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Rejected" stackId="a" fill="#EDEBE4" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  )
}
