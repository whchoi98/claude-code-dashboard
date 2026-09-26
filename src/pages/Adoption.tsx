import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { RangeCoverageNote } from '../components/RangeCoverageNote'
import { badgeSource } from '../lib/format'
import { GroupScopeNote } from '../components/GroupScopeNote'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCents, maskEmail } from '../lib/format'
import { useSortable } from '../lib/useSortable'
import { SortableTh } from '../components/SortableTh'
import type { Skill, Connector, ChatProject, Plugin } from '../types'

type DayEntry<T> = { date: string; source: string; data: T[] }
type RangeResp<T> = { range: { starting_date: string; ending_date: string }; days: DayEntry<T>[] }

type Row = { name: string; label: string; Users: number; Chat: number; Code: number; Cowork: number; lastSeen: string; staleInWindow: boolean }
// Feature-flagged upstream counters are null (never 0) while not reported for
// the org — the window aggregate stays null unless some day carried a number.
type SkillRow = Row & { Invocations: number | null; share: string | null; overageCents: number | null; listCents: number | null }
type ConnectorRow = Row & { read: number | null; write: number | null; unclassified: number | null; managedAuthUsers: number | null }
type PluginRow = { name: string; label: string; Users: number; Installs: number; Invocations: number; Code: number; lastSeen: string; staleInWindow: boolean; aggregate: boolean }
// `third-party` is an upstream aggregate bucket (plugin activity with no name
// from the reporting client), not a plugin — label it and keep it off the
// stale-adoption list.
const PLUGIN_AGGREGATE = 'third-party'

