# Group Visibility Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll group scoping out from the Users pilot to the 7 clean per-user pages, share the `/api/groups` fetch via a context provider, and add an honest "scope not applied" hint to org-level pages — shipped as v1.5.0.

**Architecture:** A new `GroupScopeProvider` fetches `/api/groups` once and shares it via React context; `useGroupScope` is refactored to read that context (same public interface, so `Users.tsx`/`GroupControl` are untouched). Scoped pages add an `inGroup` guard to their per-user aggregation; org pages render a `GroupScopeNote`.

**Tech Stack:** React 18 + TS 5 strict, react-router-dom (`useSearchParams`), `useFetch`. Verify with `npx tsc --noEmit` + `npx vite build`; server unchanged so `bash tests/run-all.sh` stays 59/59.

---

## Spec

Approved design: `docs/superpowers/specs/2026-06-17-group-visibility-rollout-design.md`. Read it once.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/GroupScopeProvider.tsx` | single `/api/groups` fetch + context (`useGroupScopeData`) | 1 |
| `src/lib/useGroupScope.ts` | URL `?group=` + `inGroup` derivation, reads context | 1 |
| `src/App.tsx` | wrap `<Routes>` in `<GroupScopeProvider>` | 1 |
| `src/components/GroupScopeNote.tsx` | org-page "scope not applied" hint | 2 |
| `src/lib/i18n.tsx` | `group.note` (en+ko) | 2 |
| `ClaudeCode/UserProductivity/Cowork/Office/Design.tsx` | `inGroup` guards | 3 |
| `Productivity.tsx`, `UserSearch.tsx` | `inGroup` (reduce/list filter) | 4 |
| `Overview/Trends/Adoption/Executive/Cost/Compliance.tsx` | render `<GroupScopeNote />` | 5 |
| `package.json`, `CHANGELOG.md` | v1.5.0 | 6 |

## Context for every task

`useGroupScope()` currently (post-Foundation) returns `{ group, setGroup, groups, hasMap, loading, inGroup, refetch }` and itself calls `useFetch('/api/groups')`. Task 1 moves the fetch into a provider; the hook's return interface is unchanged. `inGroup(email)`: `group===''`→true (no-op); `UNMAPPED`→email not in map; else `map[email_lower]===group`. The Users pilot pattern is `if (!inGroup(r.user.email_address)) continue` as the first statement in the per-user loop + `inGroup` added to the aggregating `useMemo`'s dep array. ESM/strict; Korean commits; never `--no-verify`.

---

## Task 1: GroupScopeProvider + useGroupScope refactor + App wiring

**Files:**
- Create: `src/components/GroupScopeProvider.tsx`
- Modify: `src/lib/useGroupScope.ts` (replace fetch with context read)
- Modify: `src/App.tsx` (wrap Routes)

- [ ] **Step 1: Create `src/components/GroupScopeProvider.tsx`**

```tsx
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useFetch } from '../lib/api'

type GroupsResp = {
  source: 'live' | 'empty'
  file: string | null
  groups: string[]
  map: Record<string, string>   // lowercased email → group
}

export type GroupScopeData = {
  groups: string[]
  map: Record<string, string>
  hasMap: boolean
  loading: boolean
  refetch: () => Promise<void>
}

const EMPTY: GroupScopeData = { groups: [], map: {}, hasMap: false, loading: false, refetch: async () => {} }

const GroupScopeContext = createContext<GroupScopeData>(EMPTY)

/** Reads the shared group map from context. Consumed by useGroupScope. */
export function useGroupScopeData(): GroupScopeData {
  return useContext(GroupScopeContext)
}

/**
 * Fetches the admin email→group mapping (`GET /api/groups`) ONCE and shares it
 * via context, so the sidebar control + every scoped page read one request and
 * a single refetch (after upload) refreshes all consumers.
 */
