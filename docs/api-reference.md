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

Returns key presence flags (`analytics | admin | compliance | none`) and Analytics API data constraints.

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

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cost/live?starting_date=&ending_date=` | **Live**: org-wide spend/tokens by `(product, model)` over the date range. Calls Anthropic's `/v1/organizations/analytics/cost_report` (USD + requests) and `/v1/organizations/analytics/usage_report` (tokens) with the analytics key, joined on `(product, model)` and reshaped to the same payload as `/cost/csv` (rows have empty `user_email` — analytics endpoints do not expose a per-user dimension). Adds a `daily` array of `{ date, model, spend, input, output, requests }` (per-date × model) — drives the daily-spend trends chart, the 30-day rolling projection, and the Executive page's spend trend area. Defaults to `[today−31, today]`. Returns 400 `analytics_key_required` when `ANTHROPIC_ANALYTICS_KEY` is missing — UI uses this to fall back to CSV. |
| GET | `/api/cost/csv` | **Reconciliation**: latest Spend Report CSV from `s3://<archive>/spend-reports/`, parsed + totals. Same response shape as `/api/cost/live` but `source: "csv"`, with no `daily` array. |
| GET | `/api/cost/efficiency?starting_date=&ending_date=` | Join of Spend CSV + `users/range` → per-user economic productivity score. Date range is optional; defaults to the CSV's native period. Server clamps `ending_date` to `today − 3` (Analytics API buffer). |
| POST | `/api/cost/upload` | Multipart CSV upload (field `file`). 25 MB cap. Validates required columns (`user_email`, `product`, `model`, `total_requests`, `total_prompt_tokens`, `total_completion_tokens`, `total_net_spend_usd`). Filenames matching `spend-report-+YYYY-MM-DD-to-YYYY-MM-DD.csv` are preserved; anything else is renamed to a safe today-derived name. |
| GET | `/api/cost/uploads` | Lists all CSVs under `spend-reports/` with parsed period, size, and `last_modified`, newest first. Used by the dashboard's upload history + overlap detection. |
| DELETE | `/api/cost/uploads/:file` | Removes a single CSV. Filename regex-checked (`[A-Za-z0-9._-]+\.csv`) to block path traversal. |

## AI Analyze (Bedrock)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/analyze` | Server-sent events stream. Body: `{ question, locale, mode }` where `mode ∈ {direct, sql}`. Emits `status`, `sql`, `rows`, `text`, `stop`, `done`, `error` events. |

## Archive (Athena)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/archive/query` | Body `{ query }`. Only `SELECT` / `WITH` allowed (sanitizer in `server/aws.js` rejects multi-statement queries, forbidden keywords, and any FROM/JOIN target outside the four allowed tables). The polling budget is 60 seconds — beyond that the route throws `"Athena query did not finish within 60 s. Try a narrower date range."` rather than calling `GetQueryResultsCommand` on a still-RUNNING query (which previously surfaced as a generic `athena_error`). Note: the partition column `date` is `varchar`, so filter with plain string literals (`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`) — wrapping in `DATE '…'` raises `TYPE_MISMATCH: Cannot check if varchar is BETWEEN date and date` on Athena Engine v3. The `/api/analyze` SQL-mode prompt enforces the same rule. Returns rows array. |

## Response shape conventions

- All successful JSON responses include a `source` field where relevant: `"live"`, `"csv"`, `"s3"`, `"mock"`, `"upstream_error"`.
- Errors use `{ error: "<code>", message: "<human text>" }`.
- Pagination cursor names are **per-endpoint** — most Analytics + Admin routes paginate via `body.next_page`, but **Compliance** uses `?after_id=<last_event_id>` (no `next_page` field is ever returned). Always confirm before wiring a new proxy route; relying on `next_page` against Compliance silently breaks pagination after page 1.
