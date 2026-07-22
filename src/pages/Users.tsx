import { useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { RangeCoverageNote } from '../components/RangeCoverageNote'
import { badgeSource } from '../lib/format'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { UserDetailPanel } from '../components/UserDetailPanel'
import { DateRangeControl } from '../components/DateRangeControl'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { fmtNum, fmtPct, acceptRate, maskEmail } from '../lib/format'
import { useT } from '../lib/i18n'
import type { UserRecord } from '../types'
import clsx from 'clsx'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type UserTokensResp = { users: { email: string; cache_hit_rate?: number | null }[] }
type Row = {
  email: string; messages: number; convos: number; sessions: number;
  loc: number; locRemoved: number; commits: number; prs: number;
  cowork: number; coworkActions: number; design: number;
  accepted: number; rejected: number; accept: number | null;
  cacheHit: number | null;
}
type K = 'user' | 'messages' | 'sessions' | 'loc' | 'commits' | 'prs' | 'cowork' | 'design' | 'accept' | 'cache'

export function Users() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const { data, loading, error } = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  // Per-user cache hit rate (user_usage_report), WINDOW-ALIGNED with the
  // engagement columns: the server clamps users/range to the 3-day
  // finalization buffer, so the tokens window must end at today−3 too —
  // mixing regimes in one sortable row is the exact bug class
  // /cost/efficiency clamps against server-side. Spans over 31 days are
  // served too: the server chunks them into ≤31-day upstream segments
  // (upstream span cap) and re-aggregates per user.
  const tokensEnd = useMemo(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 3)
    const buffered = d.toISOString().slice(0, 10)
    return range.endingDate < buffered ? range.endingDate : buffered
  }, [range.endingDate])
  const tokensStart = range.startingDate < tokensEnd ? range.startingDate : tokensEnd
  const tokens = useFetch<UserTokensResp>(
    `/api/cost/user-tokens?starting_date=${tokensStart}&ending_date=${tokensEnd}`,
  )
  const cacheByEmail = useMemo(() => {
    const m = new Map<string, number | null>()
    // While a window switch is in flight, useFetch still holds the PREVIOUS
    // window's response — joining it would label old percentages with the
    // new range. Show '—' until the new response settles.
    if (tokens.loading) return m
    for (const u of tokens.data?.users ?? []) m.set(u.email.toLowerCase(), u.cache_hit_rate ?? null)
    return m
  }, [tokens.data, tokens.loading])
  const source = badgeSource(data?.days?.[0]?.source)
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const aggregated = useMemo<Row[]>(() => {
    // Aggregate per-user across the selected window. acceptRate is recomputed
    // from summed numerator/denominator so a single high-volume day can't get
    // diluted by averaging daily ratios.
    const byEmail = new Map<string, Row>()
    for (const d of data?.days ?? []) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const cc = r.claude_code_metrics
        const ta = cc.tool_actions
        const email = r.user.email_address
        let cur = byEmail.get(email)
        if (!cur) {
          cur = { email, messages: 0, convos: 0, sessions: 0, loc: 0, locRemoved: 0, commits: 0, prs: 0, cowork: 0, coworkActions: 0, design: 0, accepted: 0, rejected: 0, accept: null, cacheHit: null }
          byEmail.set(email, cur)
        }
        cur.messages   += r.chat_metrics.message_count
        cur.convos     += r.chat_metrics.distinct_conversation_count
        cur.sessions   += cc.core_metrics.distinct_session_count
        cur.loc        += cc.core_metrics.lines_of_code.added_count
        cur.locRemoved += cc.core_metrics.lines_of_code.removed_count
        cur.commits    += cc.core_metrics.commit_count
        cur.prs        += cc.core_metrics.pull_request_count
        // Optional chaining: pre-2026-07 S3 archive rows predate these surfaces.
        cur.cowork        += r.cowork_metrics?.distinct_session_count ?? 0
        cur.coworkActions += r.cowork_metrics?.action_count ?? 0
        cur.design        += r.design_metrics?.distinct_session_count ?? 0
        cur.accepted   += ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
                          ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
        cur.rejected   += ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
                          ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }
    }
    return Array.from(byEmail.values()).map((u) => ({
      ...u,
      accept: acceptRate(u.accepted, u.rejected),
      cacheHit: cacheByEmail.get(u.email.toLowerCase()) ?? null,
    }))
  }, [data, inGroup, cacheByEmail])

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase()
    return f ? aggregated.filter((r) => r.email.toLowerCase().includes(f)) : aggregated
  }, [aggregated, q])

  const accessors: Record<K, (r: Row) => string | number | null | undefined> = {
    user:     (r) => r.email,
    messages: (r) => r.messages,
    sessions: (r) => r.sessions,
    loc:      (r) => r.loc,
    commits:  (r) => r.commits,
    prs:      (r) => r.prs,
    cowork:   (r) => r.cowork,
    design:   (r) => r.design,
    accept:   (r) => r.accept,
    cache:    (r) => r.cacheHit,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<Row, K>(filtered, accessors, {
    initialKey: 'loc', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
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
      <RangeCoverageNote resp={data} />
      <div className="p-4 lg:p-8 print:p-8">
        {rows.length === 0 ? (
          <EmptyState title={t('users.empty')} hint={t('users.empty.hint')} />
        ) : (
          <div className="rounded-xl border border-ink-100 bg-white shadow-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-muted/60">
                <tr>
                  <Th label={t('users.col.user')}     k="user"     align="left" />
                  <Th label={t('users.col.messages')} k="messages" align="left" />
                  <Th label={t('users.col.sessions')} k="sessions" align="left" />
                  <Th label={t('users.col.loc')}      k="loc"      align="left" />
                  <Th label={t('users.col.commits')}  k="commits"  align="left" />
                  <Th label={t('users.col.prs')}      k="prs"      align="left" />
                  <Th label={t('users.col.cowork')}   k="cowork"   align="left" />
                  <Th label={t('users.col.design')}   k="design"   align="left" />
                  <Th label={t('users.col.accept')}   k="accept"   align="left" />
                  <Th label={t('users.col.cache')}    k="cache"    align="left" />
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
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.cowork)} <span className="text-ink-300 text-xs">/ {fmtNum(r.coworkActions)}a</span></td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtNum(r.design)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{fmtPct(r.accept)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-600">{r.cacheHit != null ? fmtPct(r.cacheHit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UserDetailPanel email={selected} range={range} onClose={() => setSelected(null)} />
    </div>
  )
}
