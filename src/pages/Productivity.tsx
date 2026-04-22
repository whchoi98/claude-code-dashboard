import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  Area, Bar, AreaChart,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { KpiCard } from '../components/KpiCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtPct, fmtDate, acceptRate } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }

const WEIGHTS = {
  loc: 0.30,
  accept: 0.25,
  commits: 0.20,
  activity: 0.15,
  sessions: 0.10,
}
// Targets used to normalize inputs into 0..1 before weighting.
const TARGETS = {
  locPerDevPerDay:      200,
  commitsPerDevPerDay:  1.5,
  sessionsPerDevPerDay: 3,
  activityFloor:        0.5, // % of seats that should be active daily
}

export function Productivity() {
  const t = useT()
  const { range: dr } = useDateRange('14d')
  const range = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${dr.startingDate}&ending_date=${dr.endingDate}`,
  )

  const { daily, aggregate, score } = useMemo(() => {
    const days = range.data?.days ?? []

    const daily = days.map((d) => {
      const active = d.data.filter((u) => u.claude_code_metrics.core_metrics.distinct_session_count > 0)
      const loc = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
      const locRem = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.removed_count, 0)
      const commits = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.commit_count, 0)
      const prs = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.pull_request_count, 0)
      const sessions = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.distinct_session_count, 0)

      const accepted = d.data.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
               ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
      }, 0)
      const rejected = d.data.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
               ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }, 0)
      const rate = acceptRate(accepted, rejected)

      return {
        date: fmtDate(d.date),
        activeDevs: active.length,
        totalUsers: d.data.length,
        loc, locRem,
        commits, prs, sessions,
        accepted, rejected,
        acceptRate: rate == null ? null : rate * 100,
      }
    })

    const agg = daily.reduce((a, d) => ({
      locTotal: a.locTotal + d.loc,
      commitsTotal: a.commitsTotal + d.commits,
      prsTotal: a.prsTotal + d.prs,
      sessionsTotal: a.sessionsTotal + d.sessions,
      acceptedTotal: a.acceptedTotal + d.accepted,
      rejectedTotal: a.rejectedTotal + d.rejected,
      activeDevDays: a.activeDevDays + d.activeDevs,
      maxUsers: Math.max(a.maxUsers, d.totalUsers),
    }), { locTotal: 0, commitsTotal: 0, prsTotal: 0, sessionsTotal: 0,
          acceptedTotal: 0, rejectedTotal: 0, activeDevDays: 0, maxUsers: 0 })

    const nDays = Math.max(1, daily.length)
    const avgDevsPerDay = agg.activeDevDays / nDays
    const locPerDevPerDay      = avgDevsPerDay === 0 ? 0 : (agg.locTotal / nDays) / avgDevsPerDay
    const commitsPerDevPerDay  = avgDevsPerDay === 0 ? 0 : (agg.commitsTotal / nDays) / avgDevsPerDay
    const sessionsPerDevPerDay = avgDevsPerDay === 0 ? 0 : (agg.sessionsTotal / nDays) / avgDevsPerDay
    const orgAccept = acceptRate(agg.acceptedTotal, agg.rejectedTotal) ?? 0
    const activityShare = agg.maxUsers === 0 ? 0 : avgDevsPerDay / agg.maxUsers

    // Composite productivity score 0..100
    const cap = (x: number) => Math.max(0, Math.min(1, x))
    const score =
      WEIGHTS.loc      * cap(locPerDevPerDay / TARGETS.locPerDevPerDay) +
      WEIGHTS.accept   * cap(orgAccept) +
      WEIGHTS.commits  * cap(commitsPerDevPerDay / TARGETS.commitsPerDevPerDay) +
      WEIGHTS.activity * cap(activityShare / TARGETS.activityFloor) +
      WEIGHTS.sessions * cap(sessionsPerDevPerDay / TARGETS.sessionsPerDevPerDay)

    return {
      daily,
      aggregate: {
        locPerDevPerDay,
        commitsPerDevPerDay,
        sessionsPerDevPerDay,
        avgAccept: orgAccept,
        avgDevsPerDay,
        activityShare,
        ...agg,
      },
      score: Math.round(score * 100),
    }
  }, [range.data])

  if (range.loading) return <LoadingState />
  if (range.error) return <ErrorState error={range.error} />

  const days = range.data?.days?.length ?? 7

  return (
    <div>
      <PageHeader
        title={t('prod.title')}
        subtitle={t('prod.subtitle', { days })}
        source={range.data?.days?.[0]?.source as 'live' | 'mock' | undefined}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-5 gap-4">
          <ScoreCard score={score} t={t} />
          <KpiCard label={t('prod.avg_loc')}     value={fmtCompact(Math.round(aggregate.locPerDevPerDay))}     hint={`${fmtCompact(aggregate.locTotal)} total`} />
          <KpiCard label={t('prod.avg_sess')}    value={aggregate.sessionsPerDevPerDay.toFixed(1)}              hint={`${fmtNum(aggregate.sessionsTotal)} total`} />
          <KpiCard label={t('prod.avg_commits')} value={aggregate.commitsPerDevPerDay.toFixed(1)}               hint={`${fmtNum(aggregate.commitsTotal)} / ${fmtNum(aggregate.prsTotal)} PR`} />
          <KpiCard label={t('prod.avg_accept')}  value={fmtPct(aggregate.avgAccept)}                            hint={`${fmtNum(aggregate.acceptedTotal + aggregate.rejectedTotal)} ops`} />
        </div>

        <ChartCard title={t('prod.loc_trend')}>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <defs>
                <linearGradient id="locGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#D97757" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#D97757" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="loc" stroke="#D97757" strokeWidth={2} fill="url(#locGrad)" name="Added" />
              <Area type="monotone" dataKey="locRem" stroke="#8A8474" strokeWidth={1.5} fillOpacity={0} name="Removed" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="grid grid-cols-2 gap-6">
          <ChartCard title={t('prod.commits_prs')}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="commits" stroke="#D97757" strokeWidth={2.5} dot={{ r: 2 }} name="Commits" />
                <Line type="monotone" dataKey="prs"     stroke="#1F1E1D" strokeWidth={2}   dot={false} name="PRs" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t('prod.accept_trend')}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis unit="%" domain={[0, 100]} />
                <Tooltip formatter={(v: number) => v == null ? '—' : `${v.toFixed(1)}%`} />
                <Line type="monotone" dataKey="acceptRate" stroke="#B75E40" strokeWidth={2.5} dot={{ r: 2 }} name="Rate" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title={t('prod.sessions')}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis yAxisId="left" />
              <YAxis yAxisId="right" orientation="right" />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar  yAxisId="left"  dataKey="sessions"    fill="#F5DCCF" radius={[3, 3, 0, 0]} name="Sessions" />
              <Line yAxisId="right" dataKey="activeDevs"  stroke="#D97757" strokeWidth={2.5} dot={{ r: 2 }} name="Active devs" />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  )
}

function ScoreCard({ score, t }: { score: number; t: (k: any, p?: any) => string }) {
  // Color ramp: red < 40, amber < 70, green otherwise
  const hue = score >= 70 ? 145 : score >= 40 ? 35 : 10
  const circumference = 2 * Math.PI * 26
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100)
  return (
    <div className="relative rounded-xl border border-claude-200 bg-white px-5 py-4 shadow-card overflow-hidden">
      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('prod.score')}</div>
      <div className="mt-2 flex items-center gap-3">
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="26" fill="none" stroke="#EDEBE4" strokeWidth="6" />
          <circle
            cx="32" cy="32" r="26" fill="none"
            stroke={`hsl(${hue}, 60%, 50%)`}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 32 32)"
          />
          <text x="32" y="36" textAnchor="middle" className="font-semibold" fontSize="16" fill="#1F1E1D">
            {score}
          </text>
        </svg>
        <div className="flex-1">
          <div className="text-[11px] text-ink-500 leading-tight">{t('prod.score.desc')}</div>
          <div className="text-[11px] text-ink-400 mt-1">{t('prod.score.hint')}</div>
        </div>
      </div>
    </div>
  )
}
