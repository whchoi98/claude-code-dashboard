# Collector office / design / cowork-tool-edit Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture `office_metrics` (4 surfaces incl. Outlook), `design_metrics`, and the new `cowork_metrics` tool-edit fields in the daily collector so they reach both the Athena archive and the live dashboard read path.

**Architecture:** Extract the flatten/inflate contract into two dependency-free modules (`collector/flatten.js`, `server/inflate.js`) so it is unit-testable, then add ~34 nullable `bigint` columns across the write side (`flattenUser`), read side (`inflateUser`), Glue schema (`USER_COLUMNS`), types, mock, and chatbot hints — additive only. Forward-only; `?? null` preserves the "not tracked" signal for cowork tool-edit fields, `?? 0` for office/design.

**Tech Stack:** Node 20 ESM Lambda (collector), Express ESM server, AWS CDK (Glue partition-projection table + OpenX JSON SerDe), TypeScript types, standalone TAP `.mjs` tests run by `tests/run-all.sh`.

**Spec:** `docs/superpowers/specs/2026-06-11-collector-office-design-cowork-design.md`

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `collector/flatten.js` | **create** | Pure `flattenUser`/`flattenSkill`/`flattenConnector` (write side) |
| `collector/handler.js` | modify | Import from `./flatten.js`; remove local defs |
| `server/inflate.js` | **create** | Pure `inflateUser` (read side) |
| `server/index.js` | modify | Import from `./inflate.js`; remove local def |
| `infra/lib/storage-stack.ts` | modify | Append 34 `bigint` columns to `USER_COLUMNS` |
| `src/types.ts` | modify | `outlook` surface, `DesignMetrics`, nullable cowork tool-edit |
| `server/mock.js` | modify | Mock the new user-record fields |
| `server/aws.js` | modify | Document new columns in `ATHENA_SCHEMA_HINT` |
| `server/chat-tools.js` | modify | Document new columns in `ATHENA_SCHEMA_HINT_FOR_TOOL` |
| `collector/glue-schemas.md` | modify | Doc-sync the new columns |
| `tests/server/test-flatten-inflate.mjs` | **create** | Round-trip + drift-guard test (auto-discovered by `run-all.sh`) |
| `CHANGELOG.md`, `package.json` | modify | v0.9.0 release entry + version bump |

**Test runner:** `tests/run-all.sh` globs `tests/server/*.mjs` and runs each with `node` (exit 0/1). New test MUST live in `tests/server/`. Run the whole suite with `bash tests/run-all.sh`.

---

## Task 1: Extract pure flatten/inflate modules (refactor, no behavior change)

**Files:**
- Create: `collector/flatten.js`
- Modify: `collector/handler.js:14-15` (add import), `collector/handler.js:131-193` (remove local defs)
- Create: `server/inflate.js`
- Modify: `server/index.js:7` (add import), `server/index.js:30-79` (remove local def)
- Test: `tests/server/test-flatten-inflate.mjs` (create — characterization)

- [ ] **Step 1: Create `collector/flatten.js`** with the three functions moved verbatim from `handler.js`:

```js
// Pure flatten helpers — Analytics API nested records → columnar NDJSON rows
// that Athena/Glue can query and server/inflate.js inflateUser() can reconstruct.
// Dependency-free so the flatten↔inflate contract is unit-testable in isolation
// (tests/server/test-flatten-inflate.mjs). Field names MUST stay in lockstep with
// server/inflate.js — a mismatch silently writes zeros (see collector/CLAUDE.md).

export function flattenUser(r) {
  const cc = r.claude_code_metrics || {}
  const core = cc.core_metrics || {}
  const tools = cc.tool_actions || {}
  const tool = (t) => ({
    accepted: t?.accepted_count ?? 0,
    rejected: t?.rejected_count ?? 0,
  })
  const chat = r.chat_metrics || {}
  const cowork = r.cowork_metrics || {}
  return {
    user_id:                r.user?.id,
    user_email:             r.user?.email_address,
    chat_conversations:     chat.distinct_conversation_count ?? 0,
    chat_messages:          chat.message_count ?? 0,
    chat_thinking_messages: chat.thinking_message_count ?? 0,
    chat_files_uploaded:    chat.distinct_files_uploaded_count ?? 0,
    chat_artifacts:         chat.distinct_artifacts_created_count ?? 0,
    chat_skills:            chat.distinct_skills_used_count ?? 0,
    chat_connectors:        chat.connectors_used_count ?? 0,
    cc_sessions:            core.distinct_session_count ?? 0,
    lines_of_code_added:    core.lines_of_code?.added_count ?? 0,
    lines_of_code_removed:  core.lines_of_code?.removed_count ?? 0,
    commits_by_claude_code: core.commit_count ?? 0,
    prs_by_claude_code:     core.pull_request_count ?? 0,
    edit_tool_accepted:          tool(tools.edit_tool).accepted,
    edit_tool_rejected:          tool(tools.edit_tool).rejected,
    multi_edit_tool_accepted:    tool(tools.multi_edit_tool).accepted,
    multi_edit_tool_rejected:    tool(tools.multi_edit_tool).rejected,
    write_tool_accepted:         tool(tools.write_tool).accepted,
    write_tool_rejected:         tool(tools.write_tool).rejected,
    notebook_edit_tool_accepted: tool(tools.notebook_edit_tool).accepted,
    notebook_edit_tool_rejected: tool(tools.notebook_edit_tool).rejected,
    web_search_count:       r.web_search_count ?? 0,
    cowork_sessions:        cowork.distinct_session_count ?? 0,
    cowork_messages:        cowork.message_count ?? 0,
    cowork_actions:         cowork.action_count ?? 0,
    cowork_dispatch_turns:  cowork.dispatch_turn_count ?? 0,
  }
}

export function flattenSkill(s) {
  return {
    skill_name: s.skill_name,
    distinct_users: s.distinct_user_count ?? 0,
    chat_uses: s.chat_metrics?.distinct_conversation_skill_used_count ?? 0,
    claude_code_uses: s.claude_code_metrics?.distinct_session_skill_used_count ?? 0,
    cowork_uses: s.cowork_metrics?.distinct_session_skill_used_count ?? 0,
  }
}

export function flattenConnector(c) {
  return {
    connector_name: c.connector_name,
    distinct_users: c.distinct_user_count ?? 0,
    chat_uses: c.chat_metrics?.distinct_conversation_connector_used_count ?? 0,
    claude_code_uses: c.claude_code_metrics?.distinct_session_connector_used_count ?? 0,
    cowork_uses: c.cowork_metrics?.distinct_session_connector_used_count ?? 0,
  }
}
```

