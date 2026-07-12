import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { ChartCard } from '../components/ChartCard'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { UserDetailPanel } from '../components/UserDetailPanel'
import { DateRangeControl } from '../components/DateRangeControl'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtPct, acceptRate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }

const WEIGHTS = { loc: 0.30, accept: 0.25, commits: 0.20, activity: 0.15, sessions: 0.10 }
const TARGETS = {
  locPerDay:      200,
  commitsPerDay:  1.5,
  sessionsPerDay: 3,
  activityDays:   0.4, // share of days active in the window
}

type K = 'user' | 'score' | 'loc' | 'sessions' | 'commits' | 'accept' | 'activeDays'

export function UserProductivity() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const url = `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const rangeResp = useFetch<RangeResp>(url)

  const enrichedRows = useMemo(() => {
    const days = rangeResp.data?.days ?? []
    const windowSize = Math.max(1, days.length)

    // Aggregate per-user across the range
    const byEmail = new Map<string, {
      email: string
      activeDays: number
      loc: number
      locRem: number
      sessions: number
      commits: number
      prs: number
      messages: number
      accepted: number
      rejected: number
      cowork: number
    }>()

    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const email = r.user.email_address
        const cc = r.claude_code_metrics.core_metrics
        const ta = r.claude_code_metrics.tool_actions
        const sessions = cc.distinct_session_count
        const key = email
        let cur = byEmail.get(key)
        if (!cur) {
          cur = { email, activeDays: 0, loc: 0, locRem: 0, sessions: 0, commits: 0, prs: 0, messages: 0, accepted: 0, rejected: 0, cowork: 0 }
          byEmail.set(key, cur)
        }
        if (sessions > 0 || r.chat_metrics.message_count > 0) cur.activeDays += 1
        cur.loc      += cc.lines_of_code.added_count
        cur.locRem   += cc.lines_of_code.removed_count
        cur.sessions += sessions
        cur.commits  += cc.commit_count
        cur.prs      += cc.pull_request_count
        cur.messages += r.chat_metrics.message_count
        cur.accepted += ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
                       ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
        cur.rejected += ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
                       ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
        cur.cowork   += r.cowork_metrics.distinct_session_count
      }
    }

    const cap = (x: number) => Math.max(0, Math.min(1, x))
    const enriched = Array.from(byEmail.values()).map((u) => {
      const accept = acceptRate(u.accepted, u.rejected)
      const locPerDay      = u.loc / windowSize
      const commitsPerDay  = u.commits / windowSize
      const sessionsPerDay = u.sessions / windowSize
      const activityShare  = u.activeDays / windowSize

      const score =
        WEIGHTS.loc      * cap(locPerDay / TARGETS.locPerDay) +
        WEIGHTS.accept   * cap(accept ?? 0) +
        WEIGHTS.commits  * cap(commitsPerDay / TARGETS.commitsPerDay) +
        WEIGHTS.activity * cap(activityShare / TARGETS.activityDays) +
        WEIGHTS.sessions * cap(sessionsPerDay / TARGETS.sessionsPerDay)

      return {
        ...u,
        masked: maskEmail(u.email),
        accept,
        locPerDay,
        commitsPerDay,
        sessionsPerDay,
        activityShare,
        score: Math.round(score * 100),
      }
    })

    const f = q.trim().toLowerCase()
    return enriched.filter((r) => !f || r.masked.toLowerCase().includes(f) || r.email.toLowerCase().includes(f))
  }, [rangeResp.data, q, inGroup])

  type R = (typeof enrichedRows)[number]
  const accessors: Record<K, (r: R) => string | number | null | undefined> = {
    user:       (r) => r.email,
    score:      (r) => r.score,
    loc:        (r) => r.loc,
    sessions:   (r) => r.sessions,
    commits:    (r) => r.commits,
    accept:     (r) => r.accept,
    activeDays: (r) => r.activeDays,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<R, K>(enrichedRows, accessors, {
    initialKey: 'score', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )

  if (rangeResp.loading) return <LoadingState />
  if (rangeResp.error) return <ErrorState error={rangeResp.error} />

  const chartData = rows.slice(0, 10).map((r) => ({
    name: r.masked,
    score: r.score,
    LOC: r.loc,
  }))

  return (
    <div>
      <PageHeader
        title={t('user_prod.title')}
        subtitle={t('user_prod.subtitle', { days: range.days })}
        source={rangeResp.data?.days?.[0]?.source as 'live' | 'mock' | undefined}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('users.search')}
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-claude-500 focus:outline-none w-full sm:w-56"
            />
          </div>
        }
      />
      <GroupTabs />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        {rows.length > 0 && (
          <ChartCard title={t('user_prod.top10')} subtitle={t('user_prod.top10.sub')}>
            <ResponsiveContainer width="100%" height={Math.max(240, chartData.length * 30)}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" domain={[0, 100]} />
                <YAxis dataKey="name" type="category" width={150} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number, n: string) => n === 'score' ? `${v}/100` : fmtNum(v)} />
                <Bar dataKey="score" fill="#D97757" radius={[0, 4, 4, 0]} name={t('user_prod.metric.score')} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {rows.length === 0 ? (
          <EmptyState title={t('users.empty')} hint={t('users.empty.hint')} />
        ) : (
          <div className="rounded-xl border border-ink-100 bg-white shadow-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-muted/60">
                <tr>
                  <Th label={t('user_prod.col.user')}       k="user"       align="left" />
                  <Th label={t('user_prod.col.score')}      k="score"      align="left" />
                  <Th label={t('user_prod.col.loc')}        k="loc"        align="left" />
                  <Th label={t('user_prod.col.sessions')}   k="sessions"   align="left" />
                  <Th label={t('user_prod.col.commits')}    k="commits"    align="left" />
                  <Th label={t('user_prod.col.accept')}     k="accept"     align="left" />
                  <Th label={t('user_prod.col.active_days')} k="activeDays" align="left" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.email}
                    onClick={() => setSelected(r.email)}
                    className={clsx(
                      'border-t border-ink-100 cursor-pointer transition-colors',
                      selected === r.email ? 'bg-claude-50/60' : 'hover:bg-paper-muted/40',
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-ink-700">{r.masked}</td>
                    <td className="px-4 py-2.5">
                      <ScoreBadge score={r.score} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <span className="text-claude-600 font-medium">+{fmtCompact(r.loc)}</span>
                      <span className="text-ink-300 text-xs"> / {r.locPerDay.toFixed(0)}/d</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">
                      {fmtNum(r.sessions)} <span className="text-ink-300 text-xs">/ {r.sessionsPerDay.toFixed(1)}/d</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">
                      {fmtNum(r.commits)} <span className="text-ink-300 text-xs">/ {fmtNum(r.prs)} PR</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtPct(r.accept)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">
                      {r.activeDays} / {range.days}
                      <span className="text-ink-300 text-xs"> ({(r.activityShare * 100).toFixed(0)}%)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl border border-ink-100 bg-paper-muted/40 px-5 py-3 text-[11px] text-ink-500 leading-relaxed">
          <b className="text-ink-700">{t('user_prod.score_formula')}</b>
          <br />
          {t('user_prod.score_formula.body')}
          <br />
          <span className="text-ink-400">{t('user_prod.score_note')}</span>
        </div>
      </div>

      <UserDetailPanel email={selected} range={range} onClose={() => setSelected(null)} />
    </div>
  )
}

function ScoreBadge({ score }: { score: number }) {
  const hue = score >= 70 ? 145 : score >= 40 ? 35 : 10
  const circumference = 2 * Math.PI * 10
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100)
  return (
    <div className="inline-flex items-center gap-2">
      <svg width="28" height="28" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="10" fill="none" stroke="#EDEBE4" strokeWidth="3" />
        <circle
          cx="14" cy="14" r="10" fill="none"
          stroke={`hsl(${hue}, 60%, 50%)`}
          strokeWidth="3" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 14 14)"
        />
      </svg>
      <span className="font-semibold text-ink-800 tabular-nums">{score}</span>
    </div>
  )
}
