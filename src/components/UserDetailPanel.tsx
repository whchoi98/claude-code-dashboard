import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Legend,
} from 'recharts'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import { fmtNum, fmtPct, fmtCompact, fmtDate, acceptRate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[]; error?: unknown }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }

interface Props {
  email: string | null
  onClose: () => void
}

export function UserDetailPanel({ email, onClose }: Props) {
  const t = useT()
  const [range, setRange] = useState<RangeResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!email) return
    let aborted = false
    setLoading(true); setErr(null)
    fetch('/api/analytics/users/range')
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || r.statusText)
        return body
      })
      .then((body) => { if (!aborted) setRange(body) })
      .catch((e) => { if (!aborted) setErr(String(e.message || e)) })
      .finally(() => { if (!aborted) setLoading(false) })
    return () => { aborted = true }
  }, [email])

  const daily = useMemo(() => {
    if (!email || !range) return []
    return range.days.map((d) => {
      const rec = d.data.find((u) => u.user.email_address === email)
      const cc = rec?.claude_code_metrics.core_metrics
      const ta = rec?.claude_code_metrics.tool_actions
      const accepted = ta ? ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
                            ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count : 0
      const rejected = ta ? ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
                            ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count : 0
      return {
        date: fmtDate(d.date),
        messages: rec?.chat_metrics.message_count ?? 0,
        sessions: cc?.distinct_session_count ?? 0,
        loc: cc?.lines_of_code.added_count ?? 0,
        commits: cc?.commit_count ?? 0,
        prs: cc?.pull_request_count ?? 0,
        cowork: rec?.cowork_metrics.distinct_session_count ?? 0,
        web: rec?.web_search_count ?? 0,
        accepted,
        rejected,
        rate: acceptRate(accepted, rejected),
      }
    })
  }, [email, range])

  const toolBreakdown = useMemo(() => {
    if (!email || !range) return []
    const tools = ['edit_tool', 'multi_edit_tool', 'write_tool', 'notebook_edit_tool'] as const
    return tools.map((t) => {
      let accepted = 0, rejected = 0
      for (const d of range.days) {
        const rec = d.data.find((u) => u.user.email_address === email)
        if (!rec) continue
        accepted += rec.claude_code_metrics.tool_actions[t].accepted_count
        rejected += rec.claude_code_metrics.tool_actions[t].rejected_count
      }
      return { tool: t.replace('_tool', '').replace('_', ' '), Accepted: accepted, Rejected: rejected }
    })
  }, [email, range])

  const totals = useMemo(() => {
    if (!daily.length) return null
    return daily.reduce((acc, d) => ({
      messages: acc.messages + d.messages,
      sessions: acc.sessions + d.sessions,
      loc:      acc.loc + d.loc,
      commits:  acc.commits + d.commits,
      prs:      acc.prs + d.prs,
      cowork:   acc.cowork + d.cowork,
      web:      acc.web + d.web,
      accepted: acc.accepted + d.accepted,
      rejected: acc.rejected + d.rejected,
    }), { messages:0, sessions:0, loc:0, commits:0, prs:0, cowork:0, web:0, accepted:0, rejected:0 })
  }, [daily])

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={clsx(
          'fixed inset-0 bg-ink-900/20 backdrop-blur-[2px] transition-opacity z-30',
          email ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      />

      {/* Slide-in panel */}
      <aside
        className={clsx(
          'fixed right-0 top-0 bottom-0 w-[560px] max-w-[90vw] bg-paper border-l border-ink-100 shadow-2xl z-40 transition-transform duration-200 overflow-y-auto',
          email ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {email && (
          <div className="p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">
                  {t('detail.title')}
                </div>
                <h2 className="text-xl font-semibold text-ink-800 mt-0.5">{maskEmail(email)}</h2>
                {range && (
                  <div className="text-[11px] text-ink-400 mt-1">
                    {fmtDate(range.range.starting_date)} – {fmtDate(range.range.ending_date)}
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                className="rounded-full border border-ink-200 bg-white w-7 h-7 flex items-center justify-center text-ink-500 hover:bg-paper-muted"
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            {loading && <div className="skeleton h-32 rounded-xl" />}
            {err && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2 text-sm">
                {err}
              </div>
            )}

            {!loading && totals && (
              <>
                {/* Aggregate tiles */}
                <div className="grid grid-cols-4 gap-2 text-sm">
                  <Tile label={t('detail.chat')}     value={fmtNum(totals.messages)} />
                  <Tile label={t('detail.sessions')} value={fmtNum(totals.sessions)} />
                  <Tile label={t('detail.loc')}      value={fmtCompact(totals.loc)} accent />
                  <Tile label={t('detail.commits')}  value={`${fmtNum(totals.commits)}`} hint={`/ ${fmtNum(totals.prs)} PR`} />
                  <Tile label={t('detail.cowork')}    value={fmtNum(totals.cowork)} />
                  <Tile label={t('detail.web_search')} value={fmtNum(totals.web)} />
                  <Tile label={t('users.col.accept')} value={fmtPct(acceptRate(totals.accepted, totals.rejected))} />
                  <Tile label="Total Tool Ops" value={fmtNum(totals.accepted + totals.rejected)} />
                </div>

                {/* 7-day trend */}
                <div className="rounded-xl border border-ink-100 bg-white p-4">
                  <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">
                    {t('detail.7day_trend')}
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={daily} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="2 4" />
                      <XAxis dataKey="date" fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="loc" stroke="#D97757" strokeWidth={2} name="LOC" dot={{ r: 2 }} />
                      <Line type="monotone" dataKey="sessions" stroke="#1F1E1D" strokeWidth={1.5} name="Sessions" dot={false} />
                      <Line type="monotone" dataKey="messages" stroke="#8A8474" strokeWidth={1.5} name="Messages" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Tool breakdown */}
                <div className="rounded-xl border border-ink-100 bg-white p-4">
                  <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">
                    {t('detail.tool_breakdown')}
                  </div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={toolBreakdown} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="2 4" />
                      <XAxis dataKey="tool" fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Accepted" stackId="a" fill="#D97757" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Rejected" stackId="a" fill="#EDEBE4" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Daily table */}
                <div className="rounded-xl border border-ink-100 bg-white overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-paper-muted/60 text-ink-500">
                      <tr>
                        <th className="text-left px-3 py-2 uppercase tracking-wider">Date</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">Sess</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">LOC</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">Commits</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">Accept</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daily.map((d) => (
                        <tr key={d.date} className="border-t border-ink-100">
                          <td className="px-3 py-1.5 text-ink-700">{d.date}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(d.sessions)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-claude-600">{fmtNum(d.loc)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(d.commits)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtPct(d.rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  )
}

function Tile({ label, value, hint, accent }: { label: string; value: React.ReactNode; hint?: string; accent?: boolean }) {
  return (
    <div className={clsx('rounded-lg border px-2 py-1.5', accent ? 'border-claude-200 bg-claude-50/40' : 'border-ink-100 bg-white')}>
      <div className="text-[10px] uppercase tracking-wider text-ink-400 font-medium truncate">{label}</div>
      <div className="text-[15px] font-semibold text-ink-800 tabular-nums leading-none mt-1">{value}</div>
      {hint && <div className="text-[10px] text-ink-400 mt-0.5">{hint}</div>}
    </div>
  )
}