export function GroupScopeProvider({ children }: { children: ReactNode }) {
  const { data, loading, refetch } = useFetch<GroupsResp>('/api/groups')
  const value = useMemo<GroupScopeData>(() => {
    const groups = data?.groups ?? []
    const map = data?.map ?? {}
    return { groups, map, hasMap: data?.source === 'live' && groups.length > 0, loading, refetch }
  }, [data, loading, refetch])
  return <GroupScopeContext.Provider value={value}>{children}</GroupScopeContext.Provider>
}
```

- [ ] **Step 2: Refactor `src/lib/useGroupScope.ts` to read context**

Replace the ENTIRE file contents with:

```ts
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useGroupScopeData } from '../components/GroupScopeProvider'

/** Sentinel group value: users NOT present in the uploaded mapping. */
export const UNMAPPED = '__unmapped__'

/**
 * Global group-scope state. Combines the shared admin email→group map (provided
 * once by GroupScopeProvider) with a URL-synced `?group=` selection. `inGroup(email)`
 * is the predicate every scoped page applies in its per-user aggregation:
 *   - group === ''            → All (everyone)
 *   - group === UNMAPPED      → email NOT in the mapping
 *   - else                    → map[email_lower] === group
 */
export function useGroupScope() {
  const [params, setParams] = useSearchParams()
  const { groups, map, hasMap, loading, refetch } = useGroupScopeData()

  const rawGroup = params.get('group') ?? ''
  // Fall back to "All" if the selected name is no longer present in the map.
  const group = rawGroup === UNMAPPED || groups.includes(rawGroup) ? rawGroup : ''

  const setGroup = useCallback((g: string) => {
    const next = new URLSearchParams(params)
    if (!g) next.delete('group')
    else next.set('group', g)
    setParams(next, { replace: true })
  }, [params, setParams])

  const inGroup = useCallback((email: string | null | undefined): boolean => {
    if (!group) return true
    const e = (email ?? '').toLowerCase()
    // own-key check (not `in`) so an email literally named "toString" etc.
    // can't match a prototype member and be miscounted as mapped.
    if (group === UNMAPPED) return !Object.prototype.hasOwnProperty.call(map, e)
    return Object.prototype.hasOwnProperty.call(map, e) && map[e] === group
  }, [group, map])

  return { group, setGroup, groups, hasMap, loading, inGroup, refetch }
}
```

- [ ] **Step 3: Wrap `<Routes>` in `src/App.tsx`**

Add the import after `import { Layout } from './components/Layout'` (line 2):

```tsx
import { GroupScopeProvider } from './components/GroupScopeProvider'
```

Change the returned JSX from `return (\n    <Routes>` … `</Routes>\n  )` to wrap it:

```tsx
  return (
    <GroupScopeProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="exec" element={<Executive />} />
          <Route path="users" element={<Users />} />
          <Route path="trends" element={<Trends />} />
          <Route path="claude-code" element={<ClaudeCode />} />
          <Route path="cowork" element={<Cowork />} />
          <Route path="office" element={<Office />} />
          <Route path="design" element={<Design />} />
          <Route path="productivity" element={<Productivity />} />
          <Route path="user-productivity" element={<UserProductivity />} />
          <Route path="user-search" element={<UserSearch />} />
          <Route path="adoption" element={<Adoption />} />
          <Route path="cost" element={<Cost />} />
          <Route path="compliance" element={<Compliance />} />
          <Route path="analyze" element={<Analyze />} />
          <Route path="archive" element={<Archive />} />
          <Route path="changelog" element={<Changelog />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </GroupScopeProvider>
  )
```

- [ ] **Step 4: Type-check + build (behavior-preserving — Users/GroupControl must still compile against the same hook interface)**

Run: `npx tsc --noEmit` → exit 0.
Run: `npx vite build` → success.
Run: `grep -n "useFetch" src/lib/useGroupScope.ts` → NO matches (the fetch moved to the provider).

- [ ] **Step 5: Commit**

```bash
git add src/components/GroupScopeProvider.tsx src/lib/useGroupScope.ts src/App.tsx
git commit -m "refactor(groups): /api/groups를 GroupScopeProvider 컨텍스트로 단일화 (중복 fetch + staleness 해소)"
```

---

## Task 2: GroupScopeNote component + `group.note` i18n

**Files:**
- Create: `src/components/GroupScopeNote.tsx`
- Modify: `src/lib/i18n.tsx` (`group.note` en+ko)

- [ ] **Step 1: Add the English `group.note` key**

In `src/lib/i18n.tsx`, find the en key `    'group.empty':          'No mapping uploaded — showing all users.',` and add immediately after it:

```ts
    'group.note':           'Group scope ({group}) isn’t applied on this page — showing org-wide data.',
```

(The `’` is U+2019, required because the strings are single-quoted JS literals.)

- [ ] **Step 2: Add the Korean `group.note` key**

In `src/lib/i18n.tsx`, find the ko key `    'group.empty':          '매핑 미업로드 — 전체 사용자 표시.',` and add immediately after it:

```ts
    'group.note':           '이 페이지에는 그룹 스코프({group})가 적용되지 않습니다 — 전사 데이터 표시.',
```

- [ ] **Step 3: Create `src/components/GroupScopeNote.tsx`**

```tsx
import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Honest hint for org-level pages that do NOT honor the global group scope.
 * Renders nothing when no group is selected; otherwise a subtle banner noting
 * the page shows org-wide data regardless of the selected group.
 */
export function GroupScopeNote() {
  const t = useT()
  const { group } = useGroupScope()
  if (!group) return null
  const label = group === UNMAPPED ? t('group.unmapped') : group
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
      {t('group.note', { group: label })}
    </div>
  )
}
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit` → exit 0.
Run: `npx vite build` → success.
Run: `grep -c "'group.note'" src/lib/i18n.tsx` → `2` (en + ko parity).

- [ ] **Step 5: Commit**

```bash
git add src/components/GroupScopeNote.tsx src/lib/i18n.tsx
git commit -m "feat(groups): GroupScopeNote 컴포넌트 + group.note i18n (org 페이지 힌트)"
```

---

## Task 3: Scope the 5 standard `users/range` pages

For EACH page: (a) add `import { useGroupScope } from '../lib/useGroupScope'` with the other imports; (b) add `const { inGroup } = useGroupScope()` immediately after the `const { range } = useDateRange(...)` line; (c) insert the guard(s) shown; (d) add `inGroup` to the aggregating `useMemo` dep array shown.

**Files:** `src/pages/ClaudeCode.tsx`, `UserProductivity.tsx`, `Cowork.tsx`, `Office.tsx`, `Design.tsx`

- [ ] **Step 1: ClaudeCode.tsx** — guard the one loop, update dep.

Replace:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        const cm = r.claude_code_metrics.core_metrics
```
with:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const cm = r.claude_code_metrics.core_metrics
```
Then change `}, [data])` (the agg memo closer) to `}, [data, inGroup])`.

- [ ] **Step 2: UserProductivity.tsx** — guard the one loop, update dep.

Replace:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        const email = r.user.email_address
        const cc = r.claude_code_metrics.core_metrics
```
with:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const email = r.user.email_address
        const cc = r.claude_code_metrics.core_metrics
