# server — Express proxy + AWS integrations

## Role

ESM Node 20 process (`"type": "module"` at repo root). Serves `/api/*` routes that fan out to three Anthropic API families, Amazon Bedrock, Athena, and S3. In production, also serves the built Vite bundle as static assets with SPA fallback.

## Files

- **`index.js`** — Entry. Loads env, instantiates Express, registers Analytics / Admin / Compliance proxy routes, serves the SPA in production. Owns the 5-minute in-memory cache (`cache` Map) and the S3-first `readUsersFromS3` helper.
- **`aws.js`** — AWS integrations via `registerAwsRoutes(app, { fetchAnalytics })`: Bedrock `ConverseStream` (SSE), Bedrock SQL generation with robust parsing, Athena query execution, S3 CSV reading, economic productivity join.
- **`mock.js`** — Deterministic mock generators for local dev when no Analytics key is configured. Schema must track `src/types.ts`; the fake data is only valid when it matches the real shape.

## Conventions

- **ESM only**. No `require`. Use `node --check server/*.js` for syntax validation.
- **Never instantiate AWS clients per request** — create them once in the module scope so SDK credential provider chains cache.
- **Always paginate upstream responses**. Analytics / Admin pagination caps at 1000; loop until `!has_more`.
- **Mask before logging emails**. If you add a debug `console.log`, pass the email through `maskEmail` first (or just don't log it).
- **Secret resolution**: read via `process.env.*`. In production these come from ECS `secrets:` (Secrets Manager injection). Locally they come from `.env` (gitignored).

## Adding a new route

1. Register it on `app.get('/api/...')` in `index.js` (proxy routes) or via `registerAwsRoutes` in `aws.js` (AWS-integrated routes).
2. Auto-paginate upstream if the API returns `has_more`.
3. Fall back gracefully: return `[]` with a non-2xx status + `{ error: 'code', message: '…' }` rather than crashing.
4. Document the route in `docs/api-reference.md`.
