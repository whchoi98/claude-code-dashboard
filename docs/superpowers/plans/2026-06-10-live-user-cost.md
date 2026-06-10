# Live Per-User Cost (`user_cost_report`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cost page's per-user spend tables and `/cost/efficiency` work live (no CSV) using the Analytics `user_cost_report` endpoint, keeping CSV as an optional fallback for per-user tokens + old-date reconciliation.

**Architecture:** A new `GET /api/cost/users` proxies `user_cost_report` (paginated, raw emails). `GET /api/cost/efficiency` gains a live spend source: it builds per-user spend from `user_cost_report` for the exact selected range (no CSV-period scaling) and joins it with the existing Analytics `users/range` productivity aggregation on `email`; if `user_cost_report` is empty/unavailable it falls back to the existing CSV path. `Cost.tsx` lights up the per-user "Top by Cost" table + the `distinct_users` KPI in live mode and shows token-ranked tables only when per-user tokens exist (CSV).

**Tech Stack:** Express 4 (ESM) · AWS SDK v3 (S3) · `fetch` to `api.anthropic.com` · React 18 + TS. Spec: `docs/superpowers/specs/2026-06-10-live-user-cost-design.md`. Verified live contract is in the spec's Context section.

---

## File Structure

**Modified**
- `server/aws.js` — add exported pure `userCostToUsers(data)`; add closure helper `fetchUserCostReport({starting,ending})` (paginate + raw emails); add `router.get('/cost/users')`; add a live spend branch to `router.get('/cost/efficiency')`.
- `src/pages/Cost.tsx` — gate the 3 token-ranked Top tables on per-user-token availability; source `distinct_users` from `eff.data.user_count` in live mode.
- `src/lib/i18n.tsx` — one new caveat key (`cost.top.live_caveat`) in en + ko.
- `docs/anthropic-api-fields.md`, `docs/api-reference.md`, `docs/architecture.md`, `server/CLAUDE.md`, `src/CLAUDE.md` — doc sync.
- `docs/decisions/0009-live-user-cost.md` — new ADR.
- `CHANGELOG.md`, `package.json` — v0.8.0.

**New (test)**
- `tests/server/test-user-cost.mjs` — unit tests for `userCostToUsers`.

---

## Phase 1 — Server: `/api/cost/users` (proxy `user_cost_report`)

### Task 1: Pure `userCostToUsers(data)` mapping (TDD)