- [ ] **Step 2: Rewire `collector/handler.js`** — add the import after line 15 (`import { SecretsManagerClient, ... }`):

```js
import { flattenUser, flattenSkill, flattenConnector } from './flatten.js'
```

Then delete the now-duplicated block `collector/handler.js:131-193` (the contract comment + `function flattenUser`/`flattenSkill`/`flattenConnector`). Leave their call sites (`users.map(flattenUser)` etc.) untouched.

- [ ] **Step 3: Create `server/inflate.js`** with `inflateUser` moved verbatim from `index.js:31-79`:

```js
// Pure read-side helper — flattened NDJSON row (collector/flatten.js flattenUser)
// → nested Analytics-API shape. Dependency-free so the flatten↔inflate contract
// is unit-testable in isolation. Field names MUST stay in lockstep with
// collector/flatten.js — a mismatch silently writes zeros (collector/CLAUDE.md).
export function inflateUser(f) {
  return {
    user: { id: f.user_id, email_address: f.user_email },
    chat_metrics: {
      distinct_conversation_count:        f.chat_conversations ?? 0,
      message_count:                      f.chat_messages ?? 0,
      thinking_message_count:             f.chat_thinking_messages ?? 0,
      distinct_projects_used_count:       0,
      distinct_projects_created_count:    0,
      distinct_artifacts_created_count:   f.chat_artifacts ?? 0,
      distinct_skills_used_count:         f.chat_skills ?? 0,
      connectors_used_count:              f.chat_connectors ?? 0,
      distinct_files_uploaded_count:      f.chat_files_uploaded ?? 0,
      shared_conversations_viewed_count:  0,
      distinct_shared_artifacts_viewed_count: 0,
    },
    claude_code_metrics: {
      core_metrics: {
        distinct_session_count: f.cc_sessions ?? 0,
        commit_count:           f.commits_by_claude_code ?? 0,
        pull_request_count:     f.prs_by_claude_code ?? 0,
        lines_of_code: {
          added_count:   f.lines_of_code_added ?? 0,
          removed_count: f.lines_of_code_removed ?? 0,
        },
      },
      tool_actions: {
        edit_tool:          { accepted_count: f.edit_tool_accepted ?? 0,          rejected_count: f.edit_tool_rejected ?? 0 },
        multi_edit_tool:    { accepted_count: f.multi_edit_tool_accepted ?? 0,    rejected_count: f.multi_edit_tool_rejected ?? 0 },
        write_tool:         { accepted_count: f.write_tool_accepted ?? 0,         rejected_count: f.write_tool_rejected ?? 0 },
        notebook_edit_tool: { accepted_count: f.notebook_edit_tool_accepted ?? 0, rejected_count: f.notebook_edit_tool_rejected ?? 0 },
      },
    },
    office_metrics: {
      excel:      { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
      powerpoint: { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
      word:       { distinct_session_count: 0, message_count: 0, skills_used_count: 0, distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0 },
    },
    cowork_metrics: {
      distinct_session_count: f.cowork_sessions ?? 0,
      action_count:           f.cowork_actions ?? 0,
      dispatch_turn_count:    f.cowork_dispatch_turns ?? 0,
      message_count:          f.cowork_messages ?? 0,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    web_search_count: f.web_search_count ?? 0,
  }
}
```

