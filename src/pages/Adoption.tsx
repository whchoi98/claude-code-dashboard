import { useMemo } from 'react'
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

type Row = { name: string; Users: number; Chat: number; Code: number; Cowork: number }
type ProjectRow = Pick<ChatProject, 'project_id' | 'project_name' | 'message_count' | 'distinct_conversation_count' | 'distinct_user_count' | 'created_by'>

export function Adoption() {
  const t = useT()
  const { range } = useDateRange('14d')
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const skills     = useFetch<RangeResp<Skill>>(`/api/analytics/skills/range${q}`)
  const connectors = useFetch<RangeResp<Connector>>(`/api/analytics/connectors/range${q}`)
  const projects   = useFetch<RangeResp<ChatProject>>(`/api/analytics/projects/range${q}`)

  // Distinct user counts can't be deduped across days because the API doesn't
  // return user IDs at the skill/connector level — MAX (peak day) is the honest
  // approximation. Usage counts (Chat/Code/Cowork) SUM naturally.
  const skillRows = useMemo<Row[]>(() => {
    const by = new Map<string, Row>()
    for (const day of skills.data?.days ?? []) {
      for (const s of day.data) {
        const cur = by.get(s.skill_name) ?? { name: s.skill_name, Users: 0, Chat: 0, Code: 0, Cowork: 0 }
        cur.Users  = Math.max(cur.Users, s.distinct_user_count)
        cur.Chat  += s.chat_metrics.distinct_conversation_skill_used_count
        cur.Code  += s.claude_code_metrics.distinct_session_skill_used_count
        cur.Cowork += s.cowork_metrics.distinct_session_skill_used_count
        by.set(s.skill_name, cur)
      }
    }
    return Array.from(by.values()).sort((a, b) => b.Users - a.Users)
  }, [skills.data])

  const connectorRows = useMemo<Row[]>(() => {
    const by = new Map<string, Row>()
    for (const day of connectors.data?.days ?? []) {
      for (const c of day.data) {
        const cur = by.get(c.connector_name) ?? { name: c.connector_name, Users: 0, Chat: 0, Code: 0, Cowork: 0 }
        cur.Users  = Math.max(cur.Users, c.distinct_user_count)
        cur.Chat  += c.chat_metrics.distinct_conversation_connector_used_count
        cur.Code  += c.claude_code_metrics.distinct_session_connector_used_count
        cur.Cowork += c.cowork_metrics.distinct_session_connector_used_count
        by.set(c.connector_name, cur)
      }
    }
    return Array.from(by.values()).sort((a, b) => b.Users - a.Users)
  }, [connectors.data])

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

  if (skills.loading || connectors.loading || projects.loading) return <LoadingState />
  if (skills.error) return <ErrorState error={skills.error} />
  if (connectors.error) return <ErrorState error={connectors.error} />
  if (projects.error) return <ErrorState error={projects.error} />

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
