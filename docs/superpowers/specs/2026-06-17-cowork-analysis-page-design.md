# Cowork Analysis Page — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan

## Goal

Add a first-class **Cowork** dashboard page that surfaces cowork engagement
(sessions / messages / actions / dispatch turns), cowork active-user trends
(DAU/WAU/MAU), per-user cowork leaders, and cowork file-editing adoption — data
that is fully captured today but only thinly surfaced as secondary metrics on
code-centric pages.

## Architecture

A pure frontend page, `src/pages/Cowork.tsx`. **No backend changes** — it reuses
two existing Analytics proxy routes:

- `GET /api/analytics/summaries?starting_date&ending_date` → `{ source, reason?, data: Summary[] }`, one row per day; carries `cowork_daily/weekly/monthly_active_user_count` + `assigned_seat_count`.
- `GET /api/analytics/users/range?starting_date&ending_date` → `{ range, cache, days: [{ date, source, data: UserRecord[] }] }`; each `UserRecord.cowork_metrics` has the full 14-field block.

The page mirrors the established page skeleton (ClaudeCode/Productivity/Trends):
`PageHeader` (with `source`/`reason` + `right={<DateRangeControl />}`) outside a
`<div className="p-8 space-y-6">` body; `useDateRange('7d')`; all aggregation in
`useMemo`; KPI grid of `KpiCard`; `ChartCard` + Recharts `ResponsiveContainer`;
`useSortable` + `SortableTh` for the table. Two `useFetch` calls; guard order:
`if (summaries.loading || users.loading) return <LoadingState/>` then
`if (summaries.error) return <ErrorState error={summaries.error}/>` (one guard per
source), AFTER the `useMemo` (hooks run unconditionally).

`source` badge from `users.data?.days?.[0]?.source as 'live'|'mock'|undefined`.

## Data shapes (reference)

`CoworkMetrics` (src/types.ts) — `number`: `distinct_session_count`, `action_count`, `dispatch_turn_count`, `message_count`, `skills_used_count`, `distinct_skills_used_count`, `connectors_used_count`, `distinct_connectors_used_count`. `number | null` (the 6 tool-edit fields): `file_edit_count`, `edit_tool_count`, `multi_edit_tool_count`, `write_tool_count`, `notebook_edit_tool_count`, `sessions_with_file_edits_count`.

`Summary` — `cowork_daily_active_user_count`, `cowork_weekly_active_user_count`, `cowork_monthly_active_user_count`, `assigned_seat_count`, `starting_at`.

Range envelope (declare locally in the page, matches every `/range` route):
```ts
type DayEntry = { date: string; source: string; data: UserRecord[] }
type RangeResp = { range: { starting_date: string; ending_date: string }; days: DayEntry[] }
type SummariesResp = { source: 'live' | 'mock'; reason?: string; data: Summary[] }
```

## KPI row (4 cards)

1. **Active cowork users** (`accent`) — distinct `user.email_address` with `cowork_metrics.distinct_session_count > 0` across the window (users/range), `fmtNum`.
2. **Cowork sessions** — Σ `distinct_session_count` over (day,user), `fmtCompact`.
3. **Cowork messages** — Σ `message_count`, `fmtCompact`.
4. **Cowork adoption** — latest summary day's `cowork_daily_active_user_count / assigned_seat_count` → `fmtPct(fraction)`; if `assigned_seat_count` is 0/absent → `fmtPct(null)` renders "—".

## Sections

1. **DAU/WAU/MAU trend** — `LineChart` from summaries. `rows = summaries.data.map(s => ({ date: fmtDate(s.starting_at), DAU: s.cowork_daily_active_user_count, WAU: s.cowork_weekly_active_user_count, MAU: s.cowork_monthly_active_user_count }))`. 3 lines: DAU `#B75E40`, WAU `#DF8663`, MAU `#8A8474`. No client aggregation (summaries is natively per-day).

2. **Daily cowork engagement** — `AreaChart` from users/range. `daily = days.map(d => ({ date: fmtDate(d.date), sessions: Σ distinct_session_count, messages: Σ message_count, actions: Σ action_count, dispatchTurns: Σ dispatch_turn_count }))`. `sessions` as filled Area (`#B75E40`, gradient); `messages`/`actions`/`dispatchTurns` as Lines (`#E69F7F` claude-300 / `#8A8474` ink-400 / `#1F1E1D` ink-800). Standard margin + `CartesianGrid strokeDasharray="2 4"` + `Legend iconType="circle"`.

