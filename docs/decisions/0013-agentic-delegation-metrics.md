# ADR-0013: Agentic delegation metrics — Cowork actions/prompt as the KPI, CC accepted-only per-session proxy, org-level skill $/use

- **Status**: Accepted
- **Date**: 2026-07-08
- **Deciders**: @whchoi98
- **Related**: [ADR-0012](0012-live-user-tokens.md) (live per-user data lineage), metrics-catalog §4.8–4.11

## Context

The Agentic page ("How agentic is the work?") needs a delegation KPI:
actions Claude performs per prompt. Probing the Analytics API (2026-07-08)
showed the required numerator/denominator pair exists on exactly ONE
surface: `cowork_metrics` carries both `action_count` and `message_count`.
Claude Code exposes tool-action counts but **no prompt count** anywhere
(`core_metrics` = sessions/commits/PRs/LOC only). The user detail panel's
skills card additionally needed per-skill cost/uses, but the skills
endpoint has **no user × skill dimension** (skill rows carry no actor;
user rows carry only unnamed per-surface `skills_used_count` tallies).

## Decision

1. **Actions per prompt = Cowork `action_count ÷ message_count`** (ratio of
   period sums, same definition for the KPI, daily trend, and per-user
   rows). It is the only directly measurable prompt→actions pair; other
   surfaces are not blended in.
2. **Claude Code proxy = accepted tool actions ÷ distinct sessions.**
   Rejected proposals are excluded — an action Claude *performs* must have
   executed, matching Cowork `action_count` semantics. Labeled as a proxy
   ("the API has no prompt count") rather than presented as actions/prompt.
3. **Skill cost-per-use is org-level only**: `attributed_list_price/100 ÷
   invocation_count` per skill over the window (new 2026-07 skills-endpoint
   fields, cents convention verified live). The user detail panel labels
   the card org-wide; per-user skill data is limited to the surface counts
   the API provides. Archived days pre-dating `invocation_count` fall back
   to per-surface skill-used counts, with the effective window shown.

## Consequences

- The delegation KPI is exact but Cowork-scoped; orgs with little Cowork
  usage see sparse data (empty-state explains). If upstream ever ships a
  Claude Code prompt count, the CC proxy should be replaced.
- Accepted-only CC counting makes the number smaller than the detail
  panel's "Tool ops" tile (accepted+rejected) — different labels, both
  documented in metrics-catalog §4.9.
- Per-skill per-user attribution stays impossible until the API grows a
  user × skill dimension; revisit if `skills` rows ever gain an actor.
