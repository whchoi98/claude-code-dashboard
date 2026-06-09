# Analyze → Tool-Use Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `/analyze` route into a conversational, multi-turn tool-use chatbot (the LLM autonomously calls data tools) exposed both as the full page and a global floating widget.

**Architecture:** A new `POST /api/chat/stream` runs a Bedrock Converse tool-use loop (max 4 hops) over 4 tools (`get_analytics_overview`, `run_athena_sql`, `get_cost_summary`, `search_users`), streaming SSE. The frontend keeps conversation state in a `useChatStream` hook and renders it through one shared `ChatPanel` used by both `Analyze.tsx` (page variant, keeps MD/PDF export) and a `FloatingChat` widget mounted in `Layout`. Memory is client-side: the last 12 turns are sent as `history[]`.

**Tech Stack:** Express 4 (ESM) · AWS SDK v3 `ConverseStreamCommand` + `ConverseCommand` with `toolConfig` · React 18 + TypeScript · Tailwind · `react-markdown`. Spec: `docs/superpowers/specs/2026-06-09-analyze-tool-use-chatbot-design.md`.

---

## File Structure

**New files**
- `server/chat-tools.js` — pure, testable: email masking, history→Bedrock messages, follow-up parsing, user ranking, overview compaction, `TOOL_SPECS`, `CHAT_SYSTEM_PROMPT`, `makeToolRunner(deps)`. No AWS client imports.
- `tests/server/test-chat-tools.mjs` — unit tests for the pure functions above.
- `src/lib/useChatStream.ts` — chat state hook + SSE parser.
- `src/components/chat/MessageList.tsx` — bubbles, markdown, typing dots, tool badges, follow-up/suggested pills.
- `src/components/chat/ChatComposer.tsx` — textarea + send/stop.
- `src/components/chat/ChatPanel.tsx` — shared surface (page + widget variants), controlled via a `chat` prop.
- `src/components/chat/FloatingChat.tsx` — global launcher button + modal.
- `docs/decisions/0008-tool-use-chatbot.md` — ADR.

**Modified files**
- `server/aws.js` — add `fetchCostSummary()` (refactor from `/cost/live`), add `POST /chat/stream` + `generateFollowups()`, remove `POST /analyze` + `generateSql` + `extractSql`.
- `src/pages/Analyze.tsx` — rewrite around `ChatPanel variant="page"`, keep export toolbar.
- `src/components/Layout.tsx` — mount `<FloatingChat />`.
- `src/lib/i18n.tsx` — add `chat.*` keys (en+ko), remove `analyze.mode.*`.
- `tests/run-all.sh` — register the new node test.
- `server/CLAUDE.md`, `src/CLAUDE.md`, `docs/api-reference.md`, `docs/architecture.md` — doc sync.
- `CHANGELOG.md`, `package.json` — v0.7.0 entry + version bump.

---

## Phase 1 — Server: chat-tools module (pure, TDD)

### Task 1: Email masking + history→messages helpers

**Files:**
- Create: `server/chat-tools.js`
- Test: `tests/server/test-chat-tools.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/server/test-chat-tools.mjs`:

```js
// Standalone ESM test for server/chat-tools.js pure helpers.
// Runs with: node tests/server/test-chat-tools.mjs
// Exit code 0 on success, 1 on any failure (TAP-like output).

import {
  maskEmail, maskEmailsDeep, historyToBedrockMessages,
  parseFollowups, rankUsers, compactOverview,
} from '../../server/chat-tools.js'

let testNum = 0
let failed = 0
function ok(name, cond) {
  testNum += 1
  if (cond) { console.log(`ok ${testNum} - ${name}`) }
  else { failed += 1; console.log(`not ok ${testNum} - ${name}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// maskEmail
ok('maskEmail keeps 2 chars + domain', maskEmail('alice.kim@acme.com') === 'al*******@acme.com')
ok('maskEmail short local untouched', maskEmail('ab@x.com') === 'ab@x.com')
ok('maskEmail null → empty', maskEmail(null) === '')

// maskEmailsDeep
ok('maskEmailsDeep masks nested', eq(
  maskEmailsDeep({ rows: [{ user_email: 'bob.lee@acme.com', n: 5 }] }),
  { rows: [{ user_email: 'bo*****@acme.com', n: 5 }] },
))
ok('maskEmailsDeep leaves non-emails', maskEmailsDeep('hello world') === 'hello world')