- [ ] **Step 4: Rewire `server/index.js`** — add the import after line 7 (`import { registerAwsRoutes } from './aws.js'`):

```js
import { inflateUser } from './inflate.js'
```

Then delete the local `inflateUser` definition + its lead comment at `server/index.js:30-79`. Leave `readUsersFromS3`'s `rows.map(inflateUser)` call untouched.

- [ ] **Step 5: Create `tests/server/test-flatten-inflate.mjs`** (characterization — existing fields only for now):

```js
// Round-trip test for the collector flatten ↔ server inflate contract.
// node tests/server/test-flatten-inflate.mjs — exit 0 on success, 1 on failure.
import { flattenUser } from '../../collector/flatten.js'
import { inflateUser } from '../../server/inflate.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// A synthetic Analytics-API user record covering every metric group.
const record = {
  user: { id: 'u1', email_address: 'a@acme.com' },
  chat_metrics: { distinct_conversation_count: 3, message_count: 40, thinking_message_count: 5, distinct_files_uploaded_count: 2, distinct_artifacts_created_count: 1, distinct_skills_used_count: 4, connectors_used_count: 2 },
  claude_code_metrics: {
    core_metrics: { distinct_session_count: 7, commit_count: 9, pull_request_count: 2, lines_of_code: { added_count: 100, removed_count: 20 } },
    tool_actions: {
      edit_tool: { accepted_count: 10, rejected_count: 1 },
      multi_edit_tool: { accepted_count: 5, rejected_count: 0 },
      write_tool: { accepted_count: 3, rejected_count: 2 },
      notebook_edit_tool: { accepted_count: 1, rejected_count: 0 },
    },
  },
  web_search_count: 8,
  cowork_metrics: {
    distinct_session_count: 2, action_count: 11, dispatch_turn_count: 4, message_count: 6,
    file_edit_count: 3, edit_tool_count: 2, multi_edit_tool_count: null,
    write_tool_count: 0, notebook_edit_tool_count: null, sessions_with_file_edits_count: 1,
  },
  office_metrics: {
    excel:      { distinct_session_count: 1, message_count: 2, skills_used_count: 3, distinct_skills_used_count: 4, connectors_used_count: 5, distinct_connectors_used_count: 6 },
    powerpoint: { distinct_session_count: 7, message_count: 8, skills_used_count: 9, distinct_skills_used_count: 10, connectors_used_count: 11, distinct_connectors_used_count: 12 },
    word:       { distinct_session_count: 13, message_count: 14, skills_used_count: 15, distinct_skills_used_count: 16, connectors_used_count: 17, distinct_connectors_used_count: 18 },
    outlook:    { distinct_session_count: 19, message_count: 20, skills_used_count: 21, distinct_skills_used_count: 22, connectors_used_count: 23, distinct_connectors_used_count: 24 },
  },
  design_metrics: { distinct_session_count: 30, distinct_projects_used_count: 31, distinct_projects_created_count: 32, message_count: 33 },
}

const flat = flattenUser(record)
const round = inflateUser(flat)
const empty = flattenUser({ user: { id: 'x', email_address: 'x@y.com' } })

// --- Task 1: existing-field characterization (behavior preserved by extraction) ---
ok('flatten keeps user id/email', flat.user_id === 'u1' && flat.user_email === 'a@acme.com')
ok('round-trip chat messages', round.chat_metrics.message_count === 40)
ok('round-trip cc loc added', round.claude_code_metrics.core_metrics.lines_of_code.added_count === 100)
ok('round-trip edit_tool accepted', round.claude_code_metrics.tool_actions.edit_tool.accepted_count === 10)
ok('round-trip cowork existing', round.cowork_metrics.distinct_session_count === 2 && round.cowork_metrics.action_count === 11)
ok('round-trip web_search_count', round.web_search_count === 8)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 6: Verify syntax + suite**

Run: `node --check collector/flatten.js && node --check collector/handler.js && node --check server/inflate.js && node --check server/index.js`
Expected: no output (all valid).

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: 6 `ok` lines, exits 0.

Run: `bash tests/run-all.sh`
Expected: ends `# passed: N / N (failed: 0)` (the new `.mjs` is auto-discovered; total grows by 1 suite).

- [ ] **Step 7: Commit**

```bash
git add collector/flatten.js collector/handler.js server/inflate.js server/index.js tests/server/test-flatten-inflate.mjs
git commit -m "refactor: flatten/inflate를 순수 모듈로 추출 + 라운드트립 테스트"
```

---

## Task 2: office_metrics capture — 4 surfaces incl. Outlook (24 columns, `?? 0`)

**Files:**
- Modify: `collector/flatten.js` (add `office` alias + 24 keys to `flattenUser`)
- Modify: `server/inflate.js` (add `officeSurface` helper + 4-surface `office_metrics` block)
- Modify: `infra/lib/storage-stack.ts:34` (append 24 `bigint` columns to `USER_COLUMNS`)
- Modify: `src/types.ts:61-65` (add `outlook`, make `word` required)
- Modify: `server/mock.js:108-112` (add `outlook: emptyOffice()`)
- Test: `tests/server/test-flatten-inflate.mjs` (add office assertions)

