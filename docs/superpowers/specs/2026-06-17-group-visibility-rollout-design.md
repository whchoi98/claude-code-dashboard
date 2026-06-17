# Group Visibility — Rollout — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Builds on:** Group Visibility Foundation (`2026-06-17-group-visibility-foundation-design.md`, shipped v1.4.0 — `useGroupScope`/`inGroup`, `GroupControl`, `/api/groups`, Users pilot).
**Version target:** **v1.5.0**

## Goal

Extend the Foundation's group scoping from the single Users pilot to the rest of the
dashboard. Two parts: (1) a one-time refactor so the `/api/groups` map is fetched **once**
(shared via context) instead of per-consumer, and (2) apply `inGroup` to every page with a
per-user dimension, plus an honest "scope not applied here" hint on org-level pages.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Shared fetch | **Context provider** — `GroupScopeProvider` fetches `/api/groups` once; `useGroupScope` reads context. Fixes the per-page duplicate fetch AND post-upload staleness flagged in the Foundation review. |
| Scope this cycle | The **7 clean per-user pages**. Cost + Executive (mixed) and Compliance (audit) deferred to a later cycle. |
| Org-level pages | Selector stays globally visible; org data pages show a **"group scope not applied"** hint when a group is selected (no false impression of filtering). |
| Empty state | Reuse each page's existing empty state (no per-page copy churn this cycle). |

## Architecture

### 1. `GroupScopeProvider` + `useGroupScope` refactor

Today `useGroupScope` itself calls `useFetch('/api/groups')`, so every consumer (the sidebar
`GroupControl` + each scoped page) issues its own request, and `GroupControl`'s post-upload
`refetch()` only refreshes its own instance. The refactor splits responsibilities:

- **`src/components/GroupScopeProvider.tsx`** (new): calls `useFetch<GroupsResp>('/api/groups')`
  **once** and provides `{ groups, map, hasMap, loading, refetch }` through a React context
  (`GroupScopeContext`). The context default is a safe empty value
  (`{ groups: [], map: {}, hasMap: false, loading: false, refetch: async () => {} }`) so the
  hook never throws if used outside the provider.
- **`src/lib/useGroupScope.ts`** (refactored): reads the context for the fetched data and
  `useSearchParams` for `?group=`, then derives the **same public interface** it returns today —
  `{ group, setGroup, groups, hasMap, loading, inGroup, refetch }`. The `group` resolution
  (stale-name → All fallback), `setGroup`, and the `inGroup` predicate (own-key check,
  `UNMAPPED` sentinel) are unchanged. Because the interface is identical, `Users.tsx` and
  `GroupControl` need **no changes**.
- **`src/App.tsx`**: wrap `<Routes>` in `<GroupScopeProvider>`. The provider sits inside the
  Router (from `main.tsx`), so `useFetch` and every page's `useSearchParams` work. All consumers
  (sidebar control + pages) now share the single fetch; one `refetch` updates everyone.

`UNMAPPED` stays exported from `src/lib/useGroupScope.ts` (GroupControl imports it). The
`GroupsResp` type moves to (or is shared between) the provider and hook.

### 2. Scoped pages (7) — apply `inGroup`

Each page calls `const { inGroup } = useGroupScope()` and guards its per-user aggregation,
matching the Users pilot. `group === ''` makes `inGroup` a no-op (everyone passes), so default
behavior is unchanged. Per-page guard points (verified against current code):

| Page | Source | Guard point(s) |
|---|---|---|
| `UserProductivity.tsx` | `users/range` | 1 loop: `for (const r of d.data)` → `if (!inGroup(r.user.email_address)) continue` |
| `ClaudeCode.tsx` | `users/range` | 1 loop (same form) |
| `Cowork.tsx` | `users/range` | 2 loops (daily-engagement memo + per-user table memo) — guard both |
| `Office.tsx` | `users/range` | 2 loops (session-surface memo + per-user memo) — guard both |
| `Design.tsx` | `users/range` | 2 loops (daily memo + per-user memo) — guard both |
| `Productivity.tsx` | `users/range` | reduce/filter-based per day: introduce `const scoped = d.data.filter((u) => inGroup(u.user.email_address))` and use `scoped` in place of `d.data` for that day's `.filter`/`.reduce` calls |
| `UserSearch.tsx` | `cost/csv` (+ `users/range`) | filter the searchable user list: `[...new Set(csv.data.rows.map((r) => r.user_email))]` → `.filter((e) => inGroup(e))` before dedup/sort |