// historyToBedrockMessages
ok('history maps roles + drops empties', eq(
  historyToBedrockMessages([
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'hello' },
  ]),
  [
    { role: 'user', content: [{ text: 'hi' }] },
    { role: 'assistant', content: [{ text: 'hello' }] },
  ],
))
ok('history drops leading assistant', eq(
  historyToBedrockMessages([{ role: 'assistant', text: 'x' }, { role: 'user', text: 'q' }]),
  [{ role: 'user', content: [{ text: 'q' }] }],
))
ok('history caps to last 12 turns', historyToBedrockMessages(
  Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` })),
).length <= 12)

console.log(`\n1..${testNum}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/server/test-chat-tools.mjs`
Expected: FAIL — `Cannot find module '../../server/chat-tools.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/chat-tools.js` with this opening section:

```js
// Pure, dependency-free helpers + tool registry for the /api/chat/stream
// tool-use chatbot. No AWS client instantiation here so this module is
// unit-testable in isolation (see tests/server/test-chat-tools.mjs).

export const MAX_TOOL_HOPS = 4
export const HISTORY_MAX_TURNS = 12
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// Mirror of src/lib/format.ts maskEmail — keep the two in sync.
export function maskEmail(email) {
  if (!email) return ''
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return email
  return local.slice(0, 2) + '*'.repeat(Math.max(3, local.length - 2)) + domain
}

// Recursively mask any email-shaped string anywhere in a value. Used on tool
// results BEFORE they reach the model, so raw emails never enter the prompt.
export function maskEmailsDeep(value) {
  if (typeof value === 'string') return value.replace(EMAIL_RE, (m) => maskEmail(m))
  if (Array.isArray(value)) return value.map(maskEmailsDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = maskEmailsDeep(v)
    return out
  }
  return value
}

// Client sends [{role,text}]; build Bedrock messages[], dropping empty turns,
// capping to the last HISTORY_MAX_TURNS, and ensuring it does not start with
// an assistant turn (Bedrock requires the first message to be from the user).
export function historyToBedrockMessages(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-HISTORY_MAX_TURNS)
  while (turns.length && turns[0].role === 'assistant') turns.shift()
  return turns.map((t) => ({ role: t.role, content: [{ text: t.text }] }))
}
```

- [ ] **Step 4: Run test — `maskEmail`/`maskEmailsDeep`/`history` pass, `parseFollowups`/`rankUsers`/`compactOverview` fail**

Run: `node tests/server/test-chat-tools.mjs`
Expected: the first 8 assertions pass; the import still throws because `parseFollowups`, `rankUsers`, `compactOverview` are not exported yet. (If the import error masks the passes, that is fine — Task 2 adds the rest.)

- [ ] **Step 5: Commit**

```bash
git add server/chat-tools.js tests/server/test-chat-tools.mjs
git commit -m "feat(chat): 챗봇 도구 모듈 — 이메일 마스킹·히스토리 변환 헬퍼"
```

### Task 2: Follow-up parsing + user ranking + overview compaction

**Files:**
- Modify: `server/chat-tools.js` (append)
- Test: `tests/server/test-chat-tools.mjs` (append)

- [ ] **Step 1: Append failing tests**

Add before the `console.log(\`\n1..${testNum}\`)` line in `tests/server/test-chat-tools.mjs`:

```js
// parseFollowups
ok('parseFollowups reads JSON array', eq(
  parseFollowups('["Q1?","Q2?","Q3?","Q4?"]'),
  ['Q1?', 'Q2?', 'Q3?'],
))
ok('parseFollowups fenced json', eq(
  parseFollowups('```json\n["A?","B?"]\n```'),
  ['A?', 'B?'],
))
ok('parseFollowups line fallback', eq(
  parseFollowups('1. First question?\n2. Second question?'),
  ['First question?', 'Second question?'],
))
ok('parseFollowups garbage → []', eq(parseFollowups('no questions here'), []))

// rankUsers (UserRecord shape from src/types.ts)
const U = (email, loc, commits) => ({
  user: { id: email, email_address: email },
  claude_code_metrics: {
    core_metrics: { distinct_session_count: 1, commit_count: commits, pull_request_count: 0,
      lines_of_code: { added_count: loc, removed_count: 0 } },
    tool_actions: { edit_tool: { accepted_count: 8, rejected_count: 2 },
      multi_edit_tool: { accepted_count: 0, rejected_count: 0 },
      write_tool: { accepted_count: 0, rejected_count: 0 },
      notebook_edit_tool: { accepted_count: 0, rejected_count: 0 } },
  },
})
const ranked = rankUsers([U('a@x.com', 10, 1), U('bob@x.com', 500, 9)], { limit: 5 })
ok('rankUsers sorts by activity desc', ranked[0].email === 'bo*@x.com' || ranked[0].email.startsWith('bo'))
ok('rankUsers masks email', !ranked.some((r) => r.email.includes('bob@')))
ok('rankUsers honors limit', rankUsers([U('a@x.com', 1, 0), U('b@x.com', 2, 0), U('c@x.com', 3, 0)], { limit: 2 }).length === 2)
ok('rankUsers query filter', rankUsers([U('alice@x.com', 1, 0), U('bob@x.com', 2, 0)], { query: 'alice' }).length === 1)

// compactOverview
const snap = {
  window: { starting_date: '2026-05-20', ending_date: '2026-06-03' },
  summaries: [{ daily_active_user_count: 40, weekly_active_user_count: 90, assigned_seat_count: 120 }],
  users_today: [U('a@x.com', 1, 0), U('b@x.com', 2, 0)],
  skills: [{ skill_name: 'pdf', distinct_user_count: 12 }, { skill_name: 'sql', distinct_user_count: 3 }],
  connectors: [{ connector_name: 'github', distinct_user_count: 30 }],
}
const ov = compactOverview(snap)
ok('compactOverview drops raw user list', ov.users_today === undefined && ov.active_user_count === 2)
ok('compactOverview keeps summaries + seats', ov.summaries.length === 1)
ok('compactOverview top skills sorted', ov.top_skills[0].skill_name === 'pdf')
```

- [ ] **Step 2: Run test to verify the new assertions fail**

Run: `node tests/server/test-chat-tools.mjs`
Expected: FAIL — `parseFollowups is not a function` (import-level), or `not ok` lines for the new cases.

- [ ] **Step 3: Append implementation to `server/chat-tools.js`**

```js
// Extract up to 3 follow-up questions. Prefer a JSON array (optionally fenced);
// fall back to numbered/bulleted question lines. Returns [] on anything unusable.
export function parseFollowups(text) {
  const raw = String(text || '')
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : raw
  const arrMatch = candidate.match(/\[[\s\S]*\]/)
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0])
      if (Array.isArray(arr)) {
        const out = arr.map((s) => String(s).trim()).filter(Boolean)
        if (out.length) return out.slice(0, 3)
      }
    } catch { /* fall through to line parsing */ }
  }
  const lines = raw.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.endsWith('?'))
  return lines.slice(0, 3)
}

const cc = (u) => u?.claude_code_metrics?.core_metrics || {}
const locTotal = (u) => (cc(u).lines_of_code?.added_count || 0) + (cc(u).lines_of_code?.removed_count || 0)
const userScore = (u) => locTotal(u) + (cc(u).commit_count || 0) * 20 + (cc(u).pull_request_count || 0) * 50

// Rank UserRecord[] by Claude Code activity, mask emails, return compact rows.
export function rankUsers(users, { query, limit = 10 } = {}) {
  const q = (query || '').toLowerCase().trim()
  const list = (Array.isArray(users) ? users : [])
    .filter((u) => !q || (u?.user?.email_address || '').toLowerCase().includes(q))
    .sort((a, b) => userScore(b) - userScore(a))
    .slice(0, Math.max(1, Math.min(50, limit)))
  return list.map((u) => {
    const ta = u?.claude_code_metrics?.tool_actions || {}
    const acc = Object.values(ta).reduce((s, t) => s + (t?.accepted_count || 0), 0)
    const rej = Object.values(ta).reduce((s, t) => s + (t?.rejected_count || 0), 0)
    return {
      email: maskEmail(u?.user?.email_address || ''),
      lines_of_code: locTotal(u),
      commits: cc(u).commit_count || 0,
      prs: cc(u).pull_request_count || 0,
      sessions: cc(u).distinct_session_count || 0,
      tool_acceptance_rate: acc + rej === 0 ? null : Number((acc / (acc + rej)).toFixed(3)),
    }
  })
}

// Strip the heavy per-user array from the snapshot to keep tokens low; keep the
// org summaries, seat counts, and top skills/connectors by reach.
export function compactOverview(snapshot) {
  const s = snapshot || {}
  const topBy = (arr, key) => (Array.isArray(arr) ? arr : [])
    .slice().sort((a, b) => (b.distinct_user_count || 0) - (a.distinct_user_count || 0))
    .slice(0, 10).map((x) => ({ [key]: x[key], distinct_user_count: x.distinct_user_count || 0 }))
  return {
    window: s.window,
    summaries: s.summaries || [],
    active_user_count: (s.users_today || []).length,
    top_skills: topBy(s.skills, 'skill_name'),
    top_connectors: topBy(s.connectors, 'connector_name'),
  }
}
```

- [ ] **Step 4: Run test to verify all pass**

Run: `node tests/server/test-chat-tools.mjs`
Expected: `1..18` (or current count) all `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/chat-tools.js tests/server/test-chat-tools.mjs
git commit -m "feat(chat): 팔로업 파싱·사용자 랭킹·개요 압축 헬퍼"
```

### Task 3: Tool specs, system prompt, and tool runner

**Files:**
- Modify: `server/chat-tools.js` (append)
- Test: `tests/server/test-chat-tools.mjs` (append)

- [ ] **Step 1: Append failing tests**

Add before the `console.log` summary line:

```js
import { TOOL_SPECS, CHAT_SYSTEM_PROMPT, makeToolRunner } from '../../server/chat-tools.js'

ok('TOOL_SPECS has 4 tools', TOOL_SPECS.length === 4)
ok('TOOL_SPECS names', eq(
  TOOL_SPECS.map((t) => t.toolSpec.name).sort(),
  ['get_analytics_overview', 'get_cost_summary', 'run_athena_sql', 'search_users'],
))
ok('system prompt localized ko', CHAT_SYSTEM_PROMPT('ko', '2026-06-09').includes('한국어'))

// makeToolRunner with stubbed deps
const runner = makeToolRunner({
  fetchAnalytics: async () => snap,
  runAthenaSafe: async (sql) => ({ columns: ['user_email'], rows: [{ user_email: 'x@y.com' }] }),
  fetchCostSummary: async () => ({ totals: { net_spend_usd: 5 } }),
})
ok('runner overview ok', (await runner('get_analytics_overview', {})).data.active_user_count === 2)
ok('runner athena masks emails', (await runner('run_athena_sql', { sql: 'SELECT 1' })).data.rows[0].user_email.includes('*'))
ok('runner unknown tool → error', (await runner('nope', {})).ok === false)
```

Note: the test file's top-level must allow `await` — change `process.exit(...)` usage by wrapping the new `await` calls. Since Node ESM modules support top-level await, this works as-is.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/server/test-chat-tools.mjs`
Expected: FAIL — `TOOL_SPECS is not a function`/undefined export.

- [ ] **Step 3: Append implementation to `server/chat-tools.js`**

```js
export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'get_analytics_overview',
      description: 'Org-wide Claude Code adoption & productivity snapshot for the recent ~14-day window: daily/weekly/monthly active users, assigned seats, and the most-adopted skills and connectors. Use for "how are we doing overall" questions. Returns no per-user rows (use search_users or run_athena_sql for those) and no USD cost (use get_cost_summary).',
      inputSchema: { json: { type: 'object', properties: {}, additionalProperties: false } },
    },
  },
  {
    toolSpec: {
      name: 'run_athena_sql',
      description: `Run ONE read-only Athena SQL SELECT over the S3 archive for historical, time-series, or per-user questions beyond the live snapshot. Returns { columns, rows }. Emails in results are masked automatically.\n\n${ATHENA_SCHEMA_HINT_FOR_TOOL}`,
      inputSchema: {
        json: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'A single SELECT/WITH statement. Always filter the string `date` partition: WHERE date BETWEEN \'YYYY-MM-DD\' AND \'YYYY-MM-DD\'. Add ORDER BY + LIMIT.' } },
          required: ['sql'], additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_cost_summary',
      description: 'Org-wide spend in USD plus token totals, grouped by product and model, over a date range (defaults to the last ~31 days). There is NO per-user cost dimension in the live API (ADR-0003). Use for "where is the money going / spend by model" questions.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            starting_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
            ending_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          },
          additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'search_users',
      description: 'Top Claude Code contributors (or a lookup by email substring) for the recent snapshot day, ranked by lines of code + commits + PRs. Emails are masked. Use for "who are the most active users" questions.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional case-insensitive email substring filter.' },
            limit: { type: 'integer', description: 'Max rows (1-50, default 10).' },
          },
          additionalProperties: false,
        },
      },
    },
  },
]

export function CHAT_SYSTEM_PROMPT(locale, today) {
  const lang = locale === 'ko'
    ? '답변은 반드시 한국어로, 간결한 마크다운(필요 시 ## 헤더·`-` 목록·표)으로 작성하세요.'
    : 'Answer in clear English as concise Markdown (use ## headings, "-" lists, and GFM tables where they help).'
  return [
    'You are an enterprise analytics assistant for Claude Code Enterprise. This is a multi-turn conversation — use the prior turns for context.',
    'Use the provided tools to fetch real data before answering; never invent numbers. Cite exact figures and compute rates/growth explicitly.',
    'Pick the right tool: get_analytics_overview for org-level adoption; search_users for per-user rankings; run_athena_sql for historical/time-series/custom aggregations; get_cost_summary for USD spend.',
    'Data caveats to respect: a 3-day finalization buffer, a 90-day live lookback, and no Bedrock usage in cost.',
    'PRIVACY: emails returned by tools are already masked (e.g. al*****@acme.com). Echo them exactly as given; never reconstruct or guess a full address. Do not escape the asterisks with backslashes.',
    `Today is ${today} (UTC). When writing Athena date filters, end ranges no later than 3 days ago.`,
    lang,
  ].join('\n')
}

// Build a tool dispatcher from injected async deps. Memoizes the analytics
// snapshot so overview + search_users in one turn share a single fetch.
export function makeToolRunner({ fetchAnalytics, runAthenaSafe, fetchCostSummary }) {
  let snapPromise = null
  const snap = () => (snapPromise ||= fetchAnalytics())
  return async function runTool(name, input = {}) {
    try {
      if (name === 'get_analytics_overview') {
        return { ok: true, data: compactOverview(await snap()) }
      }
      if (name === 'search_users') {
        const rows = rankUsers((await snap()).users_today, input)
        return { ok: true, data: { users: rows }, rowCount: rows.length }
      }
      if (name === 'run_athena_sql') {
        const { columns, rows } = await runAthenaSafe(String(input.sql || ''))
        const capped = rows.slice(0, 200)
        return { ok: true, data: maskEmailsDeep({ columns, rows: capped, row_count: rows.length }), rowCount: rows.length }
      }
      if (name === 'get_cost_summary') {
        return { ok: true, data: maskEmailsDeep(await fetchCostSummary(input)) }
      }
      return { ok: false, data: { error: `Unknown tool: ${name}` } }
    } catch (err) {
      return { ok: false, data: { error: err?.message || String(err) } }
    }
  }
}
```

Also add this constant near the top of `server/chat-tools.js` (after the regex
constants), since the tool description references it. It mirrors the schema hint
in `server/aws.js`:

```js
const ATHENA_SCHEMA_HINT_FOR_TOOL = `Athena database \`claude_code_analytics\`. Tables (partitioned by string \`date\` YYYY-MM-DD):
• claude_code_analytics (per-user-per-day): user_id, user_email, cc_sessions, lines_of_code_added, lines_of_code_removed, commits_by_claude_code, prs_by_claude_code, edit_tool_accepted, edit_tool_rejected, multi_edit_tool_accepted, multi_edit_tool_rejected, write_tool_accepted, write_tool_rejected, notebook_edit_tool_accepted, notebook_edit_tool_rejected, web_search_count
• summaries_daily (org/day): date, daily_active_user_count, weekly_active_user_count, monthly_active_user_count, assigned_seat_count, pending_invite_count
• skills_daily: skill_name, distinct_users, chat_uses, claude_code_uses
• connectors_daily: connector_name, distinct_users, chat_uses, claude_code_uses
Partition column is varchar — do NOT wrap literals in DATE '...'. All values integers; rates are computed.`
```

- [ ] **Step 4: Run test to verify all pass**

Run: `node tests/server/test-chat-tools.mjs`
Expected: all `ok`, exit 0.

- [ ] **Step 5: Register the test in the runner + commit**

Read `tests/run-all.sh`; in the node-test section (near the comment "Node-based sanitizer tests") add a line mirroring the existing invocation:

```bash
node tests/server/test-chat-tools.mjs || fail=1
```

(Match the exact pattern already used for `test-athena-sanitizer.mjs` / `test-cost-live-reshape.mjs` in that file.)

```bash
git add server/chat-tools.js tests/server/test-chat-tools.mjs tests/run-all.sh
git commit -m "feat(chat): 도구 스펙·시스템 프롬프트·도구 디스패처 + 러너 등록"
```

---

## Phase 2 — Server: chat route in `server/aws.js`

### Task 4: Refactor `/cost/live` to a reusable `fetchCostSummary()`; remove `/analyze`

**Files:**
- Modify: `server/aws.js`

- [ ] **Step 1: Add the `fetchCostSummary` helper inside `registerAwsRoutes`**

Insert just after `runAthenaSafe` (around line 390), inside `registerAwsRoutes`:

```js
  // Fetch + reshape org cost (used by GET /cost/live and the chat cost tool).
  async function fetchCostSummary({ starting_date, ending_date } = {}) {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) throw new Error('ANTHROPIC_ANALYTICS_KEY is required for cost data.')
    const today = new Date()
    const minus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
    const startingDate = starting_date || minus(31)
    const endingDate = ending_date || minus(0)
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const buildUrl = (p) => {
      const params = new URLSearchParams({ starting_at: `${startingDate}T00:00:00Z`, ending_at: `${endingDate}T00:00:00Z`, bucket_width: '1d' })
      params.append('group_by[]', 'product'); params.append('group_by[]', 'model')
      return `${apiUrl}${p}?${params.toString()}`
    }
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }
    const [costRes, usageRes] = await Promise.all([
      fetch(buildUrl('/v1/organizations/analytics/cost_report'), { headers }),
      fetch(buildUrl('/v1/organizations/analytics/usage_report'), { headers }),
    ])
    const costBody = await costRes.json().catch(() => ({}))
    const usageBody = await usageRes.json().catch(() => ({}))
    if (!costRes.ok) throw new Error(`cost_report ${costRes.status}`)
    if (!usageRes.ok) throw new Error(`usage_report ${usageRes.status}`)
    return analyticsReportsToCostResp(costBody, usageBody, { starting_date: startingDate, ending_date: endingDate })
  }