**Files:**
- Modify: `server/aws.js` (add an exported module-level function, next to `analyticsReportsToCostResp` near the top — NOT inside `registerAwsRoutes`, so it's importable without instantiating AWS clients, exactly like `analyticsReportsToCostResp`).
- Test: `tests/server/test-user-cost.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/server/test-user-cost.mjs`:

```js
// Standalone ESM test for userCostToUsers (server/aws.js).
// Runs with: node tests/server/test-user-cost.mjs — exit 0 on success, 1 on failure.
import { userCostToUsers } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const eqf = (a, b) => Math.abs(a - b) < 1e-6

const page = [
  { actor: { type: 'user_actor', user_id: 'u1', name: 'Alice', email: 'alice@acme.com', deleted: false },
    currency: 'USD', amount: '1175883.870130', list_amount: '1175885.870130', requests: 52110 },
  { actor: { type: 'user_actor', user_id: 'u2', name: 'Bob', email: 'bob@acme.com', deleted: false },
    currency: 'USD', amount: '5000', list_amount: '5000', requests: 3 },
  // api_actor with no email — excluded (user-centric endpoint; can't join)
  { actor: { type: 'api_actor', api_key_id: 'k1' }, currency: 'USD', amount: '99', requests: 1 },
]
const users = userCostToUsers(page)
ok('excludes actors without email', users.length === 2)
ok('cents → USD net', eqf(users[0].net_spend_usd, 11758.8387013))
ok('cents → USD gross from list_amount', eqf(users[0].gross_spend_usd, 11758.8587013))
ok('gross falls back to amount when list_amount missing', eqf(userCostToUsers([{ actor: { email: 'x@y.com' }, amount: '200' }])[0].gross_spend_usd, 2))
ok('passes raw email (no masking here)', users[0].email === 'alice@acme.com')
ok('passes user_id + name', users[0].user_id === 'u1' && users[0].name === 'Alice')
ok('requests numeric', users[1].requests === 3)
ok('empty / non-array → []', userCostToUsers(null).length === 0 && userCostToUsers(undefined).length === 0)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/server/test-user-cost.mjs`
Expected: FAIL — `userCostToUsers is not a function` (not yet exported).

- [ ] **Step 3: Implement `userCostToUsers`** in `server/aws.js`

Add immediately after the `analyticsReportsToCostResp` function (it ends around line 137, before the Athena sanitizer section):

```js
// Map a user_cost_report `data[]` array to the dashboard's per-user shape.
// amount/list_amount are decimal strings in fractional CENTS (same convention
// as cost_report) → /100 for USD. Emails are returned RAW for the email-keyed
// efficiency join; the frontend masks via maskEmail on render. api_actor rows
// (no email) are excluded — this endpoint is user-centric and emails are the
// join key.
export function userCostToUsers(data) {
  return (Array.isArray(data) ? data : [])
    .map((r) => {
      const a = r.actor || {}
      return {
        email: a.email || '',
        user_id: a.user_id || null,
        name: a.name || null,
        deleted: !!a.deleted,
        net_spend_usd: parseFloat(r.amount || '0') / 100,
        gross_spend_usd: parseFloat(r.list_amount || r.amount || '0') / 100,
        requests: Number(r.requests || 0),
      }
    })
    .filter((u) => u.email)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/server/test-user-cost.mjs`
Expected: `1..8` all `ok`, exit 0. Also `node --check server/aws.js`.

- [ ] **Step 5: Register test in runner (if needed) + commit**

`tests/run-all.sh` auto-discovers `tests/server/*.mjs` (confirmed by Phase-1 of the chatbot work); verify with `bash tests/run-all.sh` that `test-user-cost.mjs` is picked up. If the runner lists node suites explicitly instead, add a line mirroring `test-athena-sanitizer.mjs`.

```bash
git add server/aws.js tests/server/test-user-cost.mjs tests/run-all.sh
git commit -m "feat(cost): userCostToUsers — user_cost_report → 사용자별 USD 매핑"
```

### Task 2: `fetchUserCostReport` helper + `GET /api/cost/users`

**Files:**
- Modify: `server/aws.js` (inside `registerAwsRoutes`)

- [ ] **Step 1: Add the paginating fetch helper** inside `registerAwsRoutes`, right after `fetchCostSummary` (around line 367):

```js
  // Paginate user_cost_report for [starting, ending] and return RAW merged
  // data[] (emails unmasked — needed for the email-keyed efficiency join;
  // the frontend masks on render). Caps pages to stay within the 60/min budget.
  async function fetchUserCostReport({ starting_date, ending_date } = {}) {
    const ANALYTICS_KEY = process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY
    if (!ANALYTICS_KEY) { const e = new Error('ANTHROPIC_ANALYTICS_KEY is required for per-user cost.'); e.code = 'analytics_key_required'; throw e }
    // Clamp ending to today-3 (Analytics 3-day buffer); default to a 31-day window.
    const today = new Date()
    const minus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
    const maxEnd = minus(3)
    let ending = ending_date || maxEnd
    if (ending > maxEnd) ending = maxEnd
    const starting = starting_date || minus(34)
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com'
    const apiVersion = process.env.ANTHROPIC_VERSION || '2023-06-01'
    const headers = { 'x-api-key': ANALYTICS_KEY, 'anthropic-version': apiVersion }

    const all = []
    let page = null
    let refreshedAt = null
    const MAX_PAGES = 50
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({ starting_at: `${starting}T00:00:00Z`, ending_at: `${ending}T00:00:00Z`, limit: '1000' })
      if (page) params.set('page', page)
      const res = await fetch(`${apiUrl}/v1/organizations/analytics/user_cost_report?${params.toString()}`, { headers })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { const e = new Error(`user_cost_report ${res.status}`); e.code = 'upstream_error'; e.upstream = body; throw e }
      if (Array.isArray(body.data)) all.push(...body.data)
      refreshedAt = body.data_refreshed_at ?? refreshedAt
      if (!body.has_more || !body.next_page) break
      page = body.next_page
      if (i === MAX_PAGES - 1) console.warn(`[cost/users] hit ${MAX_PAGES}-page cap; results truncated`)
    }
    return { data: all, period: { starting_date: starting, ending_date: ending }, data_refreshed_at: refreshedAt }
  }
```

- [ ] **Step 2: Add the route** (place it near `/cost/live`, after that handler ~line 600):

```js
  // GET /api/cost/users — per-user USD spend (user_cost_report), sorted by spend.
  // Raw emails; the frontend masks via maskEmail. No per-user token counts exist
  // in this endpoint (cost + requests only).
  router.get('/cost/users', async (req, res) => {
    try {
      const { data, period, data_refreshed_at } = await fetchUserCostReport({
        starting_date: req.query.starting_date, ending_date: req.query.ending_date,
      })
      const users = userCostToUsers(data).sort((a, b) => b.net_spend_usd - a.net_spend_usd)
      res.json({ source: 'live', period, data_refreshed_at, users })
    } catch (err) {
      if (err?.code === 'analytics_key_required') {
        return res.status(400).json({ error: 'analytics_key_required', message: err.message })
      }
      return res.status(502).json({ error: 'upstream_error', message: err?.message || String(err), upstream: err?.upstream })
    }
  })
```

- [ ] **Step 3: Verify**

Run: `node --check server/aws.js` and `bash tests/run-all.sh` (still green — no behavior change to tested paths).

- [ ] **Step 4: Manual smoke (real key)**

```bash
PORT=5199 node server/index.js >/tmp/ccd.log 2>&1 &
sleep 2
curl -s "http://localhost:5199/api/cost/users?starting_date=2026-05-08&ending_date=2026-06-07" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('source',d.get('source'),'users',len(d.get('users',[])),'top_keys',list((d.get('users') or [{}])[0].keys()))"
kill %1 2>/dev/null
```
Expected: `source live`, `users > 0`, keys include `email,user_id,name,net_spend_usd,gross_spend_usd,requests`. (Do NOT print full emails — the one-liner only prints keys.)

- [ ] **Step 5: Commit**

```bash
git add server/aws.js
git commit -m "feat(cost): GET /api/cost/users — user_cost_report 프록시(페이지네이션)"
```

---

## Phase 2 — Server: live spend branch in `/cost/efficiency`

### Task 3: Prefer live `user_cost_report` spend; CSV as fallback

**Files:**
- Modify: `server/aws.js` — the `router.get('/cost/efficiency', …)` handler (currently ~lines 762–997).

**Context:** Today the handler is CSV-first: it reads the latest Spend Report CSV (404 if none), aggregates `bySpendUser` from it, then joins Analytics `users/range` productivity (steps 4–6) with an activity-weighted scaling that distributes the CSV's fixed-period total across the selected range. We make spend source live by default: `user_cost_report` queried for the **exact** range (so scaling is unnecessary), keeping the CSV path as a fallback. Steps 4–6 (productivity aggregation, join, scoring) are reused unchanged except the response's `source` field.

- [ ] **Step 1: Replace the handler's top (from `router.get('/cost/efficiency'` through the end of the old "step 3a" block, i.e. everything BEFORE the `// 4) Aggregate productivity per user.` comment) with:**

```js
  router.get('/cost/efficiency', async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    const today = new Date(); today.setUTCDate(today.getUTCDate() - 3)
    const maxEnd = today.toISOString().slice(0, 10)

    // ── Spend source: prefer LIVE user_cost_report for the exact selected
    //    range; fall back to the uploaded Spend Report CSV (per-user tokens +
    //    old-date reconciliation). The productivity join below keys on email
    //    either way. ───────────────────────────────────────────────────────
    const bySpendUser = new Map()
    let csvPeriod = null
    let source = 'live+analytics'
    let starting = req.query.starting_date
    let ending = req.query.ending_date
    if (ending && ending > maxEnd) ending = maxEnd

    let liveUsers = []
    try {
      const live = await fetchUserCostReport({ starting_date: starting, ending_date: ending })
      liveUsers = userCostToUsers(live.data)
      starting = live.period.starting_date
      ending = live.period.ending_date
      csvPeriod = { starting_date: starting, ending_date: ending }
    } catch {
      liveUsers = []   // fall through to CSV
    }

    if (liveUsers.length > 0) {
      for (const u of liveUsers) {
        bySpendUser.set(u.email, {
          spend: u.net_spend_usd, prompt_tokens: 0, completion_tokens: 0,
          requests: u.requests, models: new Set(), products: new Set(),
        })
      }
    } else {
      // ── CSV fallback (prior behaviour) ─────────────────────────────────
      source = 'csv+analytics'
      if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
      let csvRows = []
      try {
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'spend-reports/' }))
        const objs = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
        if (objs.length === 0) {
          return res.status(404).json({ error: 'no_spend_report', message: 'No live per-user cost available and no Spend Report CSV uploaded.' })
        }
        const latest = objs.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
        const name = latest.Key.split('/').pop() || ''
        const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
        csvPeriod = m ? { starting_date: m[1], ending_date: m[2] } : null
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
        csvRows = parseCsv(await obj.Body.transformToString()).rows
      } catch (err) {
        return res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
      }
      for (const r of csvRows) {
        const u = bySpendUser.get(r.user_email) ?? { spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0, models: new Set(), products: new Set() }
        u.spend += Number(r.total_net_spend_usd || 0)
        u.prompt_tokens += Number(r.total_prompt_tokens || 0)
        u.completion_tokens += Number(r.total_completion_tokens || 0)
        u.requests += Number(r.total_requests || 0)
        u.models.add(r.model); u.products.add(r.product)
        bySpendUser.set(r.user_email, u)
      }
      starting = starting || csvPeriod?.starting_date
      ending = ending || csvPeriod?.ending_date
      if (ending && ending > maxEnd) ending = maxEnd
    }

    const isLive = source === 'live+analytics'
    const PORT = Number(process.env.PORT) || 5174

    // Productivity over the selected range (same self-call as before).
    const rangeResp = await fetch(
      `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${starting}&ending_date=${ending}`,
    ).then((r) => r.json()).catch(() => ({ days: [] }))

    // Activity-weighted scaling applies ONLY to the CSV path (a fixed-period
    // total). The live path is already range-exact → sameRange=true → ratio 1.
    const sessionsByUserInCsvPeriod = new Map()
    const csvPeriodStart = csvPeriod?.starting_date
    let   csvPeriodEnd   = csvPeriod?.ending_date
    if (csvPeriodEnd && csvPeriodEnd > maxEnd) csvPeriodEnd = maxEnd
    const sameRange = isLive ? true : (csvPeriodStart === starting && csvPeriodEnd === ending)
    if (!isLive && !sameRange && csvPeriodStart && csvPeriodEnd) {
      const csvAnalyticsResp = await fetch(
        `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${csvPeriodStart}&ending_date=${csvPeriodEnd}`,
      ).then((r) => r.json()).catch(() => ({ days: [] }))
      for (const d of csvAnalyticsResp.days || []) {
        if (d.source === 'mock') continue
        for (const rec of d.data || []) {
          const sess = rec.claude_code_metrics?.core_metrics?.distinct_session_count ?? 0
          const email = rec.user?.email_address
          if (!email) continue
          sessionsByUserInCsvPeriod.set(email, (sessionsByUserInCsvPeriod.get(email) ?? 0) + sess)
        }
      }
    }
```

Leave the existing `// 4) Aggregate productivity per user.` block and step 5 (join) **unchanged** — they already read `rangeResp`, `bySpendUser`, `sessionsByUserInCsvPeriod`, and `sameRange`, all set above.

- [ ] **Step 2: Change the response `source` field** (step 6, ~line 982):

Find:
```js
    res.json({
      source: 'csv+analytics',
```
Replace with:
```js
    res.json({
      source,
```

- [ ] **Step 3: Verify**

Run: `node --check server/aws.js` (clean). `bash tests/run-all.sh` (green). Confirm the old inline CSV-first block is gone: `grep -n "Pull the latest spend CSV\|bySpendUser = new Map" server/aws.js` should show only the new structure (the old "// 1) Pull the latest spend CSV" comment removed).

- [ ] **Step 4: Manual smoke (real key, no CSV needed)**

```bash
PORT=5199 node server/index.js >/tmp/ccd.log 2>&1 &
sleep 2
curl -s "http://localhost:5199/api/cost/efficiency?starting_date=2026-05-08&ending_date=2026-06-07" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('source',d.get('source'),'user_count',d.get('user_count'),'first_has_spend',(d.get('users') or [{}])[0].get('spend_usd') is not None,'first_tokens',(d.get('users') or [{}])[0].get('prompt_tokens'))"
kill %1 2>/dev/null
```
Expected: `source live+analytics`, `user_count > 0`, `first_has_spend True`, `first_tokens 0` (no per-user tokens live).

- [ ] **Step 5: Commit**

```bash
git add server/aws.js
git commit -m "feat(cost): /cost/efficiency 라이브 spend(user_cost_report) 우선 + CSV 폴백"
```

---

## Phase 3 — Frontend: light up live per-user UI

### Task 4: Token-table gating + live `distinct_users` KPI in `Cost.tsx`

**Files:**
- Modify: `src/pages/Cost.tsx`
- Modify: `src/lib/i18n.tsx`

- [ ] **Step 1: Add the `cost.top.live_caveat` i18n key** (en + ko) in `src/lib/i18n.tsx`, next to the existing `cost.top.*` keys:

```js
// en
    'cost.top.live_caveat': 'Per-user spend is live from the Analytics API for the selected range. Per-user token breakdowns require a Spend Report CSV.',
// ko
    'cost.top.live_caveat': '사용자별 지출은 선택 범위에 대해 Analytics API에서 라이브로 가져옵니다. 사용자별 토큰 분해는 Spend Report CSV가 필요합니다.',
```

- [ ] **Step 2: Add a `hasPerUserTokens` flag** in the `Cost` component, near `userRowsForTop` (~line 372):

```tsx
  // Per-user TOKEN counts exist only from CSV — user_cost_report is cost-only.
  const hasPerUserTokens = (eff.data?.source?.includes('csv') ?? false) || !!csvUserRows
```

- [ ] **Step 3: Gate the 3 token Top-tables + add the live caveat** — replace the Top-N grid block (~lines 584–589):

Find:
```tsx
            <div className="grid grid-cols-2 gap-6">
              <TopTable title={t('cost.top_cost')}   rows={topSpend}  metric="spend"        formatter={fmtUsd}     accent t={t} />
              <TopTable title={t('cost.top_total')}  rows={topTotal}  metric="total_tokens" formatter={fmtCompact} t={t} />
              <TopTable title={t('cost.top_input')}  rows={topInput}  metric="input"        formatter={fmtCompact} t={t} />
              <TopTable title={t('cost.top_output')} rows={topOutput} metric="output"       formatter={fmtCompact} t={t} />
            </div>
```
Replace with:
```tsx
            {!hasPerUserTokens && (
              <p className="text-[11px] text-ink-400 mb-2 px-1">{t('cost.top.live_caveat')}</p>
            )}
            <div className={hasPerUserTokens ? 'grid grid-cols-2 gap-6' : 'grid grid-cols-1 gap-6 max-w-md'}>
              <TopTable title={t('cost.top_cost')} rows={topSpend} metric="spend" formatter={fmtUsd} accent t={t} />
              {hasPerUserTokens && (
                <>
                  <TopTable title={t('cost.top_total')}  rows={topTotal}  metric="total_tokens" formatter={fmtCompact} t={t} />
                  <TopTable title={t('cost.top_input')}  rows={topInput}  metric="input"        formatter={fmtCompact} t={t} />
                  <TopTable title={t('cost.top_output')} rows={topOutput} metric="output"       formatter={fmtCompact} t={t} />
                </>
              )}
            </div>
```

- [ ] **Step 4: Source `distinct_users` from efficiency in live mode** — replace the KPI hint (~lines 416–423):

Find:
```tsx
            hint={
              // Prefer CSV's per-user count when available (it's the only
              // source that has user attribution today). Fall back to
              // models·products in live-only mode.
              csvData?.totals?.distinct_users
                ? `${fmtNum(csvData.totals.distinct_users)} users · ${data.totals.distinct_models} models`
                : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`
            }
