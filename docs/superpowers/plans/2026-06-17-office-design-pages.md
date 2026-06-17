# Office + Design Surface Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new pages — `/office` (Excel/PowerPoint/Word/Outlook) and `/design` — surfacing the `office_metrics`/`design_metrics` data, mirroring the shipped Cowork page.

**Architecture:** Two pure frontend pages, each a single `useFetch('/api/analytics/users/range')` + `useMemo` aggregation + KpiCard/ChartCard/useSortable. Empty-state gated on window-total===0 (office is 0 today → empty-state; design has data). No backend changes.

**Tech Stack:** React 18 + TS strict + Recharts. Verify with `npx tsc --noEmit` + `npx vite build` (no frontend test harness).

**Spec:** `docs/superpowers/specs/2026-06-17-office-design-pages-design.md`. Template: the in-repo `src/pages/Cowork.tsx`.

---

## File structure

| File | Change | Task |
|---|---|---|
| `src/pages/Office.tsx` | **create** | 1 |
| `src/lib/i18n.tsx` | `office.*` keys (en+ko) | 1 |
| `src/pages/Design.tsx` | **create** | 2 |
| `src/lib/i18n.tsx` | `design.*` keys (en+ko) | 2 |
| `src/App.tsx` | 2 routes | 3 |
| `src/components/Layout.tsx` | 2 NAV entries | 3 |
| `src/lib/i18n.tsx` | `nav.office`/`nav.design` keys (en+ko) | 3 |
| `package.json`, `CHANGELOG.md` | v1.1.0 | 3 |

**No `npm test`.** Verify with `npx tsc --noEmit` + `npx vite build`. Each page typechecks standalone before being routed (Task 3).

---

## Task 1: Office page (`src/pages/Office.tsx`) + `office.*` i18n keys

**Files:** Create `src/pages/Office.tsx`; Modify `src/lib/i18n.tsx` (en+ko).

- [ ] **Step 1: Add `office.*` keys to `src/lib/i18n.tsx`.** Into the `en` block:

```ts
    // Office
    'office.title': 'Office',
    'office.subtitle': 'Claude usage in Excel / PowerPoint / Word / Outlook over {start} → {end} ({days}d).',
    'office.kpi.active_users': 'Active Office Users',
    'office.kpi.active_users.hint': 'distinct users with ≥1 Office session in window',
    'office.kpi.sessions': 'Office Sessions',
    'office.kpi.messages': 'Office Messages',
    'office.kpi.skills': 'Skills Used',
    'office.byapp.title': 'Usage by App',
    'office.byapp.sub': 'Sessions per Office surface',
    'office.daily.title': 'Daily Office Engagement',
    'office.daily.sub': 'Sessions per app per day',
    'office.top.title': 'Top Office Users',
    'office.top.sub': 'Per-user Office totals over the window',
    'office.top.empty': 'No Office activity in this window',
    'office.empty': 'No Office usage yet',
    'office.empty.hint': 'Excel / PowerPoint / Word / Outlook activity will populate this page as Office adoption grows.',
    'office.surface.excel': 'Excel',
    'office.surface.powerpoint': 'PowerPoint',
    'office.surface.word': 'Word',
    'office.surface.outlook': 'Outlook',
    'office.metric.sessions': 'Sessions',
    'office.metric.messages': 'Messages',
    'office.col.user': 'User',
```

Into the `ko` block:

```ts
    // Office (ko)
    'office.title': 'Office',
    'office.subtitle': '{start} → {end} ({days}일) Excel / PowerPoint / Word / Outlook 내 Claude 사용.',
    'office.kpi.active_users': '활성 Office 사용자',
    'office.kpi.active_users.hint': '기간 내 Office 세션 1회 이상인 distinct 사용자',
    'office.kpi.sessions': 'Office 세션',
    'office.kpi.messages': 'Office 메시지',
    'office.kpi.skills': '사용 스킬',
    'office.byapp.title': '앱별 사용량',
    'office.byapp.sub': 'Office surface별 세션',
    'office.daily.title': '일별 Office 참여량',
    'office.daily.sub': '일별 앱별 세션',
    'office.top.title': 'Top Office 사용자',
    'office.top.sub': '기간 내 사용자별 Office 합계',
    'office.top.empty': '이 기간에 Office 활동 없음',
    'office.empty': '아직 Office 사용 없음',
    'office.empty.hint': 'Office 도입이 늘면 Excel / PowerPoint / Word / Outlook 활동이 이 페이지에 자동으로 표시됩니다.',
    'office.surface.excel': 'Excel',
    'office.surface.powerpoint': 'PowerPoint',
    'office.surface.word': 'Word',
    'office.surface.outlook': 'Outlook',
    'office.metric.sessions': '세션',
    'office.metric.messages': '메시지',
    'office.col.user': '사용자',
```

Match the file's existing indentation; add inside the correct `DICT.en` / `DICT.ko` literals.

- [ ] **Step 2: Create `src/pages/Office.tsx`:**

```tsx
import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtDate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type OfficeRow = { email: string; sessions: number; messages: number }
type Tt = (k: any, p?: any) => string

const SURFACES = ['excel', 'powerpoint', 'word', 'outlook'] as const
const SURFACE_COLOR: Record<(typeof SURFACES)[number], string> = {
  excel: '#D97757', powerpoint: '#DF8663', word: '#8A8474', outlook: '#B75E40',
}

export function Office() {
  const t = useT()
  const { range } = useDateRange('7d')
  const users = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      const row = { date: fmtDate(d.date), excel: 0, powerpoint: 0, word: 0, outlook: 0 }
      for (const r of d.data) for (const s of SURFACES) row[s] += r.office_metrics[s].distinct_session_count
      return row
    })
    const surfaceTotals: Record<(typeof SURFACES)[number], { sessions: number; messages: number }> = {
      excel: { sessions: 0, messages: 0 }, powerpoint: { sessions: 0, messages: 0 },
      word: { sessions: 0, messages: 0 }, outlook: { sessions: 0, messages: 0 },
    }
    const byEmail = new Map<string, OfficeRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0, skillsTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        const email = r.user.email_address
        let userSessions = 0, userMessages = 0
        for (const s of SURFACES) {
          const m = r.office_metrics[s]
          surfaceTotals[s].sessions += m.distinct_session_count
          surfaceTotals[s].messages += m.message_count
          userSessions += m.distinct_session_count
          userMessages += m.message_count
          skillsTotal += m.skills_used_count
        }
        sessionsTotal += userSessions
        messagesTotal += userMessages
        if (userSessions > 0) activeEmails.add(email)
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0 }; byEmail.set(email, cur) }
        cur.sessions += userSessions
        cur.messages += userMessages
      }
    }
    const surfaceBars = SURFACES.map((s) => ({ surface: s, sessions: surfaceTotals[s].sessions }))
    return {
      daily, surfaceBars,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal, skillsTotal,
    }
  }, [users.data])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = users.data?.days?.[0]?.source as 'live' | 'mock' | undefined
  const hasData = agg.sessionsTotal > 0

  return (
    <div>
      <PageHeader
        title={t('office.title')}
        subtitle={t('office.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('office.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('office.kpi.active_users.hint')} />
          <KpiCard label={t('office.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('office.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('office.kpi.skills')} value={fmtCompact(agg.skillsTotal)} />
        </div>

        {hasData ? (
          <>
            <ChartCard title={t('office.byapp.title')} subtitle={t('office.byapp.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={agg.surfaceBars} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="surface" tickFormatter={(s: string) => t(`office.surface.${s}` as any)} />
                  <YAxis />
                  <Tooltip labelFormatter={(s: string) => t(`office.surface.${s}` as any)} />
                  <Bar dataKey="sessions" name={t('office.metric.sessions')} radius={[4, 4, 0, 0]}>
                    {agg.surfaceBars.map((b) => (<Cell key={b.surface} fill={SURFACE_COLOR[b.surface]} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('office.daily.title')} subtitle={t('office.daily.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  {SURFACES.map((s) => (
                    <Area key={s} type="monotone" dataKey={s} stackId="office" name={t(`office.surface.${s}` as any)} stroke={SURFACE_COLOR[s]} fill={SURFACE_COLOR[s]} fillOpacity={0.35} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('office.top.title')} subtitle={t('office.top.sub')}>
              <OfficeUserTable rows={agg.users} t={t} />
            </ChartCard>
          </>
        ) : (
          <EmptyState title={t('office.empty')} hint={t('office.empty.hint')} />
        )}
      </div>
    </div>
  )
}

function OfficeUserTable({ rows, t }: { rows: OfficeRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<OfficeRow, 'email' | 'sessions' | 'messages'>(
    rows,
    { email: (r) => r.email, sessions: (r) => r.sessions, messages: (r) => r.messages },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('office.top.empty')} /></div>
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('office.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('office.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('office.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no errors), `npx vite build` (succeeds). The page isn't routed yet (Task 3) — it must still compile.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Office.tsx src/lib/i18n.tsx
git commit -m "feat(office): Office surface 페이지 + office.* i18n 키"
```