- [ ] **Step 1: Add office assertions to the test (before the `console.log` footer):**

```js
// --- Task 2: office_metrics (4 surfaces incl. outlook) ---
ok('flatten office outlook messages', flat.office_outlook_messages === 20)
ok('flatten office excel distinct_connectors', flat.office_excel_distinct_connectors === 6)
ok('round-trip office word skills_used', round.office_metrics.word.skills_used_count === 15)
ok('round-trip office outlook present (4th surface)', round.office_metrics.outlook.distinct_session_count === 19)
ok('office surfaces = excel,outlook,powerpoint,word', Object.keys(round.office_metrics).sort().join(',') === 'excel,outlook,powerpoint,word')
ok('absent office_metrics → 0', empty.office_excel_sessions === 0 && empty.office_outlook_messages === 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: FAIL — `office_outlook_messages` is `undefined` (flatten doesn't emit it yet) and `round.office_metrics.outlook` is `undefined`.

- [ ] **Step 3: Add the `office` alias + 24 keys to `flattenUser`** in `collector/flatten.js`. Add the alias next to the others:

```js
  const cowork = r.cowork_metrics || {}
  const office = r.office_metrics || {}
```

Then add these 24 keys immediately after `cowork_dispatch_turns: cowork.dispatch_turn_count ?? 0,` (still inside the returned object):

```js
    office_excel_sessions:              office.excel?.distinct_session_count ?? 0,
    office_excel_messages:              office.excel?.message_count ?? 0,
    office_excel_skills_used:           office.excel?.skills_used_count ?? 0,
    office_excel_distinct_skills:       office.excel?.distinct_skills_used_count ?? 0,
    office_excel_connectors_used:       office.excel?.connectors_used_count ?? 0,
    office_excel_distinct_connectors:   office.excel?.distinct_connectors_used_count ?? 0,
    office_powerpoint_sessions:            office.powerpoint?.distinct_session_count ?? 0,
    office_powerpoint_messages:            office.powerpoint?.message_count ?? 0,
    office_powerpoint_skills_used:         office.powerpoint?.skills_used_count ?? 0,
    office_powerpoint_distinct_skills:     office.powerpoint?.distinct_skills_used_count ?? 0,
    office_powerpoint_connectors_used:     office.powerpoint?.connectors_used_count ?? 0,
    office_powerpoint_distinct_connectors: office.powerpoint?.distinct_connectors_used_count ?? 0,
    office_word_sessions:              office.word?.distinct_session_count ?? 0,
    office_word_messages:              office.word?.message_count ?? 0,
    office_word_skills_used:           office.word?.skills_used_count ?? 0,
    office_word_distinct_skills:       office.word?.distinct_skills_used_count ?? 0,
    office_word_connectors_used:       office.word?.connectors_used_count ?? 0,
    office_word_distinct_connectors:   office.word?.distinct_connectors_used_count ?? 0,
    office_outlook_sessions:            office.outlook?.distinct_session_count ?? 0,
    office_outlook_messages:            office.outlook?.message_count ?? 0,
    office_outlook_skills_used:         office.outlook?.skills_used_count ?? 0,
    office_outlook_distinct_skills:     office.outlook?.distinct_skills_used_count ?? 0,
    office_outlook_connectors_used:     office.outlook?.connectors_used_count ?? 0,
    office_outlook_distinct_connectors: office.outlook?.distinct_connectors_used_count ?? 0,
```

- [ ] **Step 4: Rewrite the `office_metrics` block in `server/inflate.js`.** Add a module-scope helper above `inflateUser`:

```js
// Reconstruct one office surface (excel/powerpoint/word/outlook) from flat columns.
function officeSurface(f, s) {
  return {
    distinct_session_count:         f[`office_${s}_sessions`] ?? 0,
    message_count:                  f[`office_${s}_messages`] ?? 0,
    skills_used_count:              f[`office_${s}_skills_used`] ?? 0,
    distinct_skills_used_count:     f[`office_${s}_distinct_skills`] ?? 0,
    connectors_used_count:          f[`office_${s}_connectors_used`] ?? 0,
    distinct_connectors_used_count: f[`office_${s}_distinct_connectors`] ?? 0,
  }
}
```

Then replace the hardcoded-zeros `office_metrics:` block (excel/powerpoint/word) inside `inflateUser` with:

```js
    office_metrics: {
      excel:      officeSurface(f, 'excel'),
      powerpoint: officeSurface(f, 'powerpoint'),
      word:       officeSurface(f, 'word'),
      outlook:    officeSurface(f, 'outlook'),
    },