```

- [ ] **Step 2: Replace the `/cost/live` body to call it**

Change the `router.get('/cost/live', ...)` handler (lines ~589-652) to:

```js
  router.get('/cost/live', async (req, res) => {
    try {
      const out = await fetchCostSummary({ starting_date: req.query.starting_date, ending_date: req.query.ending_date })
      res.json(out)
    } catch (err) {
      const msg = err?.message || String(err)
      const code = /is required/.test(msg) ? 400 : 502
      res.status(code).json({ error: code === 400 ? 'analytics_key_required' : 'upstream_error', message: msg })
    }
  })
```

- [ ] **Step 3: Remove the obsolete `/analyze` route + `generateSql` + `extractSql`**

Delete:
- the entire `router.post('/analyze', ...)` handler (lines ~392-478),
- the `generateSql` function (lines ~346-384),
- the `extractSql` function (lines ~320-344).

Keep `ATHENA_SCHEMA_HINT`, `sanitizeAthenaQuery`, `runAthena`, `runAthenaSafe`, `sseInit`, `sseSend`, and `analyticsReportsToCostResp`. (Verify `extractSql`/`generateSql` have no other callers: `grep -n "extractSql\|generateSql" server/`.)

- [ ] **Step 4: Verify syntax**

Run: `node --check server/aws.js`
Expected: no output (valid). Also run `grep -n "generateSql\|extractSql\|'/analyze'" server/aws.js` → no matches.

- [ ] **Step 5: Commit**

```bash
git add server/aws.js
git commit -m "refactor(server): fetchCostSummary 추출 + 구 /analyze·generateSql 제거"
```

### Task 5: Add `POST /chat/stream` (tool-use loop) + `generateFollowups`

**Files:**
- Modify: `server/aws.js`

- [ ] **Step 1: Import chat-tools at the top of `server/aws.js`**

Add to the import block (near line 3):

```js
import {
  MAX_TOOL_HOPS, TOOL_SPECS, CHAT_SYSTEM_PROMPT, makeToolRunner,
  historyToBedrockMessages, parseFollowups,
} from './chat-tools.js'
```

- [ ] **Step 2: Add `generateFollowups` inside `registerAwsRoutes`** (after `fetchCostSummary`)

```js
  async function generateFollowups(userMsg, answer, locale) {
    const langName = locale === 'ko' ? 'Korean' : 'English'
    const prompt = [
      'Given this analytics Q&A, propose exactly 3 short, specific follow-up questions a user would naturally ask next.',
      `Write them in ${langName}. Reference concrete entities (model names, metrics, time windows) where possible.`,
      'Return ONLY a JSON array of 3 strings, nothing else.',
      '', `QUESTION: ${userMsg}`, '', `ANSWER: ${answer.slice(0, 2000)}`,
    ].join('\n')
    try {
      const out = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0.4 },
      }))
      const text = out.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') || ''
      return parseFollowups(text)
    } catch { return [] }
  }
