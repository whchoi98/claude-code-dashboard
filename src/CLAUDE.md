# src — React SPA (Vite)

## Role

Browser-side SPA. Renders the 18 dashboard pages, handles i18n / date range / email masking, and talks to the Express proxy under `/api`.

## Layout

```
src/
├── components/           # shared UI
│   ├── Layout.tsx        # h-screen flex wrapper (sidebar pinned, main scrolls in its own pane); NAV array, language toggle, health badges, version badge → /changelog, static AWS run-rate label
│   ├── ClaudeIcon.tsx    # animated asterisk mark
│   ├── KpiCard.tsx · ChartCard.tsx · PageHeader.tsx · LoadingState.tsx
│   ├── UserDetailPanel.tsx   # right-side slide-in drill-down; follows the page date range (range prop from Users/UserProductivity), adds per-product AND per-model spend cards (+prev-period Δ on products) and skills cards (org top skills $/use — the API has no user×skill dimension); org-wide cost/skills fetches dedupe per session via module-level panelFetchCache
│   ├── DateRangeControl.tsx  # 7d/14d/30d/custom popover (maxEnd = today; footnote explains the Analytics 3-day partial-count buffer)
│   ├── CsvUploader.tsx       # multipart upload + preview + period-overlap warning
│   ├── GroupTabs.tsx         # per-page group scope tabs (All · groups · Unmapped) + email→group CSV upload; URL-synced via useGroupScope. Replaced the former sidebar GroupControl (removed 2026-07) — rendered right after PageHeader on the 10 group-aware pages
│   ├── GroupScopeNote.tsx    # amber group-scope banner; self-hides when no group selected. Default = "not applied — org-wide data" (note-only org pages); variant="partial" = "per-user parts scoped, org aggregates stay org-wide" (Cowork · Cost · Agentic)
│   ├── SortableTh.tsx        # ▲/▼ header cell — pairs with useSortable; click to sort, click again to flip
│   ├── Markdown.tsx      # react-markdown@10 + remark-gfm for AI output
│   └── chat/             # tool-use chatbot UI (shared by Analyze page + FloatingChat)
│       ├── ChatPanel.tsx     # shared chat surface — `variant="page"` (full) | `variant="widget"` (floating); accepts a `ChatStream` prop
│       ├── MessageList.tsx   # message bubbles, typing dots, tool-call badges (running/done/error), markdown rendering
│       ├── ChatComposer.tsx  # textarea + Send / Stop buttons; Enter to send, Shift-Enter for newline
│       └── FloatingChat.tsx  # fixed-position launcher button + modal panel; mounted globally in Layout.tsx
├── pages/                # one file per route — 18 total (Analyze.tsx rebuilt as a chatbot page around ChatPanel; MD/PDF export toolbar retained; Agentic.tsx = actions-per-prompt delegation metrics + org spend context)
├── lib/
│   ├── i18n.tsx          # en/ko toggle + dictionary
│   ├── useDateRange.ts   # URL-synced state (?range=7d|14d|30d|custom, ?start=, ?end=). Default preset = 7d. maxEnd = today (UTC).
│   ├── GroupScopeProvider.tsx # fetches the email→group map (/api/groups) ONCE, shares it via context; wraps <Routes> in App.tsx. Any non-'empty' source lights up the per-page GroupTabs: 'live' (admin CSV) · 'members' (real RBAC membership via the Compliance members endpoint) · 'auto' (spend-derived fallback from user_cost_report×rbac_group_id)
│   ├── useGroupScope.ts  # reads GroupScopeProvider context + ?group= URL state → { group, setGroup, groups, hasMap, loading, inGroup, refetch }. inGroup(email): ''→all · UNMAPPED→not-in-map · else map[email_lower]===group
│   ├── api.ts            # useFetch<T>(url) — single-URL fetch, exposes refetch + source/reason from response
│   ├── useChatStream.ts  # multi-turn chat state + SSE parser; sends `POST /api/chat/stream` with { message, history[], locale }; parses status/tool_call/tool_result/text/followups/error/done events; exports ChatMessage, ToolCall, ChatStream types
│   ├── useHealth.ts
│   ├── useSortable.ts    # bidirectional column-sort state for tables; nulls always pinned to bottom; strings via localeCompare, numbers by value
│   └── format.ts         # fmtNum / fmtCents / fmtDate / maskEmail / acceptRate
│
│ Page-local hooks (not in lib/ — kept colocated with the consumer page):
│   - useCostData(range)  # composite: tries /api/cost/live first, falls back to /api/cost/csv;
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
- **Group scope**: per-page tabs (`GroupTabs`, rendered right after `PageHeader`, URL-synced `?group=`) filter per-user pages to an admin-defined group; the old global sidebar selector was removed 2026-07. To scope a per-user page, render `<GroupTabs />` after the header, call `const { inGroup } = useGroupScope()` and guard each per-user aggregation loop with `if (!inGroup(r.user.email_address)) continue` (add `inGroup` to that `useMemo`'s deps). With no group selected `inGroup` returns `true` for everyone (no-op), so default behavior is unchanged. The `/api/groups` map is fetched once by `GroupScopeProvider` (in `App.tsx`) — never re-fetch it per page. Pages whose data has no per-user dimension render `<GroupScopeNote />` under the tabs (Adoption) or skip tabs entirely; Cost is **partially scoped** — its per-user tables/charts (Top-10s, chargeback, spend limits, efficiency) honor the group while org-level cost_report aggregates stay org-wide, flagged by `<GroupScopeNote variant="partial" />`. Fully scoped + tabs: Users, UserProductivity, ClaudeCode, Office, Design, Productivity, UserSearch. Tabs + partial note (mixed org/per-user surfaces): Cowork (org summaries Adoption KPI + DAU/WAU/MAU trend stay org-wide), Cost, Agentic (spend section is org-wide cost_report). Tabs + full note (org-only data): Adoption. Note-only (no tabs): Overview, Trends, Executive, Compliance. Sidebar NavLinks re-append ?group= (Layout.tsx withGroup) so the selection survives page switches.

## Adding a page

1. Create `src/pages/MyPage.tsx`.
2. Add the route in `src/App.tsx`.
3. Add the nav entry in `src/components/Layout.tsx` (`NAV` array).
4. Add `nav.my_page` + `nav.hint.my_page` keys in both `en` and `ko` dicts of `i18n.tsx`.
5. If the page has its own prose keys, also add a `my_page.*` section in both dicts.
