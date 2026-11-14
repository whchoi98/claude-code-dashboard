// Standalone ESM test for the Usage and Cost Analytics API adapter
// (server/cost-api.js, ADR-0023): v2 query shaping, row → legacy-shape
// conversion (zero-filled daily buckets, flattened per-user rows) and the
// v2 → legacy fallback switch.
// Runs with: node tests/server/test-cost-api-v2.mjs — exit 0 on success, 1 on failure.
import {
  COST_API_BETA, V2_ROW_LIMIT, costApiMode, v2PathFor,
  dailyReportParamsV2, userReportParamsV2, flattenV2Row, rowsToDailyBuckets,
  isV2FallbackError, makeCostApiSwitch,
} from '../../server/cost-api.js'
import { analyticsReportsToCostResp, userCostToUsers, mergeUserReportRows } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// ── mode + paths ────────────────────────────────────────────────────────────
ok('default mode is v2', costApiMode({}) === 'v2')
ok('CCD_COST_API=legacy pins the legacy reports', costApiMode({ CCD_COST_API: 'legacy' }) === 'legacy')
ok('mode value is case/space tolerant', costApiMode({ CCD_COST_API: ' Legacy ' }) === 'legacy')
ok('unknown mode values fall back to v2', costApiMode({ CCD_COST_API: 'nonsense' }) === 'v2')
ok('cost reports map to /analytics/cost', v2PathFor('cost_report') === '/v1/organizations/analytics/cost'
  && v2PathFor('user_cost_report') === '/v1/organizations/analytics/cost')
ok('usage reports map to /analytics/usage', v2PathFor('usage_report') === '/v1/organizations/analytics/usage'
  && v2PathFor('user_usage_report') === '/v1/organizations/analytics/usage')
ok('beta header value is the documented one', COST_API_BETA === 'analytics-usage-cost-2026-08-24')

// ── query shaping ───────────────────────────────────────────────────────────
{
  const p = dailyReportParamsV2('2026-11-01', '2026-11-08', ['product', 'model'], { rbacGroupId: 'rbac_group_x' })
  ok('daily params use time_bucket_width (not bucket_width)', p.get('time_bucket_width') === '1d' && !p.has('bucket_width'))
  ok('daily params send the exclusive ending_at as given', p.get('starting_at') === '2026-11-01T00:00:00Z' && p.get('ending_at') === '2026-11-08T00:00:00Z')
  ok('daily params ask for time-ordered rows at the row max', p.get('order_by') === 'time' && p.get('order') === 'asc' && p.get('limit') === String(V2_ROW_LIMIT))
  ok('daily params carry dims and the rbac filter', p.getAll('group_by[]').join(',') === 'product,model' && p.get('rbac_group_ids[]') === 'rbac_group_x')
}
{
  const p = userReportParamsV2('2026-11-01', '2026-11-08', 'model')
  ok('per-user params group by actor first, then the dim', p.getAll('group_by[]').join(',') === 'actor,model')
  ok('per-user params keep only user actors', p.get('actor_types[]') === 'user_actor')
  ok('per-user params have no time bucket (one row per user × dim)', !p.has('time_bucket_width'))
  const q = userReportParamsV2('2026-11-01', '2026-11-08')
  ok('ungrouped per-user params group by actor only', q.getAll('group_by[]').join(',') === 'actor')
}

