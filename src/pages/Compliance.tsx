import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ComposedChart, Line, ReferenceLine, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupScopeNote } from '../components/GroupScopeNote'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtNum, fmtDate, maskEmail, isUnmasked } from '../lib/format'
import { useSortable } from '../lib/useSortable'
import { SortableTh } from '../components/SortableTh'

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

type Resp = {
  source: 'live'
  data: ActivityEvent[]
  has_more: boolean
  total_fetched: number
  in_window?: number
  /** Why server-side pagination stopped: 'starting_date' = date boundary
   *  reached (good); 'max' = hit max records cap (older events missing);
   *  'has_more=false' = no more upstream events; 'cap' = page cap; 'empty';
   *  'time_budget' = server walk budget hit; 'upstream_<status>' = mid-walk
   *  upstream failure degraded to a partial result. */
  stop_reason?: string
  /** Present when the server returned a mid-walk degraded (partial) result. */
  partial?: boolean
}

/** Stop reasons that mean the requested window was fully covered. */
const COMPLETE_STOPS = new Set(['starting_date', 'has_more=false', 'empty'])

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
  const { range } = useDateRange('7d')
  const [filterType, setFilterType] = useState<string | 'all' | 'risk' | 'login'>('all')
  const [selected, setSelected] = useState<ActivityEvent | null>(null)
  // Stable identity: the panel's focus-management effect depends on onClose —
  // an inline arrow would re-run it (and yank focus) on every parent render.
  const closePanel = useCallback(() => setSelected(null), [])
  const [q, setQ] = useState('')

  // useDateRange clamps endingDate to today-3 for the Analytics API's data
  // buffer. Compliance is real-time, so preset modes use today as the upper
  // bound; only an explicit custom endingDate is honored.
  const today = new Date().toISOString().slice(0, 10)
  const upper = range.preset === 'custom' ? range.endingDate : today

  // Pass the date window to the server so it can paginate via after_id only
  // until it crosses range.startingDate (huge savings for noisy orgs that
  // produce 1000+ events/day). The Compliance API has no timestamp filter
  // and pagination is sequential — every 100 events is ~1.5s of network
  // round-trip. We cap at max=2000 (~30s worst case) so the response stays
  // within ALB/CloudFront 60s timeout. The server's startup prewarm
  // re-fetches the same windows in the background so most users hit the
  // upstream cache and see results in <1s. The amber banner surfaces when
  // older events in the requested window were truncated.
  const url = `/api/compliance/activities?max=2000&pages=20&starting_date=${range.startingDate}&ending_date=${upper}`
  const { data, loading, error } = useFetch<Resp>(url)

  // The server already filtered by date; pass through directly.
  const events = useMemo(() => data?.data ?? [], [data])

  const derived = useMemo(() => {
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

    // Spike threshold = mean + 1·stdev of daily risk count, floored at 1.
    // The reference line on the daily chart highlights days with unusual
    // risk activity so the user can spot anomalies at a glance.
    const riskCounts = daily.map((d) => d.Risk)
    const meanRisk = riskCounts.length ? riskCounts.reduce((a, b) => a + b, 0) / riskCounts.length : 0
    const stdRisk = riskCounts.length
      ? Math.sqrt(riskCounts.reduce((a, b) => a + (b - meanRisk) ** 2, 0) / riskCounts.length)
      : 0
    const riskThreshold = Math.max(1, Math.round(meanRisk + stdRisk))

    return {
      total: events.length,
      risk, login, apiCalls,
      uniqueActors: uniqueActors.size,
      topTypes, topActors, daily, riskThreshold,
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
          total: data?.total_fetched ?? 0,
          start: range.startingDate,
          end: upper,
        })}
        right={<DateRangeControl />}
      />
      <GroupScopeNote />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        {data?.stop_reason && !COMPLETE_STOPS.has(data.stop_reason) && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
            {t(
              // Volume stops (max/cap) keep the "narrow the range" wording;
              // degraded stops get an accurate diagnosis + remediation.
              data.stop_reason.startsWith('upstream_') ? 'audit.partial.upstream'
                : data.stop_reason === 'time_budget' ? 'audit.partial.budget'
                : 'audit.cap.warning',
              {
                fetched: fmtNum(data.total_fetched),
                start: range.startingDate,
                end: upper,
              },
            )}
          </div>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('audit.kpi.total')} value={fmtNum(derived.total)} hint={t('audit.kpi.total.hint')} />
          <KpiCard       label={t('audit.kpi.risk')}  value={fmtNum(derived.risk)}  hint={t('audit.kpi.risk.hint')} />
          <KpiCard       label={t('audit.kpi.login')} value={fmtNum(derived.login)} hint={t('audit.kpi.login.hint')} />
          <KpiCard       label={t('audit.kpi.actors')} value={fmtNum(derived.uniqueActors)} hint={`${derived.apiCalls} api calls`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6">
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

        <ChartCard
          title={t('audit.daily')}
          subtitle={t('audit.daily.sub', { threshold: derived.riskThreshold })}
        >
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={derived.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Risk" fill="#D97757" radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="Events" stroke="#1F1E1D" strokeWidth={2} dot={false} />
              <ReferenceLine
                y={derived.riskThreshold}
                stroke="#D97757"
                strokeDasharray="4 4"
                strokeOpacity={0.5}
                label={{
                  value: `risk threshold ${derived.riskThreshold}`,
                  position: 'insideTopRight',
                  fill: '#D97757',
                  fontSize: 10,
                }}
              />
            </ComposedChart>
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
            <AuditFeedTable events={filtered} onSelect={setSelected} />
          )}
        </ChartCard>
      </div>
      <EventDetailPanel event={selected} onClose={closePanel} />
    </div>
  )
}

