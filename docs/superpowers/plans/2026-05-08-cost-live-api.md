# Cost Live API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cost page's manual-CSV-only data flow with a live `/api/cost/live` endpoint backed by `/v1/organizations/usage_report/claude_code`, with the existing CSV path retained as automatic fallback for finance reconciliation.

**Architecture:** New Express route in `server/aws.js` self-calls the existing `/api/admin/claude-code/range` endpoint, then reshapes the per-day actor records into the same `CsvResp` shape the Cost page already consumes. Cost page tries `/api/cost/live` first; on error or empty data, falls back to `/api/cost/csv`. A new `daily` array in the live response feeds a "Daily spend by model" stacked-area chart.

**Spec:** [docs/superpowers/specs/2026-05-08-analytics-cost-api-design.md](../specs/2026-05-08-analytics-cost-api-design.md)

**Tech Stack:** Express 4, Node 20 ESM, React 18, TypeScript 5, Recharts 2, Tailwind 3. Tests: standalone ESM with TAP output (matches `tests/server/test-athena-sanitizer.mjs`).

**Conventions:**
- Korean for conversation and commit messages — but existing commits are conventional-commits English (see `git log`); match that.
- All `cost.*` i18n keys must be added in both `en` and `ko` blocks.
- Email values that are masked for display still get raw-stored in `user_email`; UI calls `maskEmail()`.
- Cents → USD: divide by 100, round to 4 decimals to avoid float drift in totals.

---

## Task ordering

Server first (Tasks 1-2), then UI strings (Task 3), then frontend wiring (Tasks 4-9), then docs (Tasks 10-11), then smoke test (Task 12). Server tasks are independently testable; UI tasks build on them.

---

### Task 1: `claudeCodeRangeToCostResp` reshape function (TDD)

**Files:**
- Create: `tests/server/test-cost-live-reshape.mjs`
- Modify: `server/aws.js` (add export at module scope, near top after imports)

- [ ] **Step 1.1: Write the failing test file**

Create `tests/server/test-cost-live-reshape.mjs`:

