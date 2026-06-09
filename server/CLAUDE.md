# server — Express proxy + AWS integrations

## Role

ESM Node 20 process (`"type": "module"` at repo root). Serves `/api/*` routes
that fan out to three Anthropic API families, Amazon Bedrock, Athena, and S3.
In production, also serves the built Vite bundle as static assets with SPA
fallback.

## Files

- **`index.js`** — Entry. Loads env, instantiates Express, registers the
  Analytics / Admin / Compliance proxy routes, the S3-first
  `readUsersFromS3` helper, and the **10-minute in-memory upstream cache**
  (`cache` Map, `TTL_MS = 600_000`). Schedules a **compliance prewarm** at
  task startup + every 5 minutes for the 7d / 14d / 30d windows so the
  audit page hits the cache instead of paginating the live API.
- **`aws.js`** — AWS integrations registered via
  `registerAwsRoutes(app, { fetchAnalytics })`. Owns:
  - Cost routes: `GET /cost/live` (Analytics `cost_report` + `usage_report`,
    reshaped into `CsvResp` shape via `analyticsReportsToCostResp`),
    `/cost/csv`, `/cost/upload`, `/cost/uploads`, `DELETE /cost/uploads/:file`,
    `/cost/efficiency` (CSV × Analytics activity-weighted join).
  - AI: `POST /chat/stream` (multi-turn tool-use chatbot — Bedrock
    `ConverseStream` + `toolConfig`, `MAX_TOOL_HOPS=4`; tools:
    `get_analytics_overview`, `run_athena_sql` via `sanitizeAthenaQuery`,
    `get_cost_summary`, `search_users`; emails masked in tool results
    before reaching the model; dynamic follow-ups generated after each
    answer). Pure tool helpers + specs live in `server/chat-tools.js`.
    `fetchCostSummary()` is shared by `GET /cost/live` and the cost tool.
    Athena execution (`runAthena` polls for up to 60 s and throws an
    explicit timeout error rather than falling through to
    `GetQueryResultsCommand` on a still-RUNNING query), S3 CSV reading.
  - The `analyticsReportsToCostResp` reshape function — pure, exported,
    unit-tested in `tests/server/test-cost-live-reshape.mjs`.
- **`chat-tools.js`** — Pure, dependency-free helpers + tool registry for
  `/api/chat/stream`. Exports: `maskEmail`, `maskEmailsDeep`,
  `historyToBedrockMessages`, `parseFollowups`, `rankUsers`,
  `compactOverview`, `TOOL_SPECS`, `CHAT_SYSTEM_PROMPT`, `makeToolRunner`.
  No AWS client instantiation — fully unit-testable in isolation
  (`tests/server/test-chat-tools.mjs`).
- **`mock.js`** — Deterministic mock generators for local dev when no
  Analytics key is configured. Schema must track `src/types.ts`; the fake
  data is only valid when it matches the real shape.

## Conventions

- **ESM only**. No `require`. Use `node --check server/*.js` for syntax
  validation.
- **Never instantiate AWS clients per request** — create them once in the
  module scope so SDK credential provider chains cache.
- **Pagination cursor names differ per endpoint** — verify before wiring:
  - Analytics `users/range`, `cost_report`, `usage_report`: `?page=<token>`
    via `body.next_page`.
  - Compliance `/v1/compliance/activities`: **`?after_id=<last_event_id>`**
    derived from `data[-1].id`. The endpoint does NOT return `next_page`;
    relying on it silently breaks pagination after page 1.
- **Analytics dates must be clamped to today-3 before hitting upstream**.
  The Analytics + Admin APIs return HTTP 400 ("Data is not yet available")
  for any date inside the 3-day finalization buffer. The DateRangeControl
  picker allows today as the end date by design (the UTC/daily-refresh
  footnote spells out the partial-count caveat), so the proxy clamps
  every `ending_date` and `starting_date` it forwards via
  `clampAnalyticsEnd(raw)`. Use this helper on every new Analytics-family
  endpoint — bypassing it surfaces the upstream 400 to the user as a
  `mock` source-badge with the full error message in `reason`.
  Compliance endpoints stay un-clamped (they're real-time).
- **Self-call URL params must be `encodeURIComponent`'d** before
  interpolation — `req.query`-derived dates flow into upstream URLs and
  unencoded values can inject extra params.
- **Mask before logging emails**. If you add a debug `console.log`, pass
  the email through `maskEmail` first (or just don't log it).
- **Secret resolution**: read via `process.env.*`. In production these come
  from ECS `secrets:` (Secrets Manager injection). Locally they come from
  `.env` (gitignored, `chmod 600`).

## Route registration patterns

- Routes that pre-date `aws.js` use the bare `app.get('/api/...')` style in
  `index.js`.
- Routes added via `registerAwsRoutes` use the `router.get('/cost/...')`
  pattern (an `express.Router` mounted at `/api`). Both styles coexist — pick
  the file based on whether the route needs AWS clients (S3, Bedrock,
  Athena, Secrets Manager).

## Adding a new route

1. Register it on `app.get('/api/...')` in `index.js` (proxy routes that
   only fan out to Anthropic / use the cache) or via `router.get(...)`
   inside `registerAwsRoutes` in `aws.js` (routes that need AWS clients).
2. Auto-paginate upstream if the API returns `has_more`. Verify the cursor
   parameter name (see conventions above).
3. Fall back gracefully: return `[]` with a non-2xx status + `{ error:
   'code', message: '…' }` rather than crashing.
4. Document the route in `docs/api-reference.md`.