---

## Task 2: Design page (`src/pages/Design.tsx`) + `design.*` i18n keys

**Files:** Create `src/pages/Design.tsx`; Modify `src/lib/i18n.tsx` (en+ko).

- [ ] **Step 1: Add `design.*` keys to `src/lib/i18n.tsx`.** Into the `en` block:

```ts
    // Design
    'design.title': 'Design',
    'design.subtitle': 'Claude Design surface activity over {start} → {end} ({days}d).',
    'design.kpi.active_users': 'Active Design Users',
    'design.kpi.active_users.hint': 'distinct users with ≥1 design session in window',
    'design.kpi.sessions': 'Design Sessions',
    'design.kpi.messages': 'Design Messages',
    'design.kpi.projects': 'Projects Created',
    'design.kpi.projects.hint': 'summed across days (not distinct across the window)',
    'design.daily.title': 'Daily Design Engagement',
    'design.daily.sub': 'Sessions & messages per day',
    'design.projects.title': 'Projects',
    'design.projects.sub': 'Projects used vs created per day',
    'design.top.title': 'Top Design Users',
    'design.top.sub': 'Per-user design totals over the window',
    'design.top.empty': 'No design activity in this window',
    'design.empty': 'No design usage yet',
    'design.empty.hint': 'Design surface activity will populate this page as adoption grows.',
    'design.metric.sessions': 'Sessions',
    'design.metric.messages': 'Messages',
    'design.metric.projects_used': 'Projects used',
    'design.metric.projects_created': 'Projects created',
    'design.col.user': 'User',
```

Into the `ko` block:

```ts
    // Design (ko)
    'design.title': 'Design',
    'design.subtitle': '{start} → {end} ({days}일) Claude Design surface 활동.',
    'design.kpi.active_users': '활성 Design 사용자',
    'design.kpi.active_users.hint': '기간 내 design 세션 1회 이상인 distinct 사용자',
    'design.kpi.sessions': 'Design 세션',
    'design.kpi.messages': 'Design 메시지',
    'design.kpi.projects': '생성 프로젝트',
    'design.kpi.projects.hint': '일별 합산(윈도우 전체 distinct 아님)',
    'design.daily.title': '일별 Design 참여량',
    'design.daily.sub': '일별 세션·메시지',
    'design.projects.title': '프로젝트',
    'design.projects.sub': '일별 사용 vs 생성 프로젝트',
    'design.top.title': 'Top Design 사용자',
    'design.top.sub': '기간 내 사용자별 design 합계',
    'design.top.empty': '이 기간에 design 활동 없음',
    'design.empty': '아직 design 사용 없음',
    'design.empty.hint': '도입이 늘면 design surface 활동이 이 페이지에 자동으로 표시됩니다.',
    'design.metric.sessions': '세션',
    'design.metric.messages': '메시지',
    'design.metric.projects_used': '사용 프로젝트',
    'design.metric.projects_created': '생성 프로젝트',
    'design.col.user': '사용자',
```

- [ ] **Step 2: Create `src/pages/Design.tsx`:**