function AuditFeedTable({ events, onSelect }: { events: ActivityEvent[]; onSelect: (e: ActivityEvent) => void }) {
  type K = 'time' | 'actor' | 'event' | 'ip'
  const accessors: Record<K, (e: ActivityEvent) => string | number | null | undefined> = {
    time:  (e) => e.created_at,
    actor: (e) => e.actor.email_address || e.actor.api_key_id || e.actor.user_id,
    event: (e) => e.type,
    ip:    (e) => e.actor.ip_address,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<ActivityEvent, K>(events, accessors, {
    initialKey: 'time', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
  )
  return (
    <div className="rounded-lg border border-ink-100 overflow-auto max-h-[600px] mx-3">
      <table className="w-full text-xs">
        <thead className="bg-paper-muted/60 sticky top-0">
          <tr>
            <Th label="Time"   k="time" />
            <Th label="Actor"  k="actor" />
            <Th label="Event"  k="event" />
            <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">Detail</th>
            <Th label="IP"     k="ip" />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
                    const r = riskLabel(e.type)
                    return (
                      <tr
                        key={e.id}
                        // Pointer convenience only — the badge <button> below is
                        // the keyboard/AT entry point (a role=row can't announce
                        // clickability). Skip when the user is drag-selecting
                        // text (copying an IP/actor fires click on the row).
                        onClick={() => { if (window.getSelection()?.toString()) return; onSelect(e) }}
                        className={clsx(
                          'border-t border-ink-100 cursor-pointer',
                          r === 'risk' ? 'bg-claude-50/40 hover:bg-claude-50/70' : 'hover:bg-paper-muted/30',
                        )}>
                        <td className="px-3 py-1.5 tabular-nums whitespace-nowrap text-ink-500">
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-ink-700">{actorDisplay(e.actor)}</td>
                        <td className="px-3 py-1.5">
                          <button
                            type="button"
                            onClick={(ev) => { ev.stopPropagation(); onSelect(e) }}
                            aria-label={`${e.type} · ${new Date(e.created_at).toLocaleString()} — detail`}
                            className={clsx(
                              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer',
                              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-claude-500',
                              r === 'risk'  ? 'bg-claude-100 text-claude-800' :
                              r === 'login' ? 'bg-emerald-50 text-emerald-700' :
                              'bg-ink-100 text-ink-600',
                            )}
                          >
                            {e.type}
                          </button>
                        </td>
                        <td className="px-3 py-1.5 text-ink-500">{eventSummary(e)}</td>
                        <td className="px-3 py-1.5 text-ink-400 tabular-nums font-mono">{e.actor.ip_address ?? '—'}</td>
                      </tr>
                    )
                  })}
        </tbody>
      </table>
    </div>
  )
}

// Mask every email-shaped string (keep 1-2 leading chars + domain — the
// maskEmail convention) inside arbitrary text, for the raw-JSON view.
// Also matches percent-encoded '@' (%40): compliance_api_accessed events
// record other clients' request url/request_body verbatim, where emails
// arrive URL-encoded — a literal-@ regex would let those through.
function maskEmailsInText(s: string): string {
  // Identity-aware (ADR-0020): same verdict as maskEmail — an 'unmasked'
  // admin sees recorded url/request_body text raw, everyone else masked.
  if (isUnmasked()) return s
  return s.replace(
    /([A-Za-z0-9._+-]{1,2})[A-Za-z0-9._%+-]*(@|%40)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi,
    '$1***$2$3',
  )
}

/** Value renderer for dynamic event fields: nulls, booleans, emails, objects. */
function fieldValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object') return maskEmailsInText(JSON.stringify(v))
  return maskEmailsInText(String(v))
}

