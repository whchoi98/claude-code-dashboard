// Route-level test for the Usage and Cost Analytics API migration (ADR-0023):
// drives the REAL /api/cost/{live,users,groups} routes against a stubbed
// upstream and checks which API family each one calls, that new-API rows
// come out in the response shapes the legacy reports produced, and the
// v2 → legacy fallback + cooldown.
// Runs with: node tests/server/test-cost-api-routes.mjs — exit 0 on success, 1 on failure.
process.env.ANTHROPIC_ANALYTICS_KEY = 'test-analytics-key'
process.env.ANTHROPIC_API_URL = 'https://upstream.test'
process.env.AWS_REGION = 'us-east-1'
for (const k of ['ANTHROPIC_ANALYTICS_KEY_2', 'CCD_COST_API', 'ARCHIVE_S3_BUCKET', 'ANTHROPIC_COMPLIANCE_KEY']) delete process.env[k]

const realFetch = globalThis.fetch
const upstream = []            // { path, params, beta }
let scenario = () => null      // (path, params) → { status, body } | null (default 200 handlers)

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const group = (over = {}) => ({ product: null, model: null, rbac_group_id: null, actor: null, cost_type: null, token_type: null, ...over })
const costRow = (day, g, amount, requests = 1) => ({
  starting_at: `${day}T00:00:00Z`, ending_at: `${day}T23:59:59Z`, group: group(g),
  cost: { currency: 'USD', amount, list_amount: amount, requests },
})
const usageRow = (day, g) => ({
  starting_at: `${day}T00:00:00Z`, group: group(g),
  usage: { uncached_input_tokens: 100, cache_read_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: 50, total_tokens: 1050, requests: 3 },
})
const actor = (email) => ({ type: 'user_actor', user_id: `user_${email}`, email_address: email, name: null, deleted: false })

