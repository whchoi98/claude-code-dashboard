// Standalone ESM test for the >31-day cost-window chunking layer:
// splitCostWindow, fetchReportPagesChunked, mergeUserReportRows (server/aws.js).
// Runs with: node tests/server/test-cost-chunking.mjs — exit 0 on success, 1 on failure.
import {
  splitCostWindow, fetchReportPagesChunked, mergeUserReportRows,
  userCostToUsers, userUsageToUsers, COST_MAX_SPAN_DAYS, COST_MAX_CHUNKS,
  dailyReportParams, DAILY_BUCKET_LIMIT, RETRY_WAITS_429,
} from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const eqf = (a, b) => Math.abs(a - b) < 1e-6

// ── splitCostWindow ─────────────────────────────────────────────────────────
{
  const w = splitCostWindow('2026-07-01', '2026-07-22')
  ok('≤31d span stays a single chunk', w.chunks.length === 1 && !w.clamped)
  ok('single chunk covers the exact window', w.chunks[0][0] === '2026-07-01' && w.chunks[0][1] === '2026-07-22')
}
{
  const w = splitCostWindow('2026-06-22', '2026-07-22')  // exactly 31 days
  ok('exactly 31 days = one chunk', w.chunks.length === 1)
}
{
  const w = splitCostWindow('2026-06-21', '2026-07-22')  // 32 days
  ok('32 days = two chunks', w.chunks.length === 2)
  ok('chunk 1 is 31 days from the start', w.chunks[0][0] === '2026-06-21' && w.chunks[0][1] === '2026-07-21')
  ok('chunk 2 covers the remainder', w.chunks[1][0] === '2026-07-22' && w.chunks[1][1] === '2026-07-22')
}
{
  const w = splitCostWindow('2026-05-01', '2026-07-22')  // 83 days
  ok('83 days = three chunks', w.chunks.length === 3)
  // chunks are consecutive and non-overlapping
  let contiguous = true
  for (let i = 1; i < w.chunks.length; i++) {
    const prevEnd = new Date(`${w.chunks[i - 1][1]}T00:00:00Z`)
    const nextStart = new Date(`${w.chunks[i][0]}T00:00:00Z`)
    if (nextStart.getTime() - prevEnd.getTime() !== 86400000) contiguous = false
  }
  ok('chunks are contiguous (no gap, no overlap)', contiguous)
  ok('un-clamped window keeps the requested start', w.starting === '2026-05-01' && !w.clamped)
}
{
  const w = splitCostWindow('2025-01-01', '2026-07-22')  // far beyond cap
  ok('over-cap window clamps + flags', w.clamped === true)
  ok('clamped chunk count = COST_MAX_CHUNKS', w.chunks.length === COST_MAX_CHUNKS)
  const days = w.chunks.reduce((s, [a, b]) =>
    s + (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000 + 1, 0)
  ok('clamped span = maxDays × maxChunks', days === COST_MAX_SPAN_DAYS * COST_MAX_CHUNKS)
  ok('clamped window still ends at the requested end', w.chunks[w.chunks.length - 1][1] === '2026-07-22')
  ok('effective starting reported', w.starting === w.chunks[0][0])
}
{
  const w = splitCostWindow('2026-07-22', '2026-07-22')  // single day
  ok('single-day window = one single-day chunk', w.chunks.length === 1 && w.chunks[0][0] === '2026-07-22' && w.chunks[0][1] === '2026-07-22')
}
{
  // Inverted/unparseable pairs must NEVER yield zero chunks (a zero-chunk
  // fetch would return a silent all-zero 200) — they collapse to the ending
  // day and fail loudly upstream if genuinely malformed.
  const inv = splitCostWindow('2026-07-20', '2026-07-01')
  ok('inverted window collapses to a single ending-day chunk', inv.chunks.length === 1 && inv.chunks[0][0] === '2026-07-01' && inv.chunks[0][1] === '2026-07-01')
  const bad = splitCostWindow('not-a-date', '2026-07-01')
  ok('unparseable start still yields one chunk', bad.chunks.length === 1)
}

// ── fetchReportPagesChunked ─────────────────────────────────────────────────
{
  // fake upstream: one daily bucket per requested window start; second page never used
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const s = new URL(url).searchParams.get('starting_at').slice(0, 10)
    return { ok: true, status: 200, json: async () => ({ data: [{ starting_at: `${s}T00:00:00Z`, results: [] }], data_refreshed_at: `${s}-refresh`, has_more: false }) }
  }
  const urlFor = (s, e) => `https://x.test/report?starting_at=${s}T00%3A00%3A00Z&ending_at=${e}`
  const r = await fetchReportPagesChunked(urlFor, {}, [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-07-01'], ['2026-07-02', '2026-07-22']], fetchImpl)
  ok('chunked fetch merges every chunk\'s buckets', r.ok && r.body.data.length === 3)
  ok('buckets keep chunk order (oldest first)', r.body.data[0].starting_at.startsWith('2026-05-01') && r.body.data[2].starting_at.startsWith('2026-07-02'))
  ok('data_refreshed_at comes from the last chunk that reported one', r.body.data_refreshed_at === '2026-07-02-refresh')
  ok('one upstream call per chunk (no pagination in fake)', calls.length === 3)
}
{
  // failure in any chunk propagates as a failed fetch (persistent 429 —
  // survives the full retry ladder; waits injected so the test stays fast)
  const fetchImpl = async (url) => {
    const s = new URL(url).searchParams.get('starting_at').slice(0, 10)
    if (s === '2026-06-01') return { ok: false, status: 429, json: async () => ({ error: 'rate' }) }
    return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) }
  }
  const urlFor = (s, e) => `https://x.test/report?starting_at=${s}T00%3A00%3A00Z&ending_at=${e}`
  const r = await fetchReportPagesChunked(urlFor, {}, [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-07-01']], fetchImpl, { retryWaits429: [5, 5] })
  ok('a persistently-429 chunk fails the whole chunked fetch', r.ok === false && r.status === 429)
}
{
  // a chunk that 429s TWICE then succeeds must survive the retry ladder —
  // the 2026-08-27 incident: a 119-day load saturates the 60rpm budget and a
  // single 2s retry lands inside the same saturated minute.
  let attempts = 0
  const fetchImpl = async (url) => {
    const s = new URL(url).searchParams.get('starting_at').slice(0, 10)
    if (s === '2026-06-01' && ++attempts <= 2) {
      return { ok: false, status: 429, json: async () => ({ error: 'rate' }) }
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ starting_at: `${s}T00:00:00Z` }], has_more: false }) }
  }
  const urlFor = (s, e) => `https://x.test/report?starting_at=${s}T00%3A00%3A00Z&ending_at=${e}`
  const r = await fetchReportPagesChunked(urlFor, {}, [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-07-01']], fetchImpl, { retryWaits429: [5, 5] })
  ok('double-429-then-200 chunk recovers via the retry ladder', r.ok === true && r.body.data.length === 2)
  ok('exactly 3 attempts were made for the flapping chunk (2×429 + 1 success)', attempts === 3)
}

{
  // Per-walk retry sleep budget: with a 0ms budget the ladder must not sleep
  // at all — a persistent-429 chunk fails after its FIRST attempt (pre-fix
  // fail-fast shape). Guards the CloudFront 60s origin timeout: without the
  // cap, a 6-chunk walk's ladder sleeps sum to ~47s+ under saturation.
  let calls429 = 0
  const fetchImpl = async (url) => {
    const s = new URL(url).searchParams.get('starting_at').slice(0, 10)
    if (s === '2026-06-01') { calls429++; return { ok: false, status: 429, json: async () => ({ error: 'rate' }) } }
    return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) }
  }
  const urlFor = (s, e) => `https://x.test/report?starting_at=${s}T00%3A00%3A00Z&ending_at=${e}`
  const r = await fetchReportPagesChunked(urlFor, {}, [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-07-01']], fetchImpl, { retryWaits429: [5, 5], retrySleepBudgetMs: 0 })
  ok('exhausted sleep budget skips retries (fail-fast)', r.ok === false && calls429 === 1)
}
{
  // The default ladder is the incident-tuned constant — a silent revert to
  // the pre-incident single short retry must fail this assertion.
  ok('RETRY_WAITS_429 default is the two-step [2500, 8000] ladder',
    Array.isArray(RETRY_WAITS_429) && RETRY_WAITS_429.length === 2 && RETRY_WAITS_429[0] === 2500 && RETRY_WAITS_429[1] === 8000)
}

// ── dailyReportParams — request shaping for daily-bucket report walks ───────
{
  const p = dailyReportParams('2026-05-01', '2026-05-31', ['product', 'model'])
  ok('daily params carry limit=31 (max daily buckets/page — 5x fewer pages)', p.get('limit') === String(DAILY_BUCKET_LIMIT) && DAILY_BUCKET_LIMIT === 31)
  ok('daily params keep bucket_width=1d', p.get('bucket_width') === '1d')
  ok('daily params use exclusive ending_at (next UTC day)', p.get('starting_at') === '2026-05-01T00:00:00Z' && p.get('ending_at') === '2026-06-01T00:00:00Z')
  ok('daily params append every group_by dim', p.getAll('group_by[]').join(',') === 'product,model')
  const scoped = dailyReportParams('2026-05-01', '2026-05-31', ['product'], { rbacGroupId: 'rbac_group_x' })
  ok('rbac scope rides rbac_group_ids[]', scoped.getAll('rbac_group_ids[]').join(',') === 'rbac_group_x')
  const bare = dailyReportParams('2026-05-01', '2026-05-31')
  ok('dims optional; no rbac filter when unscoped', bare.getAll('group_by[]').length === 0 && bare.getAll('rbac_group_ids[]').length === 0)
}

// ── mergeUserReportRows — user_cost_report ──────────────────────────────────
{
  const rows = [
    { actor: { user_id: 'u1', email: 'a@x.com', name: 'A' }, amount: '100.5', list_amount: '110.5', requests: 3 },
    { actor: { user_id: 'u1', email: 'a@x.com', name: 'A' }, amount: '200.5', list_amount: '220.5', requests: 4 },
    { actor: { user_id: 'u2', email: 'b@x.com' }, amount: '50', requests: 1 },
  ]
  const m = mergeUserReportRows(rows, 'user_cost_report')
  ok('cost rows merge per user', m.length === 2)
  const u1 = m.find((r) => r.actor.user_id === 'u1')
  ok('amount sums as decimal string', eqf(parseFloat(u1.amount), 301))
  ok('list_amount sums independently of amount', eqf(parseFloat(u1.list_amount), 331))
  ok('requests sum', u1.requests === 7)
  ok('single-row user passes through', eqf(parseFloat(m.find((r) => r.actor.user_id === 'u2').amount), 50))
  // consumer end-to-end: ungrouped userCostToUsers no longer duplicates users
  const users = userCostToUsers(m)
  ok('ungrouped consumer sees one row per user after merge', users.length === 2)
  ok('merged USD is the chunk sum', eqf(users.find((u) => u.email === 'a@x.com').net_spend_usd, 3.01))
}
{
  // grouped by model: same user × different models must NOT merge
  const rows = [
    { actor: { user_id: 'u1', email: 'a@x.com' }, model: 'fable-5', amount: '100', requests: 1 },
    { actor: { user_id: 'u1', email: 'a@x.com' }, model: 'fable-5', amount: '50', requests: 1 },
    { actor: { user_id: 'u1', email: 'a@x.com' }, model: 'opus-4-8', amount: '25', requests: 1 },
  ]
  const m = mergeUserReportRows(rows, 'user_cost_report')
  ok('user × model keys stay separate', m.length === 2)
  ok('same model rows sum', eqf(parseFloat(m.find((r) => r.model === 'fable-5').amount), 150))
  const grouped = userCostToUsers(m, { by: 'model' })
  ok('grouped consumer total is exact', eqf(grouped[0].net_spend_usd, 1.75) && grouped[0].by_model.length === 2)
}
{
  // list_amount fallback ordering: second row without list_amount must use its
  // OWN amount, not the already-summed accumulator (the double-count trap)
  const rows = [
    { actor: { email: 'a@x.com' }, amount: '100', list_amount: '100', requests: 1 },
    { actor: { email: 'a@x.com' }, amount: '50', requests: 1 },
  ]
  const m = mergeUserReportRows(rows, 'user_cost_report')
  ok('list_amount fallback does not double-count', eqf(parseFloat(m[0].list_amount), 150))
}

// ── mergeUserReportRows — user_usage_report ─────────────────────────────────
{
  const rows = [
    { actor: { email: 'a@x.com' }, uncached_input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 50, requests: 2,
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 } },
    { actor: { email: 'a@x.com' }, uncached_input_tokens: 200, cache_read_input_tokens: 600, output_tokens: 70, requests: 3,
      cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 40 } },
  ]
  const m = mergeUserReportRows(rows, 'user_usage_report')
  ok('usage rows merge per user', m.length === 1)
  ok('token fields sum', m[0].uncached_input_tokens === 300 && m[0].cache_read_input_tokens === 1000 && m[0].output_tokens === 120)
  ok('nested cache_creation sums', m[0].cache_creation.ephemeral_1h_input_tokens === 40 && m[0].cache_creation.ephemeral_5m_input_tokens === 60)
  const users = userUsageToUsers(m)
  ok('usage consumer totals are exact', users[0].total_tokens === 300 + 1000 + 40 + 60 + 120 && users[0].requests === 5)
  ok('cache hit rate survives the merge', eqf(users[0].cache_hit_rate, Number((1000 / 1400).toFixed(4))))
}
{
  // merge must not mutate the input rows (first row is spread-copied)
  const first = { actor: { email: 'a@x.com' }, amount: '100', requests: 1 }
  mergeUserReportRows([first, { actor: { email: 'a@x.com' }, amount: '50', requests: 1 }], 'user_cost_report')
  ok('input rows are not mutated', first.amount === '100' && first.requests === 1)
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${n - failed}/${n}`)
process.exit(failed === 0 ? 0 : 1)