```tsx
import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line, LineChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { KpiCard } from '../components/KpiCard'
import { ChartCard } from '../components/ChartCard'
import { DateRangeControl } from '../components/DateRangeControl'
import { LoadingState, ErrorState, EmptyState } from '../components/LoadingState'
import { SortableTh } from '../components/SortableTh'
import { useFetch } from '../lib/api'
import { useDateRange } from '../lib/useDateRange'
import { useSortable } from '../lib/useSortable'
import { useT } from '../lib/i18n'
import { fmtNum, fmtCompact, fmtDate, maskEmail } from '../lib/format'
import type { UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type DesignRow = { email: string; sessions: number; messages: number; projectsCreated: number }
type Tt = (k: any, p?: any) => string

export function Design() {
  const t = useT()
  const { range } = useDateRange('7d')
  const users = useFetch<RangeResp>(
    `/api/analytics/users/range?starting_date=${range.startingDate}&ending_date=${range.endingDate}`,
  )

  const agg = useMemo(() => {
    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let sessions = 0, messages = 0, projectsUsed = 0, projectsCreated = 0
      for (const r of d.data) {
        const m = r.design_metrics
        sessions += m.distinct_session_count
        messages += m.message_count
        projectsUsed += m.distinct_projects_used_count
        projectsCreated += m.distinct_projects_created_count
      }
      return { date: fmtDate(d.date), sessions, messages, projectsUsed, projectsCreated }
    })
    const byEmail = new Map<string, DesignRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0, projectsCreatedTotal = 0
    for (const d of days) {
      for (const r of d.data) {
        const m = r.design_metrics
        const email = r.user.email_address
        if (m.distinct_session_count > 0) activeEmails.add(email)
        sessionsTotal += m.distinct_session_count
        messagesTotal += m.message_count
        projectsCreatedTotal += m.distinct_projects_created_count
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0, projectsCreated: 0 }; byEmail.set(email, cur) }
        cur.sessions += m.distinct_session_count
        cur.messages += m.message_count
        cur.projectsCreated += m.distinct_projects_created_count
      }
    }
    return {
      daily,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal, projectsCreatedTotal,
    }
  }, [users.data])

  if (users.loading) return <LoadingState />
  if (users.error) return <ErrorState error={users.error} />

  const source = users.data?.days?.[0]?.source as 'live' | 'mock' | undefined
  const hasData = agg.sessionsTotal > 0

  return (
    <div>
      <PageHeader
        title={t('design.title')}
        subtitle={t('design.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('design.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('design.kpi.active_users.hint')} />
          <KpiCard label={t('design.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('design.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('design.kpi.projects')} value={fmtCompact(agg.projectsCreatedTotal)} hint={t('design.kpi.projects.hint')} />
        </div>

        {hasData ? (
          <>
            <ChartCard title={t('design.daily.title')} subtitle={t('design.daily.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <defs>
                    <linearGradient id="designGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4CA371" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#4CA371" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="sessions" name={t('design.metric.sessions')} stroke="#4CA371" strokeWidth={2} fill="url(#designGrad)" />
                  <Line type="monotone" dataKey="messages" name={t('design.metric.messages')} stroke="#8A8474" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('design.projects.title')} subtitle={t('design.projects.sub')}>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="projectsUsed" name={t('design.metric.projects_used')} stroke="#4CA371" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="projectsCreated" name={t('design.metric.projects_created')} stroke="#8A8474" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('design.top.title')} subtitle={t('design.top.sub')}>
              <DesignUserTable rows={agg.users} t={t} />
            </ChartCard>
          </>
        ) : (
          <EmptyState title={t('design.empty')} hint={t('design.empty.hint')} />
        )}
      </div>
    </div>
  )
}

function DesignUserTable({ rows, t }: { rows: DesignRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<DesignRow, 'email' | 'sessions' | 'messages' | 'projectsCreated'>(
    rows,
    {
      email: (r) => r.email,
      sessions: (r) => r.sessions,
      messages: (r) => r.messages,
      projectsCreated: (r) => r.projectsCreated,
    },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('design.top.empty')} /></div>
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('design.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('design.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('design.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('design.metric.projects_created')} k="projectsCreated" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.projectsCreated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (no errors), `npx vite build` (succeeds).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Design.tsx src/lib/i18n.tsx
git commit -m "feat(design): Design surface 페이지 + design.* i18n 키"
```

