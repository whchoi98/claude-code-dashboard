# Office + Design Surface Pages — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Roadmap:** Step 6 (the "Surfaces" page), split into two dedicated pages per user choice.

## Goal

Two new first-class pages — **Office** (`/office`) and **Design** (`/design`) — surfacing
the `office_metrics` (Excel/PowerPoint/Word/Outlook) and `design_metrics` Claude-usage
data captured in step 5. Same pattern as the shipped Cowork page.

## Architecture

Two pure frontend pages, `src/pages/Office.tsx` and `src/pages/Design.tsx`. Each does a
single `useFetch<RangeResp>('/api/analytics/users/range?starting_date&ending_date')`
(both `office_metrics` and `design_metrics` ride on every `UserRecord`). No backend
changes. Each mirrors the Cowork page skeleton: `PageHeader` (source from
`users.data?.days?.[0]?.source`, `right={<DateRangeControl/>}`), `useDateRange('7d')`,
`useMemo` aggregation, KPI grid, `ChartCard` + Recharts, `useSortable`+`SortableTh`
table, guards after the `useMemo`.

**Empty-state rule:** `office_metrics`/`design_metrics` are plain `number` (always
present, 0 when no usage — no null distinction). So the empty-state is gated on
**window total === 0**, NOT "all null" (which the cowork tool-edit fields used). The KPI
row always renders (showing 0 / "—"); the chart sections render only when the surface's
window total > 0, else a single `EmptyState` card. Office total is 0 today → empty-state;
Design total is non-zero → charts render. When Office adoption starts, charts appear with
no code change.

## Data shapes (src/types.ts, reference)

`UserRecord.office_metrics` = `{ excel, powerpoint, word, outlook }`, each
`OfficeAppMetrics` = `{ distinct_session_count, message_count, skills_used_count, distinct_skills_used_count, connectors_used_count, distinct_connectors_used_count }` (all `number`).

`UserRecord.design_metrics` = `DesignMetrics` = `{ distinct_session_count, distinct_projects_used_count, distinct_projects_created_count, message_count }` (all `number`).

Range envelope (declare locally, matches `/range`): `type DayEntry = { date: string; source: string; data: UserRecord[] }`, `type RangeResp = { range: {...}; days: DayEntry[] }`.

## Office page (`/office`)

`const OFFICE_SURFACES = ['excel','powerpoint','word','outlook'] as const`.

**KPI row (4):** Office active users (distinct emails where the sum of the 4 surfaces'
`distinct_session_count` > 0 on a day) · Office sessions (Σ over day,user,surface of
`distinct_session_count`) · Office messages (Σ `message_count`) · Office skills used (Σ
`skills_used_count`).

**Empty-state gate:** `officeTotal = sessions total`. If `officeTotal === 0` → render the
KPI row + one `EmptyState` (`office.empty` / `office.empty.hint`). Else render the 3
sections.

**Sections (when officeTotal > 0):**
1. **Usage by app** — `BarChart` of the 4 surfaces by sessions (per-surface totals), bars colored per surface.
2. **Daily Office engagement** — stacked `AreaChart`, one area per surface (`excel`/`powerpoint`/`word`/`outlook` sessions) per day, `stackId="office"`.
3. **Top Office users** — `useSortable`+`SortableTh` table aggregated by email: User (maskEmail, left) · Sessions (Σ 4 surfaces) · Messages. `initialKey: 'sessions'`, desc.

**Surface colors:** excel `#D97757`, powerpoint `#DF8663`, word `#8A8474`, outlook `#B75E40`.

## Design page (`/design`) — brand color `#4CA371`

**KPI row (4):** Design active users (distinct emails with `design_metrics.distinct_session_count` > 0) · Design sessions (Σ) · Design messages (Σ) · Projects created (Σ `distinct_projects_created_count`).

**Empty-state gate:** `designTotal = sessions total`. If 0 → KPI row + `EmptyState`. Else the 3 sections (Design has data today → renders).

**Sections (when designTotal > 0):**
1. **Daily Design engagement** — `ComposedChart`: `sessions` Area (`#4CA371`, gradient) + `messages` Line.
2. **Projects** — `LineChart`: `projectsUsed` (Σ `distinct_projects_used_count` per day) + `projectsCreated` (Σ `distinct_projects_created_count` per day). Colors `#4CA371` / `#8A8474`.
3. **Top Design users** — `useSortable`+`SortableTh` table by email: User (maskEmail) · Sessions · Messages · Projects created. `initialKey: 'sessions'`, desc.

**Aggregation caveat:** `distinct_projects_used/created_count` can't be deduped across days → per-day SUM (a usage signal, may overcount distinct projects across the window). Documented in the section subtitle copy.

## Wiring (per page)

- `src/App.tsx` — import + `<Route path="office" element={<Office />} />` and `<Route path="design" element={<Design />} />` (above the `*` wildcard, after the `cowork` route).
- `src/components/Layout.tsx` — NAV entries after the `cowork` entry: `{ to: '/office', key: 'office', badge: '📑' }`, `{ to: '/design', key: 'design', badge: '🎨' }`.
- `src/lib/i18n.tsx` (en+ko) — `nav.office`/`nav.hint.office`, `nav.design`/`nav.hint.design`, and full `office.*` + `design.*` prose key sets (title, subtitle, KPI labels+hints, section titles/subtitles, empty-state, surface/metric labels). Finalize exact keys against the JSX.

## Error handling / edge cases

- Empty `users.days` → KPIs 0/"—", empty-state card; no crash (reduces start from 0/empty Map).
- `maskEmail()` on every rendered email.
- Every string via `t('office.*')`/`t('design.*')` with both en+ko — no hardcoded `title`/`subtitle`/`label`/`hint`/`name` props.
- `users/range` 31-day cap → 30d preset is the effective max (as on all range pages).
- Adoption-style ratios n/a here (no seats denominator for office/design); KPIs are counts.

## Testing

No frontend unit-test harness (consistent with every page). Verify with `npx tsc --noEmit`
+ `npx vite build`; `bash tests/run-all.sh` must still pass (server/hooks unaffected).
Aggregation mirrors the verified Cowork/ClaudeCode `useMemo` reduce.

## Version

v1.1.0 (two new pages). CHANGELOG entry (en `### Added` + ko `### 추가`).

## Out of scope

Backend/collector changes (data already flows); a combined Surfaces page (user chose two
separate pages); cowork (already its own page); a frontend test framework.
