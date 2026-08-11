# Identity-aware email masking (admin unmask / demo keep) — Design

- **Date**: 2026-08-11
- **Status**: Approved (owner, 2026-08-11)
- **Driver**: admin@whchoi.net must see user/cost data unmasked; demo@whchoi.net keeps the current masking.

## Decisions (owner-confirmed)

1. **Scope**: unmask ALL surfaces for allowed accounts — UI render, AI chat answers, Archive (Athena) query results.
2. **demo hardening level**: render-time masking is sufficient (current threat model: any authenticated user already receives raw emails in API JSON; masking is a presentation courtesy for demos/screen-shares).
3. **Authorization source**: Cognito group `unmasked` — membership rides the ID token's `cognito:groups` claim; account changes are a CLI call, no redeploy.

## Architecture

### Identity path (verified facts)

- Auth = 4 hand-rolled Lambda@Edge viewer-request functions; ID token stored in the `ccd_id` **HttpOnly** cookie (`infra/edge/_shared.template.js` `COOKIE.id`).
- CloudFront dynamic behaviors use `OriginRequestPolicy.ALL_VIEWER` → **cookies reach the Express origin**. HttpOnly means browser JS cannot read the token, so the server is the only place identity can be established.

### Components

1. **`server/identity.js`** (new, pure-ish, unit-testable)
   - Parse `ccd_id` from the Cookie header; verify JWT: JWKS RS256 signature, `iss` (pool issuer), `aud` (clientId), `exp`, `token_use === 'id'` — same checks as the edge `_shared.template.js`, Node 20 built-in `crypto`, zero new deps. JWKS cached 1h per process.
   - `unmask = groups.includes('unmasked')` from the `cognito:groups` claim.
   - **Fail-closed**: any failure (no cookie, bad signature, expired, missing config) → `{ unmask: false }`. Local dev (no Cognito env) therefore keeps masking.
   - Express middleware attaches `req.identity = { email, unmask }`; `GET /api/me` returns it.

2. **Frontend** — `src/lib/format.ts` gains a module flag (`setUnmasked(v)`); `maskEmail()` becomes a passthrough when set. `src/main.tsx` awaits `GET /api/me` (3s timeout, fail → masked) **before React mounts**, same pattern as `restoreOrgSelection()`. Zero changes at the ~19 existing `maskEmail` call sites; no re-render hazard because the flag is fixed pre-mount.

3. **Server-masked surfaces**
   - `/api/chat/stream`: when `req.identity.unmask`, skip `maskEmailsDeep` on tool results and relax the system prompt's masking mandate for that session. **Real-name stripping (v2.0.3) stays** — raw email already identifies; keeps the diff minimal.
   - `/api/archive/query`: skip `maskEmailsDeep` on result rows when unmasked.

4. **Infra** (`infra/lib/compute-stack.ts`): inject `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` into the task from the existing `ccd/cognito-config` secret via `ecs.Secret.fromSecretsManager(secret, field)`. clientSecret is NOT injected (not needed for verification). Region reuses `AWS_REGION`.

5. **Cognito ops**: create group `unmasked`, add admin@whchoi.net. Document group add/remove in `docs/runbooks/cognito-users.md`.

## Error handling

Every failure path degrades to masked. `/api/me` errors never block the app — the frontend proceeds masked after timeout.

## Testing

- `tests/server/test-identity.mjs`: token fixtures signed with a generated RSA keypair — happy path, expired, bad signature, wrong aud, wrong token_use, group present/absent, missing cookie/config.
- Chat-tools unmask option: extend the existing pure-module tests.
- Frontend: `tsc` + build; manual/Playwright E2E for the two accounts.
- Pre-deploy adversarial review focus: **any path where an unmasked view leaks into a demo session** (shared caches keyed without identity, chat session identity not threaded, /api/me caching).

## Out of scope

- Server-side masking of all API responses for non-allowed accounts (owner chose render-level; would break email-keyed joins and is a separate release if ever needed).
- Real-name unmasking in chat; sidebar identity badge.

## Release

v2.1.0 (minor). ADR to be added as docs/decisions/0020 (identity-aware masking via Cognito groups).
