# ADR-0014: Group membership from the Compliance members endpoint — spend-derive demoted to fallback

- **Status**: Accepted
- **Date**: 2026-07-12
- **Deciders**: @whchoi98
- **Amends**: the auto-derive path of [ADR-0011](0011-rbac-group-visibility-native.md)

## Context

ADR-0011 auto-derives the email→group map from `user_cost_report ×
rbac_group_id` because no documented membership listing existed. That
attribution is **usage-time**, which breaks down exactly when the org
reorganizes (observed live 2026-07-12: a new `Prin-Engineering` group,
seven removals / six adds across Engineering/CXO, and a Marketing→Sales
rename, all inside ten minutes):

- A **moved** user keeps rows under their old group for up to the 31-day
  window — they appear in both groups for weeks, and their old tab keeps
  claiming them.
- A **new** group is invisible until spend accrues under it (plus the ~4h
  data watermark) — its tab simply doesn't exist on reorg day.
- A **renamed** group is fine (names were already live via
  `GET /v1/compliance/groups`), but membership still lagged.

Probed live 2026-07-12: `GET /v1/compliance/groups/{group_id}/members`
exists, returns `{ user_id, email }` rows with the same `next_page` cursor
as the listing, and is served by the `read:compliance_org_data` scope the
Analytics key already carries.

## Options considered

1. **Keep spend-derive only** — zero new calls, but reorgs surface days late
   and deleted groups linger.
2. **Ask the admin to upload a CSV on every reorg** — ADR-0011 kept this as
   an override, but making it the required sync mechanism reintroduces the
   manual drift ADR-0011 was written to remove.
3. **Members endpoint as primary, spend-derive as fallback (chosen)** —
   authoritative point-in-time membership, documented endpoint, no new
   scopes; the flaky-but-proven spend path stays as a degradation layer.

## Decision

- `GET /api/groups` source chain (first that yields groups wins):
  **admin CSV** (`source:'live'`, intent override, unchanged) → **real
  membership** (`source:'members'`, new) → **spend-derive**
  (`source:'auto'`, unchanged) → **last-good of either** (`stale:true`) →
  `source:'empty'`.
- New pure helper `deriveMemberGroupMap(groupList, membersByGroupId)` keeps
  the `{ map, groups, ids }` contract; arrays are label-sorted (the client
  filters any-membership — `[0]`-as-primary was a spend-path artifact).
  Memberless groups still get a tab: an authoritative listing that says "no
  groups" now returns `empty` directly instead of letting spend rows
  resurrect deleted groups.
- One `fetchComplianceGroups()` cache (1h) feeds both the name lookup and
  the membership fetch; per-group member calls are **all-or-nothing** (a
  partial fetch would silently dump one group's users into Unmapped) and the
  assembled map is cached 1h — Console edits land within the hour instead of
  days.
- Guard rails (added after the pre-deploy adversarial review): pagination
  cap exhaustion **throws** instead of silently truncating (listing 10×100,
  members 50×100 — honoring all-or-nothing); the map cache expires with the
  **listing timestamp** it was built from (a build-time stamp compounded the
  two 1h TTLs into ~2h worst-case for group creates/deletes); failures fail
  fast for 5 minutes and concurrent cold requests share one in-flight build
  (no per-group re-burst on every SPA load during a flap); the fan-out is
  chunked 5-at-a-time (org rate budget is 60 rpm shared); an authoritative
  zero-group listing is persisted as last-good and guards the spend-derive
  fallback (deleted groups can't resurrect during an outage); the two
  `groups:*` last-good keys are eviction-immune in the shared cap-20 map;
  when both live sources fail the **fresher** of the two last-goods is
  served (`remembered_at` stamp).
- Client: `hasMap` now treats any non-`empty` source as mapped, so future
  server-side sources can't silently disable the tabs.

## Consequences

- Group creates, deletes, renames, and member moves are reflected within
  ≤1h with zero admin action; the CSV override and the spend fallback both
  survive unchanged.
- `/api/groups` no longer carries `period` on its primary path (membership
  is point-in-time, not windowed); the field remains on the `auto` fallback
  and was never consumed by the client.
- Members calls add ~1 upstream request per group per hour and likely emit
  audit events into the org's own feed (the Console's equivalent listing
  logs `group_member_list_viewed`) — the 1h cache is the noise budget.
- The members endpoint is documented for Compliance-scoped keys but its
  pagination behavior beyond 100 members/group is untested here (this org
  has ≤8 members/group); the cursor loop mirrors the listing's.