```
Then change `}, [rangeResp.data, q])` to `}, [rangeResp.data, q, inGroup])`.

- [ ] **Step 3: Cowork.tsx** — guard BOTH loops, update dep.

Daily loop — replace:
```tsx
      let sessions = 0, messages = 0, actions = 0, dispatchTurns = 0
      for (const r of d.data) {
        const c = r.cowork_metrics
```
with:
```tsx
      let sessions = 0, messages = 0, actions = 0, dispatchTurns = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const c = r.cowork_metrics
```
Per-user loop — replace:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        const c = r.cowork_metrics
        const email = r.user.email_address
```
with:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const c = r.cowork_metrics
        const email = r.user.email_address
```
Then change `}, [summaries.data, users.data])` to `}, [summaries.data, users.data, inGroup])`.

- [ ] **Step 4: Office.tsx** — guard BOTH loops, update dep.

Daily loop (braceless `for…for` — convert to braced) — replace:
```tsx
      for (const r of d.data) for (const s of SURFACES) row[s] += r.office_metrics[s].distinct_session_count
```
with:
```tsx
      for (const r of d.data) { if (!inGroup(r.user.email_address)) continue; for (const s of SURFACES) row[s] += r.office_metrics[s].distinct_session_count }
```
Per-user loop — replace:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        const email = r.user.email_address
        let userSessions = 0, userMessages = 0
```
with:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const email = r.user.email_address
        let userSessions = 0, userMessages = 0
