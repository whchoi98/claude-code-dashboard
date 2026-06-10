# Live Per-User Cost via `user_cost_report` — Design

- **Status**: Proposed
- **Date**: 2026-06-10
- **Owners**: @whchoi98
- **Resolves**: the per-user limitation recorded in [ADR-0003](../../decisions/0003-hybrid-live-cost.md) (Negative + Follow-ups). Will be recorded as ADR-0009.

## Context

ADR-0003 established the hybrid Cost page: the org-wide live Analytics endpoints
(`cost_report` + `usage_report`, joined on `(product, model)`) for totals and the
trend chart, with a manually-uploaded **Spend Report CSV** as the only source of
**per-user** spend (the live `cost_report` `group_by[]` accepts no actor/user
dimension). ADR-0003's explicit follow-up: *"If Anthropic exposes a per-user
spend endpoint … re-introduce the live Top-N tables."*

That endpoint now exists. **Verified live** against this deployment's Analytics
key (`sk-ant-api01`) on 2026-06-10:

```
GET /v1/organizations/analytics/user_cost_report?starting_at=…&ending_at=…&limit=…  → 200
{
  organization_id, has_more, next_page, data_refreshed_at,
  data: [
    {
      actor: { type:"user_actor", user_id, name, email, deleted },
      currency: "USD",
      amount:      "<decimal string, fractional CENTS, net (after discount)>",
      list_amount: "<decimal string, fractional CENTS, gross (pre-discount)>",
      requests:    <int>,
      product, model, context_window, inference_geo, speed, cost_type, token_type,  // null unless grouped
      starting_at, ending_at  // null unless bucketed
    }, …
  ]
}
```

- Results are **sorted by amount descending**. Pagination is the standard
  `?page=<cursor>` / `next_page` / `has_more` (same as other Analytics endpoints).
- `amount` is in **fractional cents** (decimal string) — same convention as
  `cost_report.amount`: `parseFloat(amount) / 100` for USD.
- **Confirmed negative:** `cost_report` with `group_by[]=actor` → **HTTP 400**;
  allowed `group_by[]` values are exactly `product, model, context_window,
  inference_geo, speed, rbac_group_id, claude_project_id, cost_type, token_type`.
  So per-user cost is available **only** via the dedicated `user_cost_report`
  endpoint — not as a `cost_report` dimension.
- **Load-bearing limitation:** `user_cost_report` returns per-user **USD cost +
  request count only — NO per-user token counts.** Per-user token granularity
  remains available only from the CSV.

## Goals

- Add live per-user spend so the Cost page's per-user Top-N tables and the
  `/cost/efficiency` view work **without a CSV upload** (CSV becomes optional).
- Keep the CSV path as an optional fallback for per-user **token** granularity
  and for billing-grade reconciliation older than the live API's correction
  window. (Chosen scope: "full live + CSV optional retention" — not removal.)

## Non-goals

- Removing the CSV upload path (routes, `CsvUploader`, S3 `spend-reports/`). It
  stays, demoted to optional.
- A live per-user **token** source — none exists in the Analytics family
  (`user_cost_report` is cost-only; `usage_report` has no actor dimension).
- Reviving the Admin-key Claude Code per-user path (`/v1/organizations/usage_report/claude_code`)
  — workspace-scoped and empty in this account (ADR-0003 history).

## Decisions (recorded from brainstorming)

| # | Decision | Choice |
|---|---|---|
| Scope | how far to remove CSV | **Full live + CSV optional retention** (per-user tables + efficiency go live; CSV kept as fallback) |
| Token columns (live) | no per-user tokens from live | Render `—` in live mode; primary efficiency metric becomes **`spend_per_loc`**; `tokens_per_loc` shown only when CSV present |
| Efficiency spend source | CSV vs live | **Live by default** (range-exact `user_cost_report`); fall back to CSV path when `user_cost_report` is empty/unavailable |
| Range scaling | CSV-period denominator hack | **Dropped in live path** — `user_cost_report` is queried for the exact requested range, so no activity-weighted re-scaling is needed |
| ADR | new vs amend | **New ADR-0009**, references ADR-0003 |

## API surface (new + changed)

### `GET /api/cost/users?starting_date=&ending_date=` (NEW)

Proxies `user_cost_report`. Clamps `ending_date` to today−3 via the existing
`clampAnalyticsEnd` convention. Paginates all pages (cap 50, respecting the
60 req/min Analytics budget). Returns **raw `email`** in the response — exactly
like the existing `/cost/efficiency` and `/analytics/users/range` endpoints,
which the Cognito-protected frontend masks at render time via `maskEmail`
(`src/lib/format.ts`). Masking must happen at the render layer, **not** in this
proxy, because the live efficiency join (below) keys on `email` and must match
the raw `email_address` returned by `/analytics/users/range` — pre-masking here
would silently break that join.

Response:
```jsonc
{
  "source": "live",
  "period": { "starting_date": "…", "ending_date": "…" },
  "data_refreshed_at": "…",
  "users": [
    { "email": "alice@acme.com", "user_id": "user_…", "name": "…",
      "net_spend_usd": 117.58, "gross_spend_usd": 117.58, "requests": 52110 }
  ]
}
```
(Cost.tsx renders every `email` through `maskEmail` per the project convention —
verify the per-user table render path masks before display.)
On missing key → 400 `analytics_key_required`; on upstream non-2xx → 502
`upstream_error` with the upstream body (same error convention as `/cost/live`).

### `GET /api/cost/efficiency` (CHANGED — add live path)

