# ADR-0011: Native RBAC group visibility — rbac_group_id dims + Compliance groups as the name source

- **Status**: Accepted
- **Date**: 2026-07-04
- **Deciders**: @whchoi98
- **Amends**: the CSV-only group mapping in the v1.4/v1.5 group-visibility rollout

## Context

Group visibility (v1.4/v1.5) was built on an admin-uploaded `email,group` CSV
because `group_by[]=rbac_group_id` returned 400 "not yet supported"
(re-probed 2026-06-17). Verified live 2026-07-03/04 (and announced only via a
2026-07-02 blog post, not the API changelog): the dimension now returns real
attribution on all four cost-family endpoints. Two gaps remained: (a) group
**names** — the scope-bearing listing endpoint we found first
(`GET /v1/organizations/rbac_groups`, scope `read:rbac_groups`) is
**undocumented** and its scope cannot be provisioned; (b) the dimension
**flaps**, intermittently returning 503 "Team membership data is not ready
yet" for hours (also undocumented).

## Options considered

1. **Keep CSV-only mapping** — stable, but manual and permanently drifts from
   the org's real RBAC/SCIM groups.
2. **Undocumented `/v1/organizations/rbac_groups`** — returns names but needs
   an unprovisionable scope and may vanish without notice.
3. **Documented `GET /v1/compliance/groups` (chosen for names)** — official,
   returns `rbac_group_…` ids + names + `source_type`, and requires
   `read:compliance_org_data`, which the provisioned Analytics key already
   carries (verified live: Security/CXO/Engineering/Marketing).

## Decision

- `/api/cost/groups` serves per-group spend from `cost_report ×
  rbac_group_id`; `/api/groups` auto-derives the sidebar email→group map from
  `user_cost_report × rbac_group_id` (max-spend group per user) when no admin
  CSV exists — an uploaded CSV still wins.
- Group ids resolve to display names via `fetchGroupNames()` →
  `GET /v1/compliance/groups`, cached 1 h + last-good, because every listing
  emits a `group_list_viewed` audit event into the org's own feed;
  `grp-<id suffix>` labels are the fallback, and duplicate names get an
  id-suffix disambiguator (extend-until-unique) to keep label→id invertible.
- The 503 flap is absorbed by a per-window **last-good cache** (`stale: true`
  responses) plus an explanatory UI note (`rbac_groups_unavailable`) instead
  of a silently missing card.

## Consequences

- Group cost and group scope work with zero admin upkeep and real names;
  the CSV upload remains as an intent override (custom groupings).
- Upstream semantics are **any-membership**: multi-group users count fully in
  each group, so group rows can sum above the org total (stated in the card
  subtitle); buckets carry at most the top-100 groups.
- The flap mitigation has no documented retry contract to lean on — behavior
  is empirically derived and may need revisiting if upstream stabilizes.
- Name lookups ride the Compliance scopes on the Analytics key; if scopes are
  ever split back into separate keys, names degrade gracefully to id-suffix
  labels.