```
Then change `}, [users.data])` to `}, [users.data, inGroup])`.

- [ ] **Step 5: Design.tsx** — guard BOTH loops, update dep.

Daily loop — replace:
```tsx
      let sessions = 0, messages = 0, projectsUsed = 0, projectsCreated = 0
      for (const r of d.data) {
        const m = r.design_metrics
```
with:
```tsx
      let sessions = 0, messages = 0, projectsUsed = 0, projectsCreated = 0
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.design_metrics
```
Per-user loop — replace:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        const m = r.design_metrics
        const email = r.user.email_address
```
with:
```tsx
    for (const d of days) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const m = r.design_metrics
        const email = r.user.email_address
```
Then change `}, [users.data])` to `}, [users.data, inGroup])`.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit` → exit 0. `npx vite build` → success.
Run: `grep -c "inGroup(r.user.email_address)" src/pages/ClaudeCode.tsx src/pages/UserProductivity.tsx src/pages/Cowork.tsx src/pages/Office.tsx src/pages/Design.tsx` → ClaudeCode 1, UserProductivity 1, Cowork 2, Office 2, Design 2.

```bash
git add src/pages/ClaudeCode.tsx src/pages/UserProductivity.tsx src/pages/Cowork.tsx src/pages/Office.tsx src/pages/Design.tsx
git commit -m "feat(groups): ClaudeCode·UserProductivity·Cowork·Office·Design에 inGroup 스코프 적용"
```

---

## Task 4: Scope Productivity (reduce-based) + UserSearch (list filter)

**Files:** `src/pages/Productivity.tsx`, `src/pages/UserSearch.tsx`

- [ ] **Step 1: Productivity.tsx — import + hook**

Add `import { useGroupScope } from '../lib/useGroupScope'` with the imports, and `const { inGroup } = useGroupScope()` immediately after the `const { range } = useDateRange(...)` line.

- [ ] **Step 2: Productivity.tsx — scope each day's slice**

Replace:
```tsx
    const daily = days.map((d) => {
      const active = d.data.filter((u) => u.claude_code_metrics.core_metrics.distinct_session_count > 0)
      const loc = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
      const locRem = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.removed_count, 0)
      const commits = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.commit_count, 0)
      const prs = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.pull_request_count, 0)
      const sessions = d.data.reduce((s, r) => s + r.claude_code_metrics.core_metrics.distinct_session_count, 0)

      const accepted = d.data.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
               ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
      }, 0)
      const rejected = d.data.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
               ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }, 0)
```
with:
```tsx
    const daily = days.map((d) => {
      const scoped = d.data.filter((u) => inGroup(u.user.email_address))
      const active = scoped.filter((u) => u.claude_code_metrics.core_metrics.distinct_session_count > 0)
      const loc = scoped.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.added_count, 0)
      const locRem = scoped.reduce((s, r) => s + r.claude_code_metrics.core_metrics.lines_of_code.removed_count, 0)
      const commits = scoped.reduce((s, r) => s + r.claude_code_metrics.core_metrics.commit_count, 0)
      const prs = scoped.reduce((s, r) => s + r.claude_code_metrics.core_metrics.pull_request_count, 0)
      const sessions = scoped.reduce((s, r) => s + r.claude_code_metrics.core_metrics.distinct_session_count, 0)

      const accepted = scoped.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.accepted_count + ta.multi_edit_tool.accepted_count +
               ta.write_tool.accepted_count + ta.notebook_edit_tool.accepted_count
      }, 0)
      const rejected = scoped.reduce((s, r) => {
        const ta = r.claude_code_metrics.tool_actions
        return s + ta.edit_tool.rejected_count + ta.multi_edit_tool.rejected_count +
               ta.write_tool.rejected_count + ta.notebook_edit_tool.rejected_count
      }, 0)