```

- [ ] **Step 3: Add the route** (where `/analyze` used to be)

```js
  // ── /api/chat/stream — multi-turn tool-use chatbot (SSE) ──────────────────
  router.post('/chat/stream', async (req, res) => {
    const { message, history = [], locale = 'en' } = req.body || {}
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }
    sseInit(res)
    const runTool = makeToolRunner({ fetchAnalytics, runAthenaSafe, fetchCostSummary })
    const today = new Date().toISOString().slice(0, 10)
    const messages = historyToBedrockMessages(history)
    messages.push({ role: 'user', content: [{ text: message }] })

    let finalText = ''
    try {
      let stopReason = null
      let hop = 0
      for (; hop <= MAX_TOOL_HOPS; hop++) {
        const stream = await bedrock.send(new ConverseStreamCommand({
          modelId: MODEL_ID,
          system: [{ text: CHAT_SYSTEM_PROMPT(locale, today) }],
          messages,
          toolConfig: { tools: TOOL_SPECS },
          inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
        }))

        // Reconstruct assistant content blocks (text + toolUse) from the stream.
        const blocks = []          // index → { type, text } | { type:'tool', toolUseId, name, json }
        for await (const ev of stream.stream) {
          const i = ev.contentBlockStart?.contentBlockIndex ?? ev.contentBlockDelta?.contentBlockIndex
          if (ev.contentBlockStart?.start?.toolUse) {
            const { toolUseId, name } = ev.contentBlockStart.start.toolUse
            blocks[i] = { type: 'tool', toolUseId, name, json: '' }
          }
          if (ev.contentBlockDelta?.delta?.text) {
            const t = ev.contentBlockDelta.delta.text
            if (!blocks[i]) blocks[i] = { type: 'text', text: '' }
            blocks[i].text += t
            finalText += t
            sseSend(res, 'text', { text: t })
          }
          if (ev.contentBlockDelta?.delta?.toolUse?.input != null) {
            blocks[i].json += ev.contentBlockDelta.delta.toolUse.input
          }
          if (ev.messageStop) stopReason = ev.messageStop.stopReason
        }

        const assistantContent = blocks.filter(Boolean).map((b) =>
          b.type === 'text'
            ? { text: b.text }
            : { toolUse: { toolUseId: b.toolUseId, name: b.name, input: b.json ? JSON.parse(b.json) : {} } })
        messages.push({ role: 'assistant', content: assistantContent })

        if (stopReason !== 'tool_use') break
        if (hop === MAX_TOOL_HOPS) {
          sseSend(res, 'status', { message: locale === 'ko' ? '도구 호출 한도에 도달해 현재까지의 답변으로 마무리합니다.' : 'Tool-call limit reached; finishing with the answer so far.' })
          break
        }

        const toolUses = blocks.filter((b) => b && b.type === 'tool')
        const toolResults = []
        for (const tu of toolUses) {
          const input = tu.json ? JSON.parse(tu.json) : {}
          sseSend(res, 'tool_call', { id: tu.toolUseId, name: tu.name, input: redactToolInput(input) })
          const out = await runTool(tu.name, input)
          sseSend(res, 'tool_result', { id: tu.toolUseId, name: tu.name, ok: out.ok, rowCount: out.rowCount ?? null })
          toolResults.push({ toolResult: {
            toolUseId: tu.toolUseId,
            content: [{ json: out.data }],
            status: out.ok ? 'success' : 'error',
          } })
        }
        messages.push({ role: 'user', content: toolResults })
      }

      const followups = await generateFollowups(message, finalText, locale)
      sseSend(res, 'followups', { suggestions: followups })
      sseSend(res, 'done', { ok: true, modelId: MODEL_ID, hops: hop })
    } catch (err) {
      sseSend(res, 'error', {
        message: err?.message || String(err),
        hint: 'Ensure the ECS task role has bedrock:InvokeModelWithResponseStream + athena/s3 for run_athena_sql.',
      })
    } finally {
      res.end()
    }
  })