```js
// Standalone ESM test for claudeCodeRangeToCostResp.
// Runs with: node tests/server/test-cost-live-reshape.mjs
// Exit code 0 on success, 1 on any failure (TAP-like output).

import { claudeCodeRangeToCostResp } from '../../server/aws.js'

const period = { starting_date: '2026-04-01', ending_date: '2026-04-02' }

const SAMPLE = {
  range: { starting_date: '2026-04-01', ending_date: '2026-04-02' },
  days: [
    {
      date: '2026-04-01',
      source: 'live',
      data: [
        {
          actor: { type: 'user_actor', email_address: 'alice@example.com' },
          core_metrics: { num_sessions: 3 },
          model_breakdown: [
            { model: 'claude-opus-4-7', tokens: { input: 1000, output: 500, cache_read: 100, cache_creation: 50 }, estimated_cost: { currency: 'USD', amount: 1234 } },
            { model: 'claude-sonnet-4-6', tokens: { input: 200, output: 80, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 56 } },
          ],
        },
      ],
    },
    {
      date: '2026-04-02',
      source: 'live',
      data: [
        {
          actor: { type: 'user_actor', email_address: 'alice@example.com' },
          core_metrics: { num_sessions: 2 },
          model_breakdown: [
            { model: 'claude-opus-4-7', tokens: { input: 500, output: 200, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 800 } },
          ],
        },
        {
          actor: { type: 'api_actor', api_key_name: 'ci-bot' },
          core_metrics: { num_sessions: 1 },
          model_breakdown: [
            { model: 'claude-haiku-4-5', tokens: { input: 50, output: 30, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 12 } },
          ],
        },
      ],
    },
  ],
}

const cases = [
  ['shape: source=live + period passthrough', () => {
    const r = claudeCodeRangeToCostResp(SAMPLE, period)
    if (r.source !== 'live') throw new Error(`source: ${r.source}`)
    if (r.period.starting_date !== '2026-04-01') throw new Error(`period.start: ${r.period.starting_date}`)
    if (r.period.ending_date   !== '2026-04-02') throw new Error(`period.end: ${r.period.ending_date}`)
    if (r.file !== null) throw new Error(`file: ${r.file}`)
  }],
  ['rows: alice aggregated across 2 days × 2 models = 2 rows + 1 api_actor row', () => {
    const r = claudeCodeRangeToCostResp(SAMPLE, period)
    if (r.rows.length !== 3) throw new Error(`rows.length: ${r.rows.length}`)
    const aliceOpus = r.rows.find((x) => x.user_email === 'alice@example.com' && x.model === 'claude-opus-4-7')
    if (!aliceOpus) throw new Error('no alice/opus row')
    if (aliceOpus.product !== 'Claude Code') throw new Error(`product: ${aliceOpus.product}`)
    // input + cache_read + cache_creation: (1000+100+50) + (500+0+0) = 1650
    if (aliceOpus.total_prompt_tokens !== 1650) throw new Error(`prompt: ${aliceOpus.total_prompt_tokens}`)
    if (aliceOpus.total_completion_tokens !== 700) throw new Error(`completion: ${aliceOpus.total_completion_tokens}`)
    // (1234 + 800) cents / 100 = 20.34
    if (Math.abs(aliceOpus.total_net_spend_usd - 20.34) > 1e-6) throw new Error(`spend: ${aliceOpus.total_net_spend_usd}`)
    if (aliceOpus.total_gross_spend_usd !== aliceOpus.total_net_spend_usd) throw new Error('gross != net')
    // sessions across 2 days: 3 + 2 = 5 (approximate "requests")
    if (aliceOpus.total_requests !== 5) throw new Error(`requests: ${aliceOpus.total_requests}`)
  }],
  ['api_actor → user_email = "API key: <name>"', () => {
    const r = claudeCodeRangeToCostResp(SAMPLE, period)
    const bot = r.rows.find((x) => x.user_email === 'API key: ci-bot')
    if (!bot) throw new Error('no api_actor row found')
    if (bot.model !== 'claude-haiku-4-5') throw new Error(`bot model: ${bot.model}`)
  }],
  ['daily series: 3 (date, model) pairs across 2 days', () => {
    const r = claudeCodeRangeToCostResp(SAMPLE, period)
    if (!Array.isArray(r.daily)) throw new Error('daily not array')
    if (r.daily.length !== 4) throw new Error(`daily.length: ${r.daily.length}`) // d1: opus,sonnet; d2: opus, haiku
    const d1Opus = r.daily.find((d) => d.date === '2026-04-01' && d.model === 'claude-opus-4-7')
    if (!d1Opus) throw new Error('no d1/opus daily')
    if (Math.abs(d1Opus.spend - 12.34) > 1e-6) throw new Error(`d1 opus spend: ${d1Opus.spend}`)
  }],
  ['totals: aggregate across all rows', () => {
    const r = claudeCodeRangeToCostResp(SAMPLE, period)
    // spend_cents: 1234 + 56 + 800 + 12 = 2102 → 21.02 USD
    if (Math.abs(r.totals.net_spend_usd - 21.02) > 1e-6) throw new Error(`net total: ${r.totals.net_spend_usd}`)
    if (r.totals.distinct_users !== 2) throw new Error(`users: ${r.totals.distinct_users}`)
    if (r.totals.distinct_models !== 3) throw new Error(`models: ${r.totals.distinct_models}`)
    if (r.totals.distinct_products !== 1) throw new Error(`products: ${r.totals.distinct_products}`)
    if (r.totals.requests !== 6) throw new Error(`req total: ${r.totals.requests}`) // 3+2+1
  }],
  ['empty days array → empty rows + zero totals + source=live', () => {
    const r = claudeCodeRangeToCostResp({ days: [] }, period)
    if (r.source !== 'live') throw new Error(`source: ${r.source}`)
    if (r.rows.length !== 0) throw new Error(`rows: ${r.rows.length}`)
    if (r.totals.net_spend_usd !== 0) throw new Error(`net: ${r.totals.net_spend_usd}`)
    if (r.totals.distinct_users !== 0) throw new Error(`users: ${r.totals.distinct_users}`)
  }],
  ['error days are skipped', () => {
    const r = claudeCodeRangeToCostResp({
      days: [
        { date: '2026-04-01', source: 'error', error: { error: 'oops' }, data: [] },
        { date: '2026-04-02', source: 'live',  data: [{ actor: { type: 'user_actor', email_address: 'b@x.com' }, core_metrics: { num_sessions: 1 }, model_breakdown: [{ model: 'claude-opus-4-7', tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 }, estimated_cost: { amount: 100, currency: 'USD' } }] }] },
      ],
    }, period)
    if (r.rows.length !== 1) throw new Error(`rows: ${r.rows.length}`)
    if (Math.abs(r.totals.net_spend_usd - 1.00) > 1e-6) throw new Error(`net: ${r.totals.net_spend_usd}`)
  }],
  ['null/missing model_breakdown → still produces user row aggregate? no — only model rows count', () => {
    const r = claudeCodeRangeToCostResp({
      days: [{ date: '2026-04-01', source: 'live', data: [{ actor: { type: 'user_actor', email_address: 'c@x.com' }, core_metrics: { num_sessions: 7 }, model_breakdown: [] }] }],
    }, period)
    if (r.rows.length !== 0) throw new Error(`rows: ${r.rows.length}`)
    // user is counted in distinct_users? choice: no — only counted when they have at least one model row
    if (r.totals.distinct_users !== 0) throw new Error(`users: ${r.totals.distinct_users}`)
  }],
]

console.log('TAP version 13')
console.log(`1..${cases.length}`)

let pass = 0, fail = 0, n = 0
for (const [desc, fn] of cases) {
  n += 1
  try {
    fn()
    console.log(`ok ${n} - ${desc}`)
    pass += 1
  } catch (err) {
    console.log(`not ok ${n} - ${desc}`)
    console.log(`  ---`)
    console.log(`  message: "${err.message}"`)
    console.log(`  ---`)
    fail += 1
  }
}
console.log(`# pass ${pass}`)
console.log(`# fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node tests/server/test-cost-live-reshape.mjs`
Expected: All cases fail with `SyntaxError` or `TypeError: claudeCodeRangeToCostResp is not a function` (the function doesn't exist yet). Exit code 1.

- [ ] **Step 1.3: Add the reshape function to `server/aws.js`**

Locate the top of `server/aws.js` (after the AWS SDK imports, before the Athena sanitizer block). Insert this exported function:

```js
// ─── Reshape: Claude Code usage range → CsvResp shape ──────────────────────
// Converts the per-day actor records returned by /api/admin/claude-code/range
// into the same shape /api/cost/csv produces, so the frontend can swap data
// sources without changing aggregation logic.
//
// IMPORTANT: cents → USD conversion happens here. The upstream API returns
// estimated_cost.amount in MINOR currency units (cents). Total amounts are
// rounded to 4 decimals during accumulation to avoid binary-float drift, then
// rounded to 2 decimals in the totals object for display.
//
// `total_requests` is set to sum(num_sessions); this is an APPROXIMATION
// since the API does not expose per-request counts. The UI tags this as
// approximate when source === 'live'.
export function claudeCodeRangeToCostResp(rangeBody, period) {
  // key: `${user_email}|${model}` → user×model aggregate row
  const acc = new Map()
  // key: `${date}|${model}` → daily×model series for the trends chart
  const dailyAcc = new Map()
  const distinctUsers = new Set()
  const distinctModels = new Set()
  let totalRequests = 0

  for (const day of rangeBody?.days || []) {
    if (day?.source === 'error') continue
    for (const rec of day?.data || []) {
      const actor = rec?.actor || {}
      const email = actor.type === 'user_actor'
        ? actor.email_address
        : (actor.type === 'api_actor' ? `API key: ${actor.api_key_name ?? 'unknown'}` : 'unknown')
      const sessions = rec?.core_metrics?.num_sessions ?? 0
      const breakdown = Array.isArray(rec?.model_breakdown) ? rec.model_breakdown : []
      if (breakdown.length === 0) continue
      distinctUsers.add(email)
      totalRequests += sessions

      for (const m of breakdown) {
        const model = m?.model
        if (!model) continue
        distinctModels.add(model)
        const t = m.tokens || {}
        const input  = (t.input ?? 0) + (t.cache_read ?? 0) + (t.cache_creation ?? 0)
        const output = t.output ?? 0
        const cents  = m.estimated_cost?.amount ?? 0
        const usd    = Math.round(cents) / 100

        const key = `${email}|${model}`
        const u = acc.get(key) ?? {
          user_email: email, account_uuid: '', product: 'Claude Code', model,
          total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0,
          total_net_spend_usd: 0, total_gross_spend_usd: 0,
        }
        u.total_prompt_tokens     += input
        u.total_completion_tokens += output
        u.total_net_spend_usd      = Number((u.total_net_spend_usd + usd).toFixed(4))
        u.total_gross_spend_usd    = u.total_net_spend_usd
        u.total_requests          += sessions
        acc.set(key, u)

        const dkey = `${day.date}|${model}`
        const d = dailyAcc.get(dkey) ?? { date: day.date, model, spend: 0, input: 0, output: 0, requests: 0 }
        d.spend    = Number((d.spend + usd).toFixed(4))
        d.input   += input
        d.output  += output
        d.requests += sessions
        dailyAcc.set(dkey, d)
      }
    }
  }

  const rows = [...acc.values()]
  const daily = [...dailyAcc.values()].sort((a, b) =>
    a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date),
  )
  const sumSpend = rows.reduce((s, r) => s + r.total_net_spend_usd, 0)
  const sumPrompt = rows.reduce((s, r) => s + r.total_prompt_tokens, 0)
  const sumCompl = rows.reduce((s, r) => s + r.total_completion_tokens, 0)

  return {
    source: 'live',
    file: null,
    last_modified: new Date().toISOString(),
    period,
    rows,
    daily,
    totals: {
      requests:           totalRequests,
      prompt_tokens:      sumPrompt,
      completion_tokens:  sumCompl,
      net_spend_usd:      Number(sumSpend.toFixed(2)),
      gross_spend_usd:    Number(sumSpend.toFixed(2)),
      distinct_users:     distinctUsers.size,
      distinct_models:    distinctModels.size,
      distinct_products:  rows.length === 0 ? 0 : 1,
    },
  }
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node tests/server/test-cost-live-reshape.mjs`
Expected: All 8 cases `ok`. `# pass 8`, `# fail 0`. Exit code 0.

- [ ] **Step 1.5: Commit**

```bash
git add server/aws.js tests/server/test-cost-live-reshape.mjs
git commit -m "feat(cost): add claudeCodeRangeToCostResp reshape with unit tests"
```

---

### Task 2: `/api/cost/live` route handler

**Files:**
- Modify: `server/aws.js` — inside `registerAwsRoutes`, near the existing `/cost/csv` handler (around line 369)

The handler self-calls the in-process Express server's `/api/admin/claude-code/range` endpoint (this pattern is already established by `/cost/efficiency` at `server/aws.js:644`). This avoids exporting `fetchJson` / pagination logic from `server/index.js`.

- [ ] **Step 2.1: Locate insertion point in `server/aws.js`**

Open `server/aws.js`, find the line immediately *after* the `/cost/csv` handler closes (it's near line 444 — immediately before the `// POST /api/cost/upload` block at line 493). Insert the new handler there.

- [ ] **Step 2.2: Add the handler**

Insert this code into `server/aws.js` (inside `registerAwsRoutes`, after `/cost/csv`, before `/cost/upload`):

```js
  // GET /api/cost/live?starting_date=YYYY-MM-DD&ending_date=YYYY-MM-DD
  //
  // Reuses /api/admin/claude-code/range via in-process self-call (same pattern
  // as /cost/efficiency below). Returns a CsvResp-shaped payload so the
  // frontend's existing Cost.tsx aggregation logic works unchanged.
  //
  // Errors:
  //   400 admin_key_required        → ANTHROPIC_ADMIN_KEY_ADMIN missing
  //   502 upstream_error            → /admin/claude-code/range returned non-2xx
  //   200 source=live, rows=[]      → empty period (UI handles → CSV fallback)
  router.get('/cost/live', async (req, res) => {
    // Default range: last 30 days, ending 1 day ago (matches Admin API freshness)
    const today = new Date()
    const todayMinus = (n) => {
      const d = new Date(today); d.setUTCDate(d.getUTCDate() - n)
      return d.toISOString().slice(0, 10)
    }
    const startingDate = req.query.starting_date || todayMinus(31)
    const endingDate   = req.query.ending_date   || todayMinus(1)

    const PORT = Number(process.env.PORT) || 5174
    const url = `http://127.0.0.1:${PORT}/api/admin/claude-code/range?starting_date=${startingDate}&ending_date=${endingDate}`
    let rangeBody
    try {
      const r = await fetch(url)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        // Propagate admin_key_required so the UI can fall back gracefully
        if (body?.error === 'admin_key_required') return res.status(400).json(body)
        return res.status(502).json({ error: 'upstream_error', message: body?.message || `range fetch ${r.status}`, upstream: body })
      }
      rangeBody = body
    } catch (err) {
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err) })
    }

    const out = claudeCodeRangeToCostResp(rangeBody, { starting_date: startingDate, ending_date: endingDate })
    res.json(out)
  })

