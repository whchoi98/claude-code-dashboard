import { useMemo } from 'react'
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { GroupScopeNote } from '../components/GroupScopeNote'
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
import { fmtNum, fmtCompact, fmtPct, fmtDate, maskEmail } from '../lib/format'
import type { Summary, UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }
type UserRow = { email: string; sessions: number; messages: number; actions: number; dispatchTurns: number }
type Tt = (k: any, p?: any) => string

const FE_KEYS = [
  'file_edit_count', 'edit_tool_count', 'multi_edit_tool_count',
  'write_tool_count', 'notebook_edit_tool_count', 'sessions_with_file_edits_count',
] as const

export function Cowork() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const summaries = useFetch<SummariesResp>(`/api/analytics/summaries${q}`)
  const users = useFetch<RangeResp>(`/api/analytics/users/range${q}`)

  const agg = useMemo(() => {
    const sums = summaries.data?.data ?? []
    const trend = sums.map((s) => ({
      date: fmtDate(s.starting_at),
      DAU: s.cowork_daily_active_user_count,
      WAU: s.cowork_weekly_active_user_count,
      MAU: s.cowork_monthly_active_user_count,
    }))
    const last = sums[sums.length - 1]
    const adoption = last && last.assigned_seat_count
      ? last.cowork_daily_active_user_count / last.assigned_seat_count
      : null

    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let sessions = 0, messages = 0, actions = 0, dispatchTurns = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const c = r.cowork_metrics
        sessions += c.distinct_session_count
        messages += c.message_count
        actions += c.action_count
        dispatchTurns += c.dispatch_turn_count
      }
      return { date: fmtDate(d.date), sessions, messages, actions, dispatchTurns }
    })

    const byEmail = new Map<string, UserRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0
    const fe: Record<(typeof FE_KEYS)[number], number> = {
      file_edit_count: 0, edit_tool_count: 0, multi_edit_tool_count: 0,
      write_tool_count: 0, notebook_edit_tool_count: 0, sessions_with_file_edits_count: 0,
    }
    let anyNonNull = false
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const c = r.cowork_metrics
        const email = r.user.email_address
        if (c.distinct_session_count > 0) activeEmails.add(email)
        sessionsTotal += c.distinct_session_count
        messagesTotal += c.message_count
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0, actions: 0, dispatchTurns: 0 }; byEmail.set(email, cur) }
        cur.sessions += c.distinct_session_count
        cur.messages += c.message_count
        cur.actions += c.action_count
        cur.dispatchTurns += c.dispatch_turn_count
        for (const k of FE_KEYS) {
          const v = c[k]
          if (v != null) anyNonNull = true
          fe[k] += v ?? 0
        }
      }
    }
    const feBars = FE_KEYS.map((k) => ({ key: k, value: fe[k] }))
    return {
      trend, adoption, daily,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal,
      feBars, feHasData: anyNonNull,
    }
  }, [summaries.data, users.data, inGroup])

  if (summaries.loading || users.loading) return <LoadingState />
  if (summaries.error) return <ErrorState error={summaries.error} />
  if (users.error) return <ErrorState error={users.error} />

  const source = users.data?.days?.[0]?.source as 'live' | 'mock' | undefined

  return (
    <div>
      <PageHeader
        title={t('cowork.title')}
        subtitle={t('cowork.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      {/* Adoption KPI + DAU/WAU/MAU trend come from org summaries (no per-user
          dimension) and ignore the group — flag it like Cost does. */}
      <GroupScopeNote variant="partial" />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('cowork.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('cowork.kpi.active_users.hint')} />
          <KpiCard label={t('cowork.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('cowork.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('cowork.kpi.adoption')} value={fmtPct(agg.adoption)} hint={t('cowork.kpi.adoption.hint')} />
        </div>

        <ChartCard title={t('cowork.trend.title')} subtitle={t('cowork.trend.sub')}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={agg.trend} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="DAU" name={t('cowork.metric.dau')} stroke="#B75E40" strokeWidth={2.5} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="WAU" name={t('cowork.metric.wau')} stroke="#DF8663" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="MAU" name={t('cowork.metric.mau')} stroke="#8A8474" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('cowork.engagement.title')} subtitle={t('cowork.engagement.sub')}>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <defs>
                <linearGradient id="coworkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#B75E40" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#B75E40" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="sessions" name={t('cowork.metric.sessions')} stroke="#B75E40" strokeWidth={2} fill="url(#coworkGrad)" />
              <Line type="monotone" dataKey="messages" name={t('cowork.metric.messages')} stroke="#E69F7F" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="actions" name={t('cowork.metric.actions')} stroke="#8A8474" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="dispatchTurns" name={t('cowork.metric.dispatch_turns')} stroke="#1F1E1D" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('cowork.top.title')} subtitle={t('cowork.top.sub')}>
          <CoworkUserTable rows={agg.users} t={t} />
        </ChartCard>

        <ChartCard title={t('cowork.fileedit.title')} subtitle={t('cowork.fileedit.sub')}>
          {agg.feHasData ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={agg.feBars} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="key" width={150} tick={{ fontSize: 11 }} tickFormatter={(k: string) => t(`cowork.fe.${k}` as any)} />
                <Tooltip formatter={(v: number) => fmtNum(v)} labelFormatter={(k: string) => t(`cowork.fe.${k}` as any)} />
                <Bar dataKey="value" fill="#B75E40" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="px-4 py-2">
              <EmptyState title={t('cowork.fileedit.empty')} hint={t('cowork.fileedit.empty.hint')} />
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  )
}

function CoworkUserTable({ rows, t }: { rows: UserRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<UserRow, 'email' | 'sessions' | 'messages' | 'actions' | 'dispatchTurns'>(
    rows,
    {
      email: (r) => r.email,
      sessions: (r) => r.sessions,
      messages: (r) => r.messages,
      actions: (r) => r.actions,
      dispatchTurns: (r) => r.dispatchTurns,
    },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('cowork.top.empty')} /></div>
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('cowork.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('cowork.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.actions')} k="actions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.dispatch_turns')} k="dispatchTurns" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.actions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.dispatchTurns)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
