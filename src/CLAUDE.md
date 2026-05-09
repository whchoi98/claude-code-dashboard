# src — React SPA (Vite)

## Role

Browser-side SPA. Renders the 14 dashboard pages, handles i18n / date range / email masking, and talks to the Express proxy under `/api`.

## Layout

```
src/
├── components/           # shared UI
│   ├── Layout.tsx        # sidebar (NAV array, language toggle, health badges, version badge → /changelog, static AWS run-rate label)
│   ├── ClaudeIcon.tsx    # animated asterisk mark
│   ├── KpiCard.tsx · ChartCard.tsx · PageHeader.tsx · LoadingState.tsx
│   ├── UserDetailPanel.tsx   # right-side slide-in (7-day drill-down)
│   ├── DateRangeControl.tsx  # 7d/14d/30d/custom popover
│   ├── CsvUploader.tsx       # multipart upload + preview + period-overlap warning
│   └── Markdown.tsx      # react-markdown@10 + remark-gfm for AI output
├── pages/                # one file per route — 14 total
├── lib/
│   ├── i18n.tsx          # en/ko toggle + dictionary
│   ├── useDateRange.ts   # URL-synced state (?range=7d|14d|30d|custom, ?start=, ?end=). Default preset = 7d.
│   ├── api.ts            # useFetch<T>(url) — single-URL fetch, exposes refetch + source/reason from response
│   ├── useHealth.ts
│   └── format.ts         # fmtNum / fmtCents / fmtDate / maskEmail / acceptRate
│
│ Page-local hooks (not in lib/ — kept colocated with the consumer page):
│   - useCostData(range)  # composite: tries /api/cost/live first, falls back to /api/cost/csv;
│                         # exposes csvData separately so per-user widgets can use CSV in live mode
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

## Adding a page

1. Create `src/pages/MyPage.tsx`.
2. Add the route in `src/App.tsx`.
3. Add the nav entry in `src/components/Layout.tsx` (`NAV` array).
4. Add `nav.my_page` + `nav.hint.my_page` keys in both `en` and `ko` dicts of `i18n.tsx`.
5. If the page has its own prose keys, also add a `my_page.*` section in both dicts.
