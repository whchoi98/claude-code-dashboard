# ADR-0009: Live per-user cost via user_cost_report (CSV demoted)

- **Status**: Accepted
- **Date**: 2026-06-10
- **Deciders**: @whchoi98
- **Resolves**: the per-user limitation in [ADR-0003](0003-hybrid-live-cost.md)

## Context

ADR-0003 kept the Spend Report CSV as the only source of per-user spend because
the live `cost_report` `group_by[]` had no actor/user dimension. Verified live on
2026-06-10: the Analytics family now exposes `GET /v1/organizations/analytics/user_cost_report`,
returning per-user USD `amount`/`list_amount` (fractional cents) + `requests` with
an `actor {user_id, name, email}`, sorted by amount, `?page=` paginated. (Confirmed
negative: `cost_report` with `group_by[]=actor` → HTTP 400.) It carries **no
per-user token counts**.

## Decision

Add `GET /api/cost/users` (proxy + pagination, raw emails masked at the frontend).
Make `GET /api/cost/efficiency` query `user_cost_report` for the exact selected
range and join it with Analytics `users/range` productivity on `email`, dropping
the CSV-period activity-weighted scaling on that path; fall back to the CSV path
when `user_cost_report` is empty/unavailable. The Cost page lights up the per-user
"Top by Cost" table + a live `distinct_users` KPI; token-ranked per-user tables
render only when per-user tokens exist (CSV). CSV upload is **retained, demoted**
to optional (per-user tokens + billing-grade reconciliation older than the live
correction window).

## Consequences

- Cost page per-user analysis works with **no CSV upload** — closes ADR-0003's
  main negative and its first two follow-ups.
- Per-user **token** granularity remains CSV-only (no live source exists).
- Email masking stays at the render layer (`maskEmail`), consistent with
  `/cost/efficiency` + `/analytics/users/range`; the efficiency join keys on raw
  email, so the proxy must not pre-mask.
- No new infra/secrets (reuses the Analytics key).
