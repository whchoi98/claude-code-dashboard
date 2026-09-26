import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AreaChart, Area,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupScopeNote } from '../components/GroupScopeNote'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtDate } from '../lib/format'
import type { Summary } from '../types'

type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }

// Per-product active users from /summaries (`<product>_<daily|weekly|monthly>_active_user_count`).
// Colors follow the Cost page's product palette. The fields are OMITTED while
// an org's per-product breakdown is off, so a product only renders when at
// least one day carries a number — absent is "unknown", never 0.
const PRODUCTS = [
  { key: 'claude_code',   label: 'Claude Code',    color: '#D97757' },
  { key: 'chat',          label: 'Chat',           color: '#1F1E1D' },
  { key: 'cowork',        label: 'Cowork',         color: '#B75E40' },
  { key: 'claude_design', label: 'Claude Design',  color: '#4CA371' },
  { key: 'office_agent',  label: 'Office Agents',  color: '#5B7FA6' },
  { key: 'science',       label: 'Claude Science', color: '#9A6FB0' },
] as const
type Period = 'daily' | 'weekly' | 'monthly'
const PERIODS: { key: Period; label: string }[] = [
  { key: 'daily', label: 'DAU' }, { key: 'weekly', label: 'WAU' }, { key: 'monthly', label: 'MAU' },
]
const productValue = (s: Summary, product: string, period: Period): number | undefined => {
  const v = (s as Record<string, unknown>)[`${product}_${period}_active_user_count`]
  return typeof v === 'number' ? v : undefined
}

export function Trends() {
  const t = useT()
  const { range } = useDateRange('7d')
  const [period, setPeriod] = useState<Period>('daily')
  const { data, loading, error, source, reason, refetch } = useFetch<SummariesResp>(
    `/api/analytics/summaries?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  const byProduct = useMemo(() => {
    const summaries = data?.data ?? []
    const present = PRODUCTS.filter((p) => summaries.some((s) => productValue(s, p.key, period) !== undefined))
    const rows = summaries.map((s) => {
      const row: Record<string, string | number | undefined> = { date: fmtDate(s.starting_at) }
      for (const p of present) row[p.key] = productValue(s, p.key, period)
      return row
    })
    return { present, rows }
  }, [data, period])
  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} onRetry={refetch} />

  const rows = (data?.data ?? []).map((s) => ({
    date: fmtDate(s.starting_at),
    DAU: s.daily_active_user_count,
    WAU: s.weekly_active_user_count,
    MAU: s.monthly_active_user_count,
    Seats: s.assigned_seat_count,
    Pending: s.pending_invite_count,
    CoworkDAU: s.cowork_daily_active_user_count,
    AdoptionRate: s.daily_adoption_rate,
  }))

  return (
    <div>
      <PageHeader
        title={t('trends.title')}
        subtitle={t('trends.subtitle')}
        source={source}
        reason={reason}
        right={<DateRangeControl />}
      />
      <GroupScopeNote />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <ChartCard title={t('trends.active_users')}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="DAU" stroke="#D97757" strokeWidth={2.5} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="WAU" stroke="#8A8474" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="MAU" stroke="#1F1E1D" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="CoworkDAU" name={t('cowork.metric.dau')} stroke="#B75E40" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={t('trends.by_product')}
          subtitle={t('trends.by_product.sub')}
          right={
            <div className="inline-flex rounded-lg border border-ink-100 bg-paper p-0.5 text-[12px] print:hidden" role="group" aria-label={t('trends.by_product.period')}>
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPeriod(p.key)}
                  aria-pressed={period === p.key}
                  className={clsx(
                    'px-2.5 py-1 rounded-md transition',
                    period === p.key ? 'bg-claude-500 text-white shadow-sm' : 'text-ink-500 hover:bg-paper-muted',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          }
        >
          {byProduct.present.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ink-400">{t('trends.by_product.empty')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={byProduct.rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                {byProduct.present.map((p) => (
                  <Line key={p.key} type="monotone" dataKey={p.key} name={p.label} stroke={p.color} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6">
          <ChartCard title={t('trends.seats_vs_mau')}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="Seats" stackId="0" stroke="#EDEBE4" fill="#F3F1EB" />
                <Area type="monotone" dataKey="MAU"   stackId="1" stroke="#D97757" fill="#F5DCCF" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t('trends.adoption_rate')} subtitle={t('trends.adoption_rate.sub')}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" />
                <YAxis unit="%" />
                <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                <Line type="monotone" dataKey="AdoptionRate" stroke="#B75E40" strokeWidth={2.5} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  )
}
