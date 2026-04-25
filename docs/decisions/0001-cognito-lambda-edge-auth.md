# ADR-0001: Cognito + Lambda@Edge authentication at CloudFront

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: @whchoi98

## Context

Before this change the CloudFront distribution was open to the public internet. The ALB was locked to CloudFront's origin-facing managed prefix list and WAF applied rate limits + OWASP Core rules, but anyone who could guess the CloudFront domain had full read access to organization-wide Claude Code analytics — per-user token counts, PII-adjacent email addresses, spend totals, and compliance events.

Requirement: all dashboard URLs must require an authenticated Claude Code Enterprise admin. Constraints:

1. **No per-route auth code** — the project has 11 pages and a growing `/api/*` surface; auth logic must not leak into the React components or Express routes.
2. **Fail closed** — unauthenticated requests must stop upstream of ECS so a misrouted Express handler can never accidentally leak data.
3. **Stay inside the existing CF → WAF → ALB → Fargate shape** — no new regional infra, no major cost, no new on-call surface.
4. **Federation-ready** — the org may later add SSO (Google Workspace, Azure AD), so the chosen mechanism should plug in without a rewrite.

## Options considered

### Option A — Cognito + Lambda@Edge (chosen)

Four viewer-request Lambda@Edge functions attached to the CloudFront distribution: `check-auth` (default behavior), `parse-auth` (`/parseauth`), `refresh-auth` (`/refreshauth`), `sign-out` (`/signout`). Cognito User Pool with Hosted UI handles the login form, Authorization Code Grant flow exchanges the code for tokens, HttpOnly `ccd_access` / `ccd_id` / `ccd_refresh` cookies carry the session.

- **Pros**: Auth enforced at every edge PoP before any origin traffic. Zero app code for auth. Cognito supports SAML / OIDC federation out of the box. Patterns well-documented by AWS (`cloudfront-authorization-at-edge` solution). Works across every CloudFront behavior uniformly, so new endpoints inherit the gate by default (whitelist model — safer than blacklisting "public" paths).
- **Cons**: Lambda@Edge has no env-var support (Cognito config must be baked into the zip at build time — we built `scripts/build-edge.mjs` + gitignored `infra/edge/dist/` to handle this). Deploy cycle is slow (5–15 min replication) — though in practice we saw ~3 min because the handler code is tiny. Debugging requires reading CloudWatch Logs in every edge region the user hits. `experimental.EdgeFunction` in CDK is still marked experimental (the cross-region SSM pattern may change).

### Option B — Auth at ALB (Cognito + ALB authentication action)

ALB listener rules natively support Cognito authentication on a per-rule basis.

- **Pros**: Simpler — no Lambda code, just CFN config. No edge function to rebuild on secret rotation.
- **Cons**: The gate is downstream of WAF/CloudFront but upstream of ECS. Public CloudFront → ALB traffic still passes WAF and the CF prefix list check, so authentication only protects the origin, not the edge surface. Also, ALB auth adds hundreds of ms to every request (OIDC token exchange per session start) and integrates poorly with SPA routing — the redirect dance fights with React Router's client-side navigation.

### Option C — Per-route Express middleware

Add session cookies + `requireAuth` middleware to `/api/*` and gate the SPA bundle fetch.

- **Pros**: All server-side, no infra changes.
- **Cons**: Fail-open by default — a new route added without the middleware is publicly accessible. Every page load must round-trip to Express even for static assets, eliminating the CloudFront cache. Doesn't scale to multi-region. Forces us to build + maintain session storage (Redis, DynamoDB).

## Decision

**Option A (Cognito + Lambda@Edge)**. The whitelist-by-default property (new CloudFront behaviors inherit the gate automatically) is worth the operational cost of Lambda@Edge. The build-time secret injection mechanism is a generic pattern we can reuse for any future edge logic that needs secrets.

## Consequences

- **Positive**: No per-route auth code anywhere. Adding an endpoint automatically gets the auth gate (verified by smoke tests on `/api/cost/upload` — it 302's to Cognito without any explicit auth code). SSO can be added later just by attaching a federation identity provider to the Cognito User Pool. Rotated client secrets do not require an app redeploy — just rebuild `infra/edge/dist/` and `cdk deploy ccd-compute`.
- **Negative**: Lambda@Edge updates take 3–15 min to replicate. Cognito config is baked into the zip — any change requires a build + redeploy. No way to add env-specific config without rebuilding. Debugging spans multiple CloudWatch regions. The `experimental.EdgeFunction` API may change in future CDK releases.
- **Follow-ups**:
  - Periodic Cognito client secret rotation — today manual (describe client, delete + recreate, update Secrets Manager, rebuild edge).
  - MFA is OFF for the user pool — consider enabling TOTP for admin accounts.
  - `AdminCreateUserOnly` is true, so self-signup is blocked; onboarding a new admin is a CLI/console action.
  - Consider moving from `experimental.EdgeFunction` to explicit cross-region `Stack`s if the experimental API breaks.

## References

- [`infra/lib/compute-stack.ts`](../../infra/lib/compute-stack.ts) — CloudFront Distribution wiring.
- [`infra/edge/`](../../infra/edge/) — handler source (`check-auth.js`, `parse-auth.js`, `refresh-auth.js`, `sign-out.js`, `_shared.template.js`).
- [`scripts/build-edge.mjs`](../../scripts/build-edge.mjs) — template → `dist/` renderer.
- [`docs/runbooks/cognito-users.md`](../runbooks/cognito-users.md) — admin operations.
- AWS solution this mirrors: [cloudfront-authorization-at-edge](https://github.com/aws-samples/cloudfront-authorization-at-edge).
