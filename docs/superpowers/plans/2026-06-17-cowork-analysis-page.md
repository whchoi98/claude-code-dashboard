# Cowork Analysis Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Cowork analysis page (4 KPIs + DAU/WAU/MAU trend + daily engagement + Top-users table + file-editing adoption) reusing existing Analytics endpoints.

**Architecture:** A pure frontend page `src/pages/Cowork.tsx` fetching `/api/analytics/summaries` (cowork DAU/WAU/MAU) and `/api/analytics/users/range` (per-user `cowork_metrics`), aggregating in `useMemo`, rendering with the established PageHeader/KpiCard/ChartCard/useSortable conventions. No backend changes.

**Tech Stack:** React 18 + TS strict + Recharts + Tailwind. Verification = `npx tsc --noEmit` + `npx vite build` (repo has no frontend unit-test harness; matches every existing page).

**Spec:** `docs/superpowers/specs/2026-06-17-cowork-analysis-page-design.md`

---

## File structure

| File | Change | Task |
|---|---|---|
| `src/pages/Cowork.tsx` | **create** — page + `CoworkUserTable` sub-component | 1 |
| `src/lib/i18n.tsx` | add `cowork.*` prose keys (en+ko) | 1 |
| `src/lib/i18n.tsx` | add `nav.cowork` + `nav.hint.cowork` (en+ko) | 2 |
| `src/App.tsx` | import + `<Route path="cowork">` | 2 |
| `src/components/Layout.tsx` | NAV entry | 2 |
| `src/pages/Trends.tsx` | cowork line color `#4CA371`→`#B75E40` | 2 |
| `package.json`, `CHANGELOG.md` | v0.10.0 | 2 |

**No `npm test`.** Verify with `npx tsc --noEmit` and `npx vite build`. The full suite `bash tests/run-all.sh` must still pass (it tests server/hooks only — unaffected, but run it to confirm no regression).

---

## Task 1: Create `src/pages/Cowork.tsx` + `cowork.*` prose i18n keys

**Files:** Create `src/pages/Cowork.tsx`; Modify `src/lib/i18n.tsx` (add `cowork.*` keys to BOTH the `en` and `ko` blocks).

- [ ] **Step 1: Add the `cowork.*` prose keys to `src/lib/i18n.tsx`.** Insert this block into the `en` dictionary (e.g. after the `cc.*` section). The page references every one of these via a typed `t('cowork....')`, so they MUST exist in `en` (the `Key` type = `keyof typeof DICT.en`) or `tsc` fails.

```ts
    // Cowork
    'cowork.title': 'Cowork',
    'cowork.subtitle': 'Cowork session activity & collaboration over {start} → {end} ({days}d).',
    'cowork.kpi.active_users': 'Active Cowork Users',
    'cowork.kpi.active_users.hint': 'distinct users with ≥1 cowork session in window',
    'cowork.kpi.sessions': 'Cowork Sessions',
    'cowork.kpi.messages': 'Cowork Messages',
    'cowork.kpi.adoption': 'Cowork Adoption',
    'cowork.kpi.adoption.hint': 'latest-day cowork DAU ÷ assigned seats',
    'cowork.trend.title': 'Cowork Active Users',
    'cowork.trend.sub': 'Daily / weekly / monthly cowork actives',
    'cowork.engagement.title': 'Daily Cowork Engagement',
    'cowork.engagement.sub': 'Sessions, messages, actions & dispatch turns per day',
    'cowork.top.title': 'Top Cowork Users',
    'cowork.top.sub': 'Per-user cowork totals over the window',
    'cowork.top.empty': 'No cowork activity in this window',
    'cowork.fileedit.title': 'Cowork File-editing Adoption',
    'cowork.fileedit.sub': 'Cowork file-edit & tool usage counts',
    'cowork.fileedit.empty': 'Cowork file-editing not active yet',
    'cowork.fileedit.empty.hint': 'These counters populate automatically once cowork file-editing is enabled for the org.',
    'cowork.metric.dau': 'Cowork DAU',
    'cowork.metric.wau': 'Cowork WAU',
    'cowork.metric.mau': 'Cowork MAU',
    'cowork.metric.sessions': 'Sessions',
    'cowork.metric.messages': 'Messages',
    'cowork.metric.actions': 'Actions',
    'cowork.metric.dispatch_turns': 'Dispatch turns',
    'cowork.col.user': 'User',
    'cowork.fe.file_edit_count': 'File edits',
    'cowork.fe.edit_tool_count': 'Edit tool',
    'cowork.fe.multi_edit_tool_count': 'Multi-edit tool',
    'cowork.fe.write_tool_count': 'Write tool',
    'cowork.fe.notebook_edit_tool_count': 'Notebook-edit tool',
    'cowork.fe.sessions_with_file_edits_count': 'Sessions w/ file edits',
```

