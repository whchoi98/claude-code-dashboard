import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useT } from '../lib/i18n'
import { fmtNum, maskEmail } from '../lib/format'
import type { Skill, Connector, ChatProject } from '../types'

type R<T> = { source: 'live' | 'mock'; reason?: string; date: string; data: T[] }

export function Adoption() {
  const t = useT()
  const { range } = useDateRange('14d')
  const d = `?date=${range.endingDate}`
  const skills     = useFetch<R<Skill>>(`/api/analytics/skills${d}`)
  const connectors = useFetch<R<Connector>>(`/api/analytics/connectors${d}`)
  const projects   = useFetch<R<ChatProject>>(`/api/analytics/projects${d}`)

  if (skills.loading || connectors.loading || projects.loading) return <LoadingState />
  if (skills.error) return <ErrorState error={skills.error} />
  if (connectors.error) return <ErrorState error={connectors.error} />
  if (projects.error) return <ErrorState error={projects.error} />

  const skillRows = (skills.data?.data ?? [])
    .map((s) => ({
      name: s.skill_name,
      Users: s.distinct_user_count,
      Chat: s.chat_metrics.distinct_conversation_skill_used_count,
      Code: s.claude_code_metrics.distinct_session_skill_used_count,
      Cowork: s.cowork_metrics.distinct_session_skill_used_count,
    }))
    .sort((a, b) => b.Users - a.Users)

  const connectorRows = (connectors.data?.data ?? [])
    .map((c) => ({
      name: c.connector_name,
      Users: c.distinct_user_count,
      Chat: c.chat_metrics.distinct_conversation_connector_used_count,
      Code: c.claude_code_metrics.distinct_session_connector_used_count,
      Cowork: c.cowork_metrics.distinct_session_connector_used_count,
    }))
    .sort((a, b) => b.Users - a.Users)

  const projectRows = [...(projects.data?.data ?? [])]
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 10)

  return (
    <div>
      <PageHeader
        title={t('adopt.title')}
        subtitle={t('adopt.subtitle')}
        source={skills.source}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <ChartCard title="Skills" subtitle="Distinct users per skill (today)">
          <ResponsiveContainer width="100%" height={Math.max(220, skillRows.length * 32)}>
            <BarChart data={skillRows} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Users" fill="#D97757" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Chat" fill="#B5AFA0" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Code" fill="#1F1E1D" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Connectors" subtitle="Distinct users per connector (today)">
          <ResponsiveContainer width="100%" height={Math.max(220, connectorRows.length * 32)}>
            <BarChart data={connectorRows} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis type="number" />
              <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Users" fill="#D97757" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Chat" fill="#B5AFA0" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Code" fill="#1F1E1D" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Top Chat Projects" subtitle="Messages per project (top 10)">
          <div className="rounded-lg border border-ink-100 overflow-hidden mx-3">
            <table className="w-full text-sm">
              <thead className="bg-paper-muted/60 text-ink-500">
                <tr>
                  <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wider">Project</th>
                  <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-wider">Users</th>
                  <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-wider">Conversations</th>
                  <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-wider">Messages</th>
                  <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wider">Created by</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map((p) => (
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
        </ChartCard>
      </div>
    </div>
  )
}