```

- [ ] **Step 3: Productivity.tsx — scope the totalUsers count + dep**

Replace `        totalUsers: d.data.length,` with `        totalUsers: scoped.length,`.
Then change `}, [range.data])` to `}, [range.data, inGroup])`.
Verify no `d.data` remains inside the `days.map((d) => {...})` callback: `grep -n "d\.data" src/pages/Productivity.tsx` should show only references OUTSIDE that callback (if any); none should remain inside the daily map.

- [ ] **Step 4: UserSearch.tsx — import + hook + filter the user list**

Add `import { useGroupScope } from '../lib/useGroupScope'` with the imports, and `const { inGroup } = useGroupScope()` near the top of the component (e.g. after the `const [tab, setTab] = useState<Tab>('overview')` line).

Replace:
```tsx
    return [...new Set(csv.data.rows.map((r) => r.user_email))].sort()
  }, [csv.data])
```
with:
```tsx
    return [...new Set(csv.data.rows.map((r) => r.user_email))].filter((e) => inGroup(e)).sort()
  }, [csv.data, inGroup])
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit` → exit 0. `npx vite build` → success.

```bash
git add src/pages/Productivity.tsx src/pages/UserSearch.tsx
git commit -m "feat(groups): Productivity(슬라이스 필터) + UserSearch(사용자 목록 필터) 스코프 적용"
```

---

## Task 5: Render `GroupScopeNote` on the 6 org pages

For EACH page: add `import { GroupScopeNote } from '../components/GroupScopeNote'` with the other imports, and render `<GroupScopeNote />` immediately after the page's main `<PageHeader ... />` element in the returned JSX (the note renders nothing unless a group is selected, so placement is safe). Use the main content render path where a page has multiple returns.

**Files:** `src/pages/Overview.tsx`, `Trends.tsx`, `Adoption.tsx`, `Executive.tsx`, `Cost.tsx`, `Compliance.tsx`

- [ ] **Step 1: Overview.tsx** — `<GroupScopeNote />` after the `<PageHeader>` (the single return at ~line 86, header at ~88).
- [ ] **Step 2: Trends.tsx** — after the `<PageHeader>` (return ~37, header ~39).
- [ ] **Step 3: Adoption.tsx** — after the main `<PageHeader>` at ~line 123 (the page's primary return ~121; the `<PageHeader>` near ~197 belongs to a different sub-render — use the ~123 one).
- [ ] **Step 4: Executive.tsx** — after the main `<PageHeader>` at ~line 231 (primary return ~228; not the ~365 branch).
- [ ] **Step 5: Cost.tsx** — Cost has multiple return branches (loading/empty/data). Read the file and place `<GroupScopeNote />` after the `<PageHeader ... />` in the MAIN data-view render (the one shown with cost data, near `<PageHeader title={t('cost.title')} subtitle={t('cost.subtitle')} />`). One placement in the primary view is sufficient.
- [ ] **Step 6: Compliance.tsx** — after the main `<PageHeader>` at ~line 203 (primary return ~201; not the ~336 branch).

- [ ] **Step 7: Verify + commit**

Run: `npx tsc --noEmit` → exit 0. `npx vite build` → success.
Run: `grep -l "GroupScopeNote" src/pages/Overview.tsx src/pages/Trends.tsx src/pages/Adoption.tsx src/pages/Executive.tsx src/pages/Cost.tsx src/pages/Compliance.tsx` → all 6 listed.

```bash
git add src/pages/Overview.tsx src/pages/Trends.tsx src/pages/Adoption.tsx src/pages/Executive.tsx src/pages/Cost.tsx src/pages/Compliance.tsx
git commit -m "feat(groups): org 페이지 6개에 GroupScopeNote 힌트 추가 (그룹 미적용 안내)"
```

---

## Task 6: v1.5.0 + CHANGELOG

**Files:** `package.json`, `CHANGELOG.md`

**CHANGELOG convention:** since v0.9.0 each release entry lives ONCE under `# English` and is BILINGUAL — `## [x.y.z]`, a `### Added`/`### Changed` (English) block, then `### 추가`/`### 변경` (Korean). The `# 한국어` section is frozen at `[0.8.0]`; do NOT add v1.5.0 there.

- [ ] **Step 1: Bump version** — in `package.json`, change `"version": "1.4.0",` to `"version": "1.5.0",`. (Confirm it reads 1.4.0 first.)

- [ ] **Step 2: Add the CHANGELOG entry** — replace the English `## [Unreleased]` block:

```markdown
## [Unreleased]

_No changes yet — next entries land here._
```

