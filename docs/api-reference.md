# API Reference

All routes are served by the Express proxy (`server/index.js` + `server/aws.js`). Frontend calls them via the Vite dev proxy (dev) or same-origin (prod).

## Authentication

In production, the CloudFront distribution fronting the API sits behind a Cognito + Lambda@Edge gate (see [ADR 0002](decisions/0002-cognito-lambda-edge-auth.md)). Every unauthenticated request is `302`-redirected to `/oauth2/authorize`; after login the browser carries three HttpOnly cookies (`ccd_access`, `ccd_id`, `ccd_refresh`) which the `check-auth` edge function verifies on every request. No per-route auth code in Express — the edge enforces it uniformly.

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
| GET | `/api/analytics/connectors?date=` | Distinct user counts per connector. |
| GET | `/api/analytics/projects?date=` | Chat project usage (`/apps/chat/projects`). |

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
| GET | `/api/compliance/activities?max=500&pages=5&type=<event_type>` | Paginated audit events with actor, IP, and event-specific fields. |

## Cost (from uploaded CSV)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cost/csv` | Latest Spend Report CSV from `s3://<archive>/spend-reports/`, parsed + totals. |
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
| POST | `/api/archive/query` | Body `{ query }`. Only `SELECT` / `WITH` allowed. Returns rows array. |

## Response shape conventions

- All successful JSON responses include a `source` field where relevant: `"live"`, `"csv"`, `"s3"`, `"mock"`, `"upstream_error"`.
- Errors use `{ error: "<code>", message: "<human text>" }`.
- Pagination tokens are opaque strings in `next_page` fields; the server auto-paginates for simple endpoints.