```

- [ ] **Step 4: Add the `redactToolInput` helper** (module scope in `server/aws.js`, near `sanitizeAthenaQuery`)

```js
// Trim + mask tool-call inputs echoed to the client (SQL truncated, emails masked).
function redactToolInput(input) {
  const out = {}
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmailSrv(m))
      if (out[k].length > 280) out[k] = out[k].slice(0, 280) + '…'
    } else out[k] = v
  }
  return out
}
function maskEmailSrv(e) { const at = e.lastIndexOf('@'); if (at < 1) return e; const l = e.slice(0, at); return l.length <= 2 ? e : l.slice(0, 2) + '*'.repeat(Math.max(3, l.length - 2)) + e.slice(at) }
```

- [ ] **Step 5: Verify + commit**

Run: `node --check server/aws.js`
Expected: valid. Then `node --check server/chat-tools.js` and `node tests/server/test-chat-tools.mjs` (still green).

```bash
git add server/aws.js
git commit -m "feat(server): POST /chat/stream — Bedrock tool-use 루프 + 동적 팔로업"
```

---

## Phase 3 — Frontend: `useChatStream` hook

### Task 6: Chat state hook + SSE parser

**Files:**
- Create: `src/lib/useChatStream.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useCallback, useRef, useState } from 'react'
import { useI18n } from './i18n'

export type ToolCall = { id: string; name: string; status: 'running' | 'done' | 'error'; rowCount?: number | null }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls: ToolCall[]
  status?: string
  error?: string
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()))
const HISTORY_MAX = 12

export function useChatStream() {
  const { locale } = useI18n()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [followups, setFollowups] = useState<string[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setMessages([]); setFollowups([]); setIsStreaming(false)
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setIsStreaming(false)
  }, [])

  const send = useCallback(async (text: string) => {
    const q = text.trim()
    if (!q || abortRef.current) return
    setFollowups([])

    const history = messagesRef.current
      .filter((m) => m.text.trim())
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, text: m.text }))

    const asstId = newId()
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', text: q, toolCalls: [] },
      { id: asstId, role: 'assistant', text: '', toolCalls: [] },
    ])
    setIsStreaming(true)

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === asstId ? fn(m) : m)))

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q, history, locale }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || res.statusText)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split('\n\n')
        buf = chunks.pop() || ''
        for (const chunk of chunks) {
          const lines = chunk.split('\n').filter(Boolean)
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || 'message'
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim()
          if (!dataLine) continue
          let data: any
          try { data = JSON.parse(dataLine) } catch { continue }
          if (ev === 'status') patch((m) => ({ ...m, status: data.message }))
          if (ev === 'text') patch((m) => ({ ...m, text: m.text + data.text, status: undefined }))
          if (ev === 'tool_call') patch((m) => ({ ...m, status: undefined, toolCalls: [...m.toolCalls, { id: data.id, name: data.name, status: 'running' }] }))
          if (ev === 'tool_result') patch((m) => ({ ...m, toolCalls: m.toolCalls.map((tc) => tc.id === data.id ? { ...tc, status: data.ok ? 'done' : 'error', rowCount: data.rowCount } : tc) }))
          if (ev === 'followups') setFollowups(Array.isArray(data.suggestions) ? data.suggestions : [])
          if (ev === 'error') patch((m) => ({ ...m, error: data.message, status: undefined }))
          if (ev === 'done') patch((m) => ({ ...m, status: undefined }))
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') patch((m) => ({ ...m, error: String(e?.message || e), status: undefined }))
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }, [locale])

  return { messages, followups, isStreaming, send, stop, reset }
}

export type ChatStream = ReturnType<typeof useChatStream>
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b --noEmit` (or rely on the Phase 7 build).
Expected: no errors in `useChatStream.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/useChatStream.ts
git commit -m "feat(chat): useChatStream 훅 — SSE 파서 + 멀티턴 상태"
```

---

## Phase 4 — Frontend: chat UI components

### Task 7: `MessageList` (bubbles, markdown, typing dots, tool badges)

**Files:**
- Create: `src/components/chat/MessageList.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { ClaudeIcon } from '../ClaudeIcon'
import { Markdown } from '../Markdown'
import { useI18n } from '../../lib/i18n'
import type { ChatMessage, ToolCall } from '../../lib/useChatStream'

function TypingDots() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-claude-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  )
}

