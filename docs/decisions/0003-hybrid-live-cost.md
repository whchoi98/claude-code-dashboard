# ADR-0003: Hybrid live Cost API with CSV reconciliation

- **Status**: Accepted
- **Date**: 2026-05-08
- **Deciders**: @whchoi98
- **Supplements**: [ADR-0002](0002-dashboard-csv-upload.md) (CSV upload retained as fallback)

## Context

ADR-0002 chose CSV upload for the Cost page because the Admin API at the time
did not expose per-user × product × model granularity. Two facts changed:

1. The Anthropic Analytics API was extended to expose per-user token + USD cost
   data. Refresh ~4h, with up to 30 days of correction for recent dates.
2. This codebase already proxies `/v1/organizations/usage_report/claude_code`
   as `/api/admin/claude-code/range` — its response carries
   `model_breakdown[].estimated_cost.amount` (cents) per user, which is
   sufficient to drive the Cost page for the Claude Code product without any
   manual upload.

## Decision

Add `/api/cost/live` that self-calls `/api/admin/claude-code/range` and
reshapes the response into the same `CsvResp` shape the Cost page already
renders. Cost.tsx tries `/api/cost/live` first; on error or empty data, it
falls back to `/api/cost/csv`. CSV upload remains available for finance
reconciliation (≥30 days back) and for non-Claude-Code products that the
endpoint does not cover.

## Consequences

### Positive

- Cost page shows live data without prior CSV upload — solves the dominant
  operator pain identified in ADR-0002 ("monthly export ritual").
- Zero new infrastructure: no new secrets, no new IAM, no new ECS env vars,
  no Glue tables. The admin key is already injected.
- Trends chart ("Daily spend by model") becomes possible because the live
  payload exposes per-day aggregates, which the single-period CSV cannot.
- 30-day correction window is non-blocking: the CSV path remains the source
  of truth for billing-grade totals on dates ≥30 days old.

### Negative

- `total_requests` is approximated from `num_sessions` — sessions are not 1:1
  with API requests. The KPI is labeled "Requests *" with a tooltip; the CSV
  path retains the exact value. Documented in `docs/api-reference.md`.
- Live mode covers Claude Code only; Chat / Cowork / Browser Extension /
  Excel / PowerPoint product breakdowns still require a CSV upload.
- The "API key:" actor namespace in live mode causes a small visual
  divergence from CSV mode (CSV groups by email_address only, where API key
  usage is invisible). Acceptable for v1; surfaces real activity that CSV
  hides.

### Follow-ups (v2 candidates)

- Migrate `/api/cost/efficiency` from CSV to live (separate PR for blast
  radius reasons).
- Verify the broader Analytics API (read:analytics scope) for
  cross-product spend; currently the `usage_report/claude_code` endpoint is
  Claude Code only.
- Surface `context_window` (200K vs 1M) and `inference_geo` (region) splits
  if operators express interest.

## References

- [Spec](../superpowers/specs/2026-05-08-analytics-cost-api-design.md)
- [Plan](../superpowers/plans/2026-05-08-cost-live-api.md)
- [`server/aws.js`](../../server/aws.js) — `/cost/live` route + reshape function
- [`src/pages/Cost.tsx`](../../src/pages/Cost.tsx) — `useCostData` hook + UI
- [Anthropic Claude Code Analytics API docs](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