Refactor the handler into:
- `fetchSpendByEmailLive({starting,ending})` — builds `Map<email,{spend,requests}>`
  from `user_cost_report` for the **exact range** (no CSV-period scaling). Tokens
  unavailable → omitted.
- `fetchSpendByEmailCsv()` — the existing CSV aggregation (spend + tokens),
  retained as fallback.
- `joinProductivity(spendByEmail, range)` — the existing analytics `users/range`
  productivity aggregation + join (steps 4–6 today), unchanged except it consumes
  whichever spend map it's given and computes `spend_per_loc`.

Default to the live spend map; if `user_cost_report` returns no users (or errors),
fall back to the CSV path. Response gains `"source": "live" | "csv"`; per-user
`prompt_tokens`/`completion_tokens`/`tokens_per_loc` are `null` in live mode.

## Component changes

### Server (`server/aws.js`)
- Add `fetchUserCostReport({starting,ending})` helper (paginate; returns **raw**
  emails for the join) — shared by `/api/cost/users` and the live efficiency path.
- Add `router.get('/cost/users', …)`.
- Refactor `/cost/efficiency` per above (live default, CSV fallback,
  `spend_per_loc`, drop range scaling on the live path). Keep CSV helpers
  (`parseCsv`, the S3 read) for the fallback.

### Frontend (`src/pages/Cost.tsx`)
- The per-user Top-N tables already source from
  `userRowsForTop = effUserRows ?? csvUserRows ?? agg.userRows`. With efficiency
  live, `effUserRows` populates in live mode → tables light up. No new gating.
- Token columns: rely on existing `fmtNum(null) → "—"`; surface `spend_per_loc`
  as the efficiency column (fall back to `tokens_per_loc` when present).
- `distinct_users` KPI: in live mode, populate from the efficiency/`/cost/users`
  user count (was `0` / hidden) → show "N users · M models" live.
- `EfficiencyUser` / `EfficiencyResp` types gain `spend_per_loc: number|null` and
  the resp gains `source`. Token fields become `number|null`.

### Types
- `EfficiencyUser.{prompt_tokens,completion_tokens,tokens_per_loc}` → `… | null`.
- Add `EfficiencyUser.spend_per_loc: number | null`.
- Add `EfficiencyResp.source: 'live' | 'csv'`.

### Documentation
- `docs/anthropic-api-fields.md` — add a `user_cost_report` subsection under §2
  (cost family): path, params, the per-result fields, the cents convention, the
  no-token caveat, and the `cost_report group_by=actor → 400` note.
- `docs/api-reference.md` — document `GET /api/cost/users`; note efficiency's live
  default + CSV fallback.
- `docs/decisions/0009-live-user-cost.md` — new ADR.
- `server/CLAUDE.md` / `src/CLAUDE.md` — note `/cost/users` + live efficiency.
- `CHANGELOG.md` + `package.json` — v0.8.0.

## Error handling
- `/cost/users`: missing key → 400; upstream non-2xx → 502 + upstream body;
  pagination cap reached → return what was collected + `log` the truncation
  (never silently cap).
- `/cost/efficiency`: live spend empty/error → fall back to CSV; CSV also absent →
  the existing 404 `no_spend_report` (now only reachable when BOTH live and CSV
  are unavailable).
- Date clamping: `clampAnalyticsEnd` on every `user_cost_report` call.

## Test strategy
### Unit (`tests/server/`)
- `mergeUserCostPages()` — concatenate paged `data[]`, stop on `has_more=false`,
  respect the page cap.
- `userCostToUsers()` — map a `user_cost_report` page to the `users[]` shape:
  `amount`/`list_amount` cents→USD (`parseFloat`/100), raw `email`/`user_id`/`name`
  passed through, `requests` passed, `deleted` actors handled.
- live efficiency join — `Map<email,spend>` × productivity join on email; token
  fields `null`; `spend_per_loc = spend / loc_added` (null when `loc_added=0`).
### Manual smoke (`npm run dev`, real key)
- `/api/cost/users` returns masked per-user spend, sorted, paginated.
- Cost page in live mode (no CSV) shows the per-user Top-N cost table + a
  non-zero `distinct_users` KPI; token columns show `—`.
- Upload a CSV → token columns populate; live remains the spend source unless
  user_cost_report is empty.
### Regression
- `node --check server/*.js`; `npm run build`; existing cost-reshape +
  sanitizer + chat-tools tests stay green.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Raw emails leak | Render-layer masking via frontend `maskEmail`, consistent with the existing `/cost/efficiency` + `/analytics/users/range` endpoints (server can't pre-mask without breaking the email join); raw emails stay inside the Cognito-protected API, never logged, never in LLM output. Confirm Cost.tsx masks the per-user table emails. |
| Large orgs → many pages → rate limit | page cap (50) + `log` truncation; 60/min budget respected; one range query per request |
| `amount` unit confusion (cents vs USD) | `/100` with `parseFloat`, mirroring the tested `cost_report` reshape; unit test |
| Live efficiency missing tokens surprises users | `source` flag + `—` rendering + CHANGELOG/ADR note; CSV restores tokens |
| Behavior change to `/cost/efficiency` blast radius | live path is additive with CSV fallback; CSV path code retained, not deleted |

## Estimated footprint
- Server: ~+160 / −40 in `server/aws.js` (new helper + route + efficiency refactor).
- Frontend: ~+30 / −10 in `src/pages/Cost.tsx` + small `types` edits.
- Docs: 1 new ADR + 4 doc edits + CHANGELOG. Tests: ~2 new `tests/server/*.mjs`.

## Open questions
- None. Token columns confirmed `—` in live; efficiency defaults live with CSV
  fallback; CSV retained.
