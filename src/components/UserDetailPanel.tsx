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
type ProductRow = { product: string; spend_usd: number; requests: number }
type ModelRow = { model: string; spend_usd: number; requests: number }
type CostUsersResp = {
  period?: { starting_date: string; ending_date: string }
  users: { email: string; net_spend_usd: number; requests: number; by_product?: ProductRow[]; by_model?: ModelRow[] }[]
}
// /api/cost/user-tokens (user_usage_report) — per-user token tiers; the
// server computes cache_hit_rate as cache_read ÷ total input, the same
// convention as the Cost page's org-wide cache-hit KPI.
type UserTokensResp = {
  users: {
    email: string
    input_tokens: number
    output_tokens: number
    requests: number
    uncached_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
    cache_hit_rate?: number | null
  }[]
}
type SkillRow = {
  skill_name: string
  skill_display_name?: string
  invocation_count?: number
  attributed_list_price?: number | string
  // pre-2026-07 archive schema (S3 rows) — per-surface "sessions using the
  // skill" counts, used as the uses fallback when invocation_count is absent
  chat_metrics?: { distinct_conversation_skill_used_count?: number }
  claude_code_metrics?: { distinct_session_skill_used_count?: number }
  cowork_metrics?: { distinct_session_skill_used_count?: number }
}
type SkillsRangeResp = { days: { date: string; source: string; data: SkillRow[] }[] }

interface Props {
  email: string | null
  onClose: () => void
  /** Page-selected window (inclusive dates). Drives the drill-down period,
   *  the per-product spend card, and its previous-period comparison. */
  range?: { startingDate: string; endingDate: string; days: number }
}

const shortModel = (m: string) =>
  m.replace(/^claude[-_]/i, '').replace(/_v\d+:\d+$/, '').replace(/[-_]\d{8}$/, '').replace(/[-_]/g, ' ')
const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const fmtUsd = (v: number) =>
  `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 })}`

// The cost/skills responses are org-wide (email-independent), so cache them
// per URL for the session — re-opening the panel for another user must not
// re-fire org-wide user_cost_report pagination chains (60 rpm org budget).
const panelFetchCache = new Map<string, Promise<any>>()
const cachedGet = (url: string) => {
  let p = panelFetchCache.get(url)
  if (!p) {
    p = fetch(url).then(async (r) => {
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || r.statusText)
      return body
    })
    p.catch(() => panelFetchCache.delete(url))  // don't cache failures
    panelFetchCache.set(url, p)
  }
  return p
}

