# projects → Athena Queryable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-archived S3 `projects` data queryable via `/api/archive/query` + the chatbot SQL tool by flattening it through a new `flattenProject` mapper and registering a `projects_daily` Glue table.

**Architecture:** Mirror the existing flatten→Glue-table→allowlist pattern: a pure `flattenProject` in `collector/flatten.js` flattens the nested `created_by` object into `created_by_id`/`created_by_email` scalars; `StorageStack` registers `projects_daily` via the existing `table()` factory; `ATHENA_ALLOWED_TABLES` + schema hints gain the table. Forward-only (old partitions read `created_by_*` as NULL).

**Tech Stack:** Node 20 ESM Lambda (collector), AWS CDK (Glue partition-projection table + OpenX JSON SerDe), Express sanitizer/allowlist, standalone TAP `.mjs` test run by `tests/run-all.sh`.

**Spec:** `docs/superpowers/specs/2026-06-11-projects-to-athena-design.md`

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `collector/flatten.js` | add `flattenProject` (pure, exported) | write-side: nested project record → flat row |
| `collector/handler.js` | import + `projects.map(flattenProject)` | stop writing projects raw |
| `infra/lib/storage-stack.ts` | `PROJECT_COLUMNS` + `table('projects_daily', …)` | register the Glue table |
| `server/aws.js` | `ATHENA_ALLOWED_TABLES` += `projects_daily`; `ATHENA_SCHEMA_HINT` | allow + document |
| `server/chat-tools.js` | `ATHENA_SCHEMA_HINT_FOR_TOOL` += projects_daily | live chatbot hint |
| `collector/glue-schemas.md` | projects_daily table section | doc-sync |
| `tests/server/test-flatten-inflate.mjs` | `flattenProject` assertions | guard the mapper |
| `package.json`, `CHANGELOG.md` | v0.9.1 | release |

**Test runner:** `bash tests/run-all.sh` globs `tests/server/*.mjs`. No `npm test`.

---

## Task 1: flattenProject + collector wiring + test

**Files:**
- Modify: `collector/flatten.js` (add `flattenProject` after `flattenConnector`)
- Modify: `collector/handler.js:16` (import), `collector/handler.js:122-124` (use mapper)
- Test: `tests/server/test-flatten-inflate.mjs` (import + assertions)

- [ ] **Step 1: Add `flattenProject` assertions to `tests/server/test-flatten-inflate.mjs`.** First extend the import on line 3 to include `flattenProject`:

```js
import { flattenUser, flattenSkill, flattenConnector, flattenProject } from '../../collector/flatten.js'
```

Then add these assertions immediately before the `console.log(\`\n1..${n}\`)` footer:

```js
// --- Step 7: flattenProject (created_by flattened; sparse → null/0) ---
const proj = flattenProject({ project_id: 'p1', project_name: 'Demo', distinct_user_count: 3, distinct_conversation_count: 5, message_count: 40, created_at: '2026-04-10T09:08:43Z', created_by: { id: 'u9', email_address: 'a@acme.com' } })
ok('flattenProject maps scalars', proj.project_id === 'p1' && proj.project_name === 'Demo' && proj.distinct_user_count === 3 && proj.distinct_conversation_count === 5 && proj.message_count === 40 && proj.created_at === '2026-04-10T09:08:43Z')
ok('flattenProject flattens created_by', proj.created_by_id === 'u9' && proj.created_by_email === 'a@acme.com')
const projSparse = flattenProject({ project_id: 'p2' })
ok('flattenProject sparse → null/0', projSparse.created_by_id === null && projSparse.created_by_email === null && projSparse.message_count === 0 && projSparse.created_at === null)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: FAIL — `flattenProject` is not exported yet (import resolves to `undefined`, calling it throws `TypeError: flattenProject is not a function`).

- [ ] **Step 3: Add `flattenProject` to `collector/flatten.js`**, immediately after the `flattenConnector` function:

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

- [ ] **Step 4: Wire `flattenProject` into `collector/handler.js`.** Extend the flatten import (currently `import { flattenUser, flattenSkill, flattenConnector } from './flatten.js'`) to:

```js
import { flattenUser, flattenSkill, flattenConnector, flattenProject } from './flatten.js'
```

Then change the projects write (currently `toNdjson(projects, { snapshot_date: date })` at lines 123-124) to map through `flattenProject`:

```js
  results.projects = await writePartition('projects', date,
    toNdjson(projects.map(flattenProject), { snapshot_date: date }))
```

- [ ] **Step 5: Verify**

Run: `node --check collector/flatten.js && node --check collector/handler.js`
Expected: no output.

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: all `ok`, exit 0 (3 new flattenProject assertions pass).

Run: `bash tests/run-all.sh`
Expected: `# passed: N / N (failed: 0)`.

- [ ] **Step 6: Commit**

```bash
git add collector/flatten.js collector/handler.js tests/server/test-flatten-inflate.mjs
git commit -m "feat(collector): flattenProject — projects를 flat 컬럼으로 기록(created_by 펼침)"
```

---

## Task 2: projects_daily Glue table + allowlist + schema hints + docs + release

