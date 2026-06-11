# Collector office / design / cowork-tool-edit Capture — Design

**Date:** 2026-06-11
**Roadmap:** Cost/Analytics step 5
**Status:** Approved (design); pending implementation plan

## Goal

Capture three families of Analytics-API user-record metrics that the collector
currently drops on write and the server re-invents as zeros on read:

1. `office_metrics` — now **4 surfaces** (`excel`, `powerpoint`, `word`, **`outlook`**), each with 6 numeric fields.
2. `design_metrics` — a **new top-level object** (4 numeric fields).
3. `cowork_metrics` **tool-edit fields** — 6 new fields that arrive as `null` on the wire today.

After this change these surface in the archive (Athena/Archive page + chatbot SQL)
and the live dashboard read path (`inflateUser`), with old partitions degrading
gracefully (NULL → 0 for office/design, NULL preserved for cowork tool-edit).

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **User record only** | office/design/cowork-tool-edit on the `users` endpoint. Skills/connectors drift and projects→Athena (step 7) are out of scope. |
| Backfill | **Forward-only** | New columns populate from deploy date onward. Old partitions read NULL. No collector re-run. |
| Null handling | **Preserve `null`** for cowork tool-edit | `null` ("feature not tracked") is distinct from `0` ("tracked, zero usage"). Stored as nullable `bigint`. |
| Field modeling | **Flat scalar columns** | ~34 nullable `bigint` columns matching the existing `flattenUser`→`inflateUser` convention. No JSON/STRUCT. |

## Architecture

The change is governed by the existing **write → read → schema** contract that
`collector/CLAUDE.md` warns about: a mismatch between the write side
(`flattenUser`) and the read side (`inflateUser`) "silently writes zeros." So the
three must change in lockstep, plus type/doc/chatbot-hint sync.

Why this migration is low-risk (confirmed by exploration):

- The Glue `users` table (`claude_code_analytics`) uses **partition projection**
  (`projection.date.range = 2026-01-01,NOW`), **not a crawler**. There is no
  per-partition schema recorded in the catalog. Adding a column to `USER_COLUMNS`
  and redeploying `ccd-storage` applies it uniformly to every date — no
  `MSCK REPAIR`, no crawler re-run, no `AddPartition`.
- The SerDe is **OpenX JSON SerDe** with `ignore.malformed.json=true`: it maps
  JSON keys to columns by name. A key absent from an old NDJSON line reads as
  `NULL`; an unknown extra key is ignored; column order is irrelevant.
- All new fields are **shallow and fixed-shape** (max 2 levels:
  `office_metrics.<surface>.<metric>`), so they extend the flat-`bigint` model
  cleanly.

**Constraint:** migrations must be **additive only**. Never rename/retype an
existing column in place — old partitions would silently read NULL/garbage for
the renamed key.

### Testability improvement (in scope)

The approved round-trip test requires importing `flattenUser` and `inflateUser`
in isolation. Today neither is importable cleanly:

- `server/index.js` boots the Express server at module top level — importing it
  to reach `inflateUser` would start a listening server.
- `collector/handler.js` imports `@aws-sdk/client-s3` and
  `@aws-sdk/client-secrets-manager` (not guaranteed present in the repo-root
  `node_modules` a root-run test uses).

So we extract the pure logic into two dependency-free modules:

- **`collector/flatten.js`** (new) — pure: `flattenUser`, `flattenSkill`,
  `flattenConnector`. No imports. `handler.js` imports from it.
- **`server/inflate.js`** (new) — pure: `inflateUser`. No imports.
  `server/index.js` imports from it.

This keeps the flatten/inflate contract in two small focused files that the test
imports with zero side effects and zero extra dependencies.

## New columns (34)

All `bigint`, appended to `USER_COLUMNS` (28 → 62). JSON SerDe ⇒ append order is
cosmetic.

### office_metrics → 24 columns

Surfaces: `excel`, `powerpoint`, `word`, `outlook`. Column pattern
`office_<surface>_<suffix>`:

| API metric (per surface) | Suffix | Flatten | Inflate |
|---|---|---|---|
| `distinct_session_count` | `_sessions` | `?? 0` | `?? 0` |
| `message_count` | `_messages` | `?? 0` | `?? 0` |
| `skills_used_count` | `_skills_used` | `?? 0` | `?? 0` |
| `distinct_skills_used_count` | `_distinct_skills` | `?? 0` | `?? 0` |
| `connectors_used_count` | `_connectors_used` | `?? 0` | `?? 0` |
| `distinct_connectors_used_count` | `_distinct_connectors` | `?? 0` | `?? 0` |

e.g. `office_excel_sessions`, `office_powerpoint_messages`,
`office_word_skills_used`, `office_outlook_distinct_connectors`.

The API returns every surface as a concrete object, so `0` is a real zero —
`?? 0` is correct (no null preservation needed here).

### cowork_metrics tool-edit → 6 columns (nullable)

Column name = API field name with `cowork_` prefix. `?? null` on **both** sides
to preserve the "not tracked" signal.

| API field (`cowork_metrics.*`) | Column |
|---|---|
| `file_edit_count` | `cowork_file_edit_count` |
| `edit_tool_count` | `cowork_edit_tool_count` |
| `multi_edit_tool_count` | `cowork_multi_edit_tool_count` |
| `write_tool_count` | `cowork_write_tool_count` |
| `notebook_edit_tool_count` | `cowork_notebook_edit_tool_count` |
| `sessions_with_file_edits_count` | `cowork_sessions_with_file_edits_count` |

`x ?? null` passes numbers through unchanged (including a real `0`) and maps
`undefined`/`null` → `null`. `JSON.stringify` writes `null` literally; OpenX reads
it as `NULL bigint`.

### design_metrics → 4 columns

New top-level object, always present, `?? 0`:

| API field (`design_metrics.*`) | Column |
|---|---|
| `distinct_session_count` | `design_sessions` |
| `distinct_projects_used_count` | `design_projects_used` |
| `distinct_projects_created_count` | `design_projects_created` |
| `message_count` | `design_messages` |

## Component changes

### Write side — `collector/flatten.js` (new) + `collector/handler.js`

- Move `flattenUser`/`flattenSkill`/`flattenConnector` into `collector/flatten.js`
  (pure, `export`ed). `handler.js` replaces the local definitions with
  `import { flattenUser, flattenSkill, flattenConnector } from './flatten.js'`.
- In `flattenUser`, add `const office = r.office_metrics || {}` and
  `const design = r.design_metrics || {}` aliases (reuse existing
  `const cowork = r.cowork_metrics || {}`), then emit the 34 new keys:
  - office: `office_<surface>_<suffix>: office.<surface>?.<metric> ?? 0` (24 keys)
  - cowork tool-edit: `cowork_file_edit_count: cowork.file_edit_count ?? null`, … (6 keys)
  - design: `design_sessions: design.distinct_session_count ?? 0`, … (4 keys)

### Read side — `server/inflate.js` (new) + `server/index.js`

- Move `inflateUser` into `server/inflate.js` (pure, `export`ed).
  `server/index.js` replaces the local definition with
  `import { inflateUser } from './inflate.js'`.
- In `inflateUser`:
  - `office_metrics`: replace the hardcoded-zero excel/powerpoint/word stub with
    all **4 surfaces** (add `outlook`), each field read from its flat column
    (`f.office_excel_sessions ?? 0`, …).
  - Add a new `design_metrics` block:
    `{ distinct_session_count: f.design_sessions ?? 0, distinct_projects_used_count: f.design_projects_used ?? 0, distinct_projects_created_count: f.design_projects_created ?? 0, message_count: f.design_messages ?? 0 }`.
  - `cowork_metrics`: add the 6 tool-edit fields with `?? null`
    (`file_edit_count: f.cowork_file_edit_count ?? null`, …). The existing
    zero-filled `skills_used_count`/`distinct_skills_used_count`/
    `connectors_used_count`/`distinct_connectors_used_count` stay as-is
    (pre-existing, out of scope).

### Schema — `infra/lib/storage-stack.ts`

Append the 34 `{ name, type: 'bigint' }` entries to `USER_COLUMNS` (before or
after `snapshot_date` — order is cosmetic for JSON SerDe).

### Types — `src/types.ts`

- `OfficeAppMetrics` stays as-is (already matches the 6-field surface shape).
- `UserRecord.office_metrics`: add `outlook: OfficeAppMetrics` and make `word`
  required (it is always present on the wire).
