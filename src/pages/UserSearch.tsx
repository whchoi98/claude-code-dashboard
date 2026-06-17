import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { useFetch } from '../lib/api'
import { useGroupScope } from '../lib/useGroupScope'
import { useI18n, useT } from '../lib/i18n'
import { fmtCompact, fmtNum, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

// ─── Types ──────────────────────────────────────────────────────────────────
type CsvRow = {
  user_email: string
  account_uuid: string
  product: string
  model: string
  total_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_net_spend_usd: number
  total_gross_spend_usd: number
}
type CsvResp = {
  source: string
  file: string | null
  period: { starting_date: string; ending_date: string } | null
  rows: CsvRow[]
  totals: { distinct_users: number }
}
type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { days: DayEntry[] }

type RangePreset = 'all' | '30d' | '14d' | '7d'
type Tab = 'overview' | 'model'

// ─── Helpers ────────────────────────────────────────────────────────────────
const shortModel = (m: string) =>
  m.replace(/^claude_/i, '').replace(/_v\d+:\d+$/, '').replace(/_\d{8}$/, '').replace(/_/g, ' ').replace(/-/g, ' ')

const FALLBACK = ['#D97757', '#1F1E1D', '#8A8474', '#B75E40', '#D7D3C7', '#E69F7F', '#4CA371', '#CC7722']

function todayUtc(offset = 0) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

// Day buckets for activity heatmap intensity (sessions per day)
function activityLevel(sessions: number): 0 | 1 | 2 | 3 | 4 {
  if (sessions <= 0) return 0
  if (sessions <= 2) return 1
  if (sessions <= 5) return 2
  if (sessions <= 10) return 3
  return 4
}
const HEAT_COLORS = ['bg-ink-100', 'bg-claude-100', 'bg-claude-200', 'bg-claude-400', 'bg-claude-600']

const DOW_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_LABELS_KO = ['일', '월', '화', '수', '목', '금', '토']

// ─── Page ───────────────────────────────────────────────────────────────────
export function UserSearch() {
  const t = useT()
  const { locale } = useI18n()
  const dowLabels = locale === 'ko' ? DOW_LABELS_KO : DOW_LABELS_EN

  const [selectedEmail, setSelectedEmail] = useState<string>('')
  const [search, setSearch] = useState('')
  const [rangePreset, setRangePreset] = useState<RangePreset>('7d')
  const [tab, setTab] = useState<Tab>('overview')
  const { inGroup } = useGroupScope()

  const csv = useFetch<CsvResp>('/api/cost/csv')
  const RANGE_END = todayUtc(-3)
  const RANGE_START = '2026-01-01'
  const rangeUrl = `/api/analytics/users/range?starting_date=${RANGE_START}&ending_date=${RANGE_END}`
  const range = useFetch<RangeResp>(rangeUrl)

  // Build candidate user list from CSV
  const allUsers = useMemo(() => {
    if (!csv.data) return [] as string[]
    return [...new Set(csv.data.rows.map((r) => r.user_email))].filter((e) => inGroup(e)).sort()
  }, [csv.data, inGroup])

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allUsers.filter((u) => u.toLowerCase().includes(q)) : allUsers
  }, [allUsers, search])

  // Auto-pick the first user once data lands, so the page isn't empty on first visit
  const activeEmail = selectedEmail || allUsers[0] || ''

  // Effective date window for the selected preset
  const effectiveRange = useMemo(() => {
    if (rangePreset === 'all') {
      return { start: csv.data?.period?.starting_date ?? RANGE_START, end: RANGE_END, days: -1 }
    }
    const days = rangePreset === '30d' ? 30 : rangePreset === '14d' ? 14 : 7
    const start = new Date(`${RANGE_END}T00:00:00Z`)
    start.setUTCDate(start.getUTCDate() - days + 1)
    return { start: start.toISOString().slice(0, 10), end: RANGE_END, days }
  }, [rangePreset, csv.data, RANGE_END])

  if (csv.loading || range.loading) return <LoadingState />
  if (csv.error) return <ErrorState error={csv.error} />
  if (allUsers.length === 0) {
    return (
      <div>
        <PageHeader title={t('user_search.title')} subtitle={t('user_search.subtitle')} />
        <EmptyState title={t('user_search.empty.no_users')} hint={t('user_search.empty.hint')} />
      </div>
    )
  }

  // ── Per-selected-user data ────────────────────────────────────────────────
  const userCsvRows = csv.data!.rows.filter((r) => r.user_email === activeEmail)
  const userDays = (range.data?.days ?? [])
    .filter((d) => d.source !== 'mock')
    .map((d) => ({
      date: d.date,
      sessions: d.data.find((r) => r.user?.email_address === activeEmail)?.claude_code_metrics?.core_metrics?.distinct_session_count ?? 0,
      messages: d.data.find((r) => r.user?.email_address === activeEmail)?.chat_metrics?.message_count ?? 0,
    }))

  const inWindow = userDays.filter((d) => d.date >= effectiveRange.start && d.date <= effectiveRange.end)
  const csvSessionsTotal = userDays.filter((d) => d.date >= (csv.data!.period?.starting_date ?? RANGE_START))
                                    .reduce((s, d) => s + d.sessions, 0)
  const sessionsInWindow = inWindow.reduce((s, d) => s + d.sessions, 0)
  const messagesInWindow = inWindow.reduce((s, d) => s + d.messages, 0)
  // Activity-weighted scaling for tokens / spend
  const ratio = csvSessionsTotal > 0 ? Math.min(1, sessionsInWindow / csvSessionsTotal) : 0
  const csvTotalTokens = userCsvRows.reduce((s, r) => s + r.total_prompt_tokens + r.total_completion_tokens, 0)
  const csvTotalSpend = userCsvRows.reduce((s, r) => s + r.total_net_spend_usd, 0)
  const csvTotalRequests = userCsvRows.reduce((s, r) => s + r.total_requests, 0)
  const tokensInWindow = csvTotalTokens * ratio
  const spendInWindow = csvTotalSpend * ratio
  const requestsInWindow = csvTotalRequests * ratio

  // Active days + streaks
  const activeDates = inWindow
    .filter((d) => d.sessions > 0 || d.messages > 0)
    .map((d) => d.date)
    .sort()

  const todayStr = todayUtc(0)
  // Current streak: walk backward from the most-recent active day, accept up to a 4-day grace
  // (Analytics 3-day buffer + today itself) for "today's streak still alive".
  let currentStreak = 0
  if (activeDates.length > 0) {
    const last = activeDates[activeDates.length - 1]
    const lastDate = new Date(`${last}T00:00:00Z`)
    const today = new Date(`${todayStr}T00:00:00Z`)
    const gapDays = Math.round((today.getTime() - lastDate.getTime()) / 86400000)
    if (gapDays <= 4) {
      currentStreak = 1
      for (let i = activeDates.length - 2; i >= 0; i--) {
        const cur = new Date(`${activeDates[i]}T00:00:00Z`)
        const prev = new Date(`${activeDates[i + 1]}T00:00:00Z`)
        if (prev.getTime() - cur.getTime() === 86400000) currentStreak++
        else break
      }
    }
  }
  // Longest streak
  let longestStreak = 0, run = 0
  let prevDate: Date | null = null
  for (const dStr of activeDates) {
    const d = new Date(`${dStr}T00:00:00Z`)
    run = (prevDate && d.getTime() - prevDate.getTime() === 86400000) ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
    prevDate = d
  }

  // Most active day-of-week
  const dowSessions = [0, 0, 0, 0, 0, 0, 0]
  for (const d of inWindow) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay()
    dowSessions[dow] += d.sessions
  }
  const peakDow = dowSessions.indexOf(Math.max(...dowSessions))
  const peakDowLabel = inWindow.length > 0 && dowSessions[peakDow] > 0 ? dowLabels[peakDow] : '—'

  // Favorite model — by total tokens across the user's CSV rows
  const modelTotals = new Map<string, { tokens: number; input: number; output: number; spend: number }>()
  for (const r of userCsvRows) {
    const key = r.model
    const cur = modelTotals.get(key) ?? { tokens: 0, input: 0, output: 0, spend: 0 }
    cur.input += r.total_prompt_tokens
    cur.output += r.total_completion_tokens
    cur.tokens += r.total_prompt_tokens + r.total_completion_tokens
    cur.spend += r.total_net_spend_usd
    modelTotals.set(key, cur)
  }
  const modelRowsSorted = [...modelTotals.entries()]
    .map(([model, v]) => ({ model, short: shortModel(model), ...v }))
    .sort((a, b) => b.tokens - a.tokens)
  const favoriteModelShort = modelRowsSorted[0]?.short ?? '—'
  const totalTokensAllModels = modelRowsSorted.reduce((s, r) => s + r.tokens, 0)

  // Heatmap data: build a 7-rows × N-cols grid for the *entire* known window
  // (we always show the same heatmap shape for orientation; range-preset
  // affects KPIs above, not the heatmap span). Sunday is the top row.
  const heatmapStart = csv.data!.period?.starting_date ?? RANGE_START
  const heatmapEnd = RANGE_END
  const heatmapDays: { date: string; sessions: number }[] = []
  {
    const cursor = new Date(`${heatmapStart}T00:00:00Z`)
    const end = new Date(`${heatmapEnd}T00:00:00Z`)
    const lookup = new Map(userDays.map((d) => [d.date, d.sessions]))
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10)
      heatmapDays.push({ date: iso, sessions: lookup.get(iso) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  // Pad the front so the first cell aligns with the correct day-of-week
  const firstDow = heatmapDays.length > 0 ? new Date(`${heatmapDays[0].date}T00:00:00Z`).getUTCDay() : 0
  const padded: ({ date: string; sessions: number } | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...heatmapDays,
  ]
  // Group into columns of 7 (Sun..Sat)
  const heatmapCols: (typeof padded)[] = []
  for (let i = 0; i < padded.length; i += 7) heatmapCols.push(padded.slice(i, i + 7))

  // Daily token bar data for Model tab (token estimate = day's session share × csv total tokens)
  const dailyBars = inWindow.map((d) => {
    const dayShare = csvSessionsTotal > 0 ? d.sessions / csvSessionsTotal : 0
    return { date: d.date.slice(5), tokens: csvTotalTokens * dayShare }
  })

  return (
    <div>
      <PageHeader
        title={t('user_search.title')}
        subtitle={t('user_search.subtitle')}
        source="csv"
        reason={`CSV · ${csv.data!.file ?? ''}`}
      />
      <div className="p-8 space-y-6">
        {/* ── User selector + range toggle ───────────────────────────── */}
        <div className="rounded-xl border border-ink-100 bg-white p-5">
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('user_search.placeholder')}
              className="flex-1 min-w-[240px] rounded-lg border border-ink-200 px-3 py-2 text-sm bg-paper-muted/40 focus:outline-none focus:border-claude-400"
            />
            <select
              value={activeEmail}
              onChange={(e) => setSelectedEmail(e.target.value)}
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm bg-white"
            >
              {filteredUsers.map((u) => (
                <option key={u} value={u}>{maskEmail(u)} ({u.split('@')[1]})</option>
              ))}
            </select>
            <div className="ml-auto inline-flex rounded-lg border border-ink-200 overflow-hidden text-[12px]">
              {(['all', '30d', '14d', '7d'] as RangePreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setRangePreset(p)}
                  className={clsx(
                    'px-3 py-1.5 transition-colors',
                    p === rangePreset
                      ? 'bg-ink-800 text-paper'
                      : 'bg-white text-ink-600 hover:bg-paper-muted/40 border-l border-ink-100 first:border-l-0',
                  )}
                >
                  {p === 'all' ? t('user_search.range.all') : p}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 text-[11px] text-ink-500">
            {t('user_search.active_range', { start: effectiveRange.start, end: effectiveRange.end })}
          </div>
        </div>

        {/* ── Tab toggle ─────────────────────────────────────────────── */}
        <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden text-sm">
          {(['overview', 'model'] as Tab[]).map((tk) => (
            <button
              key={tk}
              onClick={() => setTab(tk)}
              className={clsx(
                'px-5 py-2 transition-colors',
                tk === tab
                  ? 'bg-ink-800 text-paper'
                  : 'bg-white text-ink-600 hover:bg-paper-muted/40 border-l border-ink-100 first:border-l-0',
              )}
            >
              {t(`user_search.tab.${tk}` as any)}
            </button>
          ))}
        </div>

        {/* ── Overview tab ───────────────────────────────────────────── */}
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <KpiCard accent label={t('user_search.kpi.sessions')}     value={fmtNum(sessionsInWindow)} hint={t('user_search.kpi.sessions.hint')} />
              <KpiCard       label={t('user_search.kpi.messages')}     value={fmtNum(messagesInWindow)} hint={t('user_search.kpi.messages.hint')} />
              <KpiCard       label={t('user_search.kpi.total_tokens')} value={fmtCompact(tokensInWindow)} hint={t('user_search.kpi.total_tokens.hint')} />
              <KpiCard       label={t('user_search.kpi.active_days')}  value={fmtNum(activeDates.length)} hint={t('user_search.kpi.active_days.hint')} />
            </div>
            <div className="grid grid-cols-4 gap-4">
              <KpiCard label={t('user_search.kpi.current_streak')}    value={`${currentStreak}${t('user_search.kpi.streak_unit')}`} hint={t('user_search.kpi.current_streak.hint')} />
              <KpiCard label={t('user_search.kpi.longest_streak')}    value={`${longestStreak}${t('user_search.kpi.streak_unit')}`} hint={t('user_search.kpi.longest_streak.hint')} />
              <KpiCard label={t('user_search.kpi.peak_dow')}          value={peakDowLabel} hint={t('user_search.kpi.peak_dow.hint')} />
              <KpiCard label={t('user_search.kpi.favorite_model')}    value={favoriteModelShort} hint={t('user_search.kpi.favorite_model.hint')} />
            </div>

            <ChartCard
              title={t('user_search.heatmap.title')}
              subtitle={t('user_search.heatmap.subtitle', { start: heatmapStart, end: heatmapEnd })}
            >
              <div className="px-4 pb-3 flex gap-3">
                {/* Day-of-week labels */}
                <div className="flex flex-col gap-[2px] pt-[1px] text-[10px] text-ink-400">
                  {dowLabels.map((d, i) => (
                    <div key={d} className="h-3 leading-3">{i % 2 === 1 ? d : ''}</div>
                  ))}
                </div>
                {/* Cells */}
                <div className="flex gap-[2px] overflow-x-auto">
                  {heatmapCols.map((col, ci) => (
                    <div key={ci} className="flex flex-col gap-[2px]">
                      {Array.from({ length: 7 }, (_, ri) => {
                        const cell = col[ri]
                        if (!cell) return <div key={ri} className="w-3 h-3" />
                        const lvl = activityLevel(cell.sessions)
                        return (
                          <div
                            key={ri}
                            className={clsx('w-3 h-3 rounded-sm', HEAT_COLORS[lvl])}
                            title={`${cell.date} · ${cell.sessions} sessions`}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-4 pb-3 flex items-center gap-2 text-[10px] text-ink-400">
                <span>{t('user_search.heatmap.legend.less')}</span>
                {HEAT_COLORS.map((c, i) => <div key={i} className={clsx('w-3 h-3 rounded-sm', c)} />)}
                <span>{t('user_search.heatmap.legend.more')}</span>
              </div>
            </ChartCard>

            {/* ── Cost summary card (CSV-derived, activity-scaled) ──── */}
            <ChartCard
              title={t('user_search.cost.title')}
              subtitle={t('user_search.cost.subtitle', { start: effectiveRange.start, end: effectiveRange.end })}
            >
              <div className="grid grid-cols-4 gap-4 p-4">
                <KpiCard accent label={t('user_search.cost.spend')}    value={`$${spendInWindow.toFixed(2)}`} hint={`× ${(ratio * 100).toFixed(1)}%`} />
                <KpiCard       label={t('user_search.cost.requests')} value={fmtNum(Math.round(requestsInWindow))} hint={t('user_search.cost.requests.hint')} />
                <KpiCard       label={t('user_search.cost.csv_total_spend')} value={`$${csvTotalSpend.toFixed(2)}`} hint={t('user_search.cost.csv_total_hint')} />
                <KpiCard       label={t('user_search.cost.models_used')}    value={fmtNum(modelRowsSorted.length)} hint={t('user_search.cost.models_used.hint')} />
              </div>
            </ChartCard>
          </>
        )}

        {/* ── Model tab ──────────────────────────────────────────────── */}
        {tab === 'model' && (
          <>
            <ChartCard
              title={t('user_search.model.daily_tokens')}
              subtitle={t('user_search.model.daily_tokens.sub', { days: inWindow.length })}
            >
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dailyBars} margin={{ top: 12, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={(v: number) => fmtCompact(v)} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: number) => fmtCompact(v)} />
                  <Bar dataKey="tokens" fill="#D97757" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title={t('user_search.model.breakdown')}
              subtitle={t('user_search.model.breakdown.sub')}
            >
              <div className="p-4 space-y-2">
                {modelRowsSorted.map((m, i) => {
                  const share = totalTokensAllModels > 0 ? m.tokens / totalTokensAllModels : 0
                  return (
                    <div key={m.model} className="flex items-center gap-3 text-[12px]">
                      <div
                        className="w-3 h-3 rounded-sm shrink-0"
                        style={{ background: FALLBACK[i % FALLBACK.length] }}
                      />
                      <div className="flex-1 font-medium text-ink-700">{m.short}</div>
                      <div className="text-ink-500 tabular-nums">
                        {fmtCompact(m.input)} {t('user_search.model.in')} · {fmtCompact(m.output)} {t('user_search.model.out')}
                      </div>
                      <div className="w-16 text-right tabular-nums text-ink-700 font-medium">
                        {(share * 100).toFixed(1)}%
                      </div>
                    </div>
                  )
                })}
              </div>
            </ChartCard>
          </>
        )}
      </div>
    </div>
  )
}
