import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { KpiCard } from '../components/KpiCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtCompact, fmtNum, fmtPct, acceptRate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }

const TOOLS = ['edit_tool', 'multi_edit_tool', 'write_tool', 'notebook_edit_tool'] as const

export function ClaudeCode() {
  const t = useT()
  const { range } = useDateRange('14d')
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
    // Top contributors: aggregate per-user before slicing top 10.
    const byEmail = new Map<string, { email: string; loc: number; commits: number; prs: number }>()

    for (const d of days) {
      for (const r of d.data) {
        const cm = r.claude_code_metrics.core_metrics
        loc      += cm.lines_of_code.added_count
        locRem   += cm.lines_of_code.removed_count
        commits  += cm.commit_count
        prs      += cm.pull_request_count
        sessions += cm.distinct_session_count
        if (cm.distinct_session_count > 0) activeEmails.add(r.user.email_address)
        for (const tk of TOOLS) {
          accBy[tk] += r.claude_code_metrics.tool_actions[tk].accepted_count
          rejBy[tk] += r.claude_code_metrics.tool_actions[tk].rejected_count
        }
        const key = r.user.email_address
        let cur = byEmail.get(key)
        if (!cur) { cur = { email: key, loc: 0, commits: 0, prs: 0 }; byEmail.set(key, cur) }
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

    const totalAccepted = tools.reduce((s, t) => s + t.Accepted, 0)
    const totalRejected = tools.reduce((s, t) => s + t.Rejected, 0)

    return { loc, locRem, commits, prs, sessions, activeUsers: activeEmails.size, tools, topCreators,
             overallAccept: acceptRate(totalAccepted, totalRejected) }
  }, [data])

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
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label="Active Developers" value={fmtNum(agg.activeUsers)} hint="users with CC sessions" />
          <KpiCard label="Lines of Code" value={fmtCompact(agg.loc)} hint={`-${fmtCompact(agg.locRem)} removed`} />
          <KpiCard label="Commits / PRs" value={`${fmtNum(agg.commits)} / ${fmtNum(agg.prs)}`} hint="by Claude Code" />
          <KpiCard label="Tool Acceptance" value={fmtPct(agg.overallAccept)} hint={`${fmtNum(agg.sessions)} sessions`} />
        </div>

        <div className="grid grid-cols-3 gap-6">
          <ChartCard title="Acceptance by Tool" className="col-span-2">
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

          <ChartCard title="Acceptance Rates" subtitle="% accepted per tool">
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

        <ChartCard title="Top Contributors" subtitle="Lines of code added (top 10)">
          <ResponsiveContainer width="100%" height={360}>
            <BarChart data={agg.topCreators} layout="vertical" margin={{ top: 8, right: 16, left: 60, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="email" type="category" width={180} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="loc" fill="#D97757" radius={[0, 4, 4, 0]} name="Lines of Code" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  )
}
