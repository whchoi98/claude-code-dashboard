# src — React SPA (Vite)

## Role

Browser-side SPA. Renders the 19 dashboard pages, handles i18n / date range / email masking, and talks to the Express proxy under `/api`.

## Layout

```
src/
├── components/           # shared UI
│   ├── Layout.tsx        # h-screen flex wrapper (sidebar pinned, main scrolls in its own pane); NAV array, language toggle, health badges, version badge → /changelog, static AWS run-rate label. MOBILE (< lg): the sidebar is a fixed slide-in drawer (navOpen state + backdrop, closes on nav tap) behind a sticky hamburger top bar; pages use responsive grids (grid-cols-2 lg:grid-cols-4 KPI rows, stacked chart pairs), p-4 lg:p-8 padding, and overflow-x-auto table wrappers
│   ├── ClaudeIcon.tsx    # animated asterisk mark
│   ├── KpiCard.tsx · ChartCard.tsx · PageHeader.tsx · LoadingState.tsx
│   ├── UserDetailPanel.tsx   # right-side slide-in drill-down; follows the page date range (range prop from Users/UserProductivity), adds per-product AND per-model spend cards (+prev-period Δ on products), a Cache Efficiency card (per-user hit rate + read/write/uncached tiers from /api/cost/user-tokens — same cache_read÷input convention as the Cost page org KPI) and skills cards (org top skills $/use — the API has no user×skill dimension); org-wide cost/skills fetches dedupe per session via module-level panelFetchCache (keys are `${org}:${url}` — per-org universes never cross)
│   ├── DateRangeControl.tsx  # 1d/7d/14d/30d/custom popover (maxEnd = today; footnote explains the Analytics 3-day partial-count buffer). '1d' anchors to the most recent FINALIZED day (today−3) by default; pages with buffer-free data opt into `freshEnd` (prop here + same option in the page's own useDateRange call — separate hook instances must agree) so '1d' targets TODAY — Cost is the only opt-in (cost family serves today at a ~4h watermark). Cost's today-only window has three guards (all keyed off `isTodayOnlyWindow` in Cost.tsx): a settled-but-empty live response is USABLE (no CSV fallback — every KST morning the watermark hasn't ingested today yet; a `todayPending` note explains the zeros), forecast KPIs (30d projection · 7d avg · per-dev) render placeholders (partial-day ×30 extrapolation + eff's today−3 denominator would mislead), and Top-table fallbacks to other-window sources (eff today−3 / CSV export period) are suppressed. Server-side, the cost keep-warm presets warm the SAME [today,today] window (see server/CLAUDE.md)
│   ├── CsvUploader.tsx       # multipart upload + preview + period-overlap warning
│   ├── GroupTabs.tsx         # per-page group scope tabs (All · groups · Unmapped) + email→group CSV upload; URL-synced via useGroupScope. Replaced the former sidebar GroupControl (removed 2026-07) — rendered right after PageHeader on the 10 group-aware pages
│   ├── GroupScopeNote.tsx    # group-scope banner; self-hides when no group selected. Amber default = "not applied — org-wide data" (note-only org pages); amber variant="partial" = "per-user parts scoped, org aggregates stay org-wide" (Cowork · Agentic, and Cost in CSV/UNMAPPED mode); neutral variant="scoped" = Cost in live mode with a group id (org KPIs genuinely filtered upstream; explains any-membership/usage-time attribution)
│   ├── RangeCoverageNote.tsx # amber banner for /range responses whose `coverage` block shows unarchived/error days (days before the S3 archive floor, beyond the live budget, or upstream failures — all zero-filled; ADR-0019). Wired into the 12 range-consuming pages right after GroupTabs; accepts a single response or an array (Adoption passes skills+connectors+projects, worst coverage wins). Self-hides on full coverage
│   ├── SortableTh.tsx        # ▲/▼ header cell — pairs with useSortable; click to sort, click again to flip
│   ├── Markdown.tsx      # react-markdown@10 + remark-gfm for AI output
│   └── chat/             # tool-use chatbot UI (shared by Analyze page + FloatingChat)
│       ├── ChatPanel.tsx     # shared chat surface — `variant="page"` (full) | `variant="widget"` (floating); accepts a `ChatStream` prop
│       ├── MessageList.tsx   # message bubbles, typing dots, tool-call badges (running/done/error), markdown rendering
│       ├── ChatComposer.tsx  # textarea + Send / Stop buttons; Enter to send, Shift-Enter for newline
│       └── FloatingChat.tsx  # fixed-position launcher button + modal panel; mounted globally in Layout.tsx
├── pages/                # one file per route — 19 total (Analyze.tsx rebuilt as a chatbot page around ChatPanel; MD/PDF export toolbar retained; Agentic.tsx = actions-per-prompt delegation metrics + org spend context; ClaudeChat.tsx = claude.ai conversation usage/activity — 8 KPIs, 2 daily charts, sortable per-user table; UserProductivity's score is the ACTIVITY score (cost not a factor, cross-referenced to Cost's cost-efficiency score); Compliance.tsx = audit feed + a page-local EventDetailPanel slide-in (row/badge click → actor + dynamic fields + collapsible raw JSON; maskEmailsInText masks emails INCLUDING %40-encoded and 1-char-local forms in recorded url/request_body; real dialog semantics: focus-in — deferred ~50ms past the visibility transition's first frame or focus() is silently ignored — Tab trap, focus restore, `invisible` when closed to leave the a11y tree; onClose must be a stable useCallback or the focus effect re-runs every parent render). Its truncation banner keys off stop_reason ∉ COMPLETE_STOPS and picks wording per reason (cap/volume vs upstream_* vs time_budget); Executive mirrors the partial check on the Risk KPI hint)
├── lib/
│   ├── i18n.tsx          # en/ko toggle + dictionary
│   ├── OrgProvider.tsx   # multi-org context — fetches /api/orgs ONCE (module-level promise; StrictMode-safe), exposes useOrg() → { org, setOrg, orgs, loading }; URL-synced ?org= (absent/invalid → 'primary'; while the list loads a raw ?org= deep link is accepted optimistically so the first fetches hit the right org). Switcher picks persist to localStorage ('ccd.org'); exported restoreOrgSelection() — called from main.tsx BEFORE React mounts (synchronous history.replaceState, so the first render already carries ?org= and no wasted primary-org fetch round fires) — restores the saved id ONLY when the URL pins neither ?org= NOR ?group= (an explicit ?org= always wins; a ?group=-carrying link is a primary view pinned by its group filter — restoring over it would hijack both org and scope). A stored id the loaded /api/orgs list doesn't contain is auto-removed (single-org rollback would otherwise re-inject a dead ?org= forever with the switcher hidden); an EMPTY list (fetch failure) keeps the preference. Deep-linked visits are NOT persisted — only explicit setOrg calls. setOrg always deletes ?group= — group maps are per org. Wraps <Routes> in App.tsx OUTSIDE GroupScopeProvider. Layout renders the sidebar org switcher (segmented control above the language toggle) only when orgs.length > 1 — single-org deployments look byte-identical to before
│   ├── useDateRange.ts   # URL-synced state (?range=7d|14d|30d|custom, ?start=, ?end=). Default preset = 7d. maxEnd = today (UTC).
│   ├── GroupScopeProvider.tsx # fetches the email→group map (/api/groups) ONCE, shares it via context; wraps <Routes> in App.tsx. Any non-'empty' source lights up the per-page GroupTabs: 'live' (admin CSV) · 'members' (real RBAC membership via the Compliance members endpoint) · 'auto' (spend-derived fallback from user_cost_report×rbac_group_id)
│   ├── useGroupScope.ts  # reads GroupScopeProvider context + ?group= URL state → { group, groupId, setGroup, groups, hasMap, loading, inGroup, refetch }. inGroup(email): ''→all · UNMAPPED→not-in-map · else map[email_lower].includes(group). groupId = rbac_group_id of the selected group (members/auto sources; null on CSV/UNMAPPED) — pages pass it to cost endpoints for the upstream rbac_group_ids[] filter
│   ├── api.ts            # useFetch<T>(url) — single-URL fetch, exposes refetch + source/reason from response. Org-aware: applies orgParam(url, org) automatically (appends org=<id> only when org !== 'primary') and HARD-RESETS data on an org switch so no page can render cross-org numbers while refetching (this is also what keeps Cost's SWR + GroupScopeProvider org-safe). Direct fetch()/POST call sites must use the exported orgParam() themselves (chat stream additionally sends { org } in the body)
│   ├── useChatStream.ts  # multi-turn chat state + SSE parser; sends `POST /api/chat/stream` with { message, history[], locale }; parses status/tool_call/tool_result/text/followups/error/done events; exports ChatMessage, ToolCall, ChatStream types
│   ├── useHealth.ts
│   ├── useSortable.ts    # bidirectional column-sort state for tables; nulls always pinned to bottom; strings via localeCompare, numbers by value
│   └── format.ts         # fmtNum / fmtCents / fmtDate / maskEmail / acceptRate / badgeSource (range-day source → PageHeader badge: everything non-mock is 'live' — 's3'/'unarchived' first days must not render a "Mock" badge)
│
│ Page-local hooks (not in lib/ — kept colocated with the consumer page):
│   - useCostData(range, rbacGroupId?)  # composite: tries /api/cost/live first, falls back to /api/cost/csv;
│                         # rbacGroupId (from useGroupScope().groupId) scopes the live path to one
│                         # RBAC group via the upstream rbac_group_ids[] filter — org-level KPIs,
│                         # trends and product/model charts then reflect the group only. While the
│                         # filter is set, an EMPTY live result is legitimate (new group, no
│                         # attributed spend yet) and must NOT trigger the org-wide CSV fallback.
│                         # SWR: a SAME-scope refetch (range change / manual refetch) keeps rendering
│                         # the previous settled response with `refreshing: true` (Cost shows a
│                         # "Refreshing…" pulse line); a SCOPE change keeps the loading veil — old-
│                         # scope numbers must never render under a new tab (server 10-min cost cache
│                         # makes returns to a recent scope near-instant).
│                         # exposes csvData separately so per-user token tables can use CSV in live mode.
│                         # The per-user "Top by Cost" table is live and covers the SAME window as the
│                         # headline KPIs: it sources liveUserRows from /api/cost/users?by=model (full
│                         # range — user_cost_report serves the 3-day buffer), falling back to
│                         # /api/cost/efficiency rows (today−3-aligned with the productivity join) then
│                         # CSV. The 3 token-ranked Top tables need per-user tokens (CSV only): in
│                         # csv+analytics mode they use eff's activity-scaled range_* values; in live
│                         # mode they fall back to whole-CSV-period totals labeled by tokens_csv_caveat.
│                         # Since 2026-07 the 3 token-ranked Top tables are ALSO live: they source
│                         # /api/cost/user-tokens (user_usage_report) first and follow the selected
│                         # range; eff/CSV rows are fallbacks (tokens_csv_caveat labels the CSV case).
│                         # The Cost page also renders a "Cost by Group" card from /api/cost/groups
│                         # (native rbac_group_id attribution; labels are REAL group names via the
│                         # Compliance groups endpoint, grp-<id suffix> fallback; any-membership
│                         # semantics — group rows can sum above the org total) and a
│                         # "Spend Limits (Monthly)" card from /api/cost/spend-limits (month-to-date
│                         # spend vs effective limit; independent of the page date range).
├── types.ts              # Analytics API schema types
├── App.tsx / main.tsx
└── index.css             # Tailwind entry + custom utilities + the generic `@media print` block (visibility-based isolation of `.print-export`, `.print-hide` opt-out, auto-expanded `<details>`) used by Analyze/Cost/Executive
```

