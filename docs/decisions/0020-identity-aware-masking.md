# ADR-0020: Identity-aware email masking via Cognito groups

- **Status**: Accepted
- **Date**: 2026-08-11
- **Context**: owner request "admin@whchoi.net은 마스킹 없이, demo@whchoi.net은 마스킹 유지"

## Problem

Email masking was unconditional: `maskEmail()` at every UI render site, plus
server-side `maskEmailsDeep` on the two surfaces the frontend can't
anticipate (chat tool results feeding the LLM, free-form Athena rows from
`/api/archive/query`). The dashboard's own administrator therefore could not
see who a number belonged to, while the demo account — the actual reason
masking exists (screen-shares, workshops) — needs it kept.

There was no notion of "who is logged in" anywhere in the app: the Cognito
gate lives entirely in Lambda@Edge, and the ID token sits in an **HttpOnly**
cookie (`ccd_id`), invisible to browser JS.

## Decision

1. **Authorization = Cognito group `unmasked`** (owner-selected over an env
   allowlist). Membership rides the ID token's `cognito:groups` claim —
   adding/removing an account is one CLI call, no redeploy, no app-client or
   edge-function change. demo@whchoi.net is simply not in the group.
2. **The server verifies the token itself.** CloudFront's `ALL_VIEWER`
   origin-request policy already forwards cookies to the ALB, so
   `server/identity.js` re-runs the same checks as the edge (`JWKS` RS256
   signature, `iss`, `aud`, `exp`, `token_use === 'id'`; Node 20 built-in
   crypto, zero deps, JWKS cached 1h). An `/api`-wide middleware attaches
   `req.identity = { email, unmask }`; `GET /api/me` exposes it. **Every
   failure path fails closed to masked** — local dev (no `COGNITO_*` env)
   and direct-ALB probes always see masked data.
3. **Frontend flips once, pre-mount.** `src/main.tsx` awaits `/api/me` (3s
   timeout, fail → masked) before `createRoot`, and `format.ts`'s
   `setUnmasked()` turns `maskEmail()` into a passthrough. Fixed pre-mount →
   no re-render plumbing, zero changes at the ~19 call sites.
4. **Server-masked surfaces honor the same identity.** The chat session
   binds `unmask` into both `makeToolRunner` (tool results skip
   `maskEmailsDeep`; `rankUsers` masking is toggled via a separate options
   object so model-controlled input can never reach it) and
   `CHAT_SYSTEM_PROMPT` (the privacy line must match what the tools actually
   serve, or the model hedges). `/api/archive/query` returns raw rows for
   unmasked identities. **Real-name stripping in chat stays** — the raw
   email already identifies; names remain out of the model context.
5. **Infra**: `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` are injected from
   the existing `ccd/cognito-config` secret (field-level
   `ecs.Secret.fromSecretsManager`); `clientSecret` is deliberately not
   injected — verification needs only public identifiers.

## Explicitly out of scope (owner-confirmed)

Masking stays **render/presentation-level**: API JSON responses still carry
raw emails to any authenticated session (they always did — the frontend is
the masking layer for regular data routes). Hardening demo to server-masked
API responses would break every email-keyed join (group scope, MTD join,
user detail) and is a separate release if ever needed.

## Consequences

- Console/demo behavior is unchanged for everyone outside the `unmasked`
  group, in every failure mode (fail-closed).
- The `unmasked` group is documented in `docs/runbooks/cognito-users.md`.
- The chat privacy contract is now per-session; tests in
  `tests/server/test-chat-tools.mjs` pin both prompt variants and the
  guard behavior, `tests/server/test-identity.mjs` pins the verifier.