```
Replace with:
```tsx
            hint={
              // Per-user attribution now comes from live user_cost_report
              // (eff.user_count); CSV's distinct_users is the fallback.
              (eff.data?.user_count || csvData?.totals?.distinct_users)
                ? `${fmtNum(eff.data?.user_count || csvData?.totals?.distinct_users)} users · ${data.totals.distinct_models} models`
                : `${data.totals.distinct_models} models · ${data.totals.distinct_products} products`
            }
```

- [ ] **Step 5: Verify build**

Run: `npm run build` (tsc strict + vite). Expected: clean. (`eff.data?.source` is typed `string`; `hasPerUserTokens` is a boolean; no type errors.)

- [ ] **Step 6: Commit**

```bash
git add src/pages/Cost.tsx src/lib/i18n.tsx
git commit -m "feat(cost): 라이브 사용자별 비용 테이블·distinct_users KPI 점등 + 토큰 테이블 게이팅"
```

---

## Phase 4 — Docs, ADR, CHANGELOG

> **CAUTION:** the repo's PreToolUse secret-scan hook blocks commits whose staged content contains full `sk-ant-…`-shaped tokens. Reference keys abstractly (e.g. "the Analytics key"). NEVER use `git commit --no-verify`; if blocked, rephrase and retry.

### Task 5: ADR-0009 + doc sync

**Files:**
- Create: `docs/decisions/0009-live-user-cost.md`
- Modify: `docs/anthropic-api-fields.md`, `docs/api-reference.md`, `docs/architecture.md`, `server/CLAUDE.md`, `src/CLAUDE.md`

- [ ] **Step 1: Write ADR-0009** — `docs/decisions/0009-live-user-cost.md`:

```markdown
# ADR-0009: Live per-user cost via user_cost_report (CSV demoted)

