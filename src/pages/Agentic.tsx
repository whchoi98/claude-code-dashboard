import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, BarChart, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { RangeCoverageNote } from '../components/RangeCoverageNote'
import { badgeSource } from '../lib/format'
import { GroupScopeNote } from '../components/GroupScopeNote'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtDate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type CostResp = {
  rows: { product: string; model: string; total_net_spend_usd: number }[]
  daily: { date: string; model: string; spend: number }[]
  period?: { starting_date: string; ending_date: string } | null
  // >186-day requests clamp server-side; period reflects what was served.
  window_clamped?: boolean
}
type UserRow = {
  email: string; prompts: number; actions: number; app: number | null
  ccSessions: number; ccActions: number; ccAps: number | null
}
type Tt = (k: any, p?: any) => string

const shortModel = (m: string) =>
  m.replace(/^claude[-_]/i, '').replace(/_v\d+:\d+$/, '').replace(/[-_]\d{8}$/, '').replace(/[-_]/g, ' ')
const fmtUsd = (v: number) =>
  `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 })}`
const ccActionTotal = (r: UserRecord) => {
  // Accepted only — "actions Claude PERFORMS": a rejected tool proposal was
  // never executed, matching Cowork's action_count semantics.
  const ta = r.claude_code_metrics.tool_actions
  return ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
         ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
}

/**
 * "How agentic is the work?" — actions Claude performs per prompt (Cowork:
 * action_count / message_count, the only surface where the API exposes both).
 * Claude Code has no prompt count upstream, so actions-per-SESSION is shown
 * as its delegation proxy. Per-user parts honor the group scope; the spend
 * section is org-level cost_report data (partial-scope note).
 */