**Files:**
- Modify: `infra/lib/storage-stack.ts` (`PROJECT_COLUMNS` after line 94; `table(...)` call after line 159)
- Modify: `server/aws.js` (`ATHENA_ALLOWED_TABLES` ~line 276-281; `ATHENA_SCHEMA_HINT` ~line 366-372)
- Modify: `server/chat-tools.js` (`ATHENA_SCHEMA_HINT_FOR_TOOL` ~line 94-96)
- Modify: `collector/glue-schemas.md`
- Modify: `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Add `PROJECT_COLUMNS` + register the table in `infra/lib/storage-stack.ts`.** Add `PROJECT_COLUMNS` immediately after the `CONNECTOR_COLUMNS` definition (after line 94):

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

Then add the table registration immediately after the `table('connectors_daily', …)` line (after line 159):

```ts
    table('projects_daily', PROJECT_COLUMNS, 'projects')
```

- [ ] **Step 2: Allowlist + doc hint in `server/aws.js`.** Add `'projects_daily'` to the `ATHENA_ALLOWED_TABLES` Set:

```js
const ATHENA_ALLOWED_TABLES = new Set([
  'claude_code_analytics',
  'summaries_daily',
  'skills_daily',
  'connectors_daily',
  'projects_daily',
])
```

Then add a `projects_daily` bullet to `ATHENA_SCHEMA_HINT` — insert after the `connectors_daily` line (the `• connectors_daily: …` line, before the closing `Always filter by partition:` paragraph):

```
• projects_daily (one row per chat project per day):
  project_id, project_name, distinct_user_count, distinct_conversation_count,
  message_count, created_at, created_by_id, created_by_email
  (created_by_* are NULL for partitions collected before this column existed)
```

- [ ] **Step 3: Live chatbot hint in `server/chat-tools.js`.** Add a `projects_daily` bullet to `ATHENA_SCHEMA_HINT_FOR_TOOL` — insert after the `• connectors_daily: …` line:

```
• projects_daily: project_id, project_name, distinct_user_count, distinct_conversation_count, message_count, created_at, created_by_id, created_by_email (created_by_* nullable)
```

- [ ] **Step 4: Doc-sync `collector/glue-schemas.md`.** Add a new table section after the `summaries_daily` section (and before or after `skills_daily, connectors_daily` — placement is cosmetic):

```markdown
## `projects_daily` (daily per chat project)

| Column                      | Type   |
|-----------------------------|--------|
| project_id                  | string |
| project_name                | string |
| distinct_user_count         | bigint |
| distinct_conversation_count | bigint |
| message_count               | bigint |
| created_at                  | string |
| created_by_id               | string |
| created_by_email            | string |
| snapshot_date               | string |

Partition: `date` (string, YYYY-MM-DD). Flattened by `flattenProject` in `flatten.js`.
```

- [ ] **Step 5: Bump version + CHANGELOG.** Set `package.json` `"version"` to `0.9.1`. Add a top entry to `CHANGELOG.md` matching the existing bilingual format (`### Added` English + `### 추가` Korean), e.g.:

```markdown
## [0.9.1] - 2026-06-11

Roadmap step 7: make the archived `projects` data queryable.

### Added

- **`projects_daily` Athena table** — the collector's daily chat-project archive is now queryable via `/api/archive/query` and the chatbot SQL tool. `flattenProject` flattens the nested `created_by` into `created_by_id`/`created_by_email` scalars (projects was previously written raw); `projects_daily` registered in Glue + added to `ATHENA_ALLOWED_TABLES` and both schema hints. Forward-only: pre-existing partitions read `created_by_*` as NULL.

### 추가

- **`projects_daily` Athena 테이블** — collector의 일일 chat-project 아카이브를 `/api/archive/query`·챗봇 SQL로 쿼리 가능. `flattenProject`가 중첩 `created_by`를 `created_by_id`/`created_by_email` 스칼라로 펼침(이전엔 raw). 포워드 전용(옛 파티션은 `created_by_*` NULL).
```

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit`
Expected: no errors (no TS type changes; this only touches `.ts` in storage-stack).

Run: `node --check server/aws.js && node --check server/chat-tools.js`
Expected: no output.

Run: `bash tests/run-all.sh`
Expected: `# passed: N / N (failed: 0)`.

Run: `cd infra && npx cdk synth ccd-storage --context existingVpcId=vpc-0dfa5610180dfa628 >/dev/null && echo SYNTH_OK && cd ..`
Expected: `SYNTH_OK` (validates `PROJECT_COLUMNS` + the new table compile into the template). If `infra/node_modules` is missing, run `npm install` in `infra/` first.

```bash
git add infra/lib/storage-stack.ts server/aws.js server/chat-tools.js collector/glue-schemas.md package.json CHANGELOG.md
git commit -m "feat(archive): projects_daily Athena 테이블 + allowlist/스키마 힌트 + v0.9.1"
```

---

## Post-implementation (controller, after both tasks pass)

Handled by the controller via `finishing-a-development-branch` + deploy:

1. `cd infra && npx cdk deploy ccd-storage ccd-collector --context existingVpcId=vpc-0dfa5610180dfa628 --require-approval never` (new table + flattenProject collector).
2. Deploy `ccd-compute` (server schema-hint change); invalidate CloudFront `/*` (dist `EAKHVAM1T8MX8`).
3. Invoke the collector for a finalized date, then verify via `/api/archive/query`:
   `SELECT project_name, message_count, created_by_email FROM projects_daily WHERE date='<D>' LIMIT 5`.

## Out of scope (watch only)

`rbac_group_id` / `claude_project_id` cost group_by dims — still HTTP 400, not built.
