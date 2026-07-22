import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line, LineChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { GroupTabs } from '../components/GroupTabs'
import { RangeCoverageNote } from '../components/RangeCoverageNote'
import { badgeSource } from '../lib/format'
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
type ChatRow = {
  email: string; messages: number; convos: number; artifacts: number
  projectsCreated: number; skills: number; connectors: number; web: number
}
type Tt = (k: any, p?: any) => string

/** Claude Chat (claude.ai conversations) — period usage & activity metrics.
 *  Same fully-scoped surface-page shape as Cowork/Office/Design: users/range
 *  is the source, every per-user loop honors the group scope. */
export function ClaudeChat() {
  const t = useT()
  const { range } = useDateRange('7d')
  const { inGroup } = useGroupScope()
  const users = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let messages = 0, convos = 0, artifacts = 0, projectsCreated = 0, projectsUsed = 0, web = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.chat_metrics
        messages += m.message_count
        convos += m.distinct_conversation_count
        artifacts += m.distinct_artifacts_created_count ?? 0
        projectsCreated += m.distinct_projects_created_count ?? 0
        projectsUsed += m.distinct_projects_used_count ?? 0
        web += r.web_search_count ?? 0
      }
      return { date: fmtDate(d.date), messages, convos, artifacts, projectsCreated, projectsUsed, web }
    })
    const byEmail = new Map<string, ChatRow>()
    const activeEmails = new Set<string>()
    let messagesTotal = 0, thinkingTotal = 0, convosTotal = 0, artifactsTotal = 0
    let projectsCreatedTotal = 0, skillsTotal = 0, connectorsTotal = 0, webTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.chat_metrics
        const email = r.user.email_address
        if (m.message_count > 0) activeEmails.add(email)
        messagesTotal += m.message_count
        thinkingTotal += m.thinking_message_count ?? 0
        convosTotal += m.distinct_conversation_count
        artifactsTotal += m.distinct_artifacts_created_count ?? 0
        projectsCreatedTotal += m.distinct_projects_created_count ?? 0
        skillsTotal += m.distinct_skills_used_count ?? 0
        connectorsTotal += m.connectors_used_count ?? 0
        webTotal += r.web_search_count ?? 0
        let cur = byEmail.get(email)
        if (!cur) {
          cur = { email, messages: 0, convos: 0, artifacts: 0, projectsCreated: 0, skills: 0, connectors: 0, web: 0 }
          byEmail.set(email, cur)
        }
        cur.messages += m.message_count
        cur.convos += m.distinct_conversation_count
        cur.artifacts += m.distinct_artifacts_created_count ?? 0
        cur.projectsCreated += m.distinct_projects_created_count ?? 0
        cur.skills += m.distinct_skills_used_count ?? 0
        cur.connectors += m.connectors_used_count ?? 0
        cur.web += r.web_search_count ?? 0
      }
    }
    return {
      daily,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      messagesTotal, thinkingTotal, convosTotal, artifactsTotal,
      projectsCreatedTotal, skillsTotal, connectorsTotal, webTotal,
    }
  }, [users.data, inGroup])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = badgeSource(users.data?.days?.[0]?.source)
  const hasData = agg.messagesTotal > 0

  return (
    <div>
      <PageHeader
        title={t('claude_chat.title')}
        subtitle={t('claude_chat.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <GroupTabs />
      <RangeCoverageNote resp={users.data} />
      <div className="p-4 lg:p-8 print:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard accent label={t('claude_chat.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('claude_chat.kpi.active_users.hint')} />
          <KpiCard label={t('claude_chat.kpi.messages')} value={fmtCompact(agg.messagesTotal)} hint={t('claude_chat.kpi.messages.hint', { n: fmtCompact(agg.thinkingTotal) })} />
          <KpiCard label={t('claude_chat.kpi.convos')} value={fmtCompact(agg.convosTotal)} />
          <KpiCard label={t('claude_chat.kpi.artifacts')} value={fmtCompact(agg.artifactsTotal)} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4">
          <KpiCard label={t('claude_chat.kpi.projects')} value={fmtCompact(agg.projectsCreatedTotal)} hint={t('claude_chat.kpi.projects.hint')} />
          <KpiCard label={t('claude_chat.kpi.skills')} value={fmtCompact(agg.skillsTotal)} />
          <KpiCard label={t('claude_chat.kpi.connectors')} value={fmtCompact(agg.connectorsTotal)} />
          <KpiCard label={t('claude_chat.kpi.web')} value={fmtCompact(agg.webTotal)} />
        </div>

        {hasData ? (
          <>
            <ChartCard title={t('claude_chat.daily.title')} subtitle={t('claude_chat.daily.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <defs>
                    <linearGradient id="chatGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#D97757" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#D97757" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="messages" name={t('claude_chat.metric.messages')} stroke="#D97757" strokeWidth={2} fill="url(#chatGrad)" />
                  <Line type="monotone" dataKey="convos" name={t('claude_chat.metric.convos')} stroke="#8A8474" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('claude_chat.breakdown.title')} subtitle={t('claude_chat.breakdown.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="artifacts" name={t('claude_chat.metric.artifacts')} stroke="#D97757" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="projectsCreated" name={t('claude_chat.metric.projects_created')} stroke="#4CA371" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="projectsUsed" name={t('claude_chat.metric.projects_used')} stroke="#8A8474" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="web" name={t('claude_chat.metric.web')} stroke="#B4A78F" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('claude_chat.top.title')} subtitle={t('claude_chat.top.sub')}>
              <ChatUserTable rows={agg.users} t={t} />
            </ChartCard>
          </>
        ) : (
          <EmptyState title={t('claude_chat.empty')} hint={t('claude_chat.empty.hint')} />
        )}
      </div>
    </div>
  )
}

function ChatUserTable({ rows, t }: { rows: ChatRow[]; t: Tt }) {
  type K = 'email' | 'messages' | 'convos' | 'artifacts' | 'projectsCreated' | 'skills' | 'connectors' | 'web'
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<ChatRow, K>(
    rows,
    {
      email: (r) => r.email,
      messages: (r) => r.messages,
      convos: (r) => r.convos,
      artifacts: (r) => r.artifacts,
      projectsCreated: (r) => r.projectsCreated,
      skills: (r) => r.skills,
      connectors: (r) => r.connectors,
      web: (r) => r.web,
    },
    { initialKey: 'messages', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('claude_chat.top.empty')} /></div>
  return (
    <div className="px-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('claude_chat.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('claude_chat.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.convos')} k="convos" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.artifacts')} k="artifacts" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.projects_created')} k="projectsCreated" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.skills')} k="skills" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.connectors')} k="connectors" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('claude_chat.metric.web')} k="web" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.convos)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.artifacts)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.projectsCreated)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.skills)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.connectors)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.web)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
