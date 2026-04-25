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

type DayEntry<T> = { date: string; source: string; data: T[] }
type RangeResp<T> = { range: { starting_date: string; ending_date: string }; days: DayEntry<T>[] }

export function Adoption() {
  const t = useT()
  const { range } = useDateRange('14d')
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const skills     = useFetch<RangeResp<Skill>>(`/api/analytics/skills/range${q}`)
  const connectors = useFetch<RangeResp<Connector>>(`/api/analytics/connectors/range${q}`)
  const projects   = useFetch<RangeResp<ChatProject>>(`/api/analytics/projects/range${q}`)

  if (skills.loading || connectors.loading || projects.loading) return <LoadingState />
  if (skills.error) return <ErrorState error={skills.error} />
  if (connectors.error) return <ErrorState error={connectors.error} />
  if (projects.error) return <ErrorState error={projects.error} />

  // Aggregate skills/connectors across the window. The Analytics API doesn't
  // return user IDs at the skill/connector level, so distinct_user_count can't
  // be deduped across days — we use MAX (peak day's count) which is honest
  // about uniqueness. Usage counts (chat/code/cowork _used_count) are SUM
  // because they grow naturally over time.
  const skillBy = new Map<string, { name: string; Users: number; Chat: number; Code: number; Cowork: number }>()
  for (const day of skills.data?.days ?? []) {
    for (const s of day.data) {
      const cur = skillBy.get(s.skill_name) ?? { name: s.skill_name, Users: 0, Chat: 0, Code: 0, Cowork: 0 }
      cur.Users  = Math.max(cur.Users, s.distinct_user_count)
      cur.Chat  += s.chat_metrics.distinct_conversation_skill_used_count
      cur.Code  += s.claude_code_metrics.distinct_session_skill_used_count
      cur.Cowork += s.cowork_metrics.distinct_session_skill_used_count
      skillBy.set(s.skill_name, cur)
    }
  }
  const skillRows = Array.from(skillBy.values()).sort((a, b) => b.Users - a.Users)

  const connectorBy = new Map<string, { name: string; Users: number; Chat: number; Code: number; Cowork: number }>()
  for (const day of connectors.data?.days ?? []) {
    for (const c of day.data) {
      const cur = connectorBy.get(c.connector_name) ?? { name: c.connector_name, Users: 0, Chat: 0, Code: 0, Cowork: 0 }
      cur.Users  = Math.max(cur.Users, c.distinct_user_count)
      cur.Chat  += c.chat_metrics.distinct_conversation_connector_used_count
      cur.Code  += c.claude_code_metrics.distinct_session_connector_used_count
      cur.Cowork += c.cowork_metrics.distinct_session_connector_used_count
      connectorBy.set(c.connector_name, cur)
    }
  }
  const connectorRows = Array.from(connectorBy.values()).sort((a, b) => b.Users - a.Users)

  // Projects: SUM messages and conversations across the window; MAX distinct
  // users (same uniqueness caveat). Keep the latest seen project_name and
  // created_by metadata in case a project is renamed mid-window.
  const projectBy = new Map<string, ChatProject & { _aggMessages: number; _aggConvos: number; _aggUsers: number }>()
  for (const day of projects.data?.days ?? []) {
    for (const p of day.data) {
      const cur = projectBy.get(p.project_id)
      if (!cur) {
        projectBy.set(p.project_id, {
          ...p,
          _aggMessages: p.message_count,
          _aggConvos:   p.distinct_conversation_count,
          _aggUsers:    p.distinct_user_count,
        })
      } else {
        cur._aggMessages += p.message_count
        cur._aggConvos   += p.distinct_conversation_count
        cur._aggUsers     = Math.max(cur._aggUsers, p.distinct_user_count)
        // Latest day overwrites name and creator metadata
        cur.project_name = p.project_name
        cur.created_by   = p.created_by
      }
    }
  }
  const projectRows = Array.from(projectBy.values())
    .map((p) => ({
      project_id: p.project_id,
      project_name: p.project_name,
      message_count: p._aggMessages,
      distinct_conversation_count: p._aggConvos,
      distinct_user_count: p._aggUsers,
      created_by: p.created_by,
    }))
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 10)

  return (
    <div>
      <PageHeader
        title={t('adopt.title')}
        subtitle={t('adopt.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={skills.data?.days?.[0]?.source as 'live' | 'mock' | undefined}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <ChartCard title="Skills" subtitle="Peak distinct users per skill; Chat/Code/Cowork are window totals">
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

        <ChartCard title="Connectors" subtitle="Peak distinct users per connector; Chat/Code/Cowork are window totals">
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

        <ChartCard title="Top Chat Projects" subtitle="Total messages per project across the window (top 10)">
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