3. **Top cowork users** — `useSortable` + `SortableTh` table from users/range, aggregated into `Map<email, { email, sessions, messages, actions, dispatchTurns }>` (SUM over days). Columns: User (`maskEmail`, `align="left"`), Sessions, Messages, Actions, Dispatch turns. `initialKey: 'sessions'`, `initialDir: 'desc'`. Bordered `<table className="w-full text-sm">` following the Adoption `ProjectTable` template; `EmptyState` if zero rows.

4. **Cowork file-editing adoption** (the 6 tool-edit fields) — reduce each field with `?? 0` SUM over (day,user), AND track `anyNonNull` (true if any of the 6 fields is non-null on any record). **If `!anyNonNull`** → `<EmptyState title={t('cowork.fileedit.empty')} hint={t('cowork.fileedit.empty.hint')} />` ("cowork file-editing not active yet — populates automatically on rollout"). **Else** → horizontal `BarChart` of the 6 totals (`file_edit_count`, `edit_tool_count`, `multi_edit_tool_count`, `write_tool_count`, `notebook_edit_tool_count`, `sessions_with_file_edits_count`), bars `#B75E40`, `radius={[0,4,4,0]}`, category labels from i18n.

The `anyNonNull` test (not "sum === 0") is what distinguishes "feature not tracked" (all null) from "tracked, zero usage" (real 0s) — the payoff of the v0.9.0 null-preservation.

## Color

Cowork brand color `#B75E40` (matches `Cost.tsx` `PRODUCT_COLORS.cowork`). Secondary palette: `#DF8663` (claude-400), `#E69F7F` (claude-300), `#8A8474` (ink-400), `#1F1E1D` (ink-800). **Consistency fix:** `Trends.tsx` draws its Cowork-DAU line in `#4CA371` (a reused green, not the brand color) — change it to `#B75E40` in the same change.

## Wiring (4 edits)

1. `src/App.tsx` — `import { Cowork } from './pages/Cowork'`; `<Route path="cowork" element={<Cowork />} />` above the `path="*"` wildcard, positioned after the `claude-code` route.
2. `src/components/Layout.tsx` — insert into the `NAV` array between the `claude_code` and `productivity` entries: `{ to: '/cowork', key: 'cowork', badge: '🤝' }`.
3. `src/lib/i18n.tsx` (en + ko both) — `nav.cowork` ('Cowork'), `nav.hint.cowork` ('Sessions & collaboration' / '세션 · 협업').
4. `src/lib/i18n.tsx` (en + ko both) — `cowork.*` prose section: title, subtitle (with `{start}`/`{end}`/`{days}`), the 4 KPI labels + hints, the 4 section titles/subtitles, the file-edit empty-state strings, and the 6 file-edit bar category labels. Finalize the exact key list against the JSX so there are no unused/missing keys.

## Aggregation constraints (from exploration)

- Distinct skills/connectors can't be deduped across days → this page does **not** use those; sessions/messages/actions/dispatch_turns SUM correctly.
- The 6 tool-edit fields are `number | null` → every read uses `?? 0`; `anyNonNull` drives the empty-state.
- `users/range` caps the window to the last 31 days → the `30d` preset is the effective max (consistent with all other range pages).
- Recompute the adoption ratio from the chosen day's counts; never average per-day ratios.

## Error handling / edge cases

- Empty `summaries.data` or `users.days` → KPIs show 0/"—", charts render empty, table shows `EmptyState`. No crash (all reduces start from 0 / empty Map).
- `maskEmail()` on every rendered email (table).
- Every visible string via `t('cowork.*')` with both en+ko entries — never hardcode in `title`/`subtitle`/`label`/`hint`/`name` props.

## Testing

This repo has **no frontend unit-test harness** — the test suite (`tests/run-all.sh`) runs server `.mjs` + hooks/structure `.sh`, and cannot import `.ts`/`.tsx`. Introducing one (vitest etc.) for a single page is out of scope (YAGNI) and inconsistent with every existing page (none are unit-tested). Verification therefore matches the established convention:

- `npx tsc --noEmit` (strict; catches type errors, the null-guard contract on the 6 fields, i18n key typing).
- `npx vite build` (the production bundle compiles).
- Code review of the aggregation (it mirrors the verified ClaudeCode/Productivity `useMemo` reduce).

## Out of scope

- Cowork skill/connector usage tables (already on the Adoption page).
- Any backend/collector change (data already flows through the reused endpoints).
- A frontend test framework.