- **Status**: Accepted
- **Date**: 2026-06-10
- **Deciders**: @whchoi98
- **Resolves**: the per-user limitation in [ADR-0003](0003-hybrid-live-cost.md)

## Context

ADR-0003 kept the Spend Report CSV as the only source of per-user spend because
the live `cost_report` `group_by[]` had no actor/user dimension. Verified live on
2026-06-10: the Analytics family now exposes `GET /v1/organizations/analytics/user_cost_report`,
returning per-user USD `amount`/`list_amount` (fractional cents) + `requests` with
an `actor {user_id, name, email}`, sorted by amount, `?page=` paginated. (Confirmed
negative: `cost_report` with `group_by[]=actor` → HTTP 400.) It carries **no
per-user token counts**.

## Decision

Add `GET /api/cost/users` (proxy + pagination, raw emails masked at the frontend).
Make `GET /api/cost/efficiency` query `user_cost_report` for the exact selected
range and join it with Analytics `users/range` productivity on `email`, dropping
the CSV-period activity-weighted scaling on that path; fall back to the CSV path
when `user_cost_report` is empty/unavailable. The Cost page lights up the per-user
"Top by Cost" table + a live `distinct_users` KPI; token-ranked per-user tables
render only when per-user tokens exist (CSV). CSV upload is **retained, demoted**
to optional (per-user tokens + billing-grade reconciliation older than the live
correction window).

