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

type UsersResp = { source: 'live' | 'mock'; reason?: string; date: string; data: UserRecord[] }

const TOOLS = ['edit_tool', 'multi_edit_tool', 'write_tool', 'notebook_edit_tool'] as const

export function ClaudeCode() {
  const t = useT()
  const { range } = useDateRange('14d')
  const { data, loading, error, source, reason } = useFetch<UsersResp>(
    `/api/analytics/users?date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const recs = data?.data ?? []
    const loc = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
    const locRem = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.removed_count, 0)
    const commits = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.commit_count, 0)
    const prs = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.pull_request_count, 0)
    const sessions = recs.reduce((s, r) => s + r.claude_code_metrics.core_metrics.distinct_session_count, 0)
    const activeUsers = recs.filter((r) => r.claude_code_metrics.core_metrics.distinct_session_count > 0).length

    const tools = TOOLS.map((t) => {
      const accepted = recs.reduce((s, r) => s + r.claude_code_metrics.tool_actions[t].accepted_count, 0)
      const rejected = recs.reduce((s, r) => s + r.claude_code_metrics.tool_actions[t].rejected_count, 0)
      const rate = acceptRate(accepted, rejected)
      return {
        tool: t.replace('_tool', '').replace(/_/g, ' '),
        Accepted: accepted,
        Rejected: rejected,
        rate: rate == null ? 0 : rate * 100,
      }
    })

    const topCreators = [...recs]
      .map((r) => ({
        email: maskEmail(r.user.email_address),
        loc: r.claude_code_metrics.core_metrics.lines_of_code.added_count,
        commits: r.claude_code_metrics.core_metrics.commit_count,
        prs: r.claude_code_metrics.core_metrics.pull_request_count,
      }))
      .sort((a, b) => b.loc - a.loc)
      .slice(0, 10)

    const totalAccepted = tools.reduce((s, t) => s + t.Accepted, 0)
    const totalRejected = tools.reduce((s, t) => s + t.Rejected, 0)

    return { loc, locRem, commits, prs, sessions, activeUsers, tools, topCreators,
             overallAccept: acceptRate(totalAccepted, totalRejected) }
  }, [data])

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  return (
    <div>
      <PageHeader
        title={t('cc.title')}
        subtitle={t('cc.subtitle', { date: data?.date || '' })}
        source={source}
        reason={reason}
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