export function UserDetailPanel({ email, onClose, range: pageRange }: Props) {
  const t = useT()
  const [range, setRange] = useState<RangeResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [costCur, setCostCur] = useState<CostUsersResp | null>(null)
  // 'failed' ≠ null: a failed/skipped previous-window fetch must render the
  // delta column as "—", not as every product being "new".
  const [costPrev, setCostPrev] = useState<CostUsersResp | 'failed' | null>(null)
  const [skills, setSkills] = useState<SkillsRangeResp | null>(null)
  const [costModels, setCostModels] = useState<CostUsersResp | null>(null)
  const [userTokens, setUserTokens] = useState<UserTokensResp | null>(null)
  const [costLoading, setCostLoading] = useState(false)

  useEffect(() => {
    if (!email) return
    let aborted = false
    setLoading(true); setErr(null)
    // Follow the page-selected window when provided (server still clamps the
    // engagement family to today−3 / last 31 days); no-param fallback keeps
    // the old default window.
    const q = pageRange ? `?starting_date=${pageRange.startingDate}&ending_date=${pageRange.endingDate}` : ''
    fetch(`/api/analytics/users/range${q}`)
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || r.statusText)
        return body
      })
      .then((body) => { if (!aborted) setRange(body) })
      .catch((e) => { if (!aborted) setErr(String(e.message || e)) })
      .finally(() => { if (!aborted) setLoading(false) })
    return () => { aborted = true }
  }, [email, pageRange?.startingDate, pageRange?.endingDate])

  // Per-product spend (current + equal-length previous window) and org-wide
  // skill usage. Fetched independently of the engagement data — each section
  // simply hides if its fetch fails (allSettled), so a cost-family outage
  // can't blank the whole panel.
  useEffect(() => {
    if (!email || !pageRange) return
    // Reset so a window/user switch never shows the previous window's cards
    // under the new header while the refetch is in flight.
    setCostCur(null); setCostPrev(null); setSkills(null); setCostModels(null); setUserTokens(null)
    // The upstream cost family caps spans at 31 days — a longer custom window
    // would 400 on both calls; hide the card instead (the Cost page/CSV covers
    // >31-day analysis). Skills range is server-clamped, so it still runs.
    const costOk = pageRange.days <= 31
    let aborted = false
    setCostLoading(true)
    const prevEnd = addDaysIso(pageRange.startingDate, -1)
    const prevStart = addDaysIso(pageRange.startingDate, -pageRange.days)
    Promise.allSettled([
      costOk ? cachedGet(`/api/cost/users?by=product&starting_date=${pageRange.startingDate}&ending_date=${pageRange.endingDate}`) : Promise.reject(new Error('window > 31d')),
      costOk ? cachedGet(`/api/cost/users?by=product&starting_date=${prevStart}&ending_date=${prevEnd}`) : Promise.reject(new Error('window > 31d')),
      cachedGet(`/api/analytics/skills/range?starting_date=${pageRange.startingDate}&ending_date=${pageRange.endingDate}`),
      costOk ? cachedGet(`/api/cost/users?by=model&starting_date=${pageRange.startingDate}&ending_date=${pageRange.endingDate}`) : Promise.reject(new Error('window > 31d')),
      costOk ? cachedGet(`/api/cost/user-tokens?starting_date=${pageRange.startingDate}&ending_date=${pageRange.endingDate}`) : Promise.reject(new Error('window > 31d')),
    ]).then(([cur, prev, sk, models, tokens]) => {
      if (aborted) return
      setCostCur(cur.status === 'fulfilled' ? cur.value : null)
      setCostPrev(prev.status === 'fulfilled' ? prev.value : 'failed')
      setSkills(sk.status === 'fulfilled' ? sk.value : null)
      setCostModels(models.status === 'fulfilled' ? models.value : null)
      setUserTokens(tokens.status === 'fulfilled' ? tokens.value : null)
      setCostLoading(false)
    })
    return () => { aborted = true }
  }, [email, pageRange?.startingDate, pageRange?.endingDate, pageRange?.days])

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

  // Per-product spend rows for the selected user — current window vs the
  // equal-length previous window (share = of the user's current-period total).
  // hasPrev distinguishes "previous window fetched OK" (deltas + 'new' are
  // meaningful) from "comparison unavailable" (fetch failed/skipped → '—').
  const hasPrev = costPrev !== null && costPrev !== 'failed'
  const productRows = useMemo(() => {
    if (!email) return []
    const cur = costCur?.users?.find((u) => u.email === email)
    if (!cur?.by_product?.length) return []
    const prev = hasPrev ? (costPrev as CostUsersResp).users?.find((u) => u.email === email) : undefined
    const prevBy = new Map((prev?.by_product ?? []).map((p) => [p.product, p.spend_usd]))
    const total = cur.net_spend_usd || cur.by_product.reduce((s, p) => s + p.spend_usd, 0)
    return cur.by_product.map((p) => {
      const prevSpend = prevBy.get(p.product) ?? 0
      return {
        product: p.product.replace(/_/g, ' '),
        spend: p.spend_usd,
        share: total > 0 ? p.spend_usd / total : 0,
        delta: prevSpend > 0 ? (p.spend_usd - prevSpend) / prevSpend : null,
      }
    })
  }, [email, costCur, costPrev, hasPrev])

  const userSpendTotals = useMemo(() => {
    if (!email) return null
    const cur = costCur?.users?.find((u) => u.email === email)
    if (!cur) return null
    const prev = hasPrev ? (costPrev as CostUsersResp).users?.find((u) => u.email === email) : undefined
    const delta = prev && prev.net_spend_usd > 0 ? (cur.net_spend_usd - prev.net_spend_usd) / prev.net_spend_usd : null
    return { spend: cur.net_spend_usd, delta }
  }, [email, costCur, costPrev, hasPrev])

  // Per-model spend for the selected user over the page window (live
  // user_cost_report × model — same source as the Cost chargeback chart).
  const modelRows = useMemo(() => {
    if (!email) return []
    const cur = costModels?.users?.find((u) => u.email === email)
    if (!cur?.by_model?.length) return []
    const total = cur.net_spend_usd || cur.by_model.reduce((s, m) => s + m.spend_usd, 0)
    return cur.by_model.map((m) => ({
      model: m.model,
      short: shortModel(m.model),
      spend: m.spend_usd,
      requests: m.requests,
      share: total > 0 ? m.spend_usd / total : 0,
    }))
  }, [email, costModels])

  // Per-user cache efficiency over the page window (user_usage_report token
  // tiers). Hidden when the user has no input tokens in the window — a
  // hit-rate over zero input is meaningless, not zero.
  const cacheStats = useMemo(() => {
    if (!email) return null
    const u = userTokens?.users?.find((x) => x.email === email)
    if (!u || !(u.input_tokens > 0)) return null
    return {
      hitRate: u.cache_hit_rate ?? null,
      cacheRead: u.cache_read_tokens ?? 0,
      cacheCreation: u.cache_creation_tokens ?? 0,
      uncached: u.uncached_tokens ?? 0,
      input: u.input_tokens,
    }
  }, [email, userTokens])

  // Org-wide per-skill uses + attributed cost over the window — the Analytics
  // API has no user × skill dimension (see the card caveat). Amounts follow
  // the cost-family convention: decimal-string fractional CENTS → /100.
  const orgSkills = useMemo(() => {
    if (!skills?.days?.length) return []
    const bySkill = new Map<string, { key: string; name: string; uses: number; cost: number }>()
    for (const d of skills.days) {
      for (const r of d.data ?? []) {
        if (!r.skill_name) continue
        const s = bySkill.get(r.skill_name) ?? { key: r.skill_name, name: r.skill_display_name || r.skill_name, uses: 0, cost: 0 }
        // invocation_count shipped upstream 2026-07; S3-archived days carry
        // the older schema, so fall back to the per-surface "sessions using
        // the skill" counts there (labeled Uses either way — see caveat).
        const invocations = Number(r.invocation_count ?? 0)
        s.uses += invocations > 0 ? invocations
          : (r.chat_metrics?.distinct_conversation_skill_used_count ?? 0) +
            (r.claude_code_metrics?.distinct_session_skill_used_count ?? 0) +
            (r.cowork_metrics?.distinct_session_skill_used_count ?? 0)
        const cents = parseFloat(String(r.attributed_list_price ?? ''))
        if (Number.isFinite(cents)) s.cost += cents / 100
        bySkill.set(r.skill_name, s)
      }
    }
    return [...bySkill.values()].filter((s) => s.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, 5)
  }, [skills])

  // The selected user's skill-use counts by surface — the only per-user skill
  // signal the API provides (counts, never skill names). Chat is omitted: it
  // exposes only a per-day DISTINCT count, which cannot be meaningfully summed.
  const userSkillUses = useMemo(() => {
    if (!email || !range) return null
    let cowork = 0, office = 0, science = 0
    for (const d of range.days) {
      const rec = d.data.find((u) => u.user.email_address === email) as any
      if (!rec) continue
      cowork += rec.cowork_metrics?.skills_used_count ?? 0
      for (const app of ['excel', 'powerpoint', 'word', 'outlook']) {
        office += rec.office_metrics?.[app]?.skills_used_count ?? 0
      }
      science += rec.science_metrics?.skills_used_count ?? 0
    }
    return { cowork, office, science, total: cowork + office + science }
  }, [email, range])

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
                  <Tile label={t('detail.tool_ops')} value={fmtNum(totals.accepted + totals.rejected)} />
                </div>

                {/* Fixed-height skeleton while the cost/skills fetches are in
                    flight, so the cards don't pop in and shift the layout. */}
                {costLoading && <div className="skeleton h-40 rounded-xl" />}

                {/* Spend by product — page window vs the previous equal window */}
                {!costLoading && productRows.length > 0 && userSpendTotals && (
                  <div className="rounded-xl border border-ink-100 bg-white p-4">
                    <div className="flex items-baseline justify-between mb-1">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('detail.products')}</div>
                      {pageRange && (
                        <div className="text-[11px] text-ink-400">
                          {fmtDate(pageRange.startingDate)} – {fmtDate(pageRange.endingDate)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className="text-lg font-semibold text-ink-800 tabular-nums">{fmtUsd(userSpendTotals.spend)}</span>
                      {userSpendTotals.delta != null && (
                        <span className={clsx(
                          'text-[11px] font-medium tabular-nums',
                          userSpendTotals.delta >= 0 ? 'text-claude-700' : 'text-emerald-700',
                        )}>
                          {userSpendTotals.delta >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(userSpendTotals.delta))} {t('detail.products.prev_delta', { days: pageRange?.days ?? 0 })}
                        </span>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(96, productRows.length * 30 + 16)}>
                      <BarChart data={productRows} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="product" width={112} tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: number) => fmtUsd(v)} />
                        <Bar dataKey="spend" fill="#D97757" radius={[0, 3, 3, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-1 space-y-0.5">
                      {productRows.map((p) => (
                        <div key={p.product} className="flex items-center justify-between text-[11px] text-ink-500">
                          <span>{p.product}</span>
                          <span className="tabular-nums">
                            {fmtUsd(p.spend)} · {fmtPct(p.share)}
                            {' · '}
                            {!hasPrev ? '—' : p.delta == null ? t('detail.products.new') : `${p.delta >= 0 ? '+' : '−'}${fmtPct(Math.abs(p.delta))}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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

                {/* Spend by model — same page window, live user_cost_report */}
                {!costLoading && modelRows.length > 0 && (
                  <div className="rounded-xl border border-ink-100 bg-white p-4">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('detail.models')}</div>
                      {pageRange && (
                        <div className="text-[11px] text-ink-400">
                          {fmtDate(pageRange.startingDate)} – {fmtDate(pageRange.endingDate)}
                        </div>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(96, modelRows.length * 30 + 16)}>
                      <BarChart data={modelRows} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="short" width={112} tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v: number) => fmtUsd(v)} />
                        <Bar dataKey="spend" fill="#1F1E1D" radius={[0, 3, 3, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-1 space-y-0.5">
                      {modelRows.map((m) => (
                        <div key={m.model} className="flex items-center justify-between text-[11px] text-ink-500">
                          <span>{m.short}</span>
                          <span className="tabular-nums">{fmtUsd(m.spend)} · {fmtPct(m.share)} · {fmtNum(m.requests)} {t('user_search.model.req')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Cache efficiency — per-user token tiers (user_usage_report) */}
                {!costLoading && cacheStats && (
                  <div className="rounded-xl border border-ink-100 bg-white p-4">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('detail.cache.title')}</div>
                      {pageRange && (
                        <div className="text-[11px] text-ink-400">
                          {fmtDate(pageRange.startingDate)} – {fmtDate(pageRange.endingDate)}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <Tile label={t('detail.cache.hit_rate')} value={cacheStats.hitRate != null ? fmtPct(cacheStats.hitRate) : '—'} accent />
                      <Tile label={t('detail.cache.read')}     value={fmtCompact(cacheStats.cacheRead)} />
                      <Tile label={t('detail.cache.creation')} value={fmtCompact(cacheStats.cacheCreation)} />
                      <Tile label={t('detail.cache.uncached')} value={fmtCompact(cacheStats.uncached)} />
                    </div>
                    <div className="mt-2 text-[10px] text-ink-400">{t('detail.cache.hint')}</div>
                  </div>
                )}

                {/* Skills — user surface counts + org-wide per-skill cost/uses */}
                {!costLoading && (orgSkills.length > 0 || (userSkillUses?.total ?? 0) > 0) && (
                  <div className="rounded-xl border border-ink-100 bg-white p-4">
                    <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">
                      {t('detail.skills.title')}
                    </div>
                    {userSkillUses && userSkillUses.total > 0 && (
                      <>
                        <div className="text-[10px] text-ink-400 mb-1">{t('detail.skills.user')}</div>
                        <div className="grid grid-cols-3 gap-2 text-sm mb-3">
                          <Tile label={t('detail.skills.cowork')} value={fmtNum(userSkillUses.cowork)} />
                          <Tile label={t('detail.skills.office')} value={fmtNum(userSkillUses.office)} />
                          <Tile label={t('detail.skills.science')} value={fmtNum(userSkillUses.science)} />
                        </div>
                      </>
                    )}
                    {orgSkills.length > 0 && (
                      <>
                        <div className="flex items-baseline justify-between mb-1">
                          <div className="text-[10px] uppercase tracking-wider text-ink-400">{t('detail.skills.org')}</div>
                          {/* Effective window from the returned days — the server clamps
                              to today−3 and slices to the last 31 days, so this can be
                              narrower than the page selection. */}
                          {(skills?.days?.length ?? 0) > 0 && (
                            <div className="text-[10px] text-ink-400 tabular-nums">
                              {fmtDate(skills!.days[0].date)} – {fmtDate(skills!.days[skills!.days.length - 1].date)}
                            </div>
                          )}
                        </div>
                        <table className="w-full text-xs">
                          <thead className="text-ink-400">
                            <tr>
                              <th className="text-left py-1 font-medium">{t('detail.skills.col.skill')}</th>
                              <th className="text-right py-1 font-medium">{t('detail.skills.col.uses')}</th>
                              <th className="text-right py-1 font-medium">{t('detail.skills.col.cpu')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orgSkills.map((s) => {
                              const cpu = s.uses > 0 ? s.cost / s.uses : 0
                              return (
                                <tr key={s.key} className="border-t border-ink-100">
                                  <td className="py-1 text-ink-700">{s.name}</td>
                                  <td className="py-1 text-right tabular-nums">{fmtNum(s.uses)}</td>
                                  <td className="py-1 text-right tabular-nums">
                                    {s.cost > 0 ? (cpu >= 0.01 ? fmtUsd(cpu) : `$${cpu.toFixed(4)}`) : '—'}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </>
                    )}
                    <p className="mt-2 text-[10px] text-ink-400">{t('detail.skills.caveat')}</p>
                  </div>
                )}

                {/* Daily table */}
                <div className="rounded-xl border border-ink-100 bg-white overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-paper-muted/60 text-ink-500">
                      <tr>
                        <th className="text-left px-3 py-2 uppercase tracking-wider">{t('detail.col.date')}</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">{t('detail.col.sessions')}</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">{t('detail.col.loc')}</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">{t('detail.col.commits')}</th>
                        <th className="text-right px-3 py-2 uppercase tracking-wider">{t('detail.col.accept')}</th>
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