- New `DesignMetrics` type `{ distinct_session_count; distinct_projects_used_count; distinct_projects_created_count; message_count }` (all `number`); add `design_metrics: DesignMetrics` to `UserRecord`.
- `CoworkMetrics`: add the 6 tool-edit fields typed `number | null`.

### Chatbot / docs sync

- `server/aws.js` `ATHENA_SCHEMA_HINT` (~:344-372): document the 34 new
  `claude_code_analytics` columns so the chatbot's `run_athena_sql` tool can query them.
- `server/chat-tools.js` (~:93): update the column list referenced there if it
  enumerates user columns.
- `collector/glue-schemas.md`: add the 34 columns to the `claude_code_analytics` table doc.

## Data flow

```
Analytics API user record
  office_metrics {excel,powerpoint,word,outlook}  (concrete, numeric)
  design_metrics {…}                              (concrete, numeric)
  cowork_metrics {…tool-edit…}                    (null on the wire today)
        │
        ▼  collector/handler.js → flatten.js flattenUser  (?? 0 / ?? null)
   NDJSON row  →  s3://<archive>/users/date=D/users-D.json
        │
        ├─▶ [Athena partition projection]  old date = NULL · new date = value
        │     →  /api/archive/query  (schema-agnostic; any column queryable)
        │     →  chatbot run_athena_sql  (ATHENA_SCHEMA_HINT documents columns)
        │
        └─▶ [readUsersFromS3 + inflate.js inflateUser]  → live dashboard (nested)
              (live API range routes still pass design_metrics through directly;
               the prior live-vs-archive design divergence is resolved.)
```

## Error handling / edge cases

- **Old API records missing `office_metrics`/`design_metrics`**: `r.office_metrics || {}`, `office.<surface>?.<metric> ?? 0` → 0. Safe.
- **Old partitions (pre-deploy)**: NDJSON lines lack the new keys → OpenX reads NULL. `inflateUser` maps office/design NULL → 0 and cowork tool-edit NULL → null. Consistent with the forward-only decision.
- **`null` vs `0` for cowork tool-edit**: `?? null` preserves a genuine API `0` and maps null/undefined → null. Never coerces to 0.
- **No rename/retype**: only additive column changes (hard rule).

## Testing

- **`tests/collector/test-flatten-inflate.mjs`** (new): import `flattenUser`
  from `collector/flatten.js` and `inflateUser` from `server/inflate.js`. Feed a
  synthetic user record with all 4 office surfaces populated, a populated
  `design_metrics`, and cowork tool-edit fields set to a mix of numbers and
  `null`. Assert:
  1. `flattenUser` emits all 34 new keys with the correct values.
  2. cowork tool-edit `null` is preserved through flatten (not coerced to 0).
  3. `inflateUser(flattenUser(record))` round-trips office (4 surfaces incl. outlook), design, and cowork tool-edit values; null stays null; office/design absent → 0.
- **Schema-drift guard** (lightweight): a test asserting the key set emitted by
  `flattenUser` for the new fields is a subset of the documented column list
  (catch a future add-to-one-side-only mistake).
- `node --check collector/flatten.js collector/handler.js server/inflate.js server/index.js` for ESM syntax.
- `npx tsc --noEmit` for the `types.ts` changes.
- Full suite target: ~56 → ~60 passing.

## Deploy sequence

```bash
cd infra
npx cdk deploy ccd-storage ccd-collector \
  --context existingVpcId=vpc-0dfa5610180dfa628 --require-approval never
# then the server + frontend via the /deploy fast-path (ccd-compute)
```

OpenX ignores unknown keys and reads missing keys as NULL, so order cannot break
reads; deploying `ccd-storage` first (columns registered) is simply cleanest.
Verify `cdk diff ccd-storage` shows a **Modify** (Glue UpdateTable, in-place) on
the table, not a Replace, before relying on zero-downtime.

## Out of scope (explicitly deferred)

- Skills/connectors endpoint drift (their `outlook` surface + `enable_count`,
  `estimated_overage_spend`, `read_call_count`, etc.).
- `projects` → `ATHENA_ALLOWED_TABLES` (roadmap step 7).
- Backfill of historical partitions.
- The 4 pre-existing zero-filled cowork skill/connector fields in `inflateUser`.
