# src — React SPA (Vite)

## Role

Browser-side SPA. Renders the 14 dashboard pages, handles i18n / date range / email masking, and talks to the Express proxy under `/api`.

## Layout

```
src/
├── components/           # shared UI
│   ├── Layout.tsx        # h-screen flex wrapper (sidebar pinned, main scrolls in its own pane); NAV array, language toggle, health badges, version badge → /changelog, static AWS run-rate label
│   ├── ClaudeIcon.tsx    # animated asterisk mark
│   ├── KpiCard.tsx · ChartCard.tsx · PageHeader.tsx · LoadingState.tsx
│   ├── UserDetailPanel.tsx   # right-side slide-in (7-day drill-down)
│   ├── DateRangeControl.tsx  # 7d/14d/30d/custom popover (maxEnd = today; footnote explains the Analytics 3-day partial-count buffer)
│   ├── CsvUploader.tsx       # multipart upload + preview + period-overlap warning
│   ├── GroupControl.tsx      # sidebar group selector (All · groups · Unmapped) + email→group CSV upload; URL-synced via useGroupScope
│   ├── GroupScopeNote.tsx    # amber "group scope not applied — org-wide data" banner; self-hides when no group selected; on the 6 org pages
│   ├── SortableTh.tsx        # ▲/▼ header cell — pairs with useSortable; click to sort, click again to flip
│   ├── Markdown.tsx      # react-markdown@10 + remark-gfm for AI output
│   └── chat/             # tool-use chatbot UI (shared by Analyze page + FloatingChat)
│       ├── ChatPanel.tsx     # shared chat surface — `variant="page"` (full) | `variant="widget"` (floating); accepts a `ChatStream` prop
│       ├── MessageList.tsx   # message bubbles, typing dots, tool-call badges (running/done/error), markdown rendering
│       ├── ChatComposer.tsx  # textarea + Send / Stop buttons; Enter to send, Shift-Enter for newline
│       └── FloatingChat.tsx  # fixed-position launcher button + modal panel; mounted globally in Layout.tsx
├── pages/                # one file per route — 14 total (Analyze.tsx rebuilt as a chatbot page around ChatPanel; MD/PDF export toolbar retained)
├── lib/
│   ├── i18n.tsx          # en/ko toggle + dictionary
│   ├── useDateRange.ts   # URL-synced state (?range=7d|14d|30d|custom, ?start=, ?end=). Default preset = 7d. maxEnd = today (UTC).
│   ├── GroupScopeProvider.tsx # fetches the email→group map (/api/groups) ONCE, shares it via context; wraps <Routes> in App.tsx. Accepts source 'live' (admin CSV) AND 'auto' (server-derived from user_cost_report×rbac_group_id, labels grp-<id suffix>) — both light up the sidebar selector
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
│                         # A cost.top.live_caveat note shows in live-only mode explaining the token gap.
│                         # The Cost page also renders a "Cost by Group" card from /api/cost/groups
│                         # (native rbac_group_id attribution; labels grp-<id suffix> until a
│                         # read:rbac_groups key exists for name resolution).
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
- **Group scope**: a global selector (`GroupControl` in the sidebar, URL-synced `?group=`) filters per-user pages to an admin-defined group. To scope a per-user page, call `const { inGroup } = useGroupScope()` and guard each per-user aggregation loop with `if (!inGroup(r.user.email_address)) continue` (add `inGroup` to that `useMemo`'s deps). With no group selected `inGroup` returns `true` for everyone (no-op), so default behavior is unchanged. The `/api/groups` map is fetched once by `GroupScopeProvider` (in `App.tsx`) — never re-fetch it per page. Org-level pages that can't honor the scope (no per-user dimension, or org-only aggregates like daily summaries / live cost) render `<GroupScopeNote />` after their `PageHeader` instead. Scoped: Users, UserProductivity, ClaudeCode, Cowork (per-user parts), Office, Design, Productivity, UserSearch. Note-only (org): Overview, Trends, Adoption, Executive, Cost, Compliance.

## Adding a page

1. Create `src/pages/MyPage.tsx`.
2. Add the route in `src/App.tsx`.
3. Add the nav entry in `src/components/Layout.tsx` (`NAV` array).
4. Add `nav.my_page` + `nav.hint.my_page` keys in both `en` and `ko` dicts of `i18n.tsx`.
5. If the page has its own prose keys, also add a `my_page.*` section in both dicts.
