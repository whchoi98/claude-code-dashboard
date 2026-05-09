# ADR-0005 — Default date window: 7 days

**Status**: Accepted
**Date**: 2026-05-09
**Supersedes**: implicit 14d / 30d defaults from v0.1.0–v0.3.0

## Context

Every range-aware page calls `useDateRange(defaultPreset)` to seed its
`?range=` URL state. Through v0.3.0 the defaults varied per page:

| Page | Pre-0.4.0 default |
|------|-------------------|
| Trends | 30d |
| Cost | 30d |
| Overview, Users, UserProductivity, Productivity, ClaudeCode, Adoption, Compliance, UserSearch | 14d |

User feedback flagged two problems with the longer defaults:

1. **Stale signal** — at 30d the "Top contributors" leaderboards and
   tool-acceptance KPIs were dominated by the long tail; week-over-week
   regressions were invisible because they averaged into the broader
   window.
2. **API rate-limit pressure** — Compliance pagination at 30d hits the
   `pages=20 / max=2000` ceiling on noisy orgs, surfacing the truncation
   banner more often than necessary.

## Decision

Standardize on **7d** as the default `range` preset across every
sidebar-routed page, including the implicit default in
`useDateRange()`. UserSearch's "All" / "30d" / "14d" / "7d" toggle also
boots on `7d`.

Users can still pick 30d or 14d via the existing date-range control.

## Trade-offs

- **Tighter signal at the cost of older context.** The Overview / Users
  pages now reflect "the last business week" by default. Owners
  comparing to monthly reports must explicitly switch to 30d.
- **Window-bisection metrics work at 7d, but barely.** Adoption's
  stale-skill detector splits the window in half (so 7d → 3d/4d) and
  the Compliance spike threshold uses `mean(daily risk) + 1·stdev` of
  the windowed series. Both are still meaningful at 7d, but the
  variance is high. If we shrink the default further (e.g., 3d) these
  signals would collapse.
- **30d Trends/Cost views are no longer the default landing.** The
  Cost page's CSV reconciliation flow was always range-agnostic, so
  this only affects the live-API top-line; users doing finance
  reconciliation must know to switch presets. Documented in the page
  subtitle.

## Consequences

- Implementation: every `useDateRange(...)` call in `src/pages/*.tsx`
  passes `'7d'`; `src/lib/useDateRange.ts` default also changes to
  `'7d'`. UserSearch's local `useState<RangePreset>` initializes on
  `'7d'`.
- Architecture doc updated to call out the 7d default.
- The Executive page assumes 7d as the headline window; its KPI
  computation works at any preset but the `{days}` placeholder in the
  headline string is now meaningfully short by default.

## Status of related decisions

- ADR-0004's compliance prewarm pre-fetches the 7d / 14d / 30d windows
  on each ECS boot — the 7d entry was already there, so this decision
  doesn't change cache hit rates.
