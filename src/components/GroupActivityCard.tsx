import { useMemo } from 'react'
import { ChartCard } from './ChartCard'
import { EmptyState } from './LoadingState'
import { SortableTh } from './SortableTh'
import { useFetch } from '../lib/api'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact } from '../lib/format'
import { chatOf, coworkOf } from '../lib/unified'
import type { UserRecord } from '../types'

// /api/analytics/users/groups — the users endpoint rolled up per RBAC group
// (group_by[]=rbac_group_id). Rows carry the same metric objects as a user
// record, so the unified-aware readers apply unchanged.
type GroupRow = Partial<UserRecord> & {
  rbac_group_id?: string | null
  rbac_group_name?: string | null
  distinct_user_count?: number | null
}
type GroupsResp = { source: string; reason?: string; range?: { starting_date: string; ending_date: string }; data: GroupRow[] }
type Row = {
  id: string; name: string; members: number | null
  messages: number; ccSessions: number; loc: number; commits: number; prs: number; cowork: number
  locPerMember: number | null
}
type K = 'name' | 'members' | 'messages' | 'ccSessions' | 'loc' | 'commits' | 'prs' | 'cowork' | 'locPerMember'

/**
 * Activity compared across RBAC groups for the page's date range. Upstream
 * attribution is any-membership (a person in two groups counts fully in
 * both, so rows can sum above the org) and member counts are estimates —
 * the subtitle says so. Independent of the page's group tab by design: it
 * is the side-by-side view the tabs can't give.
 */
export function GroupActivityCard({ startingDate, endingDate }: { startingDate: string; endingDate: string }) {
  const t = useT()
  const resp = useFetch<GroupsResp>(`/api/analytics/users/groups?starting_date=${startingDate}&ending_date=${endingDate}`)

  const rows = useMemo<Row[]>(() => (resp.data?.data ?? [])
    // Null id = the unassigned remainder; it is not a group to compare.
    .filter((g) => g.rbac_group_id)
    .map((g) => {
      const rec = g as UserRecord
      const core = g.claude_code_metrics?.core_metrics
      const members = typeof g.distinct_user_count === 'number' ? g.distinct_user_count : null
      const loc = core?.lines_of_code?.added_count ?? 0
      return {
        id: String(g.rbac_group_id),
        name: g.rbac_group_name || `grp-${String(g.rbac_group_id).slice(-6)}`,
        members,
        messages: g.chat_metrics ? chatOf(rec).message_count : 0,
        ccSessions: core?.distinct_session_count ?? 0,
        loc,
        commits: core?.commit_count ?? 0,
        prs: core?.pull_request_count ?? 0,
        cowork: g.cowork_metrics ? coworkOf(rec).distinct_session_count : 0,
        locPerMember: members ? loc / members : null,
      }
    }), [resp.data])

  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<Row, K>(
    rows,
    {
      name: (r) => r.name, members: (r) => r.members, messages: (r) => r.messages,
      ccSessions: (r) => r.ccSessions, loc: (r) => r.loc, commits: (r) => r.commits,
      prs: (r) => r.prs, cowork: (r) => r.cowork, locPerMember: (r) => r.locPerMember,
    },
    { initialKey: 'loc', initialDir: 'desc' },
  )

  let body
  if (resp.loading) body = <div className="px-4 py-6 text-sm text-ink-400">{t('common.loading')}</div>
  else if (resp.error || resp.data?.source === 'upstream_error') {
    body = <div className="px-4 py-2"><EmptyState title={t('groups_activity.unavailable')} hint={t('groups_activity.unavailable.hint')} /></div>
  } else if (rows.length === 0) {
    body = <div className="px-4 py-2"><EmptyState title={t('groups_activity.empty')} hint={t('groups_activity.empty.hint')} /></div>
  } else {
    const th = (label: string, k: K, align: 'left' | 'right' = 'right') =>
      <SortableTh label={label} k={k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={align} />
    body = (
      <div className="px-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-ink-500">
              {th(t('groups_activity.col.group'), 'name', 'left')}
              {th(t('groups_activity.col.members'), 'members')}
              {th(t('groups_activity.col.messages'), 'messages')}
              {th(t('groups_activity.col.cc_sessions'), 'ccSessions')}
              {th(t('groups_activity.col.loc'), 'loc')}
              {th(t('groups_activity.col.loc_per_member'), 'locPerMember')}
              {th(t('groups_activity.col.commits'), 'commits')}
              {th(t('groups_activity.col.prs'), 'prs')}
              {th(t('groups_activity.col.cowork'), 'cowork')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-b border-ink-50">
                <td className="py-2 text-left text-ink-700">{r.name}</td>
                <td className="py-2 text-right tabular-nums">{r.members == null ? '—' : fmtNum(r.members)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.ccSessions)}</td>
                <td className="py-2 text-right tabular-nums">{fmtCompact(r.loc)}</td>
                <td className="py-2 text-right tabular-nums">{r.locPerMember == null ? '—' : fmtCompact(Math.round(r.locPerMember))}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.commits)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.prs)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.cowork)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <ChartCard title={t('groups_activity.title')} subtitle={t('groups_activity.sub')}>
      {body}
    </ChartCard>
  )
}