And insert the matching block into the `ko` dictionary:

```ts
    // Cowork (ko)
    'cowork.title': 'Cowork',
    'cowork.subtitle': '{start} → {end} ({days}일) Cowork 세션 활동·협업.',
    'cowork.kpi.active_users': '활성 Cowork 사용자',
    'cowork.kpi.active_users.hint': '기간 내 cowork 세션 1회 이상인 distinct 사용자',
    'cowork.kpi.sessions': 'Cowork 세션',
    'cowork.kpi.messages': 'Cowork 메시지',
    'cowork.kpi.adoption': 'Cowork 도입률',
    'cowork.kpi.adoption.hint': '최근일 cowork DAU ÷ 할당 좌석',
    'cowork.trend.title': 'Cowork 활성 사용자',
    'cowork.trend.sub': '일·주·월 cowork 활성 사용자',
    'cowork.engagement.title': '일별 Cowork 참여량',
    'cowork.engagement.sub': '일별 세션·메시지·액션·dispatch turns',
    'cowork.top.title': 'Top Cowork 사용자',
    'cowork.top.sub': '기간 내 사용자별 cowork 합계',
    'cowork.top.empty': '이 기간에 cowork 활동 없음',
    'cowork.fileedit.title': 'Cowork 파일편집 도입',
    'cowork.fileedit.sub': 'Cowork 파일편집·도구 사용 횟수',
    'cowork.fileedit.empty': 'Cowork 파일편집이 아직 비활성',
    'cowork.fileedit.empty.hint': '조직에 cowork 파일편집이 활성화되면 이 카운터가 자동으로 채워집니다.',
    'cowork.metric.dau': 'Cowork DAU',
    'cowork.metric.wau': 'Cowork WAU',
    'cowork.metric.mau': 'Cowork MAU',
    'cowork.metric.sessions': '세션',
    'cowork.metric.messages': '메시지',
    'cowork.metric.actions': '액션',
    'cowork.metric.dispatch_turns': 'Dispatch turns',
    'cowork.col.user': '사용자',
    'cowork.fe.file_edit_count': '파일 편집',
    'cowork.fe.edit_tool_count': 'Edit 도구',
    'cowork.fe.multi_edit_tool_count': 'Multi-edit 도구',
    'cowork.fe.write_tool_count': 'Write 도구',
    'cowork.fe.notebook_edit_tool_count': 'Notebook-edit 도구',
    'cowork.fe.sessions_with_file_edits_count': '파일편집 포함 세션',
```

- [ ] **Step 2: Create `src/pages/Cowork.tsx`** with exactly this content:

