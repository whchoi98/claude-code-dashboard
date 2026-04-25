import { useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { UserDetailPanel } from '../components/UserDetailPanel'
import { DateRangeControl } from '../components/DateRangeControl'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { fmtNum, fmtPct, acceptRate, maskEmail } from '../lib/format'
import { useT } from '../lib/i18n'
import type { UserRecord } from '../types'
import clsx from 'clsx'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type SortKey = 'messages' | 'loc' | 'sessions' | 'commits' | 'accept'

export function Users() {
  const t = useT()
  const { range } = useDateRange('14d')
  const { data, loading, error } = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const source = data?.days?.[0]?.source as 'live' | 'mock' | undefined
  const [sort, setSort] = useState<SortKey>('loc')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const rows = useMemo(() => {
    // Aggregate per-user across the selected window. acceptRate is recomputed
    // from summed numerator/denominator so a single high-volume day can't get
    // diluted by averaging daily ratios.
    const byEmail = new Map<string, {
      email: string; messages: number; convos: number; sessions: number;
      loc: number; locRemoved: number; commits: number; prs: number;
      accepted: number; rejected: number;
    }>()
    for (const d of data?.days ?? []) {
      for (const r of d.data) {
        const cc = r.claude_code_metrics
        const ta = cc.tool_actions
        const email = r.user.email_address
        let cur = byEmail.get(email)
        if (!cur) {
          cur = { email, messages: 0, convos: 0, sessions: 0, loc: 0, locRemoved: 0, commits: 0, prs: 0, accepted: 0, rejected: 0 }
          byEmail.set(email, cur)
        }
        cur.messages   += r.chat_metrics.message_count
        cur.convos     += r.chat_metrics.distinct_conversation_count
        cur.sessions   += cc.core_metrics.distinct_session_count
        cur.loc        += cc.core_metrics.lines_of_code.added_count
        cur.locRemoved += cc.core_metrics.lines_of_code.removed_count
        cur.commits    += cc.core_metrics.commit_count
        cur.prs        += cc.core_metrics.pull_request_count
        cur.accepted   += ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
                          ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
        cur.rejected   += ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
                          ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }
    }
    const mapped = Array.from(byEmail.values()).map((u) => ({
      ...u,
      accept: acceptRate(u.accepted, u.rejected),
    }))
    const f = q.trim().toLowerCase()
    return mapped
      .filter((r) => !f || r.email.toLowerCase().includes(f))
      .sort((a, b) => {
        const ka = (a[sort] as number | null) ?? -1
        const kb = (b[sort] as number | null) ?? -1
        return (kb as number) - (ka as number)
      })
  }, [data, sort, q])

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={
          <div className="flex items-center gap-2">
            <DateRangeControl />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('users.search')}
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-claude-500 focus:outline-none w-56"
            />
          </div>
        }
      />
      <div className="p-8">
        {rows.length === 0 ? (
          <EmptyState title={t('users.empty')} hint={t('users.empty.hint')} />
        ) : (
          <div className="rounded-xl border border-ink-100 bg-white shadow-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-muted/60 text-ink-500">
                <tr>
                  <Th label={t('users.col.user')} />
                  <Th label={t('users.col.messages')} k="messages" sort={sort} setSort={setSort} />
                  <Th label={t('users.col.sessions')} k="sessions" sort={sort} setSort={setSort} />
                  <Th label={t('users.col.loc')}      k="loc"      sort={sort} setSort={setSort} />
                  <Th label={t('users.col.commits')}  k="commits"  sort={sort} setSort={setSort} />
                  <Th label={t('users.col.prs')} />
                  <Th label={t('users.col.accept')}   k="accept"   sort={sort} setSort={setSort} />
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
                    <td className="px-4 py-2.5 font-medium text-ink-700">{maskEmail(r.email)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.messages)} <span className="text-ink-300 text-xs">/ {r.convos}c</span></td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.sessions)}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <span className="text-claude-600 font-medium">+{fmtNum(r.loc)}</span>
                      <span className="text-ink-300 text-xs"> / -{fmtNum(r.locRemoved)}</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.commits)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.prs)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtPct(r.accept)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UserDetailPanel email={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function Th({ label, k, sort, setSort }: {
  label: string; k?: SortKey; sort?: SortKey; setSort?: (k: SortKey) => void
}) {
  const active = k && sort === k
  return (
    <th
      onClick={k && setSort ? () => setSort(k) : undefined}
      className={clsx(
        'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider',
        k && 'cursor-pointer select-none hover:text-ink-800',
        active && 'text-claude-600',
      )}
    >
      {label}{active ? ' ↓' : ''}
    </th>
  )
}
