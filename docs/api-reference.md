# API Reference

All routes are served by the Express proxy (`server/index.js` + `server/aws.js`). Frontend calls them via the Vite dev proxy (dev) or same-origin (prod).

## Authentication

In production, the CloudFront distribution fronting the API sits behind a Cognito + Lambda@Edge gate (see [ADR-0001](decisions/0001-cognito-lambda-edge-auth.md)). Every unauthenticated request is `302`-redirected to `/oauth2/authorize`; after login the browser carries three HttpOnly cookies (`ccd_access`, `ccd_id`, `ccd_refresh`) which the `check-auth` edge function verifies on every request. No per-route auth code in Express — the edge enforces it uniformly.

Special path handlers (never gated by `check-auth`):

| Path | Purpose |
|------|---------|
| `/parseauth` | OAuth2 authorization-code callback. Exchanges `?code=` for tokens, sets cookies, redirects to the state-encoded return URL. |
| `/refreshauth` | Silent refresh via `refresh_token` cookie. On failure, clears cookies so `check-auth` re-runs the login flow. |
| `/signout` | Clears cookies + redirects to Cognito `/logout`. Rendered in the sidebar of the SPA. |

## Health

### `GET /api/health`

Returns key presence flags and Analytics API data constraints. `complianceKey` is `compliance` (dedicated key), **`analytics-fallback`** (no dedicated key — audit rides the Analytics key's `read:compliance_activities` scope, verified live 2026-07-03), or `none`.

## Analytics API (Enterprise key)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/analytics/summaries?starting_date=&ending_date=` | DAU/WAU/MAU, seat utilization, adoption rate. Server normalizes upstream `summaries` key → `data`. |
| GET | `/api/analytics/users?date=` | Per-user engagement + Claude Code productivity for a single day. |
| GET | `/api/analytics/users/range?starting_date=&ending_date=` | **S3-first** then live API fallback, parallel per-day fetch. Returns `days[]` plus a `cache` object (`s3_hits` / `live_calls`). |
| GET | `/api/analytics/skills?date=` | Distinct user counts per skill. |
| GET | `/api/analytics/skills/range?starting_date=&ending_date=` | Per-day fan-out of `/skills`. |
| GET | `/api/analytics/connectors?date=` | Distinct user counts per connector. |
| GET | `/api/analytics/connectors/range?starting_date=&ending_date=` | Per-day fan-out of `/connectors`. |
| GET | `/api/analytics/projects?date=` | Chat project usage (`/apps/chat/projects`). |
| GET | `/api/analytics/projects/range?starting_date=&ending_date=` | Per-day fan-out of `/projects`. |

## Admin API (Admin key required)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/admin/claude-code?starting_at=YYYY-MM-DD` | Per-user Claude Code usage with `model_breakdown` (tokens + estimated_cost in cents). Paginates server-side. |
| GET | `/api/admin/claude-code/range?starting_date=&ending_date=` | Fan-out of the single-day endpoint. |
| GET | `/api/admin/usage?starting_date=&ending_date=&bucket_width=1d&group_by=model` | Token usage grouped by the chosen dimension. |
| GET | `/api/admin/cost?starting_date=&ending_date=&group_by=description` | Cost breakdown in cents USD. |

## Compliance API (Compliance key required)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/compliance/activities?max=2000&pages=20&starting_date=&ending_date=&type=<event_type>&after_id=<cursor>` | Paginated audit events. The upstream `/v1/compliance/activities` endpoint uses `after_id=<last_event_id>` for cursor pagination (NOT a `next_page` token); the server derives the cursor from `data[-1].id` and stops paginating as soon as the oldest event on a page predates `starting_date`. Server-side cap defaults: `pages=20` / `max=2000` (sized to fit within the ~30 s ALB origin timeout — the cap was lowered from `pages=50/max=5000` in [ADR-0004](decisions/0004-compliance-pagination-prewarm.md)). Response includes `total_fetched`, `in_window`, `stop_reason` (`starting_date` / `max` / `has_more=false` / `cap` / `empty`) so the UI can warn when older events were truncated. A startup prewarm self-fetches the 7d / 14d / 30d windows on every ECS task boot and refreshes every 5 minutes — most user requests hit the upstream cache. |

## Cost (live API + CSV reconciliation)

See [ADR-0009](decisions/0009-live-user-cost.md) for the decision to promote `user_cost_report` as the primary per-user spend source and demote CSV to optional reconciliation.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cost/live?starting_date=&ending_date=` | **Live**: org-wide spend/tokens by `(product, model)` over the date range. Calls Anthropic's `/v1/organizations/analytics/cost_report` (USD + requests) and `/v1/organizations/analytics/usage_report` (tokens) with the analytics key, joined on `(product, model)` and reshaped to the same payload as `/cost/csv` (rows have empty `user_email` — analytics endpoints do not expose a per-user dimension). Adds a `daily` array of `{ date, model, spend, input, output, requests }` (per-date × model) — drives the daily-spend trends chart, the 30-day rolling projection, and the Executive page's spend trend area. Defaults to `[today−30, today]` (31 inclusive days — the upstream cost family rejects spans over 31 days). Returns 400 `analytics_key_required` when `ANTHROPIC_ANALYTICS_KEY` is missing — UI uses this to fall back to CSV. |
| GET | `/api/cost/users?starting_date=&ending_date=` | **Live per-user spend**: proxies `GET /v1/organizations/analytics/user_cost_report`, paginates (up to 50 pages / 50 000 rows), resolves its window via `resolveUserCostWindow` (`ending_date` clamps to **today** only — the upstream serves the 3-day buffer with partial data; an inverted pair pins `starting_date` back to `ending_date`), and returns `{ source: "live", period: { starting_date, ending_date }, data_refreshed_at, users: [...] }` sorted by `net_spend_usd` descending. Each user object: `{ email (RAW — mask at render via maskEmail), user_id, name, deleted, net_spend_usd, gross_spend_usd, requests }`. `amount` / `list_amount` are fractional cents → divided by 100 for USD. **No per-user token counts** (cost + requests only). `api_actor` rows (no email) are excluded. Returns 400 `analytics_key_required` if the Analytics key is missing; 502 `upstream_error` on upstream failures. |
| GET | `/api/cost/groups?starting_date=&ending_date=` | **Spend by RBAC group**: `cost_report` × `group_by[]=rbac_group_id` (shipped upstream 2026-07), paginated + reshaped via `aggregateGroupCost`. Returns `{ source, period, data_refreshed_at, groups: [{ group_id, label, spend_usd, requests }] (spend desc), ungrouped: { spend_usd, requests }, daily: [{ date, group_id, label, spend }] }`. Rows with a null group id are the genuinely-ungrouped remainder. Labels are `grp-<id suffix>` (`labelGroupIds`) — real names need a `read:rbac_groups`-scoped key. Same window rules as `/cost/users`. |
| GET | `/api/cost/csv` | **Reconciliation**: latest Spend Report CSV from `s3://<archive>/spend-reports/`, parsed + totals. Same response shape as `/api/cost/live` but `source: "csv"`, with no `daily` array. |
| GET | `/api/cost/efficiency?starting_date=&ending_date=` | Join of per-user spend + `users/range` → per-user economic productivity score. **Live by default** (v0.8.0+): queries `user_cost_report` for the exact selected range and joins on `email` with Analytics productivity data — no CSV-period activity-weighted scaling needed. Falls back to the Spend Report CSV path when `user_cost_report` is empty or unavailable. Response `source` is `"live+analytics"` (live path) or `"csv+analytics"` (CSV fallback). In live mode, per-user `prompt_tokens` / `completion_tokens` are 0 (no live source); `tokens_per_loc` is `null`. Date range optional; server clamps the whole window to `today − 3` **on purpose** (and pins `starting_date` ≤ `ending_date`): every metric here is spend ÷ productivity, and the `users/range` productivity source is hard-clamped to the 3-day buffer — mismatched windows would inflate $/LOC and skew the score. Headline-consistent full-range per-user spend comes from `/api/cost/users` instead. Score is **cost-efficiency v3** (`score_version:"3.0"`): response carries per-user `surface_scores` (code/cowork/office/design, each `[0,1]`), `productivity_index`, `efficiency_raw`, `score_components` (value/acceptance/delivery/breadth) + `economic_productivity_score` (0–100), and `totals.median_score` (cohort-median headline KPI). v3 normalizes each surface's output within its own **active** cohort, blends only active surfaces (coverage-aware), divides by total per-user $, then re-normalizes across active users. |
| POST | `/api/cost/upload` | Multipart CSV upload (field `file`). 25 MB cap. Validates required columns (`user_email`, `product`, `model`, `total_requests`, `total_prompt_tokens`, `total_completion_tokens`, `total_net_spend_usd`). Filenames matching `spend-report-+YYYY-MM-DD-to-YYYY-MM-DD.csv` are preserved; anything else is renamed to a safe today-derived name. |
| GET | `/api/cost/uploads` | Lists all CSVs under `spend-reports/` with parsed period, size, and `last_modified`, newest first. Used by the dashboard's upload history + overlap detection. |
| DELETE | `/api/cost/uploads/:file` | Removes a single CSV. Filename regex-checked (`[A-Za-z0-9._-]+\.csv`) to block path traversal. |

## Groups (visibility mapping)

Admin-defined `email→group` mapping for group-level dashboard scoping (v1.4.0). The Analytics API's `rbac_group_id`/`claude_project_id` group dimensions return HTTP 400 ("not yet supported") and user records carry no group field, so groups come from an uploaded CSV stored latest-wins at `s3://<archive>/group-map/`. Cognito-edge-gated like the cost routes.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/groups` | Returns the group mapping: `{ source: "live"|"auto"|"empty", file, groups: string[], map: Record<emailLower, group> }`. `live` = latest admin CSV under `group-map/` (wins when present — carries admin-chosen names). **`auto`** = no CSV → the map is derived from live `user_cost_report` × `rbac_group_id` (default 31-day window; each user → their max-spend group, labels `grp-<id suffix>`, plus `group_ids: Record<label, rbac_group_id>` and `period`). Neither available → `{ source: "empty", groups: [], map: {} }` (200, not an error). Works without `ARCHIVE_S3_BUCKET` (auto path only needs the Analytics key). Raw lowercased emails for client-side matching; the UI still renders every email via `maskEmail`. Consumed by the `useGroupScope` hook + the sidebar Group-scope selector. |
| POST | `/api/groups/upload` | Multipart CSV upload (field `file`, reuses the 25 MB / `.csv` multer guard). Requires `email` + `group` columns → 400 `schema_mismatch` otherwise; 400 `empty_mapping` if no valid rows. Stored latest-wins as `group-map/group-map-<YYYY-MM-DD>.csv`. Response `{ ok, file, rows, groups }`. |

## AI Chatbot (Bedrock tool-use)

See [ADR-0008](decisions/0008-tool-use-chatbot.md) for the architecture decision.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/chat/stream` | Multi-turn tool-use chatbot. Server-sent events stream. Body: `{ message, history[], locale }` — `history` is up to 12 prior turns as `[{ role: "user"|"assistant", text: string }]`; `locale` is `"en"` or `"ko"`. Runs a Bedrock `ConverseStreamCommand` tool-use loop (max 4 hops). Emails in tool results are masked before they reach the model. |

### SSE event types for `/api/chat/stream`

| Event | Payload | Meaning |
|-------|---------|---------|
| `status` | `{ message }` | Transient status text (e.g. tool-call limit reached). |
| `tool_call` | `{ id, name, input }` | The model is calling a tool; `input` has sensitive fields redacted. |
| `tool_result` | `{ id, name, ok, rowCount }` | Tool execution finished; `ok=false` means the tool errored. |
| `text` | `{ text }` | A streamed text delta from the model's response. |
| `followups` | `{ suggestions: string[] }` | Up to 3 dynamic follow-up questions generated after the answer. |
| `error` | `{ message, hint }` | Fatal stream error; the connection ends. |
| `done` | `{ ok, modelId, hops }` | Stream complete; `hops` is the number of tool-call rounds used. |

### Tools available to the model

| Tool name | Data source | Purpose |
|-----------|-------------|---------|
| `get_analytics_overview` | Live Analytics API | Org-wide adoption snapshot: DAU/WAU/MAU, assigned seats, top skills and connectors. No per-user rows and no USD cost. |
| `run_athena_sql` | S3 archive via Athena | One read-only `SELECT`/`WITH` over the four Glue tables (`claude_code_analytics`, `summaries_daily`, `skills_daily`, `connectors_daily`). Goes through `sanitizeAthenaQuery`; results capped at 200 rows. Partition column `date` is `varchar` — use plain string literals, not `DATE '…'`. |
| `get_cost_summary` | Live Analytics API | Org-wide spend in USD + tokens, grouped by product and model, over an optional date range. No per-user cost dimension (see [ADR-0003](decisions/0003-hybrid-live-cost.md)). |
| `search_users` | Live Analytics API snapshot | Top Claude Code contributors ranked by LOC + commits + PRs, with tool acceptance rate. Emails are masked. Supports optional `query` (email substring) and `limit` (1–50). |

## Archive (Athena)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/archive/query` | Body `{ query }`. Only `SELECT` / `WITH` allowed (sanitizer in `server/aws.js` rejects multi-statement queries, forbidden keywords, and any FROM/JOIN target outside the four allowed tables). The polling budget is 60 seconds — beyond that the route throws `"Athena query did not finish within 60 s. Try a narrower date range."` rather than calling `GetQueryResultsCommand` on a still-RUNNING query (which previously surfaced as a generic `athena_error`). Note: the partition column `date` is `varchar`, so filter with plain string literals (`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`) — wrapping in `DATE '…'` raises `TYPE_MISMATCH: Cannot check if varchar is BETWEEN date and date` on Athena Engine v3. The `run_athena_sql` chat tool and the Archive page's pre-filled query both enforce the same rule. Returns rows array. |

## Response shape conventions

- All successful JSON responses include a `source` field where relevant: `"live"`, `"csv"`, `"s3"`, `"mock"`, `"upstream_error"`.
- Errors use `{ error: "<code>", message: "<human text>" }`.
- Pagination cursor names are **per-endpoint** — most Analytics + Admin routes paginate via `body.next_page`, but **Compliance** uses `?after_id=<last_event_id>` (no `next_page` field is ever returned). Always confirm before wiring a new proxy route; relying on `next_page` against Compliance silently breaks pagination after page 1.
- **Date clamping**: the proxy clamps any incoming `starting_date` / `ending_date` to `today - 3` (UTC) before calling the Analytics *engagement* + Admin upstreams (those APIs return HTTP 400 inside the 3-day finalization buffer). Callers can pass `today` as `ending_date` on the picker side without triggering upstream errors; those responses simply cover up through `today - 3`. **Exception — the cost family**: `cost_report` / `usage_report` / `user_cost_report` serve the buffer days with *partial* data (verified live 2026-07-03), so the cost routes cover the full selected range up to `today`: `/api/cost/users` and `/api/cost/groups` resolve their windows via `resolveUserCostWindow` (ending ≤ today, inverted pairs pinned); `/api/cost/live` passes dates through `fetchCostSummary` (no clamp; defaults `[today−30, today]`). Note the cost family rejects spans > 31 days — longer selections fall back to the CSV path. `/api/cost/efficiency` still clamps to `today - 3` deliberately, to stay window-aligned with its `users/range` productivity join. Compliance endpoints are NOT clamped — they're real-time.