with:

```markdown
## [Unreleased]

_No changes yet — next entries land here._

## [1.5.0] - 2026-06-17

Group visibility — rollout to per-user pages.

### Added

- **Group scope across the dashboard.** The Foundation's group selector now scopes 7 more per-user pages — UserProductivity, ClaudeCode, Cowork, Office, Design, Productivity, and UserSearch — via the shared `useGroupScope().inGroup` predicate. The `/api/groups` mapping is now fetched once through a `GroupScopeProvider` context (instead of per page), so a single post-upload refetch refreshes every consumer and there's no duplicate request. Org-level pages that can't honor group scope (Overview, Trends, Adoption, Executive, Cost, Compliance) show a subtle "group scope not applied — org-wide data" note when a group is selected, so the selection is never silently ignored.

### 추가

- **대시보드 전반 그룹 스코프.** Foundation의 그룹 선택기가 공유 `useGroupScope().inGroup` 술어로 사용자 단위 7개 페이지(UserProductivity·ClaudeCode·Cowork·Office·Design·Productivity·UserSearch)를 추가로 스코프합니다. `/api/groups` 매핑은 이제 `GroupScopeProvider` 컨텍스트로 한 번만 fetch해(페이지별 중복 제거) 업로드 후 한 번의 refetch가 모든 소비자를 갱신합니다. 그룹 스코프가 적용되지 않는 org 단위 페이지(Overview·Trends·Adoption·Executive·Cost·Compliance)는 그룹 선택 시 "그룹 미적용 — 전사 데이터" 안내를 표시해 선택이 조용히 무시되지 않도록 합니다.
```

- [ ] **Step 3: Verify** — `node -e "console.log(require('./package.json').version)"` → `1.5.0`. `grep -c "## \[1.5.0\]" CHANGELOG.md` → `1`. `npx vite build` → success.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v1.5.0 — 그룹 가시성 롤아웃"
```

---

## After all tasks

Final holistic review across the branch, then `superpowers:finishing-a-development-branch`. Deploy = `/deploy` (`ccd-compute`) + CloudFront `/*` invalidation (`EAKHVAM1T8MX8`) — frontend-only change (provider, hint, i18n), no server/infra change.

## Self-Review

**1. Spec coverage:**
- §1 provider + hook refactor + App wiring → Task 1. Same hook interface (Users/GroupControl untouched) ✓.
- §2 scoped pages (7): ClaudeCode·UserProductivity·Cowork·Office·Design → Task 3; Productivity·UserSearch → Task 4. Guard points match the spec table (Cowork/Office/Design = 2 loops each) ✓.
- §3 GroupScopeNote on 6 org pages → Task 5; component → Task 2 ✓.
- §4 `group.note` i18n en+ko → Task 2 ✓.
- §5/§6 testing (tsc + build, 59/59 unchanged) + v1.5.0 → Tasks 1–6 verifies + Task 6 ✓.
- Out-of-scope (Cost/Executive full scope, Compliance audit filter, Analyze/Archive) — NOT built; Cost/Executive/Compliance get only the note ✓.

**2. Placeholder scan:** Code steps show exact old→new blocks. Task 5 placement is instruction-based (insert `<GroupScopeNote />` after `<PageHeader>`) with per-page line anchors + a grep verification — acceptable for a render-placement task where the added JSX is fully specified; Cost flagged for read-before-place due to multiple returns.

**3. Type/name consistency:** `useGroupScope()` return shape unchanged across Task 1 (definition) and Tasks 3/4 (consumers use `inGroup`). `useGroupScopeData` exported by GroupScopeProvider (Task 1), imported by useGroupScope (Task 1). `GroupScopeNote` exported (Task 2), imported by 6 pages (Task 5). `group.note` key referenced in GroupScopeNote (Task 2) exists in both dicts (Task 2). `UNMAPPED` still exported from useGroupScope (Task 1), imported by GroupControl (unchanged) + GroupScopeNote (Task 2). Dep-array edits match each page's actual closer (verified against current code: `[data]`, `[rangeResp.data, q]`, `[summaries.data, users.data]`, `[users.data]`, `[range.data]`, `[csv.data]`).