function ToolBadge({ tc }: { tc: ToolCall }) {
  const { t } = useI18n()
  const label = t(`chat.tool.${tc.name}` as any)
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border',
      tc.status === 'error'
        ? 'bg-rose-50 border-rose-200 text-rose-700'
        : 'bg-violet-50 border-violet-200 text-violet-700',
    )}>
      <span aria-hidden>{tc.status === 'running' ? '⟳' : tc.status === 'error' ? '⚠' : '✓'}</span>
      {label}{tc.rowCount != null ? ` · ${tc.rowCount}` : ''}
    </span>
  )
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <div className="space-y-4">
      {messages.map((m) => (
        <div key={m.id} className={clsx('flex gap-3', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          {m.role === 'assistant' && (
            <div className="w-8 h-8 rounded-full bg-claude-50 border border-claude-200 flex items-center justify-center shrink-0">
              <ClaudeIcon size={16} />
            </div>
          )}
          <div className={clsx(
            'rounded-2xl px-4 py-3 max-w-[80%] text-sm leading-relaxed',
            m.role === 'user' ? 'bg-claude-500 text-white' : 'bg-white border border-ink-100 shadow-sm text-ink-700',
          )}>
            {m.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">{m.toolCalls.map((tc) => <ToolBadge key={tc.id} tc={tc} />)}</div>
            )}
            {m.role === 'assistant' && m.status && (
              <div className="text-[11px] text-claude-600 italic mb-1">{m.status}</div>
            )}
            {m.role === 'assistant'
              ? (m.text ? <Markdown>{m.text}</Markdown> : !m.error && <TypingDots />)
              : <div className="whitespace-pre-wrap">{m.text}</div>}
            {m.error && (
              <div className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{m.error}</div>
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} className="print-hide" />
    </div>
  )
}
```

- [ ] **Step 2: Commit** (build verified in Phase 7)

```bash
git add src/components/chat/MessageList.tsx
git commit -m "feat(chat): MessageList — 버블·타이핑 점·도구 배지"
```

### Task 8: `ChatComposer` (textarea + send/stop)

**Files:**
- Create: `src/components/chat/ChatComposer.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react'
import { ClaudeIcon } from '../ClaudeIcon'
import { useI18n } from '../../lib/i18n'

export function ChatComposer({
  isStreaming, onSend, onStop,
}: { isStreaming: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  const submit = () => {
    const q = value.trim()
    if (!q || isStreaming) return
    onSend(q); setValue('')
  }

  return (
    <div className="rounded-xl border border-ink-100 bg-white shadow-card p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        rows={2}
        placeholder={t('chat.placeholder')}
        className="w-full text-sm bg-paper-muted/30 border border-ink-100 rounded-lg px-3 py-2 focus:outline-none focus:border-claude-500 resize-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        {isStreaming && (
          <button onClick={onStop} className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 text-ink-500 hover:bg-paper-muted">
            {t('chat.stop')}
          </button>
        )}
        <button
          onClick={submit}
          disabled={isStreaming || !value.trim()}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-claude-500 hover:bg-claude-600 disabled:opacity-50 text-white text-sm font-medium"
        >
          <ClaudeIcon size={14} tone="ghost" className="opacity-90" />
          {isStreaming ? t('chat.thinking') : t('chat.send')}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/ChatComposer.tsx
git commit -m "feat(chat): ChatComposer — 입력창 + 전송/중단"
```

### Task 9: `ChatPanel` (shared surface, page + widget variants)

**Files:**
- Create: `src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import clsx from 'clsx'
import { ClaudeIcon } from '../ClaudeIcon'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { useI18n } from '../../lib/i18n'
import type { ChatStream } from '../../lib/useChatStream'

const FALLBACK_PROMPTS = [
  'Show DAU / WAU / MAU trends and flag any week-over-week drop > 10%.',
  'Top 10 Claude Code contributors by LOC + commits + PRs, with tool acceptance.',
  'Break down spend in USD by product and model — where is the money going?',
]

export function ChatPanel({ chat, variant, onClose }: { chat: ChatStream; variant: 'page' | 'widget'; onClose?: () => void }) {
  const { t } = useI18n()
  const { messages, followups, isStreaming, send, stop, reset } = chat
  let prompts: string[]
  try { prompts = JSON.parse(t('chat.prompts' as any)) } catch { prompts = FALLBACK_PROMPTS }

  return (
    <div className={clsx('flex flex-col', variant === 'widget' ? 'h-full' : 'min-h-[60vh]')}>
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-3 print-hide">
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          <ClaudeIcon size={16} />
          <span className="font-medium text-ink-500">Claude Sonnet 4.6</span>
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button onClick={reset} className="text-[11px] px-2 py-1 rounded-lg border border-ink-200 text-ink-500 hover:bg-paper-muted/60">
              {t('chat.reset')}
            </button>
          )}
          {variant === 'widget' && onClose && (
            <button onClick={onClose} aria-label={t('common.close')} className="text-ink-400 hover:text-ink-700 px-1">✕</button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className={clsx('flex-1 overflow-y-auto px-1 print-export', variant === 'widget' && 'pr-1')}>
        {messages.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white p-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">{t('chat.suggested')}</div>
            <div className="flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button key={p} onClick={() => send(p)} className="text-[12px] px-3 py-1.5 rounded-full border border-ink-200 bg-paper-muted/40 text-ink-600 hover:bg-claude-50 hover:border-claude-200 text-left">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList messages={messages} />
        )}

        {/* Follow-up pills */}
        {!isStreaming && followups.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 print-hide">
            <span className="w-full text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('chat.followups')}</span>
            {followups.map((f) => (
              <button key={f} onClick={() => send(f)} className="text-[12px] px-3 py-1.5 rounded-full border border-claude-200 bg-claude-50/60 text-claude-700 hover:bg-claude-100">
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3 print-hide">
        <ChatComposer isStreaming={isStreaming} onSend={send} onStop={stop} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/ChatPanel.tsx
git commit -m "feat(chat): ChatPanel — 페이지·위젯 공용 챗 표면"
```

---

## Phase 5 — Frontend: widget, page rewrite, i18n

### Task 10: i18n keys (`chat.*`) in `src/lib/i18n.tsx`

**Files:**
- Modify: `src/lib/i18n.tsx`

- [ ] **Step 1: Add `chat.*` keys to the `en` dict**

Insert in the `en` block (e.g. right after the `analyze.export.pdf.hint` line, ~374):

```js
    'chat.placeholder':  'Ask anything about your org analytics…',
    'chat.send':         'Send',
    'chat.stop':         'Stop',
    'chat.thinking':     'Thinking…',
    'chat.reset':        'New chat',
    'chat.suggested':    'Try asking',
    'chat.followups':    'Follow-ups',
    'chat.widget.open':  'Ask Claude',
    'chat.widget.title': 'Analytics assistant',
    'chat.tool.get_analytics_overview': 'Overview',
    'chat.tool.run_athena_sql':         'Athena SQL',
    'chat.tool.get_cost_summary':       'Cost',
    'chat.tool.search_users':           'Users',
    'chat.prompts': JSON.stringify([
      'Show DAU / WAU / MAU trends and flag any week-over-week drop > 10% with a likely cause.',
      'Top 10 Claude Code contributors by combined LOC + commits + PRs, with each user\'s tool acceptance rate.',
      'Break down spend in USD by product and by model. Where is the money actually going?',
      'Which Skills and Connectors have the highest adoption relative to seat count?',
    ]),
```

- [ ] **Step 2: Add the same keys to the `ko` dict**

Insert in the `ko` block (after `analyze.export.pdf.hint`, ~787):

```js
    'chat.placeholder':  '조직 애널리틱스에 대해 무엇이든 물어보세요…',
    'chat.send':         '전송',
    'chat.stop':         '중단',
    'chat.thinking':     '생각하는 중…',
    'chat.reset':        '새 대화',
    'chat.suggested':    '이렇게 물어보세요',
    'chat.followups':    '이어서 질문',
    'chat.widget.open':  'Claude에게 질문',
    'chat.widget.title': '애널리틱스 어시스턴트',
    'chat.tool.get_analytics_overview': '개요',
    'chat.tool.run_athena_sql':         'Athena SQL',
    'chat.tool.get_cost_summary':       '비용',
    'chat.tool.search_users':           '사용자',
    'chat.prompts': JSON.stringify([
      '최근 DAU / WAU / MAU 추이를 보여주고, 전주 대비 10% 이상 하락한 지점과 원인을 짚어줘.',
      'LOC + 커밋 + PR 합산 기준 Claude Code 상위 10명 기여자와 각자의 도구 수락률을 보여줘.',
      '제품별·모델별 USD 지출을 분해해줘. 비용이 실제로 어디서 발생하고 있어?',
      '좌석 수 대비 채택률이 가장 높은 Skill과 Connector는 무엇이야?',
    ]),
```

- [ ] **Step 3: Remove obsolete `analyze.mode.*` keys**

Delete these 4 lines from BOTH the `en` and `ko` dicts (8 total):
`analyze.mode.direct`, `analyze.mode.direct.hint`, `analyze.mode.sql`, `analyze.mode.sql.hint`.
Keep `analyze.title`, `analyze.subtitle`, `analyze.export.*` (still used by the page).

- [ ] **Step 4: Update `analyze.subtitle`** in both dicts to describe the chatbot:

```js
// en
    'analyze.subtitle': 'Chat with Claude about your org. Sonnet 4.6 on Amazon Bedrock autonomously queries live analytics, the S3 archive, and cost reports to answer.',
// ko
    'analyze.subtitle': 'Claude와 조직 데이터에 대해 대화하세요. Amazon Bedrock의 Sonnet 4.6이 실시간 애널리틱스·S3 아카이브·비용 리포트를 스스로 조회해 답변합니다.',
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n.tsx
git commit -m "feat(i18n): chat.* 키 추가(en/ko) + analyze.mode.* 제거"
```

### Task 11: `FloatingChat` widget + mount in `Layout`

**Files:**
- Create: `src/components/chat/FloatingChat.tsx`
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Create `FloatingChat.tsx`**

```tsx
import { useState } from 'react'
import { ClaudeIcon } from '../ClaudeIcon'
import { ChatPanel } from './ChatPanel'
import { useChatStream } from '../../lib/useChatStream'
import { useI18n } from '../../lib/i18n'

export function FloatingChat() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const chat = useChatStream() // one conversation, persists while mounted

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title={t('chat.widget.open')}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-claude-500 hover:bg-claude-600 text-white shadow-lg px-4 py-3 text-sm font-medium print-hide"
        >
          <ClaudeIcon size={18} tone="ghost" />
          {t('chat.widget.open')}
        </button>
      )}
      {open && (
        <div className="fixed bottom-6 right-6 z-40 w-[400px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-3rem)] rounded-2xl border border-ink-100 bg-paper-muted/95 backdrop-blur shadow-2xl flex flex-col p-3 print-hide">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium px-1 pb-1">{t('chat.widget.title')}</div>
          <div className="flex-1 min-h-0">
            <ChatPanel chat={chat} variant="widget" onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Mount it in `Layout.tsx`**

Add the import near the top:
```tsx
import { FloatingChat } from './chat/FloatingChat'
```
Then render it as the last child of the root `<div className="grain h-screen flex">`, after `</main>`:
```tsx
      <main className="flex-1 min-w-0 h-full overflow-y-auto">
        <Outlet />
      </main>
      <FloatingChat />
    </div>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/FloatingChat.tsx src/components/Layout.tsx
git commit -m "feat(chat): FloatingChat 위젯 + Layout 전역 마운트"
```

### Task 12: Rewrite `src/pages/Analyze.tsx` around `ChatPanel`

**Files:**
- Modify (full rewrite): `src/pages/Analyze.tsx`

- [ ] **Step 1: Replace the file contents**

```tsx
import { PageHeader } from '../components/PageHeader'
import { ClaudeIcon } from '../components/ClaudeIcon'
import { ChatPanel } from '../components/chat/ChatPanel'
import { useChatStream } from '../lib/useChatStream'
import { useI18n } from '../lib/i18n'

export function Analyze() {
  const { t } = useI18n()
  const chat = useChatStream()
  const { messages } = chat

  function exportMarkdown() {
    if (messages.length === 0) return
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const lines: string[] = ['# Claude Code — Analyze', '', `> ${stamp} UTC`, '']
    for (const m of messages) {
      if (m.role === 'user') lines.push('---', '', `**Q.** ${m.text}`, '')
      else {
        if (m.toolCalls.length) lines.push(`_tools: ${m.toolCalls.map((tc) => tc.name).join(', ')}_`, '')
        if (m.text) lines.push(m.text, '')
        if (m.error) lines.push(`> ⚠ ${m.error}`, '')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `claude-code-analyze-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Browser-native print → "Save as PDF" (shared @media print mechanism).
  function exportPdf() {
    if (messages.length === 0) return
    const restore = () => document.body.classList.remove('app-print')
    document.body.classList.add('app-print')
    window.addEventListener('afterprint', restore, { once: true })
    setTimeout(() => window.print(), 50)
  }

  return (
    <div>
      <div className="print-hide">
        <PageHeader title={t('analyze.title')} subtitle={t('analyze.subtitle')} right={<ClaudeIcon size={28} animate />} />
      </div>
      <div className="p-8 max-w-5xl">
        {messages.length > 0 && (
          <div className="flex justify-end gap-2 mb-4 print-hide">
            <button onClick={exportMarkdown} title={t('analyze.export.md.hint')} className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5">
              <span aria-hidden>↓</span>{t('analyze.export.md')}
            </button>
            <button onClick={exportPdf} title={t('analyze.export.pdf.hint')} className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5">
              <span aria-hidden>🖨</span>{t('analyze.export.pdf')}
            </button>
          </div>
        )}
        <ChatPanel chat={chat} variant="page" />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/Analyze.tsx
git commit -m "feat(analyze): /analyze 페이지를 tool-use 챗봇으로 재구성 (export 유지)"
```

---

## Phase 6 — Docs, ADR, CHANGELOG

### Task 13: ADR-0008 + doc sync

**Files:**
- Create: `docs/decisions/0008-tool-use-chatbot.md`
- Modify: `server/CLAUDE.md`, `src/CLAUDE.md`, `docs/api-reference.md`, `docs/architecture.md`

- [ ] **Step 1: Write the ADR**

Create `docs/decisions/0008-tool-use-chatbot.md`:

```markdown
# ADR-0008: Tool-use chatbot replaces fixed-mode Analyze

- **Status**: Accepted
- **Date**: 2026-06-09
- **Deciders**: @whchoi98
- **Supersedes**: the `direct`/`sql` mode selector + `POST /api/analyze`

## Context

`/analyze` was a single-turn Q&A: the user pre-selected a `direct` (inject
snapshot) or `sql` (LLM authors one Athena query) mode, and each request carried
only the current question — no memory. This is less capable than the sibling
`model-monitoring` chatbot, whose power comes from a Bedrock tool-use loop,
multi-turn memory, and dynamic follow-ups.

## Decision

Replace `/api/analyze` with `POST /api/chat/stream`: a Bedrock Converse tool-use
loop (`MAX_TOOL_HOPS = 4`) over four tools — `get_analytics_overview`,
`run_athena_sql` (via the existing `sanitizeAthenaQuery`), `get_cost_summary`,
`search_users`. The LLM decides which tools to call. Conversation memory is
**client-side**: the last 12 turns are sent as `history[]` (no new infra). The
chatbot is exposed both as the reworked `/analyze` page and a global
`FloatingChat` widget, sharing one `ChatPanel`. Email masking moves to the
**tool-result layer** (server-side) so raw addresses never enter the prompt.

## Consequences

- More capable, conversational analysis; the model mixes data sources per turn.
- No new infra/IAM (reuses `bedrock:InvokeModelWithResponseStream` + athena/s3).
- Pure helpers live in `server/chat-tools.js` (unit-tested); the Bedrock
  streaming loop lives in `server/aws.js`.
- Follow-ups reuse the Sonnet model id (Haiku deferred — would need in-region
  model access).
- `direct`/`sql` modes and `generateSql` are removed.
```

- [ ] **Step 2: Update `server/CLAUDE.md`**

In the `aws.js` AI bullet, replace the `POST /analyze` description with:
`AI: POST /chat/stream (multi-turn tool-use chatbot — Bedrock ConverseStream + toolConfig, MAX_TOOL_HOPS=4; tools: get_analytics_overview, run_athena_sql via sanitizeAthenaQuery, get_cost_summary, search_users; emails masked in tool results; dynamic follow-ups). Pure tool helpers + specs live in server/chat-tools.js.` Note `fetchCostSummary` is shared by `/cost/live` and the cost tool.

- [ ] **Step 3: Update `src/CLAUDE.md`**

Under components, add `src/components/chat/` (ChatPanel, MessageList, ChatComposer, FloatingChat) and note `FloatingChat` is mounted globally in `Layout`. Under `lib/`, add `useChatStream.ts` (SSE chat hook). Note `/analyze` is now a chatbot page sharing `ChatPanel`.

- [ ] **Step 4: Update `docs/api-reference.md`**

Replace the `/analyze` section with `POST /api/chat/stream`: request `{ message, history[], locale }`; SSE events `status | tool_call | tool_result | text | followups | error | done`; document the 4 tools. Link ADR-0008.

- [ ] **Step 5: Update `docs/architecture.md`**

In the AI layer description, change "Bedrock SSE NL analysis" to "Bedrock tool-use chatbot (`/chat/stream`)" and link ADR-0008 from the Key Design Decisions section.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/0008-tool-use-chatbot.md server/CLAUDE.md src/CLAUDE.md docs/api-reference.md docs/architecture.md
git commit -m "docs: ADR-0008 + tool-use 챗봇 문서 동기화"
```

### Task 14: CHANGELOG + version bump to 0.7.0

**Files:**
- Modify: `CHANGELOG.md`, `package.json`

- [ ] **Step 1: Bump version** in `package.json`: `"version": "0.6.0"` → `"version": "0.7.0"`.

- [ ] **Step 2: Add a `## [0.7.0] - 2026-06-09` section** to `CHANGELOG.md` (match the file's existing bilingual format), with entries:
  - **Changed**: `/analyze` is now a multi-turn tool-use chatbot (replaces the direct/SQL mode selector). / `/analyze`를 멀티턴 tool-use 챗봇으로 전환(direct/SQL 모드 선택 제거).
  - **Added**: global floating chat widget on every page; dynamic follow-up questions; tool-call badges; conversation reset. / 전 페이지 플로팅 챗 위젯, 동적 팔로업 질문, 도구 호출 배지, 대화 리셋.
  - **Added**: `POST /api/chat/stream` (Bedrock tool-use loop) + `server/chat-tools.js`. / `POST /api/chat/stream` + `server/chat-tools.js`.
  - **Removed**: `POST /api/analyze`, `generateSql`. / `POST /api/analyze`, `generateSql` 제거.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "release: v0.7.0 — tool-use 챗봇 + 플로팅 위젯"
```

---

## Phase 7 — Verification

### Task 15: Build, tests, and manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Server syntax + unit tests**

Run:
```bash
node --check server/aws.js && node --check server/chat-tools.js
node tests/server/test-chat-tools.mjs
bash tests/run-all.sh
```
Expected: all green (the new chat-tools test is discovered; sanitizer + reshape tests still pass).

- [ ] **Step 2: Frontend build (strict TS)**

Run: `npm run build`
Expected: `tsc -b` passes with no `noUnusedLocals`/type errors; `vite build` writes `dist/`. (Confirm no leftover imports of removed `analyze.mode.*` keys or the old `Mode` type.)

- [ ] **Step 3: Manual smoke** (`npm run dev`, open http://localhost:5173/analyze)

Verify each:
- [ ] Multi-turn: ask "How many active users this period?", then "And how does that compare to seats?" — the second answer reflects the first (memory works).
- [ ] Tool use: ask "Top 5 contributors by lines of code last 14 days" — a `run_athena_sql` (or `search_users`) badge appears and the answer cites rows.
- [ ] Follow-up pills appear after an answer and are clickable.
- [ ] Typing dots show before the first token.
- [ ] Reset button clears the conversation.
- [ ] Widget: navigate to `/cost`, open the floating widget, ask a question — works off the Analyze page.
- [ ] Export: from `/analyze`, MD downloads and PDF opens the print dialog with the conversation.
- [ ] Privacy: ask "who are the most active users" — emails render masked (e.g. `al*****@acme.com`).

- [ ] **Step 4: Final commit** (only if Step 3 surfaced fixes)

```bash
git add -A && git commit -m "fix(chat): 스모크 테스트 후속 수정"
```

---

## Self-Review

**1. Spec coverage**
- Tool-use loop + 4 tools → Tasks 3, 5. ✓
- Remove `/analyze` + `generateSql` → Task 4. ✓
- Client history memory (12 turns) → Tasks 1 (`historyToBedrockMessages`), 6 (`useChatStream`). ✓
- Page + global widget sharing `ChatPanel` → Tasks 9, 11, 12. ✓
- Extras (follow-ups, typing dots, tool badges, reset) → Tasks 2/5 (follow-ups), 7 (dots+badges), 9 (reset). ✓
- `run_athena_sql` via `sanitizeAthenaQuery`; emails masked server-side in tool results → Task 3 (`makeToolRunner` + `maskEmailsDeep`). ✓
- SSE protocol (status/tool_call/tool_result/text/followups/error/done) → Tasks 5 (emit), 6 (parse). ✓
- MD/PDF export retained → Task 12. ✓
- Follow-up model = Sonnet → Task 5 (`generateFollowups` uses `MODEL_ID`). ✓
- i18n en+ko, remove `analyze.mode.*` → Task 10. ✓
- Docs/ADR/CHANGELOG → Tasks 13, 14. ✓
- Tests (history, parseFollowups, masking, ranking, dispatch) → Tasks 1–3. ✓

**2. Placeholder scan** — no TBD/TODO; every code step has complete code. ✓

**3. Type/name consistency**
- `ChatMessage`/`ToolCall`/`ChatStream` defined in Task 6, consumed in Tasks 7/9/11/12. ✓
- `makeToolRunner({ fetchAnalytics, runAthenaSafe, fetchCostSummary })` — deps provided in Task 5 route; `fetchCostSummary` defined in Task 4; `fetchAnalytics` is the `registerAwsRoutes` param; `runAthenaSafe` pre-exists. ✓
- SSE event names match between server emit (Task 5) and hook parse (Task 6): `status`, `text`, `tool_call`, `tool_result`, `followups`, `error`, `done`. ✓
- `TOOL_SPECS` names match `chat.tool.<name>` i18n keys (Task 10) and `runTool` switch (Task 3). ✓
- `t('chat.prompts')` parsed in `ChatPanel` (Task 9) — key added in Task 10. ✓

**Resolved during review:** the `redactToolInput` helper (Task 5) uses a local `maskEmailSrv` rather than importing from `chat-tools.js`, avoiding a circular concern and keeping `aws.js` self-contained for that echo path.