// ── row conversion ──────────────────────────────────────────────────────────
const costRow = (day, product, model, amount, requests = 1) => ({
  starting_at: `${day}T00:00:00Z`, ending_at: 'ignored',
  group: { product, model, rbac_group_id: null, cost_type: null, token_type: null, actor: null },
  cost: { currency: 'USD', amount, list_amount: amount, requests },
})
{
  const flat = flattenV2Row(costRow('2026-11-02', 'claude_code', 'claude-opus-5-5', '1200.500000', 7))
  ok('flatten lifts group dims and cost metrics to one level', flat.product === 'claude_code' && flat.model === 'claude-opus-5-5'
    && flat.amount === '1200.500000' && flat.requests === 7 && flat.currency === 'USD')
  ok('flatten tolerates a missing row', Object.keys(flattenV2Row(null)).length === 0)
  ok('Claude Tag keeps the legacy product spelling', flattenV2Row(costRow('2026-11-02', 'claude_tag', null, '1.000000')).product === 'claude-tag'
    && flattenV2Row(costRow('2026-11-02', 'claude_code', null, '1.000000')).product === 'claude_code')
}
{
  const buckets = rowsToDailyBuckets([
    costRow('2026-11-03', 'chat', 'claude-sonnet-5-5', '50.000000'),
    costRow('2026-11-01', 'claude_code', 'claude-opus-5-5', '100.000000'),
    costRow('2026-11-01', 'chat', 'claude-sonnet-5-5', '25.000000'),
  ], '2026-11-01', '2026-11-04')
  ok('every day in the window gets a bucket (empty days zero-filled)', buckets.length === 3 && buckets[1].results.length === 0)
  ok('buckets are oldest first with [d, d+1) bounds', buckets[0].starting_at === '2026-11-01T00:00:00Z' && buckets[0].ending_at === '2026-11-02T00:00:00Z'
    && buckets[2].starting_at === '2026-11-03T00:00:00Z')
  ok('rows land in their own day in legacy result shape', buckets[0].results.length === 2 && buckets[0].results[0].amount === '100.000000'
    && buckets[2].results[0].product === 'chat')
  ok('an empty row list still yields the zero-filled window', rowsToDailyBuckets([], '2026-11-13', '2026-11-14').length === 1)
  const stray = rowsToDailyBuckets([costRow('2026-10-31', 'chat', null, '9.000000')], '2026-11-01', '2026-11-02')
  ok('a row outside the window is kept, not dropped', stray.length === 2 && stray[0].starting_at === '2026-10-31T00:00:00Z')
}
{
  // The converted body must drive the existing reshape exactly like a legacy one.
  const rows = [
    costRow('2026-11-01', 'claude_code', 'claude-opus-5-5', '10000.000000', 10),
    costRow('2026-11-02', 'chat', 'claude-sonnet-5-5', '2500.000000', 4),
  ]
  const usageRow = (day, product, model, out) => ({
    starting_at: `${day}T00:00:00Z`,
    group: { product, model },
    usage: { uncached_input_tokens: 10, cache_read_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: out, requests: 1 },
  })
  const v2 = analyticsReportsToCostResp(
    { data: rowsToDailyBuckets(rows, '2026-11-01', '2026-11-03') },
    { data: rowsToDailyBuckets([usageRow('2026-11-01', 'claude_code', 'claude-opus-5-5', 5)], '2026-11-01', '2026-11-03') },
    { starting_date: '2026-11-01', ending_date: '2026-11-02' },
  )
  const legacy = analyticsReportsToCostResp(
    { data: [
      { starting_at: '2026-11-01T00:00:00Z', results: [{ product: 'claude_code', model: 'claude-opus-5-5', amount: '10000.000000', list_amount: '10000.000000', requests: 10 }] },
      { starting_at: '2026-11-02T00:00:00Z', results: [{ product: 'chat', model: 'claude-sonnet-5-5', amount: '2500.000000', list_amount: '2500.000000', requests: 4 }] },
    ] },
    { data: [
      { starting_at: '2026-11-01T00:00:00Z', results: [{ product: 'claude_code', model: 'claude-opus-5-5', uncached_input_tokens: 10, cache_read_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: 5, requests: 1 }] },
      { starting_at: '2026-11-02T00:00:00Z', results: [] },
    ] },
    { starting_date: '2026-11-01', ending_date: '2026-11-02' },
  )
  // last_modified is a wall-clock stamp taken inside each call — not part of the comparison.
  const stable = (o) => JSON.stringify({ ...o, last_modified: null })
  ok('reshape output from converted v2 rows equals the legacy-body output', stable(v2) === stable(legacy))
}
{
  // Per-user rows: flattened v2 rows feed the existing mappers unchanged.
  const userRow = (email, model, amount) => ({
    starting_at: '2026-11-01T00:00:00Z',
    group: { actor: { type: 'user_actor', user_id: `user_${email}`, email_address: email, name: 'N', deleted: false }, model, product: null, rbac_group_id: null },
    cost: { currency: 'USD', amount, list_amount: amount, requests: 2 },
  })
  const flat = [userRow('a@x.com', 'claude-opus-5-5', '300.000000'), userRow('a@x.com', 'claude-haiku-5-5', '100.000000')].map(flattenV2Row)
  const users = userCostToUsers(flat, { by: 'model' })
  ok('grouped per-user mapper reads flattened rows', users.length === 1 && users[0].net_spend_usd === 4 && users[0].by_model.length === 2)
  const merged = mergeUserReportRows([...flat, ...flat], 'user_cost_report')
  ok('chunk merge keys flattened rows by user × dim (null dims ignored)', merged.length === 2)
}

