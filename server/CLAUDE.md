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
  `COMPLIANCE_KEY` falls back to the Analytics key (its scopes include
  `read:compliance_activities`, verified live 2026-07-03) — the dedicated
  `ccd/compliance-key` secret is optional; `/api/health` reports which is
  active (`compliance` / `analytics-fallback` / `none`).
- **`inflate.js`** — pure read-side helper `inflateUser()`: a flattened NDJSON
  row (written by `collector/flatten.js`) → nested Analytics-API user shape.
  Imported by `index.js` `readUsersFromS3`; unit-tested in
  `tests/server/test-flatten-inflate.mjs`.
- **`aws.js`** — AWS integrations registered via
  `registerAwsRoutes(app, { fetchAnalytics })`. Owns:
  - Cost routes: `GET /cost/live` (Analytics `cost_report` + `usage_report`,
    reshaped via `analyticsReportsToCostResp`; also attaches `data_refreshed_at`,
    `by_cost_type` (tokens/web_search/code_execution), `by_token_type` +
    `token_tiers` (cache-hit ratio) from best-effort secondary `cost_report`
    rollups + the usage body. **All four reports are paginated via
    `fetchAllReportPages` — the API caps daily buckets at ~7/page, so a window
    > 7 days MUST follow `has_more`/`next_page` or the total truncates to its
    first week; fetching page 1 only was the v1.1.1 monthly-total bug.**),
    `/cost/users` (live per-user USD spend via `user_cost_report`, paginated,
    raw emails, sorted by `net_spend_usd` desc; no per-user token counts.
    **`?by=model` / `?by=product`** → per-user × model / × product breakdown
    (`users[].by_model[]` / `by_product[]`, same `userCostToUsers` dim-generalized
    mapper) — model feeds the Cost chargeback chart, product/model the
    user-detail panel cards),
    `/cost/groups` (org spend by **RBAC group** — `cost_report` ×
    `rbac_group_id`, reshaped via `aggregateGroupCost`; labels are REAL group
    names from `fetchGroupNames` — the documented `GET /v1/compliance/groups`,
    1h-cached because each listing emits a `group_list_viewed` audit event —
    with `grp-<id suffix>` fallback),
    `/cost/user-tokens` (per-user TOKENS via the new `user_usage_report`
    endpoint, mapped by `userUsageToUsers` — supersedes the CSV as the token
    Top-tables source),
    `/cost/spend-limits` (per-member effective limit + month-to-date spend
    via the Spend Limits API `GET /v1/organizations/spend_limits/effective`,
    scope `read:spend_limits`; mapped by `spendLimitsToMembers`; no date
    params — always the current monthly period),
    `/cost/csv`, `/cost/upload`, `/cost/uploads`, `DELETE /cost/uploads/:file`,
    `/cost/efficiency` (live-first: queries `user_cost_report` for the exact
    range via `fetchUserReport`, joins on `email` with `users/range`
    productivity — no activity-weighted scaling on the live path; falls back
    to the CSV path when live data is empty/unavailable; response `source` is
    `"live+analytics"` or `"csv+analytics"`).
  - Pure exported helpers (unit-tested in `tests/server/`): `analyticsReportsToCostResp`,
    `fetchAllReportPages(baseUrl, headers, fetchImpl?, maxPages?)` (paginates a report
    by `has_more`/`next_page`, merges every page's `data[]`; injectable `fetchImpl`
    for tests; never throws on network error → `{ ok:false }`),
    `aggregateAmountBy(body, field)` + `aggregateCostType`/`aggregateTokenTypeCost`,
    `aggregateTokenTiers(usageBody)` (cache-hit ratio from token subtype counts),
    `utcNextDay`, `resolveUserCostWindow({ starting_date, ending_date }, now?)`
    (window guard for `user_cost_report`: ending clamps to **today** only —
    NOT today−3; see the buffer note below — and an inverted pair pins
    starting to ending), and `userCostToUsers(data, { by })` — `by` = `'model' | 'product'`
    (legacy `byModel` boolean still accepted); ungrouped →
    `{ email, user_id, name, deleted, net_spend_usd, gross_spend_usd, requests }`;
    grouped → per-email `{ email, …, net_spend_usd, requests, by_model[] / by_product[] }`.
    Excludes `api_actor` rows (no email).
  - Closure helper inside `registerAwsRoutes`: `fetchUserReport({
    report, starting_date, ending_date, groupBy })` — paginates a per-user
    analytics report (`report`: `'user_cost_report'` default or
    `'user_usage_report'`; up to 50 pages; `groupBy` appends
    `group_by[]=<dim>`: `'model'` for chargeback, `'product'` for the
    user-detail product card, `'rbac_group_id'` for group-map derivation), resolves its window via `resolveUserCostWindow`
    (exclusive `ending_at` via `utcNextDay`; **the upstream cost family caps
    spans at 31 days** — defaults are `[today−30, today]`, longer selections
    400→502→CSV fallback), returns `{ data, period, data_refreshed_at }`.
    Sibling closure `fetchGroupNames()` — RBAC group id→name via the
    documented `GET /v1/compliance/groups` (compliance-or-analytics key), 1h
    cache + last-good.
  - Group helpers (pure, tested in `tests/server/test-group-cost.mjs`):
    `labelGroupIds(ids)` (`grp-<last-6>` labels, collision-extended),
    `resolveGroupLabels(ids, nameById)` (real names over grp- fallbacks,
    duplicate names id-suffixed), `aggregateGroupCost(costBody, nameById?)`
    (per-group totals + daily; null group id = genuinely-ungrouped remainder,
    accumulated not dropped), `deriveGroupMap(data, nameById?)`
    (user_cost_report×rbac_group_id → email→label**s** map — ARRAY of every
    membership per email, spend-desc, `[0]` = max-spend group; a single-value
    collapse dropped groups that were nobody's top group — + `ids`
    label→group_id lookup). `GET /groups` serves the admin CSV
    when uploaded, else **auto-derives** the map this way (`source:'auto'`;
    works without `ARCHIVE_S3_BUCKET`).
  - Per-user report mappers (pure, tested in `tests/server/test-user-usage.mjs`):
    `userUsageToUsers(data)` (input = uncached + cache_read + cache_creation
    1h+5m, reconciles with upstream `total_tokens`) and
    `spendLimitsToMembers(data)` (cents→USD; `amount:null` = unlimited →
    `utilization:null`; actor field is `email_address`, not `email`).
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
- **Analytics *usage/engagement* dates must be clamped to today-3 before
  hitting upstream — but the *cost* endpoints must NOT be**. The Analytics
  engagement endpoints (`users`, `users/range`, `summaries`, …) and the
  Admin API return HTTP 400 ("Data is not yet available") for any date
  inside the 3-day finalization buffer, so the proxy clamps every
  `ending_date`/`starting_date` it forwards via `clampAnalyticsEnd(raw)` —
  use it on every new endpoint of that family. The **cost family**
  (`cost_report`, `usage_report`, `user_cost_report`) serves those buffer
  days with *partial* data instead (verified live 2026-07-03), so clamping
  them makes the per-user tables cover fewer days than the headline KPIs —
  the 2026-07 Cost-page inaccuracy bug. Cost windows go through
  `resolveUserCostWindow` (ending ≤ today, never inverted) instead.
  **One deliberate exception**: `/cost/efficiency` clamps its whole window
  to today−3 — its metrics are spend ÷ productivity ratios and the
  `users/range` productivity side is buffer-clamped, so mismatched windows
  would inflate $/LOC and skew the econ score. Headline-consistent
  full-range per-user spend lives in `/cost/users`.
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