## Consequences

- Cost page per-user analysis works with **no CSV upload** — closes ADR-0003's
  main negative and its first two follow-ups.
- Per-user **token** granularity remains CSV-only (no live source exists).
- Email masking stays at the render layer (`maskEmail`), consistent with
  `/cost/efficiency` + `/analytics/users/range`; the efficiency join keys on raw
  email, so the proxy must not pre-mask.
- No new infra/secrets (reuses the Analytics key).
```

- [ ] **Step 2: `docs/anthropic-api-fields.md`** — under §2 (cost family), add a `user_cost_report` subsection: path `GET /v1/organizations/analytics/user_cost_report`, params `starting_at`/`ending_at` (RFC3339), `limit`, `page`; per-result fields `actor{type,user_id,name,email,deleted}`, `currency`, `amount`/`list_amount` (fractional cents — `/100`), `requests`, dimension fields; note **no token counts**; note `cost_report group_by=actor → 400`. Update the §2 closing note ("No per-user dimension … CSV reconciliation") to point at `user_cost_report` + ADR-0009.

- [ ] **Step 3: `docs/api-reference.md`** — document `GET /api/cost/users` (params, response shape, raw-email/frontend-mask note) and note `/cost/efficiency` now defaults to live spend with CSV fallback (`source: 'live+analytics' | 'csv+analytics'`). Link ADR-0009.

- [ ] **Step 4: `docs/architecture.md`** — in the cost data-flow description, note per-user cost is now live (`user_cost_report`) with CSV as optional reconciliation; link ADR-0009 from Key Design Decisions (en + ko).

- [ ] **Step 5: `server/CLAUDE.md`** — add `/cost/users` + the efficiency live/CSV behaviour + `userCostToUsers`/`fetchUserCostReport` to the `aws.js` bullet. `src/CLAUDE.md` — note the Cost page's per-user tables + `distinct_users` now work in live mode.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/0009-live-user-cost.md docs/anthropic-api-fields.md docs/api-reference.md docs/architecture.md server/CLAUDE.md src/CLAUDE.md
git commit -m "docs: ADR-0009 + user_cost_report 라이브 비용 문서 동기화"
```

