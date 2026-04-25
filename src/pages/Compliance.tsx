import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtNum, fmtDate, maskEmail } from '../lib/format'

type Actor = {
  type: 'user_actor' | 'api_actor'
  email_address?: string
  user_id?: string
  api_key_id?: string
  ip_address?: string
  user_agent?: string
}

type ActivityEvent = {
  id: string
  type: string
  created_at: string
  actor: Actor
  organization_id: string | null
  // event-specific fields (dynamic)
  [k: string]: unknown
}

type Resp = { source: 'live'; data: ActivityEvent[]; has_more: boolean; next_page: string | null; total_fetched: number }

// Event categories for filtering + coloring
const RISK_TYPES = new Set([
  'claude_user_role_updated',
  'org_user_invite_sent', 'org_user_invite_deleted',
  'org_user_deleted',
  'org_sso_toggled', 'org_sso_connection_deleted',
  'org_data_export_started', 'org_data_export_completed',
  'org_domain_verified',
  'project_deleted',
])
const LOGIN_TYPES = new Set([
  'user_signed_in_sso', 'user_signed_in_google', 'user_signed_in_apple',
  'user_signed_out', 'social_login_succeeded', 'user_logged_out',
])

function riskLabel(t: string): 'risk' | 'login' | 'info' {
  if (RISK_TYPES.has(t)) return 'risk'
  if (LOGIN_TYPES.has(t)) return 'login'
  return 'info'
}

function actorDisplay(a: Actor): string {
  if (a.type === 'api_actor') return `🔑 ${a.api_key_id ?? 'unknown key'}`
  if (a.email_address)       return `👤 ${maskEmail(a.email_address)}`
  if (a.user_id)             return `👤 ${a.user_id}`
  return 'unknown'
}

function eventSummary(ev: ActivityEvent): string {
  switch (ev.type) {
    case 'claude_user_role_updated':
      return `${ev.user_email ? maskEmail(String(ev.user_email)) : ''}: ${ev.previous_role} → ${ev.current_role}`
    case 'claude_chat_viewed':
      return `chat ${ev.claude_chat_id ? String(ev.claude_chat_id).slice(-8) : ''}`
    case 'project_created': case 'project_renamed': case 'project_deleted':
      return ev.project_name ? String(ev.project_name) : ''
    case 'compliance_api_accessed':
      return `${ev.request_method ?? ''} ${ev.status_code ?? ''}`
    case 'social_login_succeeded':
      return String(ev.provider ?? '')
    case 'file_uploaded':
      return ev.file_name ? String(ev.file_name) : ''
    default:
      return ''
  }
}