Each scoped page also adds `inGroup` to the dependency array of the `useMemo` it guards (so
re-aggregation runs when the selected group changes). `inGroup` is referentially stable
(a `useCallback` keyed on `[group, map]`), so this triggers recompute only on group/map change.

**Note (UserSearch):** filtering the user list means a user outside the selected group is not
selectable; if the currently-selected `activeEmail` falls outside the new group, the page shows
its existing "pick a user" state. No special handling needed.

### 3. Org-level hint — `GroupScopeNote`

- **`src/components/GroupScopeNote.tsx`** (new): reads `useGroupScope()`; renders **nothing**
  when `group === ''`; when a group is selected, renders a subtle banner (Claude palette, e.g.
  amber-tinted, `text-[11px]`) reading `t('group.note', { group })` — "Group scope isn't applied
  on this page (org-wide data)." Pure presentational; no props required.
- Placed (one import + one `<GroupScopeNote />` near the `PageHeader`) on the **6 org data
  pages**: `Overview.tsx`, `Trends.tsx`, `Adoption.tsx`, `Executive.tsx`, `Cost.tsx`,
  `Compliance.tsx`.
- **Not** added to `Analyze.tsx` (chat), `Archive.tsx` (raw SQL console), `Changelog.tsx`
  (static) — no group-relevant data surface.

This delivers the honest UX: scoped pages filter; org pages visibly declare they don't.

### 4. i18n

Add to both `en` and `ko` dicts in `src/lib/i18n.tsx`:

- `group.note` — en: "Group scope ({group}) isn't applied on this page — showing org-wide data."
  / ko: "이 페이지에는 그룹 스코프({group})가 적용되지 않습니다 — 전사 데이터 표시."

(`{group}` is interpolated via the existing `t(key, vars)` mechanism.)

## Components / boundaries

- `GroupScopeProvider` — owns the single fetch + context; one responsibility (data source).
- `useGroupScope` — owns URL-param + predicate derivation; depends on the context. Same
  interface as today (backward compatible).
- `GroupScopeNote` — owns the org-page hint; depends only on `useGroupScope` + i18n.
- Scoped pages — depend on `useGroupScope().inGroup`; one guard per per-user loop.

## Data flow

`GroupScopeProvider` (1 fetch) → context → `useGroupScope()` in (a) `GroupControl` (selector +
upload→`refetch`), (b) scoped pages (`inGroup` filters aggregation), (c) `GroupScopeNote` on org
pages (reads `group` to decide whether to render). `?group=` URL is the shared selection channel
across all consumers.

## Error handling / edge cases

- `/api/groups` fails or empty → context holds `{ groups:[], hasMap:false, map:{} }`; `inGroup`
  defaults to All (fail-open, everyone visible); `GroupScopeNote` renders nothing (no group can
  be selected). Same graceful degradation as the Foundation.
- Provider used-outside guard: context default prevents throws.
- Stale `?group=` not in the (refreshed) map → `useGroupScope` already falls back to All.
- Group filters a scoped page to zero users → that page's existing empty state shows.
- Cold load with `?group=X` set → brief all-users frame before the map arrives (fail-open),
  then re-filter — acceptable, same as Foundation; a loading guard is explicitly out of scope.

## Testing

- The pure `inGroup` logic is unchanged from the Foundation (already covered indirectly by
  `parseGroupMap` tests + the hook's behavior). No new server test.
- Refactor is behavior-preserving for `Users.tsx`/`GroupControl` (identical hook interface).
- Verify `npx tsc --noEmit` (strict) + `npx vite build`; full suite `bash tests/run-all.sh`
  stays green (59/59 — no server change).
- Manual contract check: with no group selected every page matches pre-rollout output (no-op);
  with a group selected, the 7 scoped pages filter and the 6 org pages show the note.

## Out of scope (later cycles)

- **Mixed pages** — full scoping of `Cost` and `Executive` (org KPIs/spend can't be
  group-attributed without per-user-per-group cost data; needs sectioned treatment + recomputed
  per-group KPIs). They get only the org hint this cycle.
- **Compliance** audit-event filtering by actor group.
- **`Analyze`/`Archive`** group awareness.
- Group-by **breakdown** views (compare groups side-by-side); group-aware empty-state copy;
  a loading skeleton to remove the cold-load flash; switching the source to `rbac_group_id`
  when the Analytics API supports it.
