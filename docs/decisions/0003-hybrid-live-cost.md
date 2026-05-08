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

Add `/api/cost/live` that calls Anthropic's Analytics API endpoints with
the analytics key:

- `/v1/organizations/analytics/cost_report`  — USD spend + request counts
- `/v1/organizations/analytics/usage_report` — token counts (input/output/cache)

Both queried with `bucket_width=1d` and `group_by[]=product&group_by[]=model`,
joined on `(product, model)` and reshaped into the `CsvResp` shape the Cost
page already renders. Cost.tsx tries `/api/cost/live` first; on error or
empty data, it falls back to `/api/cost/csv`. CSV upload remains available
for finance reconciliation (≥30 days back) and for **per-user** breakdowns
that the analytics endpoints do not expose.

### History

The first iteration self-called the Admin API's
`/v1/organizations/usage_report/claude_code` endpoint via the admin key.
That endpoint is workspace-scoped — the admin key in this account belongs
to a workspace with no Claude Code activity, so live mode silently fell
back to CSV in production. The migration to the org-wide Analytics API
(this revision) uses the analytics key (already provisioned, already in
active use for the `/api/analytics/*` proxy routes) and queries the
org-wide rollup. Per-user attribution is sacrificed because those
analytics endpoints' `group_by` options do not include any actor/user
dimension; the CSV path retains it.

## Consequences

### Positive

- Cost page shows live data without prior CSV upload — solves the dominant
  operator pain identified in ADR-0002 ("monthly export ritual").
- Zero new infrastructure: no new secrets, no new IAM, no new ECS env vars,
  no Glue tables. The analytics key is already injected.
- Trends chart ("Daily spend by model") shows real per-day aggregates from
  the live API.
- `total_requests` is real (not approximated) — `requests` is a first-class
  field in the analytics endpoints' response.
- All Anthropic products are covered (chat, claude_code, claude_chat, etc.) —
  not Claude Code only.
- 30-day correction window is non-blocking: the CSV path remains the source
  of truth for billing-grade totals on dates ≥30 days old.

### Negative

- The Anthropic Analytics endpoints (`cost_report`, `usage_report`) do not
  expose a per-user dimension — `group_by[]` accepts `product`, `model`,
  `context_window`, `inference_geo`, `speed`, `rbac_group_id`,
  `claude_project_id`, `cost_type`, `token_type` only (no `actor`/`user`).
  The Cost page's "Top 10 by Cost / Total / Input / Output" tables are
  hidden in live mode (`dataSource === 'live'`) and shown only in CSV mode.
- `distinct_users` total is reported as 0 in live mode; the KPI hint
  switches to `models · products` to avoid misleading readers.

### Follow-ups (v2 candidates)

- Migrate `/api/cost/efficiency` from CSV to live (separate PR for blast
  radius reasons; this requires a per-user spend signal that the analytics
  endpoints do not currently provide).
- If Anthropic exposes a per-user spend endpoint (e.g., a future
  `/v1/organizations/analytics/users` extension that includes
  `estimated_cost`), re-introduce the live Top-N tables.
- Surface `context_window` (200K vs 1M) and `inference_geo` (region) splits
  if operators express interest — both are first-class `group_by` options
  on `cost_report`.

## References

- [Spec](../superpowers/specs/2026-05-08-analytics-cost-api-design.md)
- [Plan](../superpowers/plans/2026-05-08-cost-live-api.md)
- [`server/aws.js`](../../server/aws.js) — `/cost/live` route + reshape function
- [`src/pages/Cost.tsx`](../../src/pages/Cost.tsx) — `useCostData` hook + UI
- [Anthropic Claude Code Analytics API docs](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