export function Compliance() {
  const t = useT()
  const { range } = useDateRange('14d')
  const [filterType, setFilterType] = useState<string | 'all' | 'risk' | 'login'>('all')
  const [q, setQ] = useState('')

  // Fetch up to 500 recent events. The Compliance API's cursor pagination
  // doesn't take a from/to date filter cleanly, so we fetch a fixed window of
  // most-recent events and filter to the selected range client-side. If the
  // chosen range falls outside the latest 500 events, the table will look
  // empty — that's an honest signal to widen the fetch (server-side max=) or
  // narrow the window.
  const { data, loading, error } = useFetch<Resp>('/api/compliance/activities?max=500&pages=5')

  const allEvents = data?.data ?? []
  const events = useMemo(() => {
    // useDateRange clamps endingDate to today-3 (Analytics API's 3-day buffer).
    // Compliance is real-time so we ignore that upper clamp for preset modes
    // and let recent events through. We still respect a user-set endingDate
    // in custom mode.
    const today = new Date().toISOString().slice(0, 10)
    const upper = range.preset === 'custom' ? range.endingDate : today
    return allEvents.filter((e) => {
      const day = e.created_at.slice(0, 10)
      return day >= range.startingDate && day <= upper
    })
  }, [allEvents, range.startingDate, range.endingDate, range.preset])

  const derived = useMemo(() => {
    // type histogram
    const byType = new Map<string, number>()
    const byActor = new Map<string, number>()
    const byDay = new Map<string, { date: string; count: number; risk: number }>()
    let risk = 0, login = 0, apiCalls = 0
    const uniqueActors = new Set<string>()

    for (const e of events) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
      const actorKey = e.actor.email_address ?? e.actor.api_key_id ?? e.actor.user_id ?? 'unknown'
      byActor.set(actorKey, (byActor.get(actorKey) ?? 0) + 1)
      uniqueActors.add(actorKey)

      const day = e.created_at.slice(0, 10)
      const bucket = byDay.get(day) ?? { date: day, count: 0, risk: 0 }
      bucket.count += 1
      if (RISK_TYPES.has(e.type)) { bucket.risk += 1; risk += 1 }
      if (LOGIN_TYPES.has(e.type)) login += 1
      if (e.actor.type === 'api_actor') apiCalls += 1
      byDay.set(day, bucket)
    }

    const topTypes = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)

    const topActors = [...byActor.entries()]
      .map(([actor, count]) => ({ actor: maskEmail(actor), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const daily = [...byDay.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: fmtDate(d.date), Events: d.count, Risk: d.risk }))

    return {
      total: events.length,
      risk, login, apiCalls,
      uniqueActors: uniqueActors.size,
      topTypes, topActors, daily,
    }
  }, [events])

  const allTypes = useMemo(() => {
    const s = new Set<string>()
    events.forEach((e) => s.add(e.type))
    return [...s].sort()
  }, [events])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return events.filter((e) => {
      if (filterType === 'risk' && !RISK_TYPES.has(e.type)) return false
      if (filterType === 'login' && !LOGIN_TYPES.has(e.type)) return false
      if (filterType !== 'all' && filterType !== 'risk' && filterType !== 'login' && e.type !== filterType) return false
      if (needle) {
        const hay = `${e.type} ${e.actor.email_address ?? ''} ${e.actor.api_key_id ?? ''} ${actorDisplay(e.actor)} ${eventSummary(e)}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [events, filterType, q])

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  return (
    <div>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle', {
          shown: events.length,
          total: allEvents.length,
          start: range.startingDate,
          end: range.preset === 'custom' ? range.endingDate : new Date().toISOString().slice(0, 10),
        })}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('audit.kpi.total')} value={fmtNum(derived.total)} hint={t('audit.kpi.total.hint')} />
          <KpiCard       label={t('audit.kpi.risk')}  value={fmtNum(derived.risk)}  hint={t('audit.kpi.risk.hint')} />
          <KpiCard       label={t('audit.kpi.login')} value={fmtNum(derived.login)} hint={t('audit.kpi.login.hint')} />
          <KpiCard       label={t('audit.kpi.actors')} value={fmtNum(derived.uniqueActors)} hint={`${derived.apiCalls} api calls`} />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <ChartCard title={t('audit.top_types')}>
            <ResponsiveContainer width="100%" height={Math.max(240, derived.topTypes.length * 26)}>
              <BarChart data={derived.topTypes} layout="vertical" margin={{ top: 8, right: 16, left: 80, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" />
                <YAxis dataKey="type" type="category" width={200} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#D97757" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t('audit.top_actors')}>
            <ResponsiveContainer width="100%" height={Math.max(240, derived.topActors.length * 26)}>
              <BarChart data={derived.topActors} layout="vertical" margin={{ top: 8, right: 16, left: 60, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" />
                <YAxis dataKey="actor" type="category" width={170} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#1F1E1D" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title={t('audit.daily')}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={derived.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="Events" stroke="#1F1E1D" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Risk"   stroke="#D97757" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={t('audit.feed')}
          subtitle={t('audit.feed.sub', { shown: filtered.length, total: events.length })}
          right={
            <div className="flex items-center gap-2">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="text-xs px-2 py-1 rounded-md border border-ink-200 bg-white"
              >
                <option value="all">{t('audit.filter.all')}</option>
                <option value="risk">{t('audit.filter.risk')}</option>
                <option value="login">{t('audit.filter.login')}</option>
                <optgroup label="Types">
                  {allTypes.map((x) => <option key={x} value={x}>{x}</option>)}
                </optgroup>
              </select>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('common.search')}
                className="text-xs px-2 py-1 rounded-md border border-ink-200 bg-white w-48"
              />
            </div>
          }
        >
          {filtered.length === 0 ? (
            <EmptyState title={t('audit.empty')} />
          ) : (
            <div className="rounded-lg border border-ink-100 overflow-auto max-h-[600px] mx-3">
              <table className="w-full text-xs">
                <thead className="bg-paper-muted/60 text-ink-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">Time</th>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">Actor</th>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">Event</th>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">Detail</th>
                    <th className="text-left px-3 py-2 uppercase tracking-wider">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => {
                    const r = riskLabel(e.type)
                    return (
                      <tr key={e.id} className={clsx(
                        'border-t border-ink-100',
                        r === 'risk' ? 'bg-claude-50/40' : 'hover:bg-paper-muted/30',
                      )}>
                        <td className="px-3 py-1.5 tabular-nums whitespace-nowrap text-ink-500">
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-ink-700">{actorDisplay(e.actor)}</td>
                        <td className="px-3 py-1.5">
                          <span className={clsx(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                            r === 'risk'  ? 'bg-claude-100 text-claude-800' :
                            r === 'login' ? 'bg-emerald-50 text-emerald-700' :
                            'bg-ink-100 text-ink-600',
                          )}>
                            {e.type}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-ink-500">{eventSummary(e)}</td>
                        <td className="px-3 py-1.5 text-ink-400 tabular-nums font-mono">{e.actor.ip_address ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  )
}