---

## Task 3: Wire routes + nav, release v1.1.0

**Files:** Modify `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/i18n.tsx`, `package.json`, `CHANGELOG.md`.

- [ ] **Step 1: `src/App.tsx`.** Add imports after `import { Cowork } from './pages/Cowork'`:

```tsx
import { Office } from './pages/Office'
import { Design } from './pages/Design'
```

Add routes immediately after the `<Route path="cowork" element={<Cowork />} />` line:

```tsx
        <Route path="office" element={<Office />} />
        <Route path="design" element={<Design />} />
```

- [ ] **Step 2: `src/components/Layout.tsx`.** In the `NAV` array, insert after the `cowork` entry:

```tsx
  { to: '/office',            key: 'office',            badge: '📑' },
  { to: '/design',            key: 'design',            badge: '🎨' },
```

- [ ] **Step 3: `src/lib/i18n.tsx` nav keys (BOTH blocks).** en:

```ts
    'nav.office': 'Office',
    'nav.hint.office': 'Excel · PowerPoint · Word · Outlook',
    'nav.design': 'Design',
    'nav.hint.design': 'Claude Design surface',
```

ko:

```ts
    'nav.office': 'Office',
    'nav.hint.office': 'Excel · PowerPoint · Word · Outlook',
    'nav.design': 'Design',
    'nav.hint.design': 'Claude Design 표면',
```

- [ ] **Step 4: Bump version + CHANGELOG.** `package.json` `"version"` → `1.1.0`. Add a top `CHANGELOG.md` entry (after `## [Unreleased]`, before `## [1.0.0]`), today `2026-06-17`, matching the en `### Added` + ko `### 추가` format:

```markdown
## [1.1.0] - 2026-06-17

Office and Design surface pages.

### Added

- **Office page** (`/office`, nav 📑) — Claude usage across the Excel / PowerPoint / Word / Outlook surfaces: active users, sessions, messages, skills KPIs; usage-by-app bar; stacked daily engagement; top-users table. Reuses `/api/analytics/users/range` (no backend change). Shows an empty-state until Office adoption begins (gated on window total > 0).
- **Design page** (`/design`, nav 🎨) — Claude Design surface activity: active users, sessions, messages, projects-created KPIs; daily engagement; projects used-vs-created trend; top-users table. Brand color `#4CA371`.

### 추가

- **Office 페이지** (`/office`, nav 📑) — Excel / PowerPoint / Word / Outlook surface 내 Claude 사용: 활성 사용자·세션·메시지·스킬 KPI, 앱별 사용량 막대, 일별 stacked 참여량, Top 사용자 테이블. `/api/analytics/users/range` 재사용(백엔드 무변경). Office 도입 전까지 empty-state(윈도우 합계>0 게이트).
- **Design 페이지** (`/design`, nav 🎨) — Claude Design surface 활동: 활성 사용자·세션·메시지·생성 프로젝트 KPI, 일별 참여량, 사용 vs 생성 프로젝트 추세, Top 사용자 테이블. 브랜드색 `#4CA371`.
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` (clean), `npx vite build` (succeeds; `/office` + `/design` reachable), `bash tests/run-all.sh` (`failed: 0`).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/Layout.tsx src/lib/i18n.tsx package.json CHANGELOG.md
git commit -m "feat: /office·/design 라우트·nav 등록 + v1.1.0"
```

---

## Post-implementation (controller)

`finishing-a-development-branch` → merge to main → push → `/deploy` (ccd-compute only; frontend+server-static) → CloudFront `/*` invalidation (dist `EAKHVAM1T8MX8`) → load `/office` (empty-state) + `/design` (real data) behind auth.

## Out of scope

Backend/collector changes; combining into one Surfaces page (user chose separate); a frontend test framework.