// Keys rendered in the dedicated header/actor sections — everything else
// lands in the generic field list.
const PANEL_HANDLED_KEYS = new Set(['id', 'type', 'created_at', 'actor'])

function EventDetailPanel({ event, onClose }: { event: ActivityEvent | null; onClose: () => void }) {
  const t = useT()
  const panelRef = useRef<HTMLElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const open = !!event

  // aria-modal promises "everything outside is inert" — honor it: move
  // focus into the panel on open, cycle Tab inside it, and restore focus
  // to the triggering element on close.
  useEffect(() => {
    if (!open) return
    const returnTo = document.activeElement as HTMLElement | null
    // Defer past the visibility transition's first frame — at t=0 the
    // computed visibility is still 'hidden' and focus() is silently ignored.
    const focusTimer = setTimeout(() => closeBtnRef.current?.focus(), 50)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, summary, a[href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables || focusables.length === 0) return
      const list = Array.from(focusables)
      const i = list.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? (i <= 0 ? list.length - 1 : i - 1)
        : (i === list.length - 1 || i < 0 ? 0 : i + 1)
      list[next].focus()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKey)
      returnTo?.focus?.()
    }
  }, [open, onClose])

  const fields = useMemo(() => {
    if (!event) return []
    return Object.entries(event)
      .filter(([k]) => !PANEL_HANDLED_KEYS.has(k))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [event])

  const r = event ? riskLabel(event.type) : 'info'
  return (
    <>
      <div
        onClick={onClose}
        className={clsx(
          'fixed inset-0 bg-ink-900/20 backdrop-blur-[2px] transition-opacity z-30',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className={clsx(
          // `invisible` when closed removes the offscreen panel (and its
          // aria-modal dialog semantics) from the a11y tree and tab order —
          // transforms alone don't (same guard as the Layout mobile drawer).
          'fixed right-0 top-0 bottom-0 w-[480px] max-w-[90vw] bg-paper border-l border-ink-100 shadow-2xl z-40 transition-[transform,visibility] duration-200 overflow-y-auto',
          open ? 'translate-x-0 visible' : 'translate-x-full invisible',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={t('audit.detail.title')}
      >
        {event && (
          <div className="p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">{t('audit.detail.title')}</div>
                <span className={clsx(
                  'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium',
                  r === 'risk'  ? 'bg-claude-100 text-claude-800' :
                  r === 'login' ? 'bg-emerald-50 text-emerald-700' :
                  'bg-ink-100 text-ink-600',
                )}>
                  {event.type}
                </span>
              </div>
              <button
                ref={closeBtnRef}
                onClick={onClose}
                aria-label={t('audit.detail.close')}
                className="flex-none rounded-md p-1.5 text-ink-400 hover:text-ink-700 hover:bg-paper-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-claude-500"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-[13px] text-ink-700 tabular-nums">{new Date(event.created_at).toLocaleString()}</div>
              <div className="text-[11px] text-ink-400 font-mono break-all">{event.created_at} · {event.id}</div>
            </div>

            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-2">{t('audit.detail.actor')}</h3>
              <dl className="rounded-lg border border-ink-100 divide-y divide-ink-100 text-[12px]">
                {([
                  ['type', event.actor.type],
                  ['email', event.actor.email_address ? maskEmail(event.actor.email_address) : null],
                  ['user_id', event.actor.user_id],
                  ['api_key_id', event.actor.api_key_id],
                  ['ip_address', event.actor.ip_address],
                  ['user_agent', event.actor.user_agent],
                ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex gap-3 px-3 py-1.5">
                    <dt className="w-24 flex-none text-ink-400 font-mono text-[11px] pt-0.5">{k}</dt>
                    <dd className="min-w-0 break-all text-ink-700">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {fields.length > 0 && (
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-2">{t('audit.detail.fields')}</h3>
                <dl className="rounded-lg border border-ink-100 divide-y divide-ink-100 text-[12px]">
                  {fields.map(([k, v]) => (
                    <div key={k} className="flex gap-3 px-3 py-1.5">
                      <dt className="w-40 flex-none text-ink-400 font-mono text-[11px] pt-0.5 break-all">{k}</dt>
                      <dd className={clsx('min-w-0 break-all', v === null || v === undefined || v === '' ? 'text-ink-300' : 'text-ink-700')}>
                        {fieldValue(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <details className="rounded-lg border border-ink-100">
              <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-ink-500 hover:text-ink-700">{t('audit.detail.raw')}</summary>
              <pre className="px-3 pb-3 text-[10.5px] leading-relaxed text-ink-600 overflow-x-auto whitespace-pre-wrap break-all">
                {maskEmailsInText(JSON.stringify(event, null, 2))}
              </pre>
            </details>
          </div>
        )}
      </aside>
    </>
  )
}
