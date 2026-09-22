import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useHealth } from '../lib/useHealth'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { useOrg } from '../lib/OrgProvider'
import { downloadCsv } from '../lib/csv'
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
  lastActive: string | null;
}
type K = 'user' | 'messages' | 'sessions' | 'loc' | 'commits' | 'prs' | 'cowork' | 'design' | 'accept' | 'cache' | 'lastActive'

// Seats whose absolute last activity is this many days ago count as dormant.
const DORMANT_DAYS = 14

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - Date.parse(`${isoDate}T00:00:00Z`)) / 86400000)
}

export function Users() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { org, loading: orgLoading } = useOrg()
  const { group, inGroup, loading: groupLoading } = useGroupScope()
  const { data, loading, error, refetch } = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  // Per-user cache hit rate (user_usage_report), WINDOW-ALIGNED with the
  // engagement columns: the server clamps users/range to the engagement
  // finalization horizon, so the tokens window must end there too — mixing
  // regimes in one sortable row is the exact bug class /cost/efficiency
  // clamps against server-side. The horizon is DYNAMIC (typically today−2,
  // reported by /api/health as bufferDays from the server's hourly upstream
  // probe); until health settles we use the conservative 3, matching the
  // server's own fallback. Spans over 31 days are served too: the server
  // chunks them into ≤31-day upstream segments (upstream span cap) and
  // re-aggregates per user.
  const health = useHealth()
  const bufferDays = health?.dataConstraints?.bufferDays ?? 3
  const tokensEnd = useMemo(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - bufferDays)
    const buffered = d.toISOString().slice(0, 10)
    return range.endingDate < buffered ? range.endingDate : buffered
  }, [range.endingDate, bufferDays])
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
  const searchRef = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<{ email: string; org: string } | null>(null)
  const [dormantOnly, setDormantOnly] = useState(false)
  // Guard during render so the panel never receives an out-of-scope email,
  // then forget it so switching back cannot reopen a cancelled selection.
  const selected = selection?.org === org && inGroup(selection.email) ? selection.email : null
  useEffect(() => {
    if (selection && selected === null) setSelection(null)
  }, [selection, selected])

  function selectUser(email: string) {
    setSelection({ email, org })
  }

  function clearSearch() {
    setQ('')
    searchRef.current?.focus()
  }

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
          cur = { email, messages: 0, convos: 0, sessions: 0, loc: 0, locRemoved: 0, commits: 0, prs: 0, cowork: 0, coworkActions: 0, design: 0, accepted: 0, rejected: 0, accept: null, cacheHit: null, lastActive: null }
          byEmail.set(email, cur)
        }
        // Absolute last-active day (shipped 2026-08; null on older archive
        // days). Every snapshot day repeats it — keep the newest value.
        const la = r.last_activity_date ?? null
        if (la && (!cur.lastActive || la > cur.lastActive)) cur.lastActive = la
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

  // Feature detection: the field only exists on data collected since 2026-08.
  // If no row in the window carries it, hide the column and the toggle rather
  // than rendering a column of dashes.
  const hasLastActive = useMemo(() => aggregated.some((r) => r.lastActive != null), [aggregated])

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase()
    let out = f ? aggregated.filter((r) => r.email.toLowerCase().includes(f)) : aggregated
    // hasLastActive guard: when a range/group/org switch drops the field
    // entirely, the toggle unmounts — a stale dormantOnly=true must not keep
    // filtering every row into an unexplained empty table.
    if (dormantOnly && hasLastActive) out = out.filter((r) => r.lastActive != null && daysSince(r.lastActive) >= DORMANT_DAYS)
    return out
  }, [aggregated, q, dormantOnly, hasLastActive])

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
    lastActive: (r) => r.lastActive,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<Row, K>(filtered, accessors, {
    initialKey: 'loc', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )

  const canExport = !loading && !orgLoading && !groupLoading && rows.length > 0
  function exportRows() {
    if (!canExport) return
    downloadCsv(
      `users_${org.replace(/[^a-zA-Z0-9_-]/g, '_')}_${range.startingDate}_${range.endingDate}_UTC.csv`,
      [
        'org', 'group', 'starting_date', 'ending_date', 'email',
        'messages', 'conversations', 'sessions', 'loc_added', 'loc_removed', 'commits', 'pull_requests',
        'cowork_sessions', 'cowork_actions', 'design_sessions', 'acceptance_rate', 'cache_hit_rate',
        ...(hasLastActive ? ['last_active_date'] : []),
      ],
      rows.map((r) => [
        org, group, range.startingDate, range.endingDate, maskEmail(r.email),
        r.messages, r.convos, r.sessions, r.loc, r.locRemoved, r.commits, r.prs,
        r.cowork, r.coworkActions, r.design, r.accept, r.cacheHit,
        ...(hasLastActive ? [r.lastActive] : []),
      ]),
    )
  }

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} onRetry={refetch} />

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl />
            {hasLastActive && (
              <button
                type="button"
                onClick={() => setDormantOnly((v) => !v)}
                aria-pressed={dormantOnly}
                className={clsx(
                  'text-sm px-3 py-1.5 rounded-lg border transition-colors',
                  dormantOnly
                    ? 'border-amber-400 bg-amber-50 text-amber-800 font-medium'
                    : 'border-ink-200 bg-white text-ink-500 hover:border-ink-300',
                )}
              >
                {t('users.dormant.toggle', { days: DORMANT_DAYS })}
              </button>
            )}
            <div className="flex w-full sm:w-auto items-center gap-2">
              <input
                ref={searchRef}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('users.search')}
                aria-label={t('users.search')}
                className="min-w-0 text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-claude-500 focus:outline-none w-full sm:w-56"
              />
              {q && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="shrink-0 text-xs text-claude-600 underline hover:text-claude-700"
                >
                  {t('table.clear')}
                </button>
              )}
            </div>
          </div>
        }
      />
      <GroupTabs />
      <RangeCoverageNote resp={data} />
      <div className="p-4 lg:p-8 print:p-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p role="status" aria-live="polite" className="text-xs text-ink-500">
            {t('table.count', { shown: rows.length, total: aggregated.length })}
          </p>
          <button
            type="button"
            onClick={exportRows}
            disabled={!canExport}
            title={t('table.export_hint')}
            className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-paper-muted disabled:opacity-50 disabled:cursor-not-allowed print:hidden"
          >
            {t('table.export')}
          </button>
        </div>
        {rows.length === 0 ? (
          <>
            <EmptyState
              title={aggregated.length === 0 ? t('common.empty') : t('table.no_matches')}
              hint={t('users.empty.hint')}
            />
            {aggregated.length > 0 && (
              <div className="mt-3 text-center">
                <button
                  type="button"
                  onClick={() => {
                    clearSearch()
                    setDormantOnly(false)
                  }}
                  className="text-xs text-claude-600 underline hover:text-claude-700"
                >
                  {t('table.reset')}
                </button>
              </div>
            )}
          </>
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
                  {hasLastActive && <Th label={t('users.col.last_active')} k="lastActive" align="left" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.email}
                    onClick={() => selectUser(r.email)}
                    className={clsx(
                      'border-t border-ink-100 cursor-pointer transition-colors',
                      selected === r.email ? 'bg-claude-50/60' : 'hover:bg-paper-muted/40',
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-ink-700">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          selectUser(r.email)
                        }}
                        aria-label={t('table.open_user', { user: maskEmail(r.email) })}
                        className="rounded text-left hover:text-claude-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-claude-500 focus-visible:outline-offset-2"
                      >
                        {maskEmail(r.email)}
                      </button>
                    </td>
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
                    {hasLastActive && (
                      <td className="px-4 py-2.5 tabular-nums text-ink-600 whitespace-nowrap">
                        {r.lastActive ?? '—'}
                        {r.lastActive != null && daysSince(r.lastActive) >= DORMANT_DAYS && (
                          <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                            {t('users.dormant.badge', { days: daysSince(r.lastActive) })}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UserDetailPanel email={selected} range={range} onClose={() => setSelection(null)} />
    </div>
  )
}