export function Agentic() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const users = useFetch<RangeResp>(`/api/analytics/users/range${q}`)
  const cost = useFetch<CostResp>(`/api/cost/live${q}`)

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let prompts = 0, actions = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        prompts += r.cowork_metrics.message_count
        actions += r.cowork_metrics.action_count
      }
      return { date: fmtDate(d.date), prompts, actions, app: prompts > 0 ? actions / prompts : null }
    })

    const byEmail = new Map<string, UserRow>()
    let promptsTotal = 0, actionsTotal = 0, ccSessionsTotal = 0, ccActionsTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        const email = r.user.email_address
        if (!inGroup(email)) continue
        const prompts = r.cowork_metrics.message_count
        const actions = r.cowork_metrics.action_count
        const ccSessions = r.claude_code_metrics.core_metrics.distinct_session_count
        const ccActions = ccActionTotal(r)
        promptsTotal += prompts; actionsTotal += actions
        ccSessionsTotal += ccSessions; ccActionsTotal += ccActions
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, prompts: 0, actions: 0, app: null, ccSessions: 0, ccActions: 0, ccAps: null }; byEmail.set(email, cur) }
        cur.prompts += prompts; cur.actions += actions
        cur.ccSessions += ccSessions; cur.ccActions += ccActions
      }
    }
    const rows = [...byEmail.values()]
      .filter((u) => u.prompts > 0 || u.ccSessions > 0)
      .map((u) => ({
        ...u,
        app: u.prompts > 0 ? u.actions / u.prompts : null,
        ccAps: u.ccSessions > 0 ? u.ccActions / u.ccSessions : null,
      }))
    const avgApp = promptsTotal > 0 ? actionsTotal / promptsTotal : null
    const ccAps = ccSessionsTotal > 0 ? ccActionsTotal / ccSessionsTotal : null
    return { daily, rows, promptsTotal, actionsTotal, avgApp, ccSessionsTotal, ccActionsTotal, ccAps }
  }, [users.data, inGroup])

  const spend = useMemo(() => {
    const daily = new Map<string, number>()
    for (const d of cost.data?.daily ?? []) {
      daily.set(d.date, (daily.get(d.date) ?? 0) + d.spend)
    }
    const byModel = new Map<string, number>()
    for (const r of cost.data?.rows ?? []) {
      byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.total_net_spend_usd)
    }
    return {
      daily: [...daily.entries()].map(([date, spend]) => ({ date, spend })).sort((a, b) => a.date.localeCompare(b.date)),
      models: [...byModel.entries()].map(([model, spend]) => ({ model, short: shortModel(model), spend })).sort((a, b) => b.spend - a.spend),
    }
  }, [cost.data])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = badgeSource(users.data?.days?.[0]?.source)
  const hasData = agg.promptsTotal > 0 || agg.ccSessionsTotal > 0

  return (
    <div>
      <PageHeader
        title={t('agentic.title')}
        subtitle={t('agentic.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <RangeCoverageNote resp={users.data} />
      {cost.data?.window_clamped && cost.data.period && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {t('cost.window_clamped', { start: cost.data.period.starting_date, end: cost.data.period.ending_date })}
        </div>
      )}
      {/* Spend section below is org-level cost_report data — flag it. */}
      <GroupScopeNote variant="partial" />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('agentic.kpi.app')} value={agg.avgApp != null ? agg.avgApp.toFixed(1) : '—'} hint={t('agentic.kpi.app.hint')} />
          <KpiCard label={t('agentic.kpi.prompts')} value={fmtNum(agg.promptsTotal)} hint={t('agentic.kpi.prompts.hint')} />
          <KpiCard label={t('agentic.kpi.actions')} value={fmtNum(agg.actionsTotal)} hint={t('agentic.kpi.actions.hint')} />
          <KpiCard label={t('agentic.kpi.cc_aps')} value={agg.ccAps != null ? agg.ccAps.toFixed(1) : '—'} hint={t('agentic.kpi.cc_aps.hint')} />
        </div>

        {!hasData && <EmptyState title={t('agentic.empty')} hint={t('agentic.empty.hint')} />}

        {hasData && (
          <>
            <ChartCard title={t('agentic.trend')} subtitle={t('agentic.trend.sub')}>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={agg.daily} margin={{ top: 12, right: 16, left: -8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="prompts" tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmtCompact(v)} />
                  <YAxis yAxisId="app" orientation="right" tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="prompts" dataKey="prompts" name={t('agentic.kpi.prompts')} fill="#EDEBE4" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="app" type="monotone" dataKey="app" name={t('agentic.kpi.app')} stroke="#D97757" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title={t('agentic.table')}
              subtitle={t('agentic.table.sub', { avg: agg.avgApp != null ? agg.avgApp.toFixed(1) : '—' })}
            >
              <AgenticUserTable rows={agg.rows} avgApp={agg.avgApp} t={t} />
            </ChartCard>
          </>
        )}

        {cost.loading && <div className="skeleton h-40 rounded-xl" />}
        {cost.error && (
          <div className="rounded-lg border border-ink-100 bg-paper-muted/40 px-4 py-3 text-[12px] text-ink-500">
            {t('agentic.spend.error')}
          </div>
        )}
        {spend.daily.length > 0 && (
          <ChartCard title={t('agentic.spend.total')} subtitle={t('agentic.spend.total.sub')}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={spend.daily} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmtUsd(v)} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Area type="monotone" dataKey="spend" stroke="#D97757" fill="#D97757" fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {spend.models.length > 0 && (
          <ChartCard title={t('agentic.spend.model')} subtitle={t('agentic.spend.model.sub')}>
            <ResponsiveContainer width="100%" height={Math.max(160, spend.models.length * 34 + 40)}>
              <BarChart data={spend.models} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v)} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="short" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Bar dataKey="spend" fill="#D97757" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    </div>
  )
}

function AgenticUserTable({ rows, avgApp, t }: { rows: UserRow[]; avgApp: number | null; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<UserRow, 'email' | 'prompts' | 'actions' | 'app' | 'ccSessions' | 'ccAps'>(
    rows,
    {
      email: (r) => r.email,
      prompts: (r) => r.prompts,
      actions: (r) => r.actions,
      app: (r) => r.app,
      ccSessions: (r) => r.ccSessions,
      ccAps: (r) => r.ccAps,
    },
    { initialKey: 'app', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('agentic.empty')} /></div>
  return (
    <div className="px-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('agentic.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('agentic.col.prompts')} k="prompts" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('agentic.col.actions')} k="actions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('agentic.col.app')} k="app" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('agentic.col.cc_sessions')} k="ccSessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('agentic.col.cc_aps')} k="ccAps" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const delta = r.app != null && avgApp != null && avgApp > 0 ? (r.app - avgApp) / avgApp : null
            return (
              <tr key={r.email} className="border-b border-ink-50">
                <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.prompts)}</td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.actions)}</td>
                <td className="py-2 text-right tabular-nums font-medium text-ink-800">
                  {r.app != null ? r.app.toFixed(1) : '—'}
                  {delta != null && (
                    <span className={delta >= 0 ? 'ml-1 text-[11px] text-claude-600' : 'ml-1 text-[11px] text-ink-400'}>
                      {delta >= 0 ? '▲' : '▼'}{Math.abs(delta * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">{fmtNum(r.ccSessions)}</td>
                <td className="py-2 text-right tabular-nums">{r.ccAps != null ? r.ccAps.toFixed(1) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