## Conventions

- **One file per page** in `src/pages/` — colocate its data hooks + aggregations.
- **Shared helpers live in `src/lib/`** — don't pollute page files with cross-cutting logic.
- **Every user email** is rendered through `maskEmail()` from `lib/format.ts`. Never emit the raw address.
- **Every new UI string** gets both `en` and `ko` keys in `src/lib/i18n.tsx` — TypeScript won't complain if you only add one but the missing locale will show the key in production. Do **not** hardcode strings into JSX `label`/`title`/`subtitle`/`hint`/`name` props (the Claude Code + Adoption pages each shipped with that bug — easy to miss because TS still compiles).
- **Charts**: use Recharts; stick to the Claude palette (`#D97757` primary, ink scale 50-900).
- **Formatting**: numbers via `fmtNum` / `fmtCompact` / `fmtPct`; money via `fmtCents` (input in cents, output USD).
- **Bundling Markdown content**: pages can import `*.md` text into the bundle with Vite's `?raw` query (used by `Changelog.tsx` for `CHANGELOG.md`). When you do this, also remove the file from `.dockerignore` — the production Docker build runs `vite build` and the `?raw` import will fail to resolve otherwise.
- **Save-as-PDF pattern**: tag the printable subtree with `.print-export` and any chrome inside it with `.print-hide`, then call `document.body.classList.add('app-print')` before `window.print()`. Listen for `afterprint` to clean up. Three pages (Analyze, Cost, Executive) share this one mechanism.
- **Sortable tables**: any per-row statistics table should use `useSortable` (`src/lib/useSortable.ts`) + `<SortableTh>` (`src/components/SortableTh.tsx`) rather than rolling its own sort state. Pass an accessor map (`Record<K, (item) => string | number | null>`) and an `initialKey` / `initialDir`. The hook handles asc/desc toggle, pins `null` values to the bottom regardless of direction, and routes string columns through `localeCompare` (so Korean labels sort by Hangul order). Five tables already use this — reuse, don't reinvent.
- **Group scope**: per-page tabs (`GroupTabs`, rendered right after `PageHeader`, URL-synced `?group=`) filter per-user pages to an admin-defined group; the old global sidebar selector was removed 2026-07. To scope a per-user page, render `<GroupTabs />` after the header, call `const { inGroup } = useGroupScope()` and guard each per-user aggregation loop with `if (!inGroup(r.user.email_address)) continue` (add `inGroup` to that `useMemo`'s deps). With no group selected `inGroup` returns `true` for everyone (no-op), so default behavior is unchanged. The `/api/groups` map is fetched once by `GroupScopeProvider` (in `App.tsx`) — never re-fetch it per page. Pages whose data has no per-user dimension render `<GroupScopeNote />` under the tabs (Adoption) or skip tabs entirely; Cost is **fully scoped in live mode** since 2026-07-12 — org-level cost_report/usage_report aggregates filter upstream via `rbac_group_ids[]` (`useGroupScope().groupId` → `useCostData(range, groupId)`, flagged by the neutral `<GroupScopeNote variant="scoped" />`), while per-user tables keep the email `inGroup` filter; in CSV mode or under UNMAPPED (no upstream id) it degrades to the old **partial** behavior (`variant="partial"`). Fully scoped + tabs: Users, UserProductivity, ClaudeCode, ClaudeChat, Office, Design, Productivity, UserSearch. Tabs + partial note (mixed org/per-user surfaces): Cowork (org summaries Adoption KPI + DAU/WAU/MAU trend stay org-wide), Cost, Agentic (spend section is org-wide cost_report). Tabs + full note (org-only data): Adoption. Note-only (no tabs): Overview, Trends, Executive, Compliance. Sidebar NavLinks re-append ?group= AND ?org= (Layout.tsx withGroup) so both selections survive page switches (the Changelog links do the same); switching org resets the group selection because the /api/groups map is per org.

## Adding a page

1. Create `src/pages/MyPage.tsx`.
2. Add the route in `src/App.tsx`.
3. Add the nav entry in `src/components/Layout.tsx` (`NAV` array).
4. Add `nav.my_page` + `nav.hint.my_page` keys in both `en` and `ko` dicts of `i18n.tsx`.
5. If the page has its own prose keys, also add a `my_page.*` section in both dicts.
