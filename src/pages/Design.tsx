import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line, LineChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { RangeCoverageNote } from '../components/RangeCoverageNote'
import { badgeSource } from '../lib/format'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtDate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type DesignRow = { email: string; sessions: number; messages: number; projectsCreated: number }
type Tt = (k: any, p?: any) => string

export function Design() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const users = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let sessions = 0, messages = 0, projectsUsed = 0, projectsCreated = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.design_metrics
        sessions += m.distinct_session_count
        messages += m.message_count
        projectsUsed += m.distinct_projects_used_count
        projectsCreated += m.distinct_projects_created_count
      }
      return { date: fmtDate(d.date), sessions, messages, projectsUsed, projectsCreated }
    })
    const byEmail = new Map<string, DesignRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0, projectsCreatedTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.design_metrics
        const email = r.user.email_address
        if (m.distinct_session_count > 0) activeEmails.add(email)
        sessionsTotal += m.distinct_session_count
        messagesTotal += m.message_count
        projectsCreatedTotal += m.distinct_projects_created_count
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0, projectsCreated: 0 }; byEmail.set(email, cur) }
        cur.sessions += m.distinct_session_count
        cur.messages += m.message_count
        cur.projectsCreated += m.distinct_projects_created_count
      }
    }
    return {
      daily,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal, projectsCreatedTotal,
    }
  }, [users.data, inGroup])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = badgeSource(users.data?.days?.[0]?.source)
  const hasData = agg.sessionsTotal > 0

  return (
    <div>
      <PageHeader
        title={t('design.title')}
        subtitle={t('design.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <RangeCoverageNote resp={users.data} />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('design.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('design.kpi.active_users.hint')} />
          <KpiCard label={t('design.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('design.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('design.kpi.projects')} value={fmtCompact(agg.projectsCreatedTotal)} hint={t('design.kpi.projects.hint')} />
        </div>

        {hasData ? (
          <>
            <ChartCard title={t('design.daily.title')} subtitle={t('design.daily.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <defs>
                    <linearGradient id="designGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4CA371" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#4CA371" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="sessions" name={t('design.metric.sessions')} stroke="#4CA371" strokeWidth={2} fill="url(#designGrad)" />
                  <Line type="monotone" dataKey="messages" name={t('design.metric.messages')} stroke="#8A8474" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('design.projects.title')} subtitle={t('design.projects.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="projectsCreated" name={t('design.metric.projects_created')} stroke="#4CA371" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="projectsUsed" name={t('design.metric.projects_used')} stroke="#8A8474" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('design.top.title')} subtitle={t('design.top.sub')}>
              <DesignUserTable rows={agg.users} t={t} />
            </ChartCard>
          </>
        ) : (
          <EmptyState title={t('design.empty')} hint={t('design.empty.hint')} />
        )}
      </div>
    </div>
  )
}

function DesignUserTable({ rows, t }: { rows: DesignRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<DesignRow, 'email' | 'sessions' | 'messages' | 'projectsCreated'>(
    rows,
    {
      email: (r) => r.email,
      sessions: (r) => r.sessions,
      messages: (r) => r.messages,
      projectsCreated: (r) => r.projectsCreated,
    },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('design.top.empty')} /></div>
  return (
    <div className="px-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('design.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('design.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('design.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('design.metric.projects_created')} k="projectsCreated" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.projectsCreated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