```

- [ ] **Step 2.3: Verify syntax**

Run: `node --check server/aws.js`
Expected: no output, exit code 0.

- [ ] **Step 2.4: Smoke-test live endpoint locally**

Start the dev server: `npm run dev` (in another terminal)

Then probe:
```bash
curl -s "http://127.0.0.1:5174/api/cost/live?starting_date=2026-04-01&ending_date=2026-04-07" | head -c 800
```

Expected (one of):
- `{"source":"live","file":null,"last_modified":"...","period":{...},"rows":[...],"daily":[...],"totals":{...}}` — admin key configured + data present
- `{"error":"admin_key_required",...}` — local `.env` lacks admin key (graceful 400)
- `{"error":"upstream_error",...}` — upstream issue

Either of the first two is a valid pass. Stop the dev server (Ctrl+C) before continuing.

- [ ] **Step 2.5: Commit**

```bash
git add server/aws.js
git commit -m "feat(cost): add /api/cost/live route via /admin/claude-code/range"
```

---

### Task 3: i18n keys (en + ko)

**Files:**
- Modify: `src/lib/i18n.tsx`

Find the `cost.*` block in both the `en` and `ko` dictionaries (search for `'cost.empty':` to locate). Insert the 7 new key pairs *immediately after the existing `cost.*` block* in each dictionary.

- [ ] **Step 3.1: Add keys to the `en` dictionary**

Find the line `'cost.empty.hint':` (or any other `'cost.*'` line) in the `en` block of `src/lib/i18n.tsx`. After the last `cost.*` entry, add:

```ts
    'cost.source.live':           'Live API',
    'cost.source.csv':            'Reconciliation CSV',
    'cost.live.caveat.30day':     'Values within the last 30 days may be revised as new events are reflected.',
    'cost.live.requests.approx':  'Approximate (session count)',
    'cost.trends.title':          'Daily spend by model',
    'cost.trends.subtitle':       'Live API · Claude Code only',
    'cost.recon.expander':        'Reconciliation CSV (≥ 30 days)',
