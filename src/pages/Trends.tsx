import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AreaChart, Area,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtDate } from '../lib/format'
import type { Summary } from '../types'

type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }

export function Trends() {
  const t = useT()
  const { range } = useDateRange('30d')
  const { data, loading, error, source, reason } = useFetch<SummariesResp>(
    `/api/analytics/summaries?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )
  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

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
      <div className="p-8 space-y-6">
        <ChartCard title="Active Users (DAU · WAU · MAU)">
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
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="grid grid-cols-2 gap-6">
          <ChartCard title="Seats vs Monthly Active">
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

          <ChartCard title="Adoption Rate" subtitle="Daily adoption (% of seats)">
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
