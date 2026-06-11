# projects → Athena Queryable — Design

**Date:** 2026-06-11
**Roadmap:** Cost/Analytics step 7
**Status:** Approved (design); pending implementation plan

## Goal

Make the already-archived S3 `projects` data queryable through `/api/archive/query`
and the chatbot's `run_athena_sql` tool by registering a Glue table for it and
adding it to the SQL allowlist.

## Problem

The collector writes a daily `projects` NDJSON partition
(`s3://<archive>/projects/date=YYYY-MM-DD/`), but:

1. **No Glue table is registered** for it — `StorageStack` only registers 4 tables
   (`claude_code_analytics`, `summaries_daily`, `skills_daily`, `connectors_daily`).
2. **It is written un-flattened** — `projects` is the only dataset the collector
   writes raw (no `flattenProject` mapper), and its `created_by` field is a nested
   object, inconsistent with the repo's flat-scalar-only column model.
3. **`projects_daily` is not in `ATHENA_ALLOWED_TABLES`**, so the sanitizer would
   reject any query referencing it even if a table existed.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Nested `created_by` | **Flatten to `created_by_id` + `created_by_email`** | Matches the repo's flat-scalar convention; fixes the lone raw-written dataset. |
| Migration | **Forward-only** | Old projects partitions keep `created_by` as a nested object (no flat columns) → `created_by_id`/`created_by_email` read NULL for them; other columns query fine. Backfill is a one-line collector loop if ever needed. |
| Glue table name | **`projects_daily`** | Matches the `<thing>_daily` naming of the other three non-user tables. S3 prefix stays `projects`. |
| `rbac_group_id` / `claude_project_id` | **Watch only — not built** | Still HTTP 400 ("not yet supported"). No code this task. |

## projects record shape (verified, 2026-06-08 partition)

```
project_id (string), project_name (string),
distinct_user_count, distinct_conversation_count, message_count (number),
created_at (string ISO ts),
created_by { id (string), email_address (string) },   ← nested; flattened
snapshot_date (string)
```

## Components

### `collector/flatten.js` — new `flattenProject(p)` (pure, exported)

```js
export function flattenProject(p) {
  return {
    project_id:                  p.project_id,
    project_name:                p.project_name,
    distinct_user_count:         p.distinct_user_count ?? 0,
    distinct_conversation_count: p.distinct_conversation_count ?? 0,
    message_count:               p.message_count ?? 0,
    created_at:                  p.created_at ?? null,
    created_by_id:               p.created_by?.id ?? null,
    created_by_email:            p.created_by?.email_address ?? null,
  }
}
```

### `collector/handler.js`

Import `flattenProject` from `./flatten.js` (alongside the existing flatten
imports) and change the projects write from raw `toNdjson(projects, …)` to
`toNdjson(projects.map(flattenProject), { snapshot_date: date })`, matching the
users/skills/connectors pattern.

### `infra/lib/storage-stack.ts` — `PROJECT_COLUMNS` + table registration

```ts
const PROJECT_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'project_id', type: 'string' },
  { name: 'project_name', type: 'string' },
  { name: 'distinct_user_count', type: 'bigint' },
  { name: 'distinct_conversation_count', type: 'bigint' },
  { name: 'message_count', type: 'bigint' },
  { name: 'created_at', type: 'string' },
  { name: 'created_by_id', type: 'string' },
  { name: 'created_by_email', type: 'string' },
  { name: 'snapshot_date', type: 'string' },
]
```

Register via the existing factory: `table('projects_daily', PROJECT_COLUMNS, 'projects')`
(same partition-projection + OpenX JSON SerDe + `2026-01-01,NOW` range as the others).

### `server/aws.js`

- Add `'projects_daily'` to the `ATHENA_ALLOWED_TABLES` Set.
- Add a `projects_daily` bullet to `ATHENA_SCHEMA_HINT` (doc copy) listing the 8 columns.

### `server/chat-tools.js`

- Add a `projects_daily` bullet to `ATHENA_SCHEMA_HINT_FOR_TOOL` (the live chatbot hint).

### `collector/glue-schemas.md`

- Add a `projects_daily` table section with the 9-column table (8 data + `snapshot_date`) and partition `date`.

## Data flow

```
Analytics API /apps/chat/projects (paginated)
  → collector flattenProject → NDJSON → s3://<archive>/projects/date=D/
  → [Glue table projects_daily, partition projection]  old partitions: created_by_* = NULL
  → /api/archive/query (sanitizer allows projects_daily) + chatbot run_athena_sql
       (chatbot masks created_by_email via maskEmailsDeep; Archive page shows raw,
        consistent with existing user_email behavior — Cognito admin-only)
```

## Error handling / edge cases

- **Missing `created_by`** on a record → `created_by_id`/`created_by_email` = null (`?? null`).
- **Old (pre-deploy) partitions** → nested `created_by` ignored by the schema (no matching column); `created_by_*` read NULL; top-level scalar columns query normally.
- **Sanitizer**: `projects_daily` must be in `ATHENA_ALLOWED_TABLES` or queries are rejected; no column-level gating (consistent with the other tables).

## Testing

- Add `flattenProject` assertions to `tests/server/test-flatten-inflate.mjs` (next to the `flattenSkill`/`flattenConnector` smoke tests): field mapping, `created_by` → `created_by_id`/`created_by_email`, and `?? null`/`?? 0` defaults on a sparse record.
- Gates: `node --check collector/flatten.js collector/handler.js`, `bash tests/run-all.sh`, `npx tsc --noEmit` (no type changes expected), `cdk synth ccd-storage`.

## Deploy

1. `cd infra && npx cdk deploy ccd-storage ccd-collector --context existingVpcId=vpc-0dfa5610180dfa628 --require-approval never` (new table + flattenProject).
2. Deploy `ccd-compute` (server schema-hint change) via `/deploy`; invalidate CloudFront `/*`.
3. Invoke the collector for a finalized date and verify with
   `SELECT project_name, message_count, created_by_email FROM projects_daily WHERE date='<D>' LIMIT 5`
   via `/api/archive/query`.

## Out of scope (watch only)

`rbac_group_id` / `claude_project_id` cost group_by dims (HTTP 400 — not yet
supported by the API). No code this task; tracked for a future re-probe.