```

- [ ] **Step 5: Append 24 columns to `USER_COLUMNS`** in `infra/lib/storage-stack.ts`, immediately after `{ name: 'cowork_dispatch_turns', type: 'bigint' },` (before `{ name: 'snapshot_date', type: 'string' }`):

```ts
  { name: 'office_excel_sessions', type: 'bigint' },
  { name: 'office_excel_messages', type: 'bigint' },
  { name: 'office_excel_skills_used', type: 'bigint' },
  { name: 'office_excel_distinct_skills', type: 'bigint' },
  { name: 'office_excel_connectors_used', type: 'bigint' },
  { name: 'office_excel_distinct_connectors', type: 'bigint' },
  { name: 'office_powerpoint_sessions', type: 'bigint' },
  { name: 'office_powerpoint_messages', type: 'bigint' },
  { name: 'office_powerpoint_skills_used', type: 'bigint' },
  { name: 'office_powerpoint_distinct_skills', type: 'bigint' },
  { name: 'office_powerpoint_connectors_used', type: 'bigint' },
  { name: 'office_powerpoint_distinct_connectors', type: 'bigint' },
  { name: 'office_word_sessions', type: 'bigint' },
  { name: 'office_word_messages', type: 'bigint' },
  { name: 'office_word_skills_used', type: 'bigint' },
  { name: 'office_word_distinct_skills', type: 'bigint' },
  { name: 'office_word_connectors_used', type: 'bigint' },
  { name: 'office_word_distinct_connectors', type: 'bigint' },
  { name: 'office_outlook_sessions', type: 'bigint' },
  { name: 'office_outlook_messages', type: 'bigint' },
  { name: 'office_outlook_skills_used', type: 'bigint' },
  { name: 'office_outlook_distinct_skills', type: 'bigint' },
  { name: 'office_outlook_connectors_used', type: 'bigint' },
  { name: 'office_outlook_distinct_connectors', type: 'bigint' },
```

- [ ] **Step 6: Update `src/types.ts`** — replace the `office_metrics` block in `UserRecord` (`src/types.ts:61-65`) with the 4-surface required form:

```ts
  office_metrics: {
    excel: OfficeAppMetrics
    powerpoint: OfficeAppMetrics
    word: OfficeAppMetrics
    outlook: OfficeAppMetrics
  }
```

(Leave the `office_metrics` blocks in the `Skill`/`Connector` types untouched — skills/connectors drift is out of scope.)

- [ ] **Step 7: Update `server/mock.js`** — add the 4th surface to the user record's `office_metrics` (`server/mock.js:108-112`):

```js
    office_metrics: {
      excel: emptyOffice(),
      powerpoint: emptyOffice(),
      word: emptyOffice(),
      outlook: emptyOffice(),
    },