```tsx
import { useMemo } from 'react'
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Area, BarChart, Bar,
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
import { fmtNum, fmtCompact, fmtPct, fmtDate, maskEmail } from '../lib/format'
import type { Summary, UserRecord } from '../types'

type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }
type UserRow = { email: string; sessions: number; messages: number; actions: number; dispatchTurns: number }
type Tt = (k: any, p?: any) => string

const FE_KEYS = [
  'file_edit_count', 'edit_tool_count', 'multi_edit_tool_count',
  'write_tool_count', 'notebook_edit_tool_count', 'sessions_with_file_edits_count',
] as const

export function Cowork() {
  const t = useT()
  const { range } = useDateRange('7d')
  const q = `?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const summaries = useFetch<SummariesResp>(`/api/analytics/summaries${q}`)
  const users = useFetch<RangeResp>(`/api/analytics/users/range${q}`)

  const agg = useMemo(() => {
    const sums = summaries.data?.data ?? []
    const trend = sums.map((s) => ({
      date: fmtDate(s.starting_at),
      DAU: s.cowork_daily_active_user_count,
      WAU: s.cowork_weekly_active_user_count,
      MAU: s.cowork_monthly_active_user_count,
    }))
    const last = sums[sums.length - 1]
    const adoption = last && last.assigned_seat_count
      ? last.cowork_daily_active_user_count / last.assigned_seat_count
      : null

    const days = users.data?.days ?? []
    const daily = days.map((d) => {
      let sessions = 0, messages = 0, actions = 0, dispatchTurns = 0
      for (const r of d.data) {
        const c = r.cowork_metrics
        sessions += c.distinct_session_count
        messages += c.message_count
        actions += c.action_count
        dispatchTurns += c.dispatch_turn_count
      }
      return { date: fmtDate(d.date), sessions, messages, actions, dispatchTurns }
    })

    const byEmail = new Map<string, UserRow>()
    const activeEmails = new Set<string>()
    let sessionsTotal = 0, messagesTotal = 0
    const fe: Record<(typeof FE_KEYS)[number], number> = {
      file_edit_count: 0, edit_tool_count: 0, multi_edit_tool_count: 0,
      write_tool_count: 0, notebook_edit_tool_count: 0, sessions_with_file_edits_count: 0,
    }
    let anyNonNull = false
    for (const d of days) {
      for (const r of d.data) {
        const c = r.cowork_metrics
        const email = r.user.email_address
        if (c.distinct_session_count > 0) activeEmails.add(email)
        sessionsTotal += c.distinct_session_count
        messagesTotal += c.message_count
        let cur = byEmail.get(email)
        if (!cur) { cur = { email, sessions: 0, messages: 0, actions: 0, dispatchTurns: 0 }; byEmail.set(email, cur) }
        cur.sessions += c.distinct_session_count
        cur.messages += c.message_count
        cur.actions += c.action_count
        cur.dispatchTurns += c.dispatch_turn_count
        for (const k of FE_KEYS) {
          const v = c[k]
          if (v != null) anyNonNull = true
          fe[k] += v ?? 0
        }
      }
    }
    const feBars = FE_KEYS.map((k) => ({ key: k, value: fe[k] }))
    return {
      trend, adoption, daily,
      users: Array.from(byEmail.values()),
      activeUsers: activeEmails.size,
      sessionsTotal, messagesTotal,
      feBars, feHasData: anyNonNull,
    }
  }, [summaries.data, users.data])

  if (summaries.loading || users.loading) return <LoadingState />
  if (summaries.error) return <ErrorState error={summaries.error} />
  if (users.error) return <ErrorState error={users.error} />

  const source = users.data?.days?.[0]?.source as 'live' | 'mock' | undefined

  return (
    <div>
      <PageHeader
        title={t('cowork.title')}
        subtitle={t('cowork.subtitle', { start: range.startingDate, end: range.endingDate, days: range.days })}
        source={source}
        reason={summaries.reason}
        right={<DateRangeControl />}
      />
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('cowork.kpi.active_users')} value={fmtNum(agg.activeUsers)} hint={t('cowork.kpi.active_users.hint')} />
          <KpiCard label={t('cowork.kpi.sessions')} value={fmtCompact(agg.sessionsTotal)} />
          <KpiCard label={t('cowork.kpi.messages')} value={fmtCompact(agg.messagesTotal)} />
          <KpiCard label={t('cowork.kpi.adoption')} value={fmtPct(agg.adoption)} hint={t('cowork.kpi.adoption.hint')} />
        </div>

        <ChartCard title={t('cowork.trend.title')} subtitle={t('cowork.trend.sub')}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={agg.trend} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="DAU" name={t('cowork.metric.dau')} stroke="#B75E40" strokeWidth={2.5} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="WAU" name={t('cowork.metric.wau')} stroke="#DF8663" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="MAU" name={t('cowork.metric.mau')} stroke="#8A8474" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('cowork.engagement.title')} subtitle={t('cowork.engagement.sub')}>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={agg.daily} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
              <defs>
                <linearGradient id="coworkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#B75E40" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#B75E40" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="sessions" name={t('cowork.metric.sessions')} stroke="#B75E40" strokeWidth={2} fill="url(#coworkGrad)" />
              <Line type="monotone" dataKey="messages" name={t('cowork.metric.messages')} stroke="#E69F7F" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="actions" name={t('cowork.metric.actions')} stroke="#8A8474" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="dispatchTurns" name={t('cowork.metric.dispatch_turns')} stroke="#1F1E1D" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('cowork.top.title')} subtitle={t('cowork.top.sub')}>
          <CoworkUserTable rows={agg.users} t={t} />
        </ChartCard>

        <ChartCard title={t('cowork.fileedit.title')} subtitle={t('cowork.fileedit.sub')}>
          {agg.feHasData ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={agg.feBars} layout="vertical" margin={{ top: 8, right: 16, left: 40, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="key" width={150} tick={{ fontSize: 11 }} tickFormatter={(k: string) => t(`cowork.fe.${k}` as any)} />
                <Tooltip formatter={(v: number) => fmtNum(v)} labelFormatter={(k: string) => t(`cowork.fe.${k}` as any)} />
                <Bar dataKey="value" fill="#B75E40" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="px-4 py-2">
              <EmptyState title={t('cowork.fileedit.empty')} hint={t('cowork.fileedit.empty.hint')} />
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  )
}

function CoworkUserTable({ rows, t }: { rows: UserRow[]; t: Tt }) {
  const { rows: sorted, sortKey, sortDir, toggle } = useSortable<UserRow, 'email' | 'sessions' | 'messages' | 'actions' | 'dispatchTurns'>(
    rows,
    {
      email: (r) => r.email,
      sessions: (r) => r.sessions,
      messages: (r) => r.messages,
      actions: (r) => r.actions,
      dispatchTurns: (r) => r.dispatchTurns,
    },
    { initialKey: 'sessions', initialDir: 'desc' },
  )
  if (rows.length === 0) return <div className="px-4 py-2"><EmptyState title={t('cowork.top.empty')} /></div>
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-ink-500">
            <SortableTh label={t('cowork.col.user')} k="email" sortKey={sortKey} sortDir={sortDir} onClick={toggle} align="left" />
            <SortableTh label={t('cowork.metric.sessions')} k="sessions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.messages')} k="messages" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.actions')} k="actions" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
            <SortableTh label={t('cowork.metric.dispatch_turns')} k="dispatchTurns" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.email} className="border-b border-ink-50">
              <td className="py-2 text-left text-ink-700">{maskEmail(r.email)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.messages)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.actions)}</td>
              <td className="py-2 text-right tabular-nums">{fmtNum(r.dispatchTurns)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Verify** (the page typechecks + compiles even though it isn't routed yet):

Run: `npx tsc --noEmit`
Expected: no errors. (Common pitfalls if it fails: a missing `cowork.*` key in the `en` block → "not assignable to parameter of type Key"; `Area`/`Line` inside a plain `AreaChart` instead of `ComposedChart`; `SortableTh`/`useSortable` generic `K` mismatch — the `K` union in `useSortable<UserRow, ...>` must list every `k=` used.)

Run: `npx vite build`
Expected: builds to `dist/` with no error (the new module compiles; it's tree-shaken out until routed).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Cowork.tsx src/lib/i18n.tsx
git commit -m "feat(cowork): Cowork 분석 페이지 컴포넌트 + cowork.* i18n 키"
```

---

## Task 2: Wire the route + nav, fix Trends color, release v0.10.0

**Files:** Modify `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/i18n.tsx`, `src/pages/Trends.tsx`, `package.json`, `CHANGELOG.md`.

- [ ] **Step 1: Register the route in `src/App.tsx`.** Add the import after the `Changelog` import (line 16):

```tsx
import { Cowork } from './pages/Cowork'
```

Add the route immediately after the `claude-code` route (line 26), before the `path="*"` wildcard:

```tsx
        <Route path="cowork" element={<Cowork />} />
```

- [ ] **Step 2: Add the NAV entry in `src/components/Layout.tsx`.** In the `NAV` array, insert between the `claude_code` (line 22) and `productivity` (line 23) entries:

```tsx
  { to: '/cowork',            key: 'cowork',            badge: '🤝' },
```

- [ ] **Step 3: Add the nav i18n keys to `src/lib/i18n.tsx`** (BOTH blocks — `en` requires it for the `Key` type, `ko` so it isn't shown as the raw key). In the `en` block next to the other `nav.*` / `nav.hint.*` entries:

```ts
    'nav.cowork': 'Cowork',
    'nav.hint.cowork': 'Sessions & collaboration',
```

In the `ko` block next to its `nav.*` / `nav.hint.*` entries:

```ts
    'nav.cowork': 'Cowork',
    'nav.hint.cowork': '세션 · 협업',
```

- [ ] **Step 4: Fix the cowork line color in `src/pages/Trends.tsx`** (consistency — `#4CA371` is a reused green, not the cowork brand color). Change the line on `Trends.tsx:58`:

```tsx
              <Line type="monotone" dataKey="CoworkDAU" name="Cowork DAU" stroke="#4CA371" strokeWidth={2} dot={false} />
```
to:
```tsx
              <Line type="monotone" dataKey="CoworkDAU" name="Cowork DAU" stroke="#B75E40" strokeWidth={2} dot={false} />
```

(Leave the `name="Cowork DAU"` string as-is — it's pre-existing; not introducing a new hardcoded-string regression in scope here.)

- [ ] **Step 5: Bump version + CHANGELOG.** Set `package.json` `"version"` to `0.10.0`. Add a top entry to `CHANGELOG.md` matching the existing bilingual format (`## [x.y.z] - YYYY-MM-DD`, summary line, `### Added` then `### 추가`). Use today's date `2026-06-17`:

```markdown
## [0.10.0] - 2026-06-17

Dedicated Cowork analysis page.

### Added

- **Cowork page** (`/cowork`, nav 🤝) — a first-class view of cowork usage that was previously only thin secondary metrics on code-centric pages. 4 KPIs (active cowork users, sessions, messages, adoption), a DAU/WAU/MAU trend, daily engagement (sessions/messages/actions/dispatch turns), a sortable Top-cowork-users table, and a file-editing adoption section. Reuses `/api/analytics/summaries` + `/api/analytics/users/range` (no backend change). The file-editing section shows an empty-state until the org's cowork tool-edit counters populate (distinguished by null vs zero).

### Changed

- Trends page cowork-DAU line recolored to the cowork brand color `#B75E40` (was a mismatched green).

### 추가

- **Cowork 페이지** (`/cowork`, nav 🤝) — 그동안 code 중심 페이지에 곁다리로만 있던 cowork 사용량을 1급 뷰로. KPI 4개(활성 사용자·세션·메시지·도입률), DAU/WAU/MAU 추세, 일별 참여량(세션·메시지·액션·dispatch), 정렬 가능한 Top cowork 사용자 테이블, 파일편집 도입 섹션. `/api/analytics/summaries` + `/api/analytics/users/range` 재사용(백엔드 무변경). 파일편집 섹션은 조직의 tool-edit 카운터가 채워질 때까지 empty-state(null과 0을 구분).

### 변경

- Trends 페이지 cowork-DAU 라인 색을 cowork 브랜드색 `#B75E40`으로 정정(기존 녹색 불일치).
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vite build`
Expected: builds with no error; `/cowork` is now reachable (route + nav registered).

Run: `bash tests/run-all.sh`
Expected: `# passed: N / N (failed: 0)` (server/hooks suite unaffected — confirms no collateral regression).

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/components/Layout.tsx src/lib/i18n.tsx src/pages/Trends.tsx package.json CHANGELOG.md
git commit -m "feat(cowork): /cowork 라우트·nav 등록 + Trends 색 정정 + v0.10.0"
```

---

## Post-implementation (controller, after both tasks pass)

Handled via `finishing-a-development-branch` + deploy: merge to main → push → `/deploy` (ccd-compute only; this is frontend+server-static, no storage/collector change) → CloudFront `/*` invalidation (dist `EAKHVAM1T8MX8`) → load `https://c4e.whchoi.net/cowork` and confirm the page renders (DAU/WAU/MAU + engagement have data; file-editing shows the empty-state).

## Out of scope

Cowork skill/connector tables (on Adoption already); any backend/collector change; a frontend test framework.
