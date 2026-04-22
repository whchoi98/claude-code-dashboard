# src — React SPA (Vite)

## Role

Browser-side SPA. Renders the 11 dashboard pages, handles i18n / date range / email masking, and talks to the Express proxy under `/api`.

## Layout

```
src/
├── components/           # shared UI
│   ├── Layout.tsx        # sidebar + language toggle + health badges
│   ├── ClaudeIcon.tsx    # animated asterisk mark
│   ├── KpiCard.tsx · ChartCard.tsx · PageHeader.tsx · LoadingState.tsx
│   ├── UserDetailPanel.tsx   # right-side slide-in (7-day drill-down)
│   ├── DateRangeControl.tsx  # 7d/14d/30d/custom popover
│   └── Markdown.tsx      # react-markdown@10 + remark-gfm for AI output
├── pages/                # one file per route
├── lib/
│   ├── i18n.tsx          # en/ko toggle + dictionary
│   ├── useDateRange.ts   # URL-synced state
│   ├── useFetch.ts / api.ts
│   ├── useHealth.ts
│   └── format.ts         # fmtNum / fmtCents / fmtDate / maskEmail / acceptRate
├── types.ts              # Analytics API schema types
├── App.tsx / main.tsx
└── index.css             # Tailwind entry + custom utilities
```

## Conventions

- **One file per page** in `src/pages/` — colocate its data hooks + aggregations.
- **Shared helpers live in `src/lib/`** — don't pollute page files with cross-cutting logic.
- **Every user email** is rendered through `maskEmail()` from `lib/format.ts`. Never emit the raw address.
- **Every new UI string** gets both `en` and `ko` keys in `src/lib/i18n.tsx` — TypeScript won't complain if you only add one but the missing locale will show the key in production.
- **Charts**: use Recharts; stick to the Claude palette (`#D97757` primary, ink scale 50-900).
- **Formatting**: numbers via `fmtNum` / `fmtCompact` / `fmtPct`; money via `fmtCents` (input in cents, output USD).

## Adding a page

1. Create `src/pages/MyPage.tsx`.
2. Add the route in `src/App.tsx`.
3. Add the nav entry in `src/components/Layout.tsx` (`NAV` array).
4. Add `nav.my_page` + `nav.hint.my_page` keys in both `en` and `ko` dicts of `i18n.tsx`.
5. If the page has its own prose keys, also add a `my_page.*` section in both dicts.