```

- [ ] **Step 8: Verify**

Run: `node --check collector/flatten.js && node --check server/inflate.js && node --check server/mock.js`
Expected: no output.

Run: `npx tsc --noEmit`
Expected: no errors (no `office_metrics` value literal in `.ts`/`.tsx` outside `types.ts`).

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: all `ok`, exits 0 (now 12 assertions).

- [ ] **Step 9: Commit**

```bash
git add collector/flatten.js server/inflate.js infra/lib/storage-stack.ts src/types.ts server/mock.js tests/server/test-flatten-inflate.mjs
git commit -m "feat(collector): office_metrics 4 surface(outlook 포함) 캡처"
```

---

## Task 3: cowork tool-edit (6 cols, `?? null`) + design_metrics (4 cols, `?? 0`)

**Files:**
- Modify: `collector/flatten.js` (add `design` alias + 6 cowork + 4 design keys to `flattenUser`)
- Modify: `server/inflate.js` (add 6 cowork tool-edit fields + new `design_metrics` block)
- Modify: `infra/lib/storage-stack.ts` (append 10 `bigint` columns to `USER_COLUMNS`)
- Modify: `src/types.ts` (6 nullable cowork fields + `DesignMetrics` + `UserRecord.design_metrics`)
- Modify: `server/mock.js` (cowork tool-edit nulls + `design_metrics`)
- Test: `tests/server/test-flatten-inflate.mjs` (add cowork-null + design assertions)

- [ ] **Step 1: Add assertions to the test (before the `console.log` footer):**

```js
// --- Task 3: cowork tool-edit (null-preserving) + design_metrics ---
ok('flatten cowork file_edit_count', flat.cowork_file_edit_count === 3)
ok('flatten cowork null preserved (not 0)', flat.cowork_multi_edit_tool_count === null && flat.cowork_notebook_edit_tool_count === null)
ok('flatten cowork real 0 preserved (not null)', flat.cowork_write_tool_count === 0)
ok('round-trip cowork tool-edit value', round.cowork_metrics.file_edit_count === 3)
ok('round-trip cowork null stays null', round.cowork_metrics.multi_edit_tool_count === null)
ok('round-trip cowork real 0 stays 0', round.cowork_metrics.write_tool_count === 0)
ok('flatten design', flat.design_sessions === 30 && flat.design_projects_created === 32)
ok('round-trip design_metrics', round.design_metrics.distinct_session_count === 30 && round.design_metrics.message_count === 33)
ok('absent cowork tool-edit → null', empty.cowork_file_edit_count === null)
ok('absent design → 0', empty.design_sessions === 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: FAIL — `flat.cowork_file_edit_count` and `flat.design_sessions` are `undefined`; `round.design_metrics` is `undefined`.

- [ ] **Step 3: Add the `design` alias + 10 keys to `flattenUser`** in `collector/flatten.js`. Add the alias:

```js
  const office = r.office_metrics || {}
  const design = r.design_metrics || {}
```

Then add these 10 keys after the office block (still inside the returned object). Note `?? null` for cowork (preserves null vs real 0), `?? 0` for design:

```js
    cowork_file_edit_count:                cowork.file_edit_count ?? null,
    cowork_edit_tool_count:                cowork.edit_tool_count ?? null,
    cowork_multi_edit_tool_count:          cowork.multi_edit_tool_count ?? null,
    cowork_write_tool_count:               cowork.write_tool_count ?? null,
    cowork_notebook_edit_tool_count:       cowork.notebook_edit_tool_count ?? null,
    cowork_sessions_with_file_edits_count: cowork.sessions_with_file_edits_count ?? null,
    design_sessions:         design.distinct_session_count ?? 0,
    design_projects_used:    design.distinct_projects_used_count ?? 0,
    design_projects_created: design.distinct_projects_created_count ?? 0,
    design_messages:         design.message_count ?? 0,
```

- [ ] **Step 4: Update `inflateUser` in `server/inflate.js`.** Add the 6 tool-edit fields inside the existing `cowork_metrics` block (after `message_count: f.cowork_messages ?? 0,`, before the zero-filled `skills_used_count`):

```js
      file_edit_count:                f.cowork_file_edit_count ?? null,
      edit_tool_count:                f.cowork_edit_tool_count ?? null,
      multi_edit_tool_count:          f.cowork_multi_edit_tool_count ?? null,
      write_tool_count:               f.cowork_write_tool_count ?? null,
      notebook_edit_tool_count:       f.cowork_notebook_edit_tool_count ?? null,
      sessions_with_file_edits_count: f.cowork_sessions_with_file_edits_count ?? null,
```

Then add a new `design_metrics` block as a sibling of `cowork_metrics` (e.g. right after the `cowork_metrics: { ... },` block, before `web_search_count:`):

```js
    design_metrics: {
      distinct_session_count:          f.design_sessions ?? 0,
      distinct_projects_used_count:    f.design_projects_used ?? 0,
      distinct_projects_created_count: f.design_projects_created ?? 0,
      message_count:                   f.design_messages ?? 0,
    },
```

- [ ] **Step 5: Append 10 columns to `USER_COLUMNS`** in `infra/lib/storage-stack.ts`, after the `office_outlook_distinct_connectors` column added in Task 2 (still before `snapshot_date`):

```ts
  { name: 'cowork_file_edit_count', type: 'bigint' },
  { name: 'cowork_edit_tool_count', type: 'bigint' },
  { name: 'cowork_multi_edit_tool_count', type: 'bigint' },
  { name: 'cowork_write_tool_count', type: 'bigint' },
  { name: 'cowork_notebook_edit_tool_count', type: 'bigint' },
  { name: 'cowork_sessions_with_file_edits_count', type: 'bigint' },
  { name: 'design_sessions', type: 'bigint' },
  { name: 'design_projects_used', type: 'bigint' },
  { name: 'design_projects_created', type: 'bigint' },
  { name: 'design_messages', type: 'bigint' },
```

- [ ] **Step 6: Update `src/types.ts`.** Add the 6 nullable fields to `CoworkMetrics` (after `message_count: number`, `src/types.ts:50`):

```ts
  file_edit_count: number | null
  edit_tool_count: number | null
  multi_edit_tool_count: number | null
  write_tool_count: number | null
  notebook_edit_tool_count: number | null
  sessions_with_file_edits_count: number | null
```

Add a new `DesignMetrics` type (e.g. after `CoworkMetrics`, before `UserRecord`):

```ts
export type DesignMetrics = {
  distinct_session_count: number
  distinct_projects_used_count: number
  distinct_projects_created_count: number
  message_count: number
}
```

Add `design_metrics` to `UserRecord` (after `cowork_metrics: CoworkMetrics`):

```ts
  design_metrics: DesignMetrics
```

- [ ] **Step 7: Update `server/mock.js`** — in `mockUserRecord`, add the 6 cowork tool-edit fields (null, mirroring the live API today) inside `cowork_metrics`, and add a `design_metrics` block. Replace the `cowork_metrics: { ... }` object and add design after it:

```js
    cowork_metrics: {
      distinct_session_count: ccActive && rand() < 0.3 ? Math.floor(1 + rand() * 3) : 0,
      action_count: 0,
      dispatch_turn_count: 0,
      message_count: 0,
      file_edit_count: null,
      edit_tool_count: null,
      multi_edit_tool_count: null,
      write_tool_count: null,
      notebook_edit_tool_count: null,
      sessions_with_file_edits_count: null,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    design_metrics: {
      distinct_session_count: 0,
      distinct_projects_used_count: 0,
      distinct_projects_created_count: 0,
      message_count: 0,
    },
    web_search_count: active ? Math.floor(rand() * 12) : 0,
```

- [ ] **Step 8: Verify**

Run: `node --check collector/flatten.js && node --check server/inflate.js && node --check server/mock.js`
Expected: no output.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `node tests/server/test-flatten-inflate.mjs`
Expected: all `ok`, exits 0 (now 22 assertions).

- [ ] **Step 9: Commit**

```bash
git add collector/flatten.js server/inflate.js infra/lib/storage-stack.ts src/types.ts server/mock.js tests/server/test-flatten-inflate.mjs
git commit -m "feat(collector): cowork tool-edit(null 보존) + design_metrics 캡처"
```

---

## Task 4: chatbot schema hints, docs, drift-guard, release

**Files:**
- Modify: `server/aws.js:344-372` (`ATHENA_SCHEMA_HINT`)
- Modify: `server/chat-tools.js:92-97` (`ATHENA_SCHEMA_HINT_FOR_TOOL`)
- Modify: `collector/glue-schemas.md` (`claude_code_analytics` column table)
- Modify: `collector/CLAUDE.md`, `server/CLAUDE.md` (note `flatten.js`/`inflate.js` split)
- Modify: `tests/server/test-flatten-inflate.mjs` (drift-guard assertion)
- Modify: `package.json` (version), `CHANGELOG.md` (v0.9.0 entry)

- [ ] **Step 1: Add a drift-guard assertion** to `tests/server/test-flatten-inflate.mjs` (before the footer). This pins the exact set of new columns `flattenUser` must emit:

```js
// --- Task 4: schema-drift guard (flatten must emit every documented new column) ---
const NEW_COLUMNS = [
  'office_excel_sessions','office_excel_messages','office_excel_skills_used','office_excel_distinct_skills','office_excel_connectors_used','office_excel_distinct_connectors',
  'office_powerpoint_sessions','office_powerpoint_messages','office_powerpoint_skills_used','office_powerpoint_distinct_skills','office_powerpoint_connectors_used','office_powerpoint_distinct_connectors',
  'office_word_sessions','office_word_messages','office_word_skills_used','office_word_distinct_skills','office_word_connectors_used','office_word_distinct_connectors',
  'office_outlook_sessions','office_outlook_messages','office_outlook_skills_used','office_outlook_distinct_skills','office_outlook_connectors_used','office_outlook_distinct_connectors',
  'cowork_file_edit_count','cowork_edit_tool_count','cowork_multi_edit_tool_count','cowork_write_tool_count','cowork_notebook_edit_tool_count','cowork_sessions_with_file_edits_count',
  'design_sessions','design_projects_used','design_projects_created','design_messages',
]
const flatKeys = new Set(Object.keys(flat))
ok('flatten emits all 34 documented new columns', NEW_COLUMNS.every((c) => flatKeys.has(c)) && NEW_COLUMNS.length === 34)
```

Run: `node tests/server/test-flatten-inflate.mjs` → all `ok` (23 assertions).

- [ ] **Step 2: Update `ATHENA_SCHEMA_HINT` in `server/aws.js`.** Extend the `claude_code_analytics` column list (after the `cowork_sessions, ... cowork_dispatch_turns` line, ~`server/aws.js:358`) with:

```
  office_excel_*, office_powerpoint_*, office_word_*, office_outlook_*
    (each surface: _sessions, _messages, _skills_used, _distinct_skills, _connectors_used, _distinct_connectors),
  cowork_file_edit_count, cowork_edit_tool_count, cowork_multi_edit_tool_count,
  cowork_write_tool_count, cowork_notebook_edit_tool_count, cowork_sessions_with_file_edits_count
    (cowork tool-edit counts are NULL until the org enables cowork file-editing),
  design_sessions, design_projects_used, design_projects_created, design_messages
```

- [ ] **Step 3: Update `ATHENA_SCHEMA_HINT_FOR_TOOL` in `server/chat-tools.js`** (the `claude_code_analytics` bullet, `server/chat-tools.js:93`). Append to the column list:

```
, office_<surface>_<metric> (surface=excel|powerpoint|word|outlook), cowork_file_edit_count, cowork_edit_tool_count, cowork_multi_edit_tool_count, cowork_write_tool_count, cowork_notebook_edit_tool_count, cowork_sessions_with_file_edits_count (nullable), design_sessions, design_projects_used, design_projects_created, design_messages
```

- [ ] **Step 4: Update `collector/glue-schemas.md`** — append the 34 rows to the `claude_code_analytics` table (after the `cowork_dispatch_turns` row, before `snapshot_date`):

```
| office_excel_sessions               | bigint  |
| office_excel_messages               | bigint  |
| office_excel_skills_used            | bigint  |
| office_excel_distinct_skills        | bigint  |
| office_excel_connectors_used        | bigint  |
| office_excel_distinct_connectors    | bigint  |
| office_powerpoint_sessions          | bigint  |
| office_powerpoint_messages          | bigint  |
| office_powerpoint_skills_used       | bigint  |
| office_powerpoint_distinct_skills   | bigint  |
| office_powerpoint_connectors_used   | bigint  |
| office_powerpoint_distinct_connectors | bigint |
| office_word_sessions                | bigint  |
| office_word_messages                | bigint  |
| office_word_skills_used             | bigint  |
| office_word_distinct_skills         | bigint  |
| office_word_connectors_used         | bigint  |
| office_word_distinct_connectors     | bigint  |
| office_outlook_sessions             | bigint  |
| office_outlook_messages             | bigint  |
| office_outlook_skills_used          | bigint  |
| office_outlook_distinct_skills      | bigint  |
| office_outlook_connectors_used      | bigint  |
| office_outlook_distinct_connectors  | bigint  |
| cowork_file_edit_count              | bigint  |
| cowork_edit_tool_count              | bigint  |
| cowork_multi_edit_tool_count        | bigint  |
| cowork_write_tool_count             | bigint  |
| cowork_notebook_edit_tool_count     | bigint  |
| cowork_sessions_with_file_edits_count | bigint |
| design_sessions                     | bigint  |
| design_projects_used                | bigint  |
| design_projects_created             | bigint  |
| design_messages                     | bigint  |
```

Also update the intro line `Schemas mirror the flattened output of collector/handler.js.` → `collector/flatten.js`.

- [ ] **Step 5: Doc-sync the module split.**
  - `collector/CLAUDE.md`: in the Files section, note `flatten.js` (pure write-side helpers) and that the `flattenUser → inflateUser` contract now lives in `collector/flatten.js` ↔ `server/inflate.js`.
  - `server/CLAUDE.md`: in the Files section, add `inflate.js` (pure read-side `inflateUser`, unit-tested via `tests/server/test-flatten-inflate.mjs`).

- [ ] **Step 6: Bump version + CHANGELOG.** Set `package.json` `"version": "0.9.0"`. Add a top entry to `CHANGELOG.md` following the existing format, e.g.:

```markdown
## v0.9.0 — Collector office/design/cowork-tool-edit 캡처

- collector가 office_metrics(excel/powerpoint/word/outlook 4 surface), design_metrics, cowork tool-edit 필드를 S3 아카이브에 캡처 (flat nullable bigint 34컬럼, USER_COLUMNS 28→62)
- cowork tool-edit는 null 보존("미추적" ≠ "0회"); office/design은 0 기본
- flatten/inflate 계약을 순수 모듈(collector/flatten.js, server/inflate.js)로 추출 + 라운드트립/드리프트 테스트
- 포워드 전용: 옛 파티션은 신규 컬럼을 NULL(office/design→0, cowork→null)로 읽음
```

- [ ] **Step 7: Final verification**

Run: `bash tests/run-all.sh`
Expected: `# passed: N / N (failed: 0)`.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `cd infra && npx cdk synth ccd-storage --context existingVpcId=vpc-0dfa5610180dfa628 >/dev/null && echo SYNTH_OK`
Expected: `SYNTH_OK` (validates the 34 new `USER_COLUMNS` entries compile into the template).

- [ ] **Step 8: Commit**

```bash
git add server/aws.js server/chat-tools.js collector/glue-schemas.md collector/CLAUDE.md server/CLAUDE.md tests/server/test-flatten-inflate.mjs package.json CHANGELOG.md
git commit -m "docs/chat: 신규 office/design/cowork 컬럼 스키마 힌트·문서 동기화 + v0.9.0"
```

---

## Post-implementation (controller, after all tasks pass)

Not plan tasks — handled by the controller via `finishing-a-development-branch` + `/deploy`:

1. `cd infra && npx cdk diff ccd-storage --context existingVpcId=vpc-0dfa5610180dfa628` — confirm the Glue table change is a **Modify** (in-place `UpdateTable`), not a Replace.
2. Deploy storage + collector: `npx cdk deploy ccd-storage ccd-collector --context existingVpcId=vpc-0dfa5610180dfa628 --require-approval never`.
3. Deploy server + frontend via `/deploy` (ccd-compute); invalidate CloudFront `/*` (dist `EAKHVAM1T8MX8`).
4. Invoke the collector for a finalized date (e.g. today−3) and confirm the new columns populate in S3 / via an Athena `SELECT office_outlook_messages, cowork_file_edit_count, design_sessions FROM claude_code_analytics WHERE date='<D>' LIMIT 5`.

## Out of scope (deferred — do not implement)

Skills/connectors endpoint drift; `projects` → `ATHENA_ALLOWED_TABLES` (step 7); historical backfill; the 4 pre-existing zero-filled cowork skill/connector fields in `inflateUser`.