// Default upstream: the new API answers, the legacy reports answer too.
function defaultUpstream(path, params) {
  const dims = params.getAll('group_by[]')
  const day = (params.get('starting_at') || '').slice(0, 10)
  if (path === '/v1/organizations/analytics/cost') {
    if (dims.includes('actor')) {
      return json(200, { data: [
        costRow(day, { actor: actor('a@x.com'), model: dims.includes('model') ? 'claude-opus-5-5' : null }, '30000.000000', 5),
        costRow(day, { actor: actor('b@x.com'), model: dims.includes('model') ? 'claude-haiku-5-5' : null }, '1000.000000', 2),
      ], has_more: false, next_page: null, data_refreshed_at: '2026-11-13T22:00:00Z' })
    }
    if (dims.includes('rbac_group_id')) {
      return json(200, { data: [costRow(day, { rbac_group_id: 'rbac_group_AAAAAA' }, '5000.000000')], has_more: false, data_refreshed_at: '2026-11-13T22:00:00Z' })
    }
    if (dims.includes('cost_type')) {
      return json(200, { data: [
        costRow(day, { cost_type: 'tokens' }, '12000.000000'),
        costRow(day, { cost_type: 'session_usage' }, '0.000000'),
      ], has_more: false, data_refreshed_at: '2026-11-13T22:00:00Z' })
    }
    if (dims.includes('token_type')) return json(200, { data: [], has_more: false })
    // product × model: one row on the first day and one on the LAST day of the window
    const end = new Date(`${(params.get('ending_at') || '').slice(0, 10)}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() - 1)
    return json(200, { data: [
      costRow(day, { product: 'claude_code', model: 'claude-opus-5-5' }, '10000.000000', 10),
      costRow(end.toISOString().slice(0, 10), { product: 'claude_tag', model: 'claude-sonnet-5-5' }, '2000.000000', 4),
    ], has_more: false, next_page: null, data_refreshed_at: '2026-11-13T22:00:00Z' })
  }
  if (path === '/v1/organizations/analytics/usage') {
    return json(200, { data: [usageRow(day, { product: 'claude_code', model: 'claude-opus-5-5' })], has_more: false, data_refreshed_at: '2026-11-13T22:00:00Z' })
  }
  if (path === '/v1/organizations/analytics/cost_report') {
    return json(200, { data: [{ starting_at: `${day}T00:00:00Z`, results: [{ product: 'claude_code', model: 'claude-opus-5-5', amount: '777.000000', list_amount: '777.000000', requests: 1 }] }], has_more: false, data_refreshed_at: '2026-11-13T21:00:00Z' })
  }
  if (path === '/v1/organizations/analytics/usage_report') return json(200, { data: [], has_more: false })
  if (path === '/v1/compliance/groups') return json(200, { data: [{ id: 'rbac_group_AAAAAA', name: 'Engineering' }], has_more: false, next_page: null })
  return json(404, { error: { message: `unstubbed ${path}` } })
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname !== 'upstream.test') return realFetch(url, init)
  const beta = init.headers?.['anthropic-beta'] || null
  upstream.push({ path: u.pathname, params: u.searchParams, beta })
  const forced = scenario(u.pathname, u.searchParams)
  return forced ? json(forced.status, forced.body) : defaultUpstream(u.pathname, u.searchParams)
}

const { default: express } = await import('express')
const { registerAwsRoutes } = await import('../../server/aws.js')
const app = express()
registerAwsRoutes(app, { fetchAnalytics: async () => ({}) })
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const get = async (path) => { const r = await realFetch(base + path); return { status: r.status, body: await r.json() } }

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const paths = () => upstream.map((c) => c.path.replace('/v1/organizations/analytics/', ''))
const reset = () => { upstream.length = 0 }

try {
  // ── /cost/live on the new API ──────────────────────────────────────────────
  {
    const r = await get('/api/cost/live?starting_date=2026-11-01&ending_date=2026-11-03')
    ok('/cost/live answers 200 from the new API', r.status === 200 && r.body.cost_api === 'v2')
    ok('only the new endpoints are called', paths().every((p) => p === 'cost' || p === 'usage') && paths().includes('usage'))
    ok('every new-API call carries the beta header', upstream.every((c) => c.beta === 'analytics-usage-cost-2026-08-24'))
    const main = upstream.find((c) => c.path.endsWith('/cost') && c.params.getAll('group_by[]').join() === 'product,model')
    ok('the daily query uses time_bucket_width + an exclusive end', main?.params.get('time_bucket_width') === '1d'
      && main.params.get('starting_at') === '2026-11-01T00:00:00Z' && main.params.get('ending_at') === '2026-11-04T00:00:00Z')
    const days = [...new Set((r.body.daily || []).map((d) => d.date))].sort()
    ok('spend rows land on their own days', days.includes('2026-11-01') && days.includes('2026-11-03'))
    const total = (r.body.rows || []).reduce((s, x) => s + x.total_net_spend_usd, 0)
    ok('cents convert to USD and sum across rows', Math.abs(total - 120) < 1e-6)
    ok('Claude Tag keeps the legacy product id', (r.body.rows || []).some((x) => x.product === 'claude-tag') && !(r.body.rows || []).some((x) => x.product === 'claude_tag'))
    ok('usage tokens join onto the cost rows', (r.body.rows || []).find((x) => x.product === 'claude_code')?.total_completion_tokens === 50)
    ok('a $0 session_usage cost type is hidden', JSON.stringify(r.body.by_cost_type) === JSON.stringify([{ cost_type: 'tokens', spend_usd: 120 }]))
    ok('data_refreshed_at passes through', r.body.data_refreshed_at === '2026-11-13T22:00:00Z')
  }

  // ── /cost/users on the new API ─────────────────────────────────────────────
  reset()
  {
    const r = await get('/api/cost/users?starting_date=2026-11-01&ending_date=2026-11-03&by=model')
    const c = upstream[0]
    ok('/cost/users reads /analytics/cost grouped by actor × model', r.status === 200 && upstream.length === 1 && c.path.endsWith('/analytics/cost')
      && c.params.getAll('group_by[]').join() === 'actor,model' && c.params.get('actor_types[]') === 'user_actor' && c.beta)
    ok('per-user rows map to the same shape as before', r.body.users?.length === 2 && r.body.users[0].email === 'a@x.com'
      && r.body.users[0].net_spend_usd === 300 && r.body.users[0].by_model?.[0]?.model === 'claude-opus-5-5')
  }
  reset()
  {
    const r = await get('/api/cost/user-tokens?starting_date=2026-11-01&ending_date=2026-11-03')
    ok('/cost/user-tokens reads /analytics/usage grouped by actor', r.status === 200 && upstream.length === 1
      && upstream[0].path.endsWith('/analytics/usage') && upstream[0].params.getAll('group_by[]').join() === 'actor')
  }

  // ── /cost/groups on the new API ────────────────────────────────────────────
  reset()
  {
    const r = await get('/api/cost/groups?starting_date=2026-11-01&ending_date=2026-11-03')
    const c = upstream.find((x) => x.path.endsWith('/analytics/cost'))
    ok('/cost/groups reads /analytics/cost grouped by rbac_group_id', r.status === 200 && c?.params.getAll('group_by[]').join() === 'rbac_group_id' && !paths().includes('cost_report'))
    ok('group spend aggregates with the real group name', r.body.groups?.[0]?.label === 'Engineering' && r.body.groups[0].spend_usd === 50)
  }

  // ── paging on the new API (limit counts rows; ?page=<next_page>) ───────────
  reset()
  scenario = (path, params) => {
    if (!path.endsWith('/analytics/cost') || params.getAll('group_by[]').join() !== 'product,model') return null
    const day = params.get('starting_at').slice(0, 10)
    return params.get('page')
      ? { status: 200, body: { data: [costRow(day, { product: 'chat', model: 'claude-sonnet-5-5' }, '300.000000')], has_more: false, next_page: null } }
      : { status: 200, body: { data: [costRow(day, { product: 'claude_code', model: 'claude-opus-5-5' }, '700.000000')], has_more: true, next_page: 'page_2' } }
  }
  {
    const r = await get('/api/cost/live?starting_date=2026-09-01&ending_date=2026-09-02')
    const total = (r.body.rows || []).reduce((s, x) => s + x.total_net_spend_usd, 0)
    ok('a second page is fetched with ?page= and both pages count', r.status === 200 && Math.abs(total - 10) < 1e-6
      && upstream.some((c) => c.path.endsWith('/analytics/cost') && c.params.get('page') === 'page_2'))
  }

  // ── a >31-day window: two chunks, each on the new API ──────────────────────
  reset()
  scenario = () => null
  {
    const r = await get('/api/cost/live?starting_date=2026-08-01&ending_date=2026-09-09')
    const main = upstream.filter((c) => c.path.endsWith('/analytics/cost') && c.params.getAll('group_by[]').join() === 'product,model')
    const spans = main.map((c) => (Date.parse(c.params.get('ending_at')) - Date.parse(c.params.get('starting_at'))) / 86_400_000).sort((a, b) => a - b)
    ok('a 40-day window is split into two chunks of at most 31 days', main.length === 2 && spans.join() === '9,31')
    ok('the chunks abut: the first ends where the second starts', main.map((c) => c.params.get('starting_at')).sort().join() === '2026-08-01T00:00:00Z,2026-09-01T00:00:00Z')
    const total = (r.body.rows || []).reduce((s, x) => s + x.total_net_spend_usd, 0)
    ok('rows from both chunks are summed once', r.body.cost_api === 'v2' && Math.abs(total - 240) < 1e-6)
    ok('multi-chunk windows skip the best-effort rollups', !upstream.some((c) => ['cost_type', 'token_type'].includes(c.params.get('group_by[]'))))
  }

  // ── a failed primary report stops before the rollups ───────────────────────
  reset()
  scenario = (path) => (path.endsWith('/analytics/usage') ? { status: 503, body: { error: { type: 'overloaded_error' } } } : null)
  {
    const r = await get('/api/cost/live?starting_date=2026-09-20&ending_date=2026-09-21')
    ok('a 5xx on a primary report is not retried on legacy and fetches no rollups', r.status === 502
      && !paths().some((p) => p.endsWith('_report')) && !upstream.some((c) => ['cost_type', 'token_type'].includes(c.params.get('group_by[]'))))
  }

  // ── transient failure: no legacy retry ─────────────────────────────────────
  reset()
  scenario = (path) => (path.endsWith('/analytics/cost') || path.endsWith('/analytics/usage') ? { status: 429, body: { error: { type: 'rate_limit_error' } } } : null)
  {
    const r = await get('/api/cost/live?starting_date=2026-10-01&ending_date=2026-10-02')
    ok('a 429 from the new API surfaces as before (502), without a legacy call', r.status === 502 && !paths().includes('cost_report') && !paths().includes('usage_report'))
  }

  // ── definitive rejection: legacy fallback + cooldown ───────────────────────
  reset()
  scenario = (path) => (path.endsWith('/analytics/cost') || path.endsWith('/analytics/usage') ? { status: 404, body: { error: { type: 'not_found_error' } } } : null)
  {
    const r = await get('/api/cost/live?starting_date=2026-10-05&ending_date=2026-10-06')
    ok('a 404 from the new API falls back to the legacy reports', r.status === 200 && r.body.cost_api === 'legacy'
      && paths().includes('cost_report') && paths().includes('usage_report'))
    ok('the legacy body is served as-is', (r.body.rows || []).some((x) => Math.abs(x.total_net_spend_usd - 7.77) < 1e-6))
    ok('legacy calls carry no beta header', upstream.filter((c) => c.path.endsWith('_report')).every((c) => !c.beta))
  }
  reset()
  scenario = () => null   // the new API is healthy again, but the org is in its cooldown
  {
    const r = await get('/api/cost/live?starting_date=2026-10-10&ending_date=2026-10-11')
    ok('during the cooldown the org goes straight to legacy', r.status === 200 && r.body.cost_api === 'legacy' && paths().every((p) => p.endsWith('_report')))
    reset()
    await get('/api/cost/users?starting_date=2026-10-10&ending_date=2026-10-11')
    ok('the cooldown covers the per-user reports too', paths().length === 1 && paths()[0] === 'user_cost_report')
  }
} catch (err) {
  ok(`unexpected error: ${err?.stack || err}`, false)
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${n - failed}/${n}`)
server.close()
process.exit(failed === 0 ? 0 : 1)
