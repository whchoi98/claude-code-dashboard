import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { ChartCard } from '../components/ChartCard'
import { KpiCard } from '../components/KpiCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtNum, fmtPct, acceptRate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type CCRow = { email: string; sessions: number; loc: number; commits: number; prs: number; accept: number | null }
type Tt = (k: any, p?: any) => string

const TOOLS = ['edit_tool', 'multi_edit_tool', 'write_tool', 'notebook_edit_tool'] as const

export function ClaudeCode() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const { data, loading, error } = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const source = data?.days?.[0]?.source as 'live' | 'mock' | undefined

  const agg = useMemo(() => {
    const days = data?.days ?? []

    // Org-wide totals: sum across every (day, user) pair.
    let loc = 0, locRem = 0, commits = 0, prs = 0, sessions = 0
    const accBy: Record<string, number> = { edit_tool: 0, multi_edit_tool: 0, write_tool: 0, notebook_edit_tool: 0 }
    const rejBy: Record<string, number> = { edit_tool: 0, multi_edit_tool: 0, write_tool: 0, notebook_edit_tool: 0 }

    // Active developers = distinct users with at least one CC session anywhere
    // in the window. We dedupe by email rather than counting per-day actives.
    const activeEmails = new Set<string>()
    const byEmail = new Map<string, { email: string; sessions: number; loc: number; commits: number; prs: number; accepted: number; rejected: number }>()

    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const cm = r.claude_code_metrics.core_metrics
        const email = r.user.email_address
        loc      += cm.lines_of_code.added_count
        locRem   += cm.lines_of_code.removed_count
        commits  += cm.commit_count
        prs      += cm.pull_request_count
        sessions += cm.distinct_session_count
        if (cm.distinct_session_count > 0) activeEmails.add(email)
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, loc: 0, commits: 0, prs: 0, accepted: 0, rejected: 0 }; byEmail.set(email, cur) }
        for (const tk of TOOLS) {
          const ta = r.claude_code_metrics.tool_actions[tk]
          accBy[tk] += ta.accepted_count
          rejBy[tk] += ta.rejected_count
          cur.accepted += ta.accepted_count
          cur.rejected += ta.rejected_count
        }
        cur.sessions += cm.distinct_session_count
        cur.loc     += cm.lines_of_code.added_count
        cur.commits += cm.commit_count
        cur.prs     += cm.pull_request_count
      }
    }

    const tools = TOOLS.map((tk) => {
      const accepted = accBy[tk]
      const rejected = rejBy[tk]
      const rate = acceptRate(accepted, rejected)
      return {
        tool: tk.replace('_tool', '').replace(/_/g, ' '),
        Accepted: accepted,
        Rejected: rejected,
        rate: rate == null ? 0 : rate * 100,
      }
    })

    const topCreators = Array.from(byEmail.values())
      .sort((a, b) => b.loc - a.loc)
      .slice(0, 10)
      .map((u) => ({ email: maskEmail(u.email), loc: u.loc, commits: u.commits, prs: u.prs }))

    const userRows: CCRow[] = Array.from(byEmail.values()).map((u) => ({
      email: u.email, sessions: u.sessions, loc: u.loc, commits: u.commits, prs: u.prs,
      accept: acceptRate(u.accepted, u.rejected),
    }))

    const totalAccepted = tools.reduce((s, t) => s + t.Accepted, 0)
    const totalRejected = tools.reduce((s, t) => s + t.Rejected, 0)

    return { loc, locRem, commits, prs, sessions, activeUsers: activeEmails.size, tools, topCreators, userRows,
             overallAccept: acceptRate(totalAccepted, totalRejected) }
  }, [data, inGroup])

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  return (
    <div>
      <PageHeader
        title={t('cc.title')}
        subtitle={t('cc.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('cc.active_devs')} value={fmtNum(agg.activeUsers)} hint={t('cc.active_devs.hint')} />
          <KpiCard label={t('cc.kpi.loc')} value={fmtCompact(agg.loc)} hint={t('cc.removed', { n: fmtCompact(agg.locRem) })} />
          <KpiCard label={t('cc.kpi.commits_prs')} value={`${fmtNum(agg.commits)} / ${fmtNum(agg.prs)}`} hint={t('cc.kpi.commits_prs.hint')} />
          <KpiCard label={t('cc.kpi.tool_accept')} value={fmtPct(agg.overallAccept)} hint={t('cc.kpi.sessions_count', { n: fmtNum(agg.sessions) })} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 print:grid-cols-3 gap-6">
          <ChartCard title={t('cc.accept_by_tool')} className="lg:col-span-2">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={agg.tools} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
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

          <ChartCard title={t('cc.accept_rates')} subtitle={t('cc.accept_rates.sub')}>
            <ResponsiveContainer width="100%" height={280}>
              <RadialBarChart
                data={agg.tools} startAngle={90} endAngle={-270}
                innerRadius="30%" outerRadius="95%"
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar
                  background={{ fill: '#F3F1EB' }}
                  dataKey="rate" cornerRadius={6} fill="#D97757"
                  label={{ position: 'insideStart', fill: '#FAF9F5', fontSize: 10 }}
                />
                <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
              </RadialBarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title={t('cc.top_contrib')} subtitle={t('cc.top_contrib.sub')}>
          <ResponsiveContainer width="100%" height={360}>
            <BarChart data={agg.topCreators} layout="vertical" margin={{ top: 8, right: 16, left: 60, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="email" type="category" width={180} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="loc" fill="#D97757" radius={[0, 4, 4, 0]} name={t('cc.contrib.loc_label')} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Per-user table — same pattern as the Cowork/Design surface pages */}
        <ChartCard title={t('cc.top.title')} subtitle={t('cc.top.sub')}>
          <CCUserTable rows={agg.userRows} t={t} />
        </ChartCard>
      </div>
    </div>
  )
}

function CCUserTable({ rows, t }: { rows: CCRow[]; t: Tt }) {
  type K = 'email' | 'sessions' | 'loc' | 'commits' | 'prs' | 'accept'
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<CCRow, K>(
    rows,
    {
      email: (r) => r.email,
      sessions: (r) => r.sessions,
      loc: (r) => r.loc,
      commits: (r) => r.commits,
      prs: (r) => r.prs,
      accept: (r) => r.accept,
    },
    { initialKey: 'loc', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('cc.top.empty')} /></div>
  return (
    <div className="px-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('users.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('users.col.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('users.col.loc')} k="loc" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('users.col.commits')} k="commits" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('users.col.prs')} k="prs" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('users.col.accept')} k="accept" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.loc)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.commits)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.prs)}</td>
              <td className="py-2 text-right tabular-nums">{fmtPct(r.accept)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
