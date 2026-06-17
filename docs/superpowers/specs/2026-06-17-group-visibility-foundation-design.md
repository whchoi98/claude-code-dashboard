# Group Visibility — Foundation — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Scope:** FOUNDATION only — group mapping source + global group filter (state + control) + ONE pilot page (Users). Rollout to the remaining ~10 pages is a separate cycle.

## Goal

Add group-level visibility across the dashboard via an admin-defined `email→group`
mapping (the Analytics API's `rbac_group_id`/`claude_project_id` group dimensions
return HTTP 400 "not yet supported" — confirmed live; user records carry no group
field). A global group selector (URL-synced like the date range) scopes every page to
the selected group. Foundation establishes the reusable mechanism + proves it on one
page; rollout then adds a one-line filter per remaining page.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Mapping source | **CSV upload → S3** (`email,group`), mirroring the spend-reports pattern. |
| Filter semantics | **Scope to selected group** — a global selector filters all (scoped) pages to that group's users. |
| Scope | **Foundation + pilot (Users page)**; remaining pages = later rollout. |

## Architecture

A global group filter (frontend-side scoping) + an admin-uploaded mapping. The Analytics
proxy routes are NOT changed (filtering happens client-side on the per-user records each
page already fetches). When `rbac_group_id` ships, the mapping source can be swapped
without touching consumers.

## 1. Mapping source (server — `server/aws.js`)

Mirror the spend-reports upload infra (multer memory storage + S3 `PutObjectCommand`, the existing `upload`/`multerErr` helpers).

- **`POST /api/groups/upload`** (multipart, field `file`): validate the CSV has `email` + `group` columns (reject otherwise → `400 { error, message }`); store to `s3://<BUCKET>/group-map/group-map-<YYYY-MM-DD>.csv` (latest-wins). Response `{ ok, file, rows, groups }`.
- **`GET /api/groups`**: read the latest object under `group-map/` (by LastModified, like `/cost/csv`), parse via `parseGroupMap`, return `{ source: 'live'|'empty', file, groups: string[], map: Record<email,group> }`. When no mapping exists → `{ source: 'empty', groups: [], map: {} }` (200, not an error).
- **Pure exported `parseGroupMap(csvText)`** → `{ map: { [email_lower]: group }, groups: string[] }`. Trims, lowercases emails for matching, skips blank/headerless rows, dedups group names, ignores rows missing email or group. Unit-tested.

(Foundation keeps it to upload + get-latest; uploads-list/delete management mirrors cost but is deferred to rollout.)

## 2. Global filter state + control (frontend)

- **`src/lib/useGroupScope.ts`** — combines the fetched map + the URL-selected group:
  - `useFetch('/api/groups')` for `{ groups, map }`.
  - URL state `?group=<name>` via `useSearchParams` (same idiom as `useDateRange`).
  - Returns `{ group, setGroup, groups, hasMap, loading, inGroup }` where `inGroup(email)`:
    - `group === ''` (All) → `true`
    - `group === '__unmapped__'` → email (lowercased) NOT in map
    - else → `map[email_lower] === group`
- **`src/components/GroupControl.tsx`** — a compact dropdown rendered in `Layout`: options = **All groups · …group names… · (Unmapped)**; writes `?group=` to the URL. Includes an "upload mapping" affordance (mirror `CsvUploader`, posts to `/api/groups/upload`, refetches). When `!hasMap`, the dropdown shows only "All groups" + an upload prompt.
- **`src/components/Layout.tsx`** — render `GroupControl` globally (e.g., in the sidebar header or top strip, near the language toggle). It is URL-synced, so every page's `useGroupScope` reflects the selection without prop-drilling.

## 3. Page application — pilot = Users

In `src/pages/Users.tsx`, call `useGroupScope()` and apply `inGroup` in the per-user aggregation: `for (const r of d.data) { if (!inGroup(r.user.email_address)) continue; … }`. `group === ''` → no-op (everyone). The page otherwise unchanged. This proves the end-to-end pattern (upload map → select group → page scopes). Pilot is swappable (Cost is the alternative).

## 4. Masking / PII

`/api/groups` returns the raw `email→group` map so the client can match `user.email_address`. The client uses it only for matching; every rendered email still goes through `maskEmail`. This is consistent with the existing admin (Cognito-gated) exposure of raw emails via `users/range` and `/cost/efficiency`. (A server-side group filter would avoid shipping the map, but requires a `group` param + per-route filtering across all proxy routes — deferred; not Foundation.)

## 5. Error handling / edge cases

- No mapping uploaded → `GET /api/groups` returns `source:'empty'`; control shows "All groups" + upload prompt; pages unfiltered.
- Malformed CSV (missing `email`/`group` column) → upload `400` with a clear message; the `GET` path tolerates partial rows (skips bad rows).
- Selected `?group=` no longer present in the map → `inGroup` matches nobody for a real name; the control falls back to "All groups" if the selected name isn't in `groups`.
- Emails compared case-insensitively (lowercased on both sides).
- `(Unmapped)` group surfaces users missing from the mapping (admin gap-spotting).

## 6. Testing

- **`parseGroupMap`** unit test (`tests/server/test-group-map.mjs`): header detection, email/group trim + lowercase, skip blank/missing-field rows, dedup group names, empty input → `{ map:{}, groups:[] }`.
- Frontend: `npx tsc --noEmit` + `npx vite build` (no frontend harness, per repo convention).
- Full suite (`bash tests/run-all.sh`) green; the new server route is additive.
- Version: **v1.3.0**.

## 7. Out of scope (rollout / later)

Applying the group filter to the remaining ~10 per-user pages; group-by breakdown views; mapping list/delete management UI; server-side group filtering; switching the source to `rbac_group_id` when the API supports it.