```

- [ ] **Step 3.2: Add keys to the `ko` dictionary**

Find the same `cost.*` block in the `ko` dictionary. Add (matching the order above):

```ts
    'cost.source.live':           '라이브 API',
    'cost.source.csv':            '정산 CSV',
    'cost.live.caveat.30day':     '최근 30일 내 값은 신규 이벤트 반영에 따라 변경될 수 있습니다.',
    'cost.live.requests.approx':  '추정값 (세션 수 기준)',
    'cost.trends.title':          '모델별 일별 지출',
    'cost.trends.subtitle':       '라이브 API · Claude Code 한정',
    'cost.recon.expander':        '정산 CSV (30일 이전)',
```

- [ ] **Step 3.3: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors. (If new key pairs unbalanced between en/ko, TypeScript's i18n key union will mismatch.)

- [ ] **Step 3.4: Commit**

```bash
git add src/lib/i18n.tsx
git commit -m "i18n(cost): add live/CSV source, trends, and 30-day caveat strings"
```

---

### Task 4: `useCostData` composite hook in Cost.tsx

**Files:**
- Modify: `src/pages/Cost.tsx` — top of file, after imports, before the `Cost` component

The existing `useFetch` always fires; firing two parallel requests (one live, one CSV) is wasteful but cheap (the CSV path is S3+5min cache). Don't refactor `useFetch` for this PR.

- [ ] **Step 4.1: Update the `CsvResp` type to include the new optional `daily` array**

Find the existing `type CsvResp = {` block (around line 31). Add `source: 'csv' | 'live'` (replacing the `source: 'csv'` literal), and add an optional `daily` array:

```ts
type DailyPoint = { date: string; model: string; spend: number; input: number; output: number; requests: number }

type CsvResp = {
  source: 'csv' | 'live'
  file: string | null
  last_modified: string
  period: { starting_date: string; ending_date: string } | null
  rows: CsvRow[]
  daily?: DailyPoint[]
  totals: {
    requests: number
    prompt_tokens: number
    completion_tokens: number
    net_spend_usd: number
    gross_spend_usd: number
    distinct_users: number
    distinct_models: number
    distinct_products: number
  }
}
```

- [ ] **Step 4.2: Add the `useCostData` hook above the `Cost` component**

Insert directly above `export function Cost()`:

```ts
type CostSource = 'live' | 'csv'

/**
 * Composite cost data hook.
 * Tries /api/cost/live first; if it errors OR returns rows=[], silently falls
 * back to /api/cost/csv. Both queries fire in parallel (cheap due to S3+cache
 * on the CSV path); the active one is selected here.
 */
function useCostData(range: { startingDate: string; endingDate: string }) {
  const liveUrl = `/api/cost/live?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const live = useFetch<CsvResp>(liveUrl)
  const csv  = useFetch<CsvResp>('/api/cost/csv')

  const liveOk = !live.loading && !live.error && (live.data?.rows.length ?? 0) > 0
  const useCsv = !liveOk
  const data = useCsv ? csv.data : live.data
  const source: CostSource = useCsv ? 'csv' : 'live'

  // Loading: at least one channel is loading and no usable data yet
  const loading = (live.loading && !live.error) || (useCsv && csv.loading && !csv.data)
  // Error: only surface CSV's error if we've actually fallen back to CSV.
  // Live errors are silent — they trigger the fallback, not a user-visible error.
  const error = useCsv ? csv.error : null

  const refetch = async () => { await live.refetch(); await csv.refetch() }
  return { data, loading, error, source, refetch }
}
```

- [ ] **Step 4.3: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors. (The hook isn't used yet, but its types must check.)

- [ ] **Step 4.4: Commit**

```bash
git add src/pages/Cost.tsx
git commit -m "feat(cost): add useCostData hook for live+CSV fallback"
```

---

### Task 5: Wire `useCostData` into `Cost` component (replace direct CSV fetch)

**Files:**
- Modify: `src/pages/Cost.tsx` — inside the `Cost()` function (currently lines 102-115)

- [ ] **Step 5.1: Replace the CSV-only fetch with `useCostData`**

Find this block in `src/pages/Cost.tsx` (around lines 102-115):

```tsx
export function Cost() {
  const t = useT()
  // CSV aggregates are pre-computed for the whole CSV period — date range
  // doesn't apply. Only the efficiency endpoint (which joins with Analytics
  // API) is date-range aware.
  const { data, loading, error, refetch } = useFetch<CsvResp>('/api/cost/csv')
  const { range } = useDateRange('30d')
  const effUrl = `/api/cost/efficiency?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const eff = useFetch<EfficiencyResp>(effUrl)

  // After a successful upload/delete, invalidate the two live queries
  // that depend on the S3 spend-reports/ prefix.
  const onUploadChange = () => { refetch(); eff.refetch() }
```

Replace with:

```tsx
export function Cost() {
  const t = useT()
  const { range } = useDateRange('30d')
  // Live API (Claude Code only) with automatic CSV fallback.
  // The CSV path also handles the >30-day reconciliation use case.
  const { data, loading, error, refetch, source: dataSource } = useCostData(range)
  const effUrl = `/api/cost/efficiency?starting_date=${range.startingDate}&ending_date=${range.endingDate}`
  const eff = useFetch<EfficiencyResp>(effUrl)

  // After a successful upload/delete, invalidate the live cost + efficiency
  // queries that depend on the S3 spend-reports/ prefix.
  const onUploadChange = () => { refetch(); eff.refetch() }
```

- [ ] **Step 5.2: Make `PageHeader source` dynamic**

Find the `<PageHeader` JSX (around line 224-231) and replace its hardcoded `source="live"` with `source={dataSource}`:

```tsx
      <PageHeader
        title={t('cost.title')}
        subtitle={data.period
          ? t('cost.subtitle.csv', { start: data.period.starting_date, end: data.period.ending_date })
          : t('cost.subtitle')}
        source={dataSource}
        reason={dataSource === 'live' ? t('cost.source.live') : `CSV · ${data.file ?? ''}`}
      />
```

- [ ] **Step 5.3: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors. (`PageHeader`'s `source` prop must accept `'csv' | 'live'`. If it only accepts a literal subset, we'll need to widen its type — see Step 5.4.)

- [ ] **Step 5.4: If `PageHeader source` prop doesn't accept `'csv'`, widen it**

If Step 5.3 errors with something like `Type '"csv"' is not assignable to type ...`, open `src/components/PageHeader.tsx` and widen the `source` prop's type to include `'csv'`. Most likely change is:

```tsx
// Before
source?: 'live' | 'mock' | 'upstream_error'
// After
source?: 'live' | 'mock' | 'upstream_error' | 'csv'
```

Then re-run `npx tsc -b --noEmit`.

- [ ] **Step 5.5: Smoke test in browser**

```bash
npm run dev
```

Open `http://localhost:5173/cost` (or the configured dev URL). Expected:
- If admin key configured + live data exists: page loads, source badge shows "Live API"
- If no admin key but CSV present: page loads, source badge shows "Reconciliation CSV"
- If neither: empty state with uploader

Stop dev server.

- [ ] **Step 5.6: Commit**

```bash
git add src/pages/Cost.tsx src/components/PageHeader.tsx
git commit -m "feat(cost): wire useCostData with dynamic source badge"
```

(Omit `PageHeader.tsx` from `git add` if Step 5.4 wasn't needed.)

---

### Task 6: 30-day caveat banner (live mode only)

**Files:**
- Modify: `src/pages/Cost.tsx` — the main rendered tree, just above the KPI grid (around line 232)

- [ ] **Step 6.1: Insert the banner**

Find this block (around lines 232-238):

```tsx
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard accent label={t('cost.kpi.total')} ...
```

Insert *between* the `<div className="p-8 space-y-6">` opener and the KPI grid:

```tsx
      <div className="p-8 space-y-6">
        <div className="flex items-center justify-end">
          <DateRangeControl />
        </div>
        {dataSource === 'live' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
            {t('cost.live.caveat.30day')}
          </div>
        )}
        <div className="grid grid-cols-4 gap-4">
```

(Keep the existing KPI grid contents unchanged after `<div className="grid grid-cols-4 gap-4">`.)

- [ ] **Step 6.2: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6.3: Smoke test**

`npm run dev` → load Cost page in live mode → confirm amber banner shown above KPIs → switch to CSV mode (toggle admin key) → confirm banner hidden.

- [ ] **Step 6.4: Commit**

```bash
git add src/pages/Cost.tsx
git commit -m "feat(cost): add 30-day caveat banner + page-level date range in live mode"
```

---

### Task 7: "Daily spend by model" trends chart (live mode only)

**Files:**
- Modify: `src/pages/Cost.tsx` — render tree, after the existing model_cost ChartCard (around line 314), before `EconomicProductivitySection`

The trends chart needs the per-day pivot. Recharts wants a flat `[{ date, model_a: spend, model_b: spend, ... }]` shape, so we pivot the `daily` array client-side.

- [ ] **Step 7.1: Add a pivot helper inside the `Cost` component (after the existing `agg` `useMemo`)**

Find the `}, [data])` line that closes the `agg` useMemo (around line 185). Immediately after it, add:

```tsx
  const trendsPivot = useMemo(() => {
    if (!data?.daily || data.daily.length === 0) return { rows: [], models: [] }
    const byDate = new Map<string, Record<string, any>>()
    const models = new Set<string>()
    for (const d of data.daily) {
      models.add(d.model)
      const row = byDate.get(d.date) ?? { date: d.date }
      row[shortModel(d.model)] = (row[shortModel(d.model)] ?? 0) + d.spend
      byDate.set(d.date, row)
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    return { rows, models: [...models].sort() }
  }, [data])
```

- [ ] **Step 7.2: Add the imports for `AreaChart` and `Area` from recharts**

Find the existing `import { ResponsiveContainer, BarChart, ... } from 'recharts'` line (line 2). Add `AreaChart, Area` to the import list:

```tsx
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ScatterChart, Scatter, ZAxis,
} from 'recharts'
```

- [ ] **Step 7.3: Render the trends chart**

Find the existing `<ChartCard title={t('cost.model_cost')} ...>` block (around line 287). After its closing `</ChartCard>` tag (around line 314), insert:

```tsx
        {dataSource === 'live' && trendsPivot.rows.length > 0 && (
          <ChartCard title={t('cost.trends.title')} subtitle={t('cost.trends.subtitle')}>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trendsPivot.rows} margin={{ top: 8, right: 16, left: -12, bottom: 8 }}>
                <CartesianGrid strokeDasharray="2 4" />
                <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tickFormatter={(v: number) => fmtUsd(v)} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                {trendsPivot.models.map((m, i) => (
                  <Area
                    key={m}
                    type="monotone"
                    dataKey={shortModel(m)}
                    stackId="m"
                    stroke={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]}
                    fill={MODEL_COLORS[m] || FALLBACK[i % FALLBACK.length]}
                    fillOpacity={0.6}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
```

- [ ] **Step 7.4: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 7.5: Smoke test**

`npm run dev` → Cost page in live mode → confirm the new "Daily spend by model" stacked area chart appears between the model_cost section and the top-tables grid → CSV mode (no admin key) → confirm the chart is hidden.

- [ ] **Step 7.6: Commit**

```bash
git add src/pages/Cost.tsx
git commit -m "feat(cost): add daily spend trends chart for live mode"
```

---

### Task 8: Collapse CSV uploader into expander

**Files:**
- Modify: `src/pages/Cost.tsx` — the existing CSV management section (around lines 328-333)

- [ ] **Step 8.1: Replace the CSV management `<div>` with a `<details>` expander**

Find this block (around lines 328-333):

```tsx
        {/* ── CSV management ──────────────────────────────────────────── */}
        <div className="pt-6 border-t border-ink-100">
          <h2 className="text-lg font-semibold text-ink-800 mb-1">{t('cost.upload.replace')}</h2>
          <p className="text-xs text-ink-500 mb-4">{t('cost.csv_upload.body')}</p>
          <CsvUploader onChange={onUploadChange} variant="full" />
        </div>
```

Replace with:

```tsx
        {/* ── CSV management (auto-expanded in CSV mode) ────────────── */}
        <details
          open={dataSource === 'csv'}
          className="pt-6 border-t border-ink-100 group"
        >
          <summary className="cursor-pointer text-sm font-semibold text-ink-700 hover:text-ink-900 select-none">
            {t('cost.recon.expander')}
          </summary>
          <div className="mt-4">
            <h3 className="text-base font-semibold text-ink-800 mb-1">{t('cost.upload.replace')}</h3>
            <p className="text-xs text-ink-500 mb-4">{t('cost.csv_upload.body')}</p>
            <CsvUploader onChange={onUploadChange} variant="full" />
          </div>
        </details>
```

- [ ] **Step 8.2: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 8.3: Smoke test**

`npm run dev` → Cost page in live mode → confirm the CSV section is collapsed (just the "Reconciliation CSV (≥ 30 days)" summary visible). Click to expand → uploader shown → switch to CSV mode → confirm auto-expanded.

- [ ] **Step 8.4: Commit**

```bash
git add src/pages/Cost.tsx
git commit -m "feat(cost): collapse CSV uploader into reconciliation expander"
```

---

### Task 9: Approximate-requests note on Requests KPI (live mode only)

**Files:**
- Modify: `src/pages/Cost.tsx` — KPI grid (around line 237)

- [ ] **Step 9.1: Append asterisk + tooltip to the Requests KpiCard hint in live mode**

Find the existing Requests KpiCard (around line 237):

```tsx
          <KpiCard       label={t('cost.kpi.requests')}   value={fmtCompact(data.totals.requests)}        hint={`${data.totals.distinct_models} models · ${data.totals.distinct_products} products`} />
```

Replace with:

```tsx
          <KpiCard
            label={dataSource === 'live' ? `${t('cost.kpi.requests')} *` : t('cost.kpi.requests')}
            value={fmtCompact(data.totals.requests)}
            hint={dataSource === 'live'
              ? t('cost.live.requests.approx')
              : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`
            }
          />
```

- [ ] **Step 9.2: Verify TypeScript compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 9.3: Smoke test**

Live mode → confirm KPI label shows "Requests *" with hint "Approximate (session count)". CSV mode → confirm label is plain "Requests" with the original models/products hint.

- [ ] **Step 9.4: Commit**

```bash
git add src/pages/Cost.tsx
git commit -m "feat(cost): label Requests KPI as approximate in live mode"
```

---

### Task 10: Document `/api/cost/live` in api-reference.md

**Files:**
- Modify: `docs/api-reference.md` — the "Cost (from uploaded CSV)" section

- [ ] **Step 10.1: Update the section heading and add the new row**

Find the line `## Cost (from uploaded CSV)` (around line 49) and replace the entire section with:

```markdown
## Cost (live API + CSV reconciliation)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cost/live?starting_date=&ending_date=` | **Live**: per-user × model spend/tokens for Claude Code product over the date range. Self-calls `/api/admin/claude-code/range` and reshapes to the same payload as `/cost/csv`. Adds a `daily` array (per-date × model) for the Trends chart. Defaults to `[today−31, today−1]`. Returns 400 `admin_key_required` when admin key is missing — UI uses this to fall back to CSV. |
| GET | `/api/cost/csv` | **Reconciliation**: latest Spend Report CSV from `s3://<archive>/spend-reports/`, parsed + totals. Same response shape as `/api/cost/live` but `source: "csv"`, with no `daily` array. |
| GET | `/api/cost/efficiency?starting_date=&ending_date=` | Join of Spend CSV + `users/range` → per-user economic productivity score. Date range is optional; defaults to the CSV's native period. Server clamps `ending_date` to `today − 3` (Analytics API buffer). |
| POST | `/api/cost/upload` | Multipart CSV upload (field `file`). 25 MB cap. Validates required columns (`user_email`, `product`, `model`, `total_requests`, `total_prompt_tokens`, `total_completion_tokens`, `total_net_spend_usd`). Filenames matching `spend-report-+YYYY-MM-DD-to-YYYY-MM-DD.csv` are preserved; anything else is renamed to a safe today-derived name. |
| GET | `/api/cost/uploads` | Lists all CSVs under `spend-reports/` with parsed period, size, and `last_modified`, newest first. Used by the dashboard's upload history + overlap detection. |
| DELETE | `/api/cost/uploads/:file` | Removes a single CSV. Filename regex-checked (`[A-Za-z0-9._-]+\.csv`) to block path traversal. |
```

- [ ] **Step 10.2: Commit**

```bash
git add docs/api-reference.md
git commit -m "docs(api-reference): add /api/cost/live row + retitle cost section"
```

---

### Task 11: ADR-0003 — Hybrid live cost API + CSV reconciliation

**Files:**
- Create: `docs/decisions/0003-hybrid-live-cost.md`

- [ ] **Step 11.1: Create the ADR**

Write `docs/decisions/0003-hybrid-live-cost.md`:

````markdown
# ADR-0003: Hybrid live Cost API with CSV reconciliation

- **Status**: Accepted
- **Date**: 2026-05-08
- **Deciders**: @whchoi98
- **Supplements**: [ADR-0002](0002-dashboard-csv-upload.md) (CSV upload retained as fallback)

## Context

ADR-0002 chose CSV upload for the Cost page because the Admin API at the time
did not expose per-user × product × model granularity. Two facts changed:

1. The Anthropic Analytics API was extended to expose per-user token + USD cost
   data. Refresh ~4h, with up to 30 days of correction for recent dates.
2. This codebase already proxies `/v1/organizations/usage_report/claude_code`
   as `/api/admin/claude-code/range` — its response carries
   `model_breakdown[].estimated_cost.amount` (cents) per user, which is
   sufficient to drive the Cost page for the Claude Code product without any
   manual upload.

## Decision

Add `/api/cost/live` that self-calls `/api/admin/claude-code/range` and
reshapes the response into the same `CsvResp` shape the Cost page already
renders. Cost.tsx tries `/api/cost/live` first; on error or empty data, it
falls back to `/api/cost/csv`. CSV upload remains available for finance
reconciliation (≥30 days back) and for non-Claude-Code products that the
endpoint does not cover.

## Consequences

### Positive

- Cost page shows live data without prior CSV upload — solves the dominant
  operator pain identified in ADR-0002 ("monthly export ritual").
- Zero new infrastructure: no new secrets, no new IAM, no new ECS env vars,
  no Glue tables. The admin key is already injected.
- Trends chart ("Daily spend by model") becomes possible because the live
  payload exposes per-day aggregates, which the single-period CSV cannot.
- 30-day correction window is non-blocking: the CSV path remains the source
  of truth for billing-grade totals on dates ≥30 days old.

### Negative

- `total_requests` is approximated from `num_sessions` — sessions are not 1:1
  with API requests. The KPI is labeled "Requests *" with a tooltip; the CSV
  path retains the exact value. Documented in `docs/api-reference.md`.
- Live mode covers Claude Code only; Chat / Cowork / Browser Extension /
  Excel / PowerPoint product breakdowns still require a CSV upload.
- The "API key:" actor namespace in live mode causes a small visual
  divergence from CSV mode (CSV groups by email_address only, where API key
  usage is invisible). Acceptable for v1; surfaces real activity that CSV
  hides.

### Follow-ups (v2 candidates)

- Migrate `/api/cost/efficiency` from CSV to live (separate PR for blast
  radius reasons).
- Verify the broader Analytics API (read:analytics scope) for
  cross-product spend; currently the `usage_report/claude_code` endpoint is
  Claude Code only.
- Surface `context_window` (200K vs 1M) and `inference_geo` (region) splits
  if operators express interest.

## References

- [Spec](../superpowers/specs/2026-05-08-analytics-cost-api-design.md)
- [Plan](../superpowers/plans/2026-05-08-cost-live-api.md)
- [`server/aws.js`](../../server/aws.js) — `/cost/live` route + reshape function
- [`src/pages/Cost.tsx`](../../src/pages/Cost.tsx) — `useCostData` hook + UI
- [Anthropic Claude Code Analytics API docs](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
````

- [ ] **Step 11.2: Commit**

```bash
git add docs/decisions/0003-hybrid-live-cost.md
git commit -m "docs(adr): 0003 hybrid live cost API + CSV reconciliation"
```

---

### Task 12: End-to-end smoke test

This is the final integration check. No code changes, just verification of all paths.

- [ ] **Step 12.1: Start dev server**

```bash
npm run dev
```

Wait for both `vite` (5173) and `node --watch server/index.js` (5174) to come up.

- [ ] **Step 12.2: Verify live mode renders correctly**

Open `http://localhost:5173/cost`. Expected:
- Source badge (top-right of PageHeader) shows "Live API"
- Amber 30-day caveat banner is visible above KPIs
- Requests KPI label shows "Requests *" with tooltip "Approximate (session count)"
- "Daily spend by model" stacked-area chart renders below the model_cost table
- "Reconciliation CSV (≥ 30 days)" expander at bottom is **collapsed**
- DateRangeControl is visible above the caveat banner; changing range refetches

- [ ] **Step 12.3: Verify auto-fallback to CSV**

In another terminal:

```bash
# Capture admin key, then unset
ORIG=$(grep ANTHROPIC_ADMIN_KEY_ADMIN .env)
sed -i '/^ANTHROPIC_ADMIN_KEY_ADMIN=/d' .env
```

Refresh the Cost page in the browser. Expected:
- Source badge shows "Reconciliation CSV"
- Amber banner is gone
- Trends chart is gone
- Requests KPI label is plain "Requests" with original hint
- Reconciliation expander is **auto-expanded** (CsvUploader visible)

Restore admin key:

```bash
echo "$ORIG" >> .env
```

Refresh page; verify live mode returns.

- [ ] **Step 12.4: Verify economic productivity section unchanged**

Confirm the existing Economic Productivity section still renders below the KPI/charts area in both live and CSV modes — it pulls from `/api/cost/efficiency` which we didn't touch.

- [ ] **Step 12.5: Verify other pages unaffected**

Click through the sidebar: Overview, Users, UserProductivity, Trends, ClaudeCode, Productivity, Adoption, Compliance, Analyze, Archive. Each should render without errors. (No changes to these pages, but a careless edit to a shared component could break one.)

- [ ] **Step 12.6: Run full reshape test suite once more**

```bash
node tests/server/test-cost-live-reshape.mjs
node tests/server/test-athena-sanitizer.mjs
```

Expected: both exit 0 with `# fail 0`.

- [ ] **Step 12.7: Verify no regressions on existing endpoints**

```bash
curl -s http://127.0.0.1:5174/api/cost/csv         | head -c 200
curl -s "http://127.0.0.1:5174/api/admin/claude-code/range?starting_date=2026-04-01&ending_date=2026-04-07" | head -c 200
curl -s http://127.0.0.1:5174/api/health           | head -c 200
```

Expected: all three return JSON (or 400 for missing keys with intelligible messages). Status code via `-w '%{http_code}'` if needed.

- [ ] **Step 12.8: Stop dev server, then push**

Ctrl+C the dev server. Push the branch:

```bash
git push origin main
```

(Or open a PR if working on a feature branch — adjust accordingly.)

---

## Self-review checklist

### Spec coverage

- [x] **Goal 1** — Live load without CSV: Tasks 2, 5
- [x] **Goal 2** — Per-user × model for any range: Task 1 reshape, Task 5 wiring
- [x] **Goal 3** — Trends section: Task 7
- [x] **Goal 4** — CSV upload retained: Task 8 (collapsed but present)
- [x] **Goal 5** — Auto-fallback: Task 4 useCostData, verified Task 12.3
- [x] **30-day caveat banner** (spec § 2): Task 6
- [x] **Requests KPI approximation note** (spec § 1, Risk table): Task 9
- [x] **i18n en + ko keys** (spec § 2): Task 3
- [x] **`PageHeader source` dynamic** (spec § 2): Task 5.2 + 5.4
- [x] **CSV uploader expander** (spec § 2): Task 8
- [x] **api-reference.md update** (spec § 2): Task 10
- [x] **ADR-0003** (spec § header): Task 11
- [x] **Reshape unit tests** (spec § 4): Task 1
- [x] **Manual smoke** (spec § 4): Task 12

### Placeholder scan

No "TBD", "TODO", "implement later", or "similar to Task N" used. Each step
has explicit code blocks or commands.

### Type consistency

- `CostSource = 'live' | 'csv'` defined in Task 4.2; used in Tasks 5, 6, 7, 8, 9.
- `CsvResp.source: 'csv' | 'live'` widened in Task 4.1; reshape function returns `'live'` (Task 1.3); CSV endpoint already returns `'csv'`.
- `DailyPoint` defined in Task 4.1; used by `trendsPivot` in Task 7.1.
- `claudeCodeRangeToCostResp(rangeBody, period)` signature consistent across Tasks 1.3, 1.1 (test), 2.2.
- `dataSource` variable name consistent across Tasks 5.1, 5.2, 6.1, 7.3, 8.1, 9.1.

### Out-of-scope confirmation

Per the spec, the following are intentionally NOT in this plan:
- `/api/cost/efficiency` migration (separate PR)
- Non-Claude-Code product live coverage
- `context_window` / `inference_geo` UI dimensions
- Collector S3 archive of cost data
- ADR-0002 deprecation

---