### Task 6: CHANGELOG + version bump to 0.8.0

**Files:** `CHANGELOG.md`, `package.json`

- [ ] **Step 1:** Bump `package.json` `"version"` `0.7.1` → `0.8.0`.

- [ ] **Step 2:** Add a `## [0.8.0] - 2026-06-10` section to `CHANGELOG.md` (match the file's existing format), entries:
  - **Added**: `GET /api/cost/users` (live per-user USD spend via `user_cost_report`).
  - **Changed**: `/cost/efficiency` now defaults to live per-user spend (CSV fallback); Cost page shows per-user "Top by Cost" + a live `distinct_users` KPI without a CSV upload. See ADR-0009.
  - **Note**: per-user token breakdowns still require a Spend Report CSV (the live endpoint is cost-only); CSV upload retained as optional reconciliation.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "release: v0.8.0 — 라이브 사용자별 비용 (CSV 선택화)"
```

---

## Phase 5 — Verification

### Task 7: Build, tests, live smoke

- [ ] **Step 1: Server + unit**

```bash
node --check server/aws.js
node tests/server/test-user-cost.mjs
bash tests/run-all.sh
```
Expected: all green (new `test-user-cost.mjs` discovered; cost-reshape + sanitizer + chat-tools still pass).

- [ ] **Step 2: Frontend build**

Run: `npm run build` — tsc strict + vite clean.

- [ ] **Step 3: Live smoke (real key)** — `PORT=5199 node server/index.js &`, then:
  - [ ] `/api/cost/users` → `source:live`, users>0, sorted desc, keys present (no full emails printed).
  - [ ] `/api/cost/efficiency` (no CSV) → `source:live+analytics`, `user_count>0`, per-user `spend_usd` present, `prompt_tokens:0`.
  - [ ] Open `/cost` in `npm run dev`: live mode shows the "Top by Cost" per-user table + non-zero `distinct_users` KPI; the 3 token tables are hidden + the `cost.top.live_caveat` note shows; emails render masked.
  - [ ] Upload a Spend Report CSV → token tables appear; spend source stays live unless `user_cost_report` is empty.
  - Kill the smoke server.

- [ ] **Step 4: Final commit** (only if smoke surfaced fixes)

```bash
git add -A && git commit -m "fix(cost): 스모크 후속 수정"
```

---

## Self-Review

**1. Spec coverage**
- `GET /api/cost/users` (proxy, paginate, raw email, cents→USD) → Tasks 1–2. ✓
- `/cost/efficiency` live default + CSV fallback, no range scaling on live → Task 3. ✓
- Per-user Top "by Cost" lights up live; token tables gated; `distinct_users` live → Task 4. ✓
- CSV retained (fallback + token tables + management UI untouched) → Task 3 (fallback branch) + Task 4 (gating); CsvUploader/`/cost/csv`/upload routes not modified. ✓
- Email masking at render layer (raw from server) → Tasks 1–2 (raw), Task 4 (existing `maskEmail` in effUserRows/csvUserRows). ✓
- `cost_per_loc` reused as the live efficiency metric (no redundant `spend_per_loc`) → Task 3 reuses existing field (noted: spec's `spend_per_loc` == existing `cost_per_loc`, so no new field). ✓
- ADR-0009, docs, CHANGELOG v0.8.0 → Tasks 5–6. ✓
- Tests (userCostToUsers) + smoke → Tasks 1, 7. ✓

**2. Placeholder scan** — no TBD/TODO; every code step has complete code. ✓

**3. Type / name consistency**
- `userCostToUsers(data)` returns `{email,user_id,name,deleted,net_spend_usd,gross_spend_usd,requests}` — consumed in `/cost/users` (Task 2) and the efficiency live branch (Task 3, reads `.email`,`.net_spend_usd`,`.requests`). ✓
- `fetchUserCostReport({starting_date,ending_date})` → `{data,period:{starting_date,ending_date},data_refreshed_at}` — consumed in Task 2 + Task 3. ✓
- efficiency response `source` is now the `source` variable (`'live+analytics'|'csv+analytics'`) — frontend `hasPerUserTokens` checks `eff.data?.source?.includes('csv')` (Task 4). ✓
- `eff.data?.user_count` exists on `EfficiencyResp` (Cost.tsx line 113) — used in the KPI (Task 4). ✓
- Reused existing `EfficiencyUser.cost_per_loc` / `EconomicProductivitySection` (no type changes needed; token fields stay `number`, value 0 in live, and are hidden via the `source`-gated tables rather than per-field null — avoids touching the totals reduce). ✓

**Deviation from spec (noted):** the spec proposed adding `EfficiencyUser.spend_per_loc` and making token fields `number|null`. Implementation reuses the existing `cost_per_loc` (identical: spend/loc_added) and keeps token fields `number` (0 in live), gating the token *tables* on `source` instead of nulling fields. This is simpler, avoids a `totals` reduce-on-null bug, and changes no types — same user-visible result ("—"/hidden token columns live).
