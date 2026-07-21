# ADR-0018: Multi-org support — second Anthropic subscription as a switchable source

- **Status**: Accepted
- **Date**: 2026-07-21
- **Deciders**: @whchoi98
- **Related**: [ADR-0015](0015-performance-caching-layer.md) · [ADR-0016](0016-audit-response-cache-partial-contract.md) · [ADR-0017](0017-compliance-s3-archival.md)

## Context

The owner operates a second Anthropic Enterprise subscription (its own org,
its own Analytics+Compliance-scoped API key, its own rate budget). The
dashboard was single-org by construction: one key set in env/Secrets
Manager, org-agnostic cache keys, one keep-warm loop, one S3 layout, one
set of Glue tables.

Requirements: view either org from the same deployment, full feature
parity for the second org (live pages AND the S3/Athena archive), and
byte-identical single-org behavior when the second key is absent.

## Decision

**An explicit org dimension end-to-end, with `primary` as the untouched
legacy default.**

1. **Org model** — ids `primary | org2`; `?org=` query param (invalid →
   `primary`); org2 exists only when `ANTHROPIC_ANALYTICS_KEY_2` is set.
   `server/orgs.js` centralizes key resolution (`analyticsKeyFor`,
   `complianceKeyFor`, `adminKeyFor` — org2 has no Admin key), S3 prefixes
   (`s3PrefixFor`: `''` vs `org2/`), and the `GET /api/orgs` capability list
   that drives the UI switcher.
2. **Caches and keep-warm are org-keyed** — every response-cache key
   (cost `makeTtlCache`, audit response cache, groups/member caches,
   last-good maps, keep-warm registry) carries an explicit `${org}:` prefix,
   primary included. Warm loops (cost 8-min cycle, analytics 5-min prewarm,
   audit preset top-ups) iterate configured orgs sequentially — each org has
   its **own upstream 60 rpm budget**, so the second org adds no contention.
   The upstream page cache was already API-key-suffixed and needed no change.
3. **S3/Glue: prefix, don't migrate** — org2 data lands under
   `org2/<table>/date=…` (+ `org2/raw/…`, `org2/spend-reports/`,
   `org2/group-map/`); primary paths stay exactly as they are (no data
   migration, no partition rewrite). Six additive Glue tables
   (`*_org2`) point at the prefixed locations — same columns, same varchar
   date projection. The Athena allowlist and the chatbot schema hints gain
   the org2 tables; the chat session is org-bound via the request body.
4. **Collector loops orgs** — the daily analytics snapshot and the 00:30 UTC
   compliance walk run per configured org (primary first); manual payloads
   accept `org` to target one. The Lambda remaining-time guard now protects
   the whole multi-org run.
5. **Frontend: global provider, one plumbing point** — `OrgProvider`
   (URL-synced like the group scope) + a sidebar switcher rendered only when
   two orgs exist. `useFetch` appends the org param centrally; direct fetch
   sites use a shared helper; module-level client caches key by org.
   **Switching org resets the group scope** — the email→group map is per org.
6. **Deploy gating** — infra injects the `ccd/analytics-key-2` secret only
   under the CDK context flag `enableOrg2`, so stacks deploy safely before
   the secret exists.

## Consequences

### Positive

- One deployment serves both subscriptions with the full page set and
  archive; org selection is shareable via URL.
- Zero behavior change for single-org installs (org2 machinery is inert
  without its key) and zero migration for existing S3/Glue data.
- Per-org rate budgets mean the second org roughly doubles background
  upstream traffic but against its own quota.

### Negative / accepted

- Memory roughly doubles for warm caches (two orgs × preset windows) —
  bounded by the existing per-cache caps.
- Admin-key-only features stay primary-only until an org2 Admin key is
  provisioned (`adminKeyFor(org2) = null`).
- Org labels are env-configured (`CCD_ORG_LABEL`/`CCD_ORG2_LABEL`) — the
  Anthropic API exposes no org display name to fetch.
- The org dimension is threaded, not typed: a new route that forgets
  `orgFromReq` silently serves primary data. Convention documented in
  server/CLAUDE.md; the review checklist covers it.
