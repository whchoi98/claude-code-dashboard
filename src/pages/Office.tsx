import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, Cell, AreaChart, Area,
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
type OfficeRow = { email: string; sessions: number; messages: number }
type Tt = (k: any, p?: any) => string

const SURFACES = ['excel', 'powerpoint', 'word', 'outlook'] as const
const SURFACE_COLOR: Record<(typeof SURFACES)[number], string> = {
  excel: '#D97757', powerpoint: '#DF8663', word: '#8A8474', outlook: '#B75E40',
}

export function Office() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const users = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      const row = { date: fmtDate(d.date), excel: 0, powerpoint: 0, word: 0, outlook: 0 }
      for (const r of d.data) { if (!inGroup(r.user.email_address)) continue; for (const s of SURFACES) row[s] += r.office_metrics[s].distinct_session_count }
      return row
    })
    const surfaceSessions: Record<(typeof SURFACES)[number], number> = {
      excel: 0, powerpoint: 0, word: 0, outlook: 0,
    }
    const byEmail = new Map<string, OfficeRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0, skillsTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const email = r.user.email_address
        let userSessions = 0, userMessages = 0
        for (const s of SURFACES) {
          const m = r.office_metrics[s]
          surfaceSessions[s] += m.distinct_session_count
          userSessions += m.distinct_session_count
          userMessages += m.message_count
          skillsTotal += m.skills_used_count
        }
        sessionsTotal += userSessions
        messagesTotal += userMessages
        if (userSessions > 0) activeEmails.add(email)
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0 }; byEmail.set(email, cur) }
        cur.sessions += userSessions
        cur.messages += userMessages
      }
    }
    const surfaceBars = SURFACES.map((s) => ({ surface: s, sessions: surfaceSessions[s] }))
    return {
      daily, surfaceBars,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal, skillsTotal,
    }
  }, [users.data, inGroup])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = badgeSource(users.data?.days?.[0]?.source)
  const hasData = agg.sessionsTotal > 0

  return (
    <div>
      <PageHeader
        title={t('office.title')}
        subtitle={t('office.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <RangeCoverageNote resp={users.data} />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('office.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('office.kpi.active_users.hint')} />
          <KpiCard label={t('office.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('office.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('office.kpi.skills')} value={fmtCompact(agg.skillsTotal)} />
        </div>

        {hasData ? (
          <>
            <ChartCard title={t('office.byapp.title')} subtitle={t('office.byapp.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={agg.surfaceBars} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="surface" tickFormatter={(s: string) => t(`office.surface.${s}` as any)} />
                  <YAxis />
                  <Tooltip labelFormatter={(s: string) => t(`office.surface.${s}` as any)} />
                  <Bar dataKey="sessions" name={t('office.metric.sessions')} radius={[4, 4, 0, 0]}>
                    {agg.surfaceBars.map((b) => (<Cell key={b.surface} fill={SURFACE_COLOR[b.surface]} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('office.daily.title')} subtitle={t('office.daily.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  {SURFACES.map((s) => (
                    <Area key={s} type="monotone" dataKey={s} stackId="office" name={t(`office.surface.${s}` as any)} stroke={SURFACE_COLOR[s]} fill={SURFACE_COLOR[s]} fillOpacity={0.35} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('office.top.title')} subtitle={t('office.top.sub')}>
              <OfficeUserTable rows={agg.users} t={t} />
            </ChartCard>
          </>
        ) : (
          <EmptyState title={t('office.empty')} hint={t('office.empty.hint')} />
        )}
      </div>
    </div>
  )
}

function OfficeUserTable({ rows, t }: { rows: OfficeRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<OfficeRow, 'email' | 'sessions' | 'messages'>(
    rows,
    { email: (r) => r.email, sessions: (r) => r.sessions, messages: (r) => r.messages },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('office.top.empty')} /></div>
  return (
    <div className="px-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('office.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('office.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('office.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
