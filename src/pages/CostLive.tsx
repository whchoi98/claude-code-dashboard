import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useGroupScope } from '../lib/useGroupScope'
import { useSortable } from '../lib/useSortable'
import { fmtPct, maskEmail } from '../lib/format'
import { useT } from '../lib/i18n'

// Live month-to-date spend per member — the Spend Limits API's
// period_to_date_spend, the SAME near-real-time figure the Anthropic Console
// member list shows (calendar month, resets on the 1st 00:00 UTC). This is
// deliberately a different regime from every other cost view: the Analytics
// cost reports run at a ~4h watermark, so this page leads them for
// currently-active users (the recurring "totals don't match" question).

type Member = {
  email: string
  name: string | null
  limit_usd: number | null
  spent_usd: number
  utilization: number | null
  period: string
  source: string
}
type Resp = { source: string; period: string; fetched_at?: string; members: Member[] }
type K = 'user' | 'spent' | 'limit' | 'util' | 'source'

const AUTO_REFRESH_MS = 60_000

function fmtUsd(v: number) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 10)   return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}
// KPI/total precision: the whole point of this page is the exact live total,
// so don't compress it to $5.6k.
const fmtUsdFull = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function CostLive() {
  const t = useT()
  const { inGroup } = useGroupScope()

  // First paint rides the server's 10-min TTL cache (keep-warm keeps it hot);
  // every subsequent tick — auto (60s) or the manual button — sends fresh=1,
  // which bypasses that TTL server-side and pulls the Spend Limits API now
  // (its own 60 rpm budget; the server still floors refreshes at 15s).
  const [auto, setAuto] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => setTick(Date.now()), AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [auto])
  const url = tick ? `/api/cost/spend-limits?fresh=1&t=${tick}` : '/api/cost/spend-limits'
  const fetched = useFetch<Resp>(url)
  // Keep the last successful payload across refresh errors: useFetch nulls
  // `data` on ANY fetch failure, and with the 60s auto-refresh a single
  // transient upstream hiccup would otherwise blank the KPIs and table that
  // were on screen a minute earlier. Errors render as an inline note while
  // the previous numbers stay up.
  const [last, setLast] = useState<Resp | null>(null)
  useEffect(() => { if (fetched.data) setLast(fetched.data) }, [fetched.data])
  const data = fetched.data ?? last
  const { loading, error } = fetched

  const scoped = useMemo(
    () => (data?.members ?? []).filter((m) => inGroup(m.email)),
    [data, inGroup],
  )
  const totals = useMemo(() => {
    const total = scoped.reduce((s, m) => s + m.spent_usd, 0)
    const active = scoped.filter((m) => m.spent_usd > 0)
    const top = active.reduce<Member | null>((best, m) => (best && best.spent_usd >= m.spent_usd ? best : m), null)
    const nearLimit = scoped.filter((m) => m.utilization != null && m.utilization >= 0.9).length
    const capped = scoped.filter((m) => m.limit_usd != null).length
    return { total, activeCount: active.length, top, nearLimit, capped }
  }, [scoped])

  const accessors: Record<K, (m: Member) => string | number | null | undefined> = {
    user:   (m) => m.email,
    spent:  (m) => m.spent_usd,
    limit:  (m) => m.limit_usd,
    util:   (m) => m.utilization,
    source: (m) => m.source,
  }
  const { rows, sortKey, sortDir, toggle } = useSortable<Member, K>(scoped, accessors, {
    initialKey: 'spent', initialDir: 'desc',
  })
  const Th = (props: { label: string; k: K; align?: 'left' | 'right' }) => (
    <SortableTh<K> label={props.label} k={props.k} sortKey={sortKey} sortDir={sortDir} onClick={toggle} align={props.align} />
  )

  const asOf = data?.fetched_at ? new Date(data.fetched_at).toLocaleTimeString() : null

  return (
    <div>
      <PageHeader
        title={t('cost_live.title')}
        subtitle={t('cost_live.subtitle')}
        source={data ? 'live' : undefined}
        right={
          <div className="flex items-center gap-3 text-xs text-ink-500">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-claude-500" />
              {t('cost_live.auto')}
            </label>
            <button
              onClick={() => setTick(Date.now())}
              className="rounded-md border border-ink-200 px-2.5 py-1 hover:bg-paper-muted text-ink-600"
            >
              {t('cost_live.refresh')}
            </button>
          </div>
        }
      />
      <GroupTabs />
      <div className="px-4 lg:px-8 py-6 space-y-6">
        {error && !data && <ErrorState error={error} />}
        {!data && !error && <LoadingState />}
        {data && (
          <>
            <p className="text-xs text-ink-400">
              {asOf ? t('cost_live.as_of', { time: asOf }) : t('cost_live.source_note')}
              {loading && <span className="ml-2 text-claude-500 animate-pulse">{t('cost_live.refreshing')}</span>}
              {error && <span className="ml-2 text-amber-600">{t('cost_live.refresh_failed')}</span>}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard label={t('cost_live.kpi.total')} value={fmtUsdFull(totals.total)} hint={t('cost_live.kpi.total_hint')} accent />
              <KpiCard label={t('cost_live.kpi.active')} value={`${totals.activeCount} / ${scoped.length}`} hint={t('cost_live.kpi.active_hint')} />
              <KpiCard
                label={t('cost_live.kpi.top')}
                value={totals.top ? fmtUsdFull(totals.top.spent_usd) : '—'}
                hint={totals.top ? maskEmail(totals.top.email) : t('cost_live.kpi.top_hint')}
              />
              <KpiCard
                label={t('cost_live.kpi.near_limit')}
                value={String(totals.nearLimit)}
                hint={t('cost_live.kpi.near_limit_hint', { n: totals.capped })}
              />
            </div>
            <ChartCard title={t('cost_live.table.title')} subtitle={t('cost_live.table.sub')}>
              {rows.length === 0 ? (
                <EmptyState title={t('cost_live.empty')} />
              ) : (
                <div className="rounded-lg border border-ink-100 overflow-x-auto mx-3 mb-3">
                  <table className="w-full text-sm">
                    <thead className="bg-paper-muted/60 text-ink-500">
                      <tr>
                        <Th label={t('user_prod.col.user')} k="user" align="left" />
                        <Th label={t('cost.limits.col.spent')} k="spent" align="right" />
                        <Th label={t('cost.limits.col.limit')} k="limit" align="right" />
                        <Th label={t('cost.limits.col.util')} k="util" align="right" />
                        <Th label={t('cost.limits.col.source')} k="source" align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.email} className="border-t border-ink-100">
                          <td className="px-3 py-1.5 font-medium text-ink-700">{maskEmail(m.email)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-claude-600 font-medium">{fmtUsd(m.spent_usd)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-600">
                            {m.limit_usd != null ? fmtUsd(m.limit_usd) : t('cost.limits.unlimited')}
                          </td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${
                            m.utilization != null && m.utilization >= 0.9 ? 'text-claude-700' : 'text-ink-600'
                          }`}>
                            {m.utilization != null ? fmtPct(m.utilization) : '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-[11px] text-ink-400">{m.source.replace(/_/g, ' ')}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-ink-200 bg-paper-muted/40 font-semibold text-ink-700">
                        <td className="px-3 py-2">{t('cost_live.total_row', { n: rows.length })}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-claude-700">{fmtUsdFull(totals.total)}</td>
                        <td className="px-3 py-2" colSpan={3} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </ChartCard>
            <p className="text-[11px] text-ink-400 max-w-3xl">{t('cost_live.note')}</p>
          </>
        )}
      </div>
    </div>
  )
}