const addNullable = (acc: number | null, v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? (acc ?? 0) + v : acc
const maxNullable = (acc: number | null, v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(acc ?? 0, v) : acc
const centsOf = (v: string | null | undefined) => {
  if (v == null) return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
type ProjectRow = Pick<ChatProject, 'project_id' | 'project_name' | 'message_count' | 'distinct_conversation_count' | 'distinct_user_count' | 'created_by'>

// An item is "stale within the window" if it had usage in the earlier
// half of the window but none in the more recent half — declining
// adoption signal worth surfacing even when the leaderboard sort still
// shows it near the top by historical totals.
function flagStale<T extends { name: string; staleInWindow: boolean; lastSeen: string }>(rows: T[], days: { date: string }[]): T[] {
  if (days.length < 2) return rows
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const cutoff = sorted[Math.floor(sorted.length / 2)].date
  return rows.map((r) => ({ ...r, staleInWindow: !!r.lastSeen && r.lastSeen < cutoff }))
}

export function Adoption() {
  const t = useT()
  const { range } = useDateRange('7d')
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const skills     = useFetch<RangeResp<Skill>>(`/api/analytics/skills/range${q}`)
  const connectors = useFetch<RangeResp<Connector>>(`/api/analytics/connectors/range${q}`)
  const projects   = useFetch<RangeResp<ChatProject>>(`/api/analytics/projects/range${q}`)
  const plugins    = useFetch<RangeResp<Plugin>>(`/api/analytics/plugins/range${q}`)

  // Distinct user counts can't be deduped across days because the API doesn't
  // return user IDs at the skill/connector level — MAX (peak day) is the honest
  // approximation. Usage counts (Chat/Code/Cowork) SUM naturally.
  // Days are iterated oldest→newest so the label/share status of the LATEST
  // day wins (display names resolve at request time and can change).
  const skillRows = useMemo<SkillRow[]>(() => {
    const by = new Map<string, SkillRow>()
    const days = [...(skills.data?.days ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    for (const day of days) {
      for (const s of day.data) {
        const used = s.distinct_user_count > 0
          || s.chat_metrics.distinct_conversation_skill_used_count > 0
          || s.claude_code_metrics.distinct_session_skill_used_count > 0
          || s.cowork_metrics.distinct_session_skill_used_count > 0
        const cur = by.get(s.skill_name) ?? {
          name: s.skill_name, label: s.skill_name, Users: 0, Chat: 0, Code: 0, Cowork: 0, lastSeen: '', staleInWindow: false,
          Invocations: null, share: null, overageCents: null, listCents: null,
        }
        if (s.skill_display_name) cur.label = s.skill_display_name
        if (s.share_status) cur.share = s.share_status
        cur.Users  = Math.max(cur.Users, s.distinct_user_count)
        cur.Chat  += s.chat_metrics.distinct_conversation_skill_used_count
        cur.Code  += s.claude_code_metrics.distinct_session_skill_used_count
        cur.Cowork += s.cowork_metrics.distinct_session_skill_used_count
        cur.Invocations  = addNullable(cur.Invocations, s.invocation_count)
        cur.overageCents = addNullable(cur.overageCents, centsOf(s.estimated_overage_spend))
        cur.listCents    = addNullable(cur.listCents, centsOf(s.attributed_list_price))
        if (used && day.date > cur.lastSeen) cur.lastSeen = day.date
        by.set(s.skill_name, cur)
      }
    }
    return flagStale(Array.from(by.values()).sort((a, b) => b.Users - a.Users), days)
  }, [skills.data])

  const connectorRows = useMemo<ConnectorRow[]>(() => {
    const by = new Map<string, ConnectorRow>()
    const days = [...(connectors.data?.days ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    for (const day of days) {
      for (const c of day.data) {
        const used = c.distinct_user_count > 0
          || c.chat_metrics.distinct_conversation_connector_used_count > 0
          || c.claude_code_metrics.distinct_session_connector_used_count > 0
          || c.cowork_metrics.distinct_session_connector_used_count > 0
        const cur = by.get(c.connector_name) ?? {
          name: c.connector_name, label: c.connector_name, Users: 0, Chat: 0, Code: 0, Cowork: 0, lastSeen: '', staleInWindow: false,
          read: null, write: null, unclassified: null, managedAuthUsers: null,
        }
        if (c.connector_display_name) cur.label = c.connector_display_name
        cur.Users  = Math.max(cur.Users, c.distinct_user_count)
        cur.Chat  += c.chat_metrics.distinct_conversation_connector_used_count
        cur.Code  += c.claude_code_metrics.distinct_session_connector_used_count
        cur.Cowork += c.cowork_metrics.distinct_session_connector_used_count
        cur.read         = addNullable(cur.read, c.read_call_count)
        cur.write        = addNullable(cur.write, c.write_call_count)
        cur.unclassified = addNullable(cur.unclassified, c.unclassified_call_count)
        // Distinct users: a stock, not a flow — peak day (same rule as Users).
        cur.managedAuthUsers = maxNullable(cur.managedAuthUsers, c.managed_auth_distinct_user_count)
        if (used && day.date > cur.lastSeen) cur.lastSeen = day.date
        by.set(c.connector_name, cur)
      }
    }
    return flagStale(Array.from(by.values()).sort((a, b) => b.Users - a.Users), days)
  }, [connectors.data])
  const skillSpendReported = useMemo(() => skillRows.some((r) => r.overageCents != null || r.listCents != null || r.Invocations != null), [skillRows])
  const connectorCallsReported = useMemo(() => connectorRows.some((r) => r.read != null || r.write != null || r.unclassified != null || r.managedAuthUsers != null), [connectorRows])

  // Installs (like distinct users) are a stock — the same install base shows
  // up every day, so MAX (peak day) is honest and SUM would multiply it by
  // the window length. Invocations/Code sessions are flows and SUM.
  const pluginRows = useMemo<PluginRow[]>(() => {
    const by = new Map<string, PluginRow>()
    for (const day of plugins.data?.days ?? []) {
      for (const p of day.data) {
        // Raw-sidecar/live rows are exact upstream shapes — sparse rows (e.g.
        // hash-id Cowork commands) can omit these counters entirely, and one
        // undefined would NaN-poison the whole window's aggregate.
        const users  = p.distinct_user_count ?? 0
        const inst   = p.install_count ?? 0
        const invoc  = p.invocation_count ?? 0
        const code   = p.claude_code_metrics?.distinct_session_plugin_used_count ?? 0
        const cowork = p.cowork_metrics?.distinct_session_plugin_used_count ?? 0
        const used = users > 0 || invoc > 0 || code > 0 || cowork > 0
        const aggregate = p.plugin_name === PLUGIN_AGGREGATE
        const cur = by.get(p.plugin_name) ?? { name: p.plugin_name, label: aggregate ? t('adopt.plugins.third_party') : p.plugin_name, Users: 0, Installs: 0, Invocations: 0, Code: 0, lastSeen: '', staleInWindow: false, aggregate }
        cur.Users        = Math.max(cur.Users, users)
        cur.Installs     = Math.max(cur.Installs, inst)
        cur.Invocations += invoc
        cur.Code        += code
        if (used && day.date > cur.lastSeen) cur.lastSeen = day.date
        by.set(p.plugin_name, cur)
      }
    }
    return flagStale(Array.from(by.values()).sort((a, b) => b.Users - a.Users), plugins.data?.days ?? [])
      .map((r) => (r.aggregate ? { ...r, staleInWindow: false } : r))
  }, [plugins.data, t])

  const staleSkills = useMemo(() => skillRows.filter((r) => r.staleInWindow), [skillRows])
  const staleConnectors = useMemo(() => connectorRows.filter((r) => r.staleInWindow), [connectorRows])
  const stalePlugins = useMemo(() => pluginRows.filter((r) => r.staleInWindow), [pluginRows])

  // Same uniqueness caveat as skills/connectors. project_name and created_by
  // are taken from the latest day to handle mid-window renames.
  const projectRows = useMemo<ProjectRow[]>(() => {
    const by = new Map<string, ProjectRow>()
    for (const day of projects.data?.days ?? []) {
      for (const p of day.data) {
        const cur = by.get(p.project_id)
        if (!cur) {
          by.set(p.project_id, {
            project_id: p.project_id,
            project_name: p.project_name,
            message_count: p.message_count,
            distinct_conversation_count: p.distinct_conversation_count,
            distinct_user_count: p.distinct_user_count,
            created_by: p.created_by,
          })
        } else {
          cur.message_count += p.message_count
          cur.distinct_conversation_count += p.distinct_conversation_count
          cur.distinct_user_count = Math.max(cur.distinct_user_count, p.distinct_user_count)
          cur.project_name = p.project_name
          cur.created_by   = p.created_by
        }
      }
    }
    return Array.from(by.values()).sort((a, b) => b.message_count - a.message_count).slice(0, 10)
  }, [projects.data])

  if (skills.loading || connectors.loading || projects.loading || plugins.loading) return <LoadingState />
  if (skills.error) return <ErrorState error={skills.error} onRetry={skills.refetch} />
  if (connectors.error) return <ErrorState error={connectors.error} onRetry={connectors.refetch} />
  if (projects.error) return <ErrorState error={projects.error} onRetry={projects.refetch} />
  if (plugins.error) return <ErrorState error={plugins.error} onRetry={plugins.refetch} />

  return (
    <div>
      <PageHeader
        title={t('adopt.title')}
        subtitle={t('adopt.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={badgeSource(skills.data?.days?.[0]?.source)}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <RangeCoverageNote resp={[skills.data, connectors.data, projects.data, plugins.data]} />
      <GroupScopeNote />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <ChartCard title={t('adopt.skills')} subtitle={t('adopt.skills.sub')}>
          <ResponsiveContainer width="100%" height={Math.max(220, skillRows.length * 32)}>
            <BarChart data={skillRows} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="label" type="category" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Users" name={t('adopt.bar.users')} fill="#D97757" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Chat"  name={t('adopt.bar.chat')}  fill="#B5AFA0" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Code"  name={t('adopt.bar.code')}  fill="#1F1E1D" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {staleSkills.length > 0 && (
            <div className="mx-3 mt-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="font-semibold">{t('adopt.stale.skills', { count: staleSkills.length })}</span>
              {' — '}
              {staleSkills.map((s) => `${s.label} (${s.lastSeen || t('adopt.never')})`).join(', ')}
            </div>
          )}
          {skillSpendReported && <SkillTable rows={skillRows} t={t} />}
        </ChartCard>

        <ChartCard title={t('adopt.connectors')} subtitle={t('adopt.connectors.sub')}>
          <ResponsiveContainer width="100%" height={Math.max(220, connectorRows.length * 32)}>
            <BarChart data={connectorRows} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="label" type="category" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Users" name={t('adopt.bar.users')} fill="#D97757" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Chat"  name={t('adopt.bar.chat')}  fill="#B5AFA0" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Code"  name={t('adopt.bar.code')}  fill="#1F1E1D" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {staleConnectors.length > 0 && (
            <div className="mx-3 mt-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="font-semibold">{t('adopt.stale.connectors', { count: staleConnectors.length })}</span>
              {' — '}
              {staleConnectors.map((c) => `${c.label} (${c.lastSeen || t('adopt.never')})`).join(', ')}
            </div>
          )}
          {connectorCallsReported && <ConnectorCallsTable rows={connectorRows} t={t} />}
        </ChartCard>

        <ChartCard title={t('adopt.plugins')} subtitle={t('adopt.plugins.sub')}>
          {pluginRows.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ink-400">{t('adopt.plugins.empty')}</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={Math.max(220, pluginRows.length * 40)}>
                <BarChart data={pluginRows} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis type="number" />
                  <YAxis dataKey="label" type="category" width={140} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Users"       name={t('adopt.bar.users')}    fill="#D97757" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Installs"    name={t('adopt.bar.installs')} fill="#B5AFA0" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Invocations" name={t('adopt.bar.invoc')}    fill="#6B6960" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Code"        name={t('adopt.bar.code')}     fill="#1F1E1D" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
              {stalePlugins.length > 0 && (
                <div className="mx-3 mt-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span className="font-semibold">{t('adopt.stale.plugins', { count: stalePlugins.length })}</span>
                  {' — '}
                  {stalePlugins.map((p) => `${p.label} (${p.lastSeen || t('adopt.never')})`).join(', ')}
                </div>
              )}
            </>
          )}
        </ChartCard>

        <ChartCard title={t('adopt.projects')} subtitle={t('adopt.projects.sub')}>
          <ProjectTable rows={projectRows} t={t} />
        </ChartCard>
      </div>
    </div>
  )
}

const SHARE_KEY = { private: 'adopt.share.private', organization: 'adopt.share.organization', public: 'adopt.share.public' } as const

// Skill usage + attributed spend. estimated_overage_spend is an allocation of
// members' metered overage (same basis as the Cost page); attributed list
// price is the rate-card value of requests that involved the skill, however
// they were funded. Both are summed across the window's days.
function SkillTable({ rows, t }: { rows: SkillRow[]; t: (k: any, p?: any) => string }) {
  type K = 'skill' | 'users' | 'invocations' | 'share' | 'overage' | 'list'
  const accessors: Record<K, (r: SkillRow) => string | number | null | undefined> = {
    skill:       (r) => r.label,
    users:       (r) => r.Users,
    invocations: (r) => r.Invocations,
    share:       (r) => r.share,
    overage:     (r) => r.overageCents,
    list:        (r) => r.listCents,
  }
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<SkillRow, K>(rows, accessors, {
    initialKey: 'overage', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )
  return (
    <div className="mx-3 mt-3">
      <p className="text-[11.5px] text-ink-500 mb-1.5">{t('adopt.skills.table.sub')}</p>
      <div className="rounded-lg border border-ink-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-muted/60">
            <tr>
              <Th label={t('adopt.col.skill')}       k="skill" align="left" />
              <Th label={t('adopt.col.users')}       k="users" />
              <Th label={t('adopt.col.invocations')} k="invocations" />
              <Th label={t('adopt.col.share')}       k="share" align="left" />
              <Th label={t('adopt.col.overage')}     k="overage" />
              <Th label={t('adopt.col.list_value')}  k="list" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-ink-100 hover:bg-paper-muted/40">
                <td className="px-4 py-2 font-medium text-ink-700" title={r.label !== r.name ? r.name : undefined}>{r.label}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.Users)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.Invocations)}</td>
                <td className="px-4 py-2 text-ink-500">{r.share ? t(SHARE_KEY[r.share as keyof typeof SHARE_KEY] ?? 'adopt.share.unknown') : '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums text-claude-600 font-medium">{fmtCents(r.overageCents)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-500">{fmtCents(r.listCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// MCP tool-call classification (read-only annotation → read / write /
// unclassified) + Enterprise Managed Auth reach. Rendered only when the org
// reports any of it; per-cell null stays '—' (not reported ≠ zero).
function ConnectorCallsTable({ rows, t }: { rows: ConnectorRow[]; t: (k: any, p?: any) => string }) {
  type K = 'connector' | 'read' | 'write' | 'unclassified' | 'writeShare' | 'managed'
  const writeShare = (r: ConnectorRow) => {
    const total = (r.read ?? 0) + (r.write ?? 0) + (r.unclassified ?? 0)
    return r.write == null || total === 0 ? null : r.write / total
  }
  const accessors: Record<K, (r: ConnectorRow) => string | number | null | undefined> = {
    connector:    (r) => r.label,
    read:         (r) => r.read,
    write:        (r) => r.write,
    unclassified: (r) => r.unclassified,
    writeShare:   (r) => writeShare(r),
    managed:      (r) => r.managedAuthUsers,
  }
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<ConnectorRow, K>(rows, accessors, {
    initialKey: 'write', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )
  return (
    <div className="mx-3 mt-3">
      <p className="text-[11.5px] text-ink-500 mb-1.5">{t('adopt.connectors.table.sub')}</p>
      <div className="rounded-lg border border-ink-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-muted/60">
            <tr>
              <Th label={t('adopt.col.connector')}    k="connector" align="left" />
              <Th label={t('adopt.col.read_calls')}   k="read" />
              <Th label={t('adopt.col.write_calls')}  k="write" />
              <Th label={t('adopt.col.unclassified')} k="unclassified" />
              <Th label={t('adopt.col.write_share')}  k="writeShare" />
              <Th label={t('adopt.col.managed_auth')} k="managed" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const ws = writeShare(r)
              return (
                <tr key={r.name} className="border-t border-ink-100 hover:bg-paper-muted/40">
                  <td className="px-4 py-2 font-medium text-ink-700" title={r.label !== r.name ? r.name : undefined}>{r.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.read)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-claude-600 font-medium">{fmtNum(r.write)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-500">{fmtNum(r.unclassified)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{ws == null ? '—' : `${(ws * 100).toFixed(1)}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.managedAuthUsers)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProjectTable({ rows, t }: { rows: ProjectRow[]; t: (k: any, p?: any) => string }) {
  type K = 'project' | 'users' | 'convos' | 'messages' | 'created'
  const accessors: Record<K, (p: ProjectRow) => string | number | null | undefined> = {
    project:  (p) => p.project_name,
    users:    (p) => p.distinct_user_count,
    convos:   (p) => p.distinct_conversation_count,
    messages: (p) => p.message_count,
    created:  (p) => p.created_by?.email_address,
  }
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<ProjectRow, K>(rows, accessors, {
    initialKey: 'messages', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )
  return (
    <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3">
      <table className="w-full text-sm">
        <thead className="bg-paper-muted/60">
          <tr>
            <Th label={t('adopt.col.project')} k="project"  align="left" />
            <Th label={t('adopt.col.users')}   k="users" />
            <Th label={t('adopt.col.convos')}  k="convos" />
            <Th label={t('adopt.col.messages')} k="messages" />
            <Th label={t('adopt.col.created')} k="created"  align="left" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.project_id} className="border-t border-ink-100 hover:bg-paper-muted/40">
              <td className="px-4 py-2 font-medium text-ink-700">{p.project_name}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtNum(p.distinct_user_count)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtNum(p.distinct_conversation_count)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-claude-600 font-medium">{fmtNum(p.message_count)}</td>
              <td className="px-4 py-2 text-ink-500">{maskEmail(p.created_by?.email_address)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