// ── fallback switch ─────────────────────────────────────────────────────────
ok('definitive v2 rejections fall back', [400, 403, 404].every((s) => isV2FallbackError({ status: s })))
ok('transient failures do not fall back', [429, 500, 503, 0].every((s) => !isV2FallbackError({ status: s })) && !isV2FallbackError(new Error('x')))
{
  const calls = []
  const sw = makeCostApiSwitch({ mode: 'v2', log: () => {} })
  const out = await sw.run('primary', async (v2) => { calls.push(v2); return v2 ? 'new' : 'old' })
  ok('v2 mode tries the new API first and stops on success', out === 'new' && calls.join() === 'true')
}
{
  const calls = []
  const sw = makeCostApiSwitch({ mode: 'legacy', log: () => {} })
  const out = await sw.run('primary', async (v2) => { calls.push(v2); return 'old' })
  ok('legacy mode never calls the new API', out === 'old' && calls.join() === 'false' && sw.active('primary') === 'legacy')
}
{
  let t = 1000
  const calls = []
  const sw = makeCostApiSwitch({ mode: 'v2', now: () => t, cooldownMs: 500, log: () => {} })
  const attempt = async (v2) => { calls.push(v2); if (v2) { const e = new Error('cost_report 404'); e.status = 404; throw e } return 'old' }
  const out = await sw.run('primary', attempt)
  ok('a failed v2 call is retried once on legacy', out === 'old' && calls.join() === 'true,false')
  await sw.run('primary', attempt)
  ok('after a legacy-rescued failure the org stays on legacy during the cooldown', calls.join() === 'true,false,false' && sw.active('primary') === 'legacy')
  await sw.run('org2', async (v2) => { calls.push(`org2:${v2}`); return 'x' })
  ok('the cooldown is per org', calls.at(-1) === 'org2:true')
  t += 501
  ok('the cooldown expires', sw.active('primary') === 'v2')
}
{
  const sw = makeCostApiSwitch({ mode: 'v2', log: () => {} })
  let threw = null
  try {
    await sw.run('primary', async (v2) => { const e = new Error(v2 ? 'cost_report 400' : 'legacy 400'); e.status = 400; throw e })
  } catch (e) { threw = e }
  ok('when legacy fails too, the LEGACY error propagates', threw?.message === 'legacy 400')
  ok('a query both APIs reject does not start the cooldown', sw.active('primary') === 'v2')
}
{
  const sw = makeCostApiSwitch({ mode: 'v2', log: () => {} })
  const calls = []
  let threw = null
  try {
    await sw.run('primary', async (v2) => { calls.push(v2); const e = new Error('cost_report 429'); e.status = 429; throw e })
  } catch (e) { threw = e }
  ok('a 429 is not retried on legacy (same org budget)', threw?.status === 429 && calls.join() === 'true')
}
{
  // New API rejects (beta withdrawn) while legacy is only rate-limited.
  const sw = makeCostApiSwitch({ mode: 'v2', log: () => {} })
  const calls = []
  const attempt = async (v2) => { calls.push(v2); const e = new Error(v2 ? 'cost_report 404' : 'cost_report 429'); e.status = v2 ? 404 : 429; throw e }
  let threw = null
  try { await sw.run('primary', attempt) } catch (e) { threw = e }
  ok('the legacy 429 propagates', threw?.status === 429 && calls.join() === 'true,false')
  ok('…and the org still moves to legacy (legacy did not reject the query)', sw.active('primary') === 'legacy')
  try { await sw.run('primary', attempt) } catch { /* expected */ }
  ok('the next call no longer pays for both families', calls.join() === 'true,false,false')
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${n - failed}/${n}`)
process.exit(failed === 0 ? 0 : 1)
