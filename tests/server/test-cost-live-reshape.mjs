// Standalone ESM test for analyticsReportsToCostResp.
// Runs with: node tests/server/test-cost-live-reshape.mjs
// Exit code 0 on success, 1 on any failure (TAP-like output).

import { analyticsReportsToCostResp, aggregateCostType } from '../../server/aws.js'

const period = { starting_date: '2026-05-01', ending_date: '2026-05-02' }

const COST = {
  data: [
    {
      starting_at: '2026-05-01T00:00:00Z',
      ending_at:   '2026-05-02T00:00:00Z',
      results: [
        { product: 'claude_code', model: 'claude-opus-4-7',   amount: '1234.50', list_amount: '1234.50', currency: 'USD', requests: 12 },
        { product: 'claude_code', model: 'claude-sonnet-4-6', amount:   '56.00', list_amount:   '56.00', currency: 'USD', requests:  5 },
        // ungrouped totals row — must be skipped to avoid double-count
        { product: null, model: null, amount: '1290.50', currency: 'USD', requests: 17 },
      ],
    },
    {
      starting_at: '2026-05-02T00:00:00Z',
      ending_at:   '2026-05-03T00:00:00Z',
      results: [
        { product: 'claude_code', model: 'claude-opus-4-7', amount: '800.00', currency: 'USD', requests: 8 },
        // a row only present in cost_report (no usage match) — should still appear with 0 tokens
        { product: 'claude_chat', model: 'claude-haiku-4-5', amount: '10.00', currency: 'USD', requests: 2 },
      ],
    },
  ],
}

const USAGE = {
  data: [
    {
      starting_at: '2026-05-01T00:00:00Z',
      results: [
        { product: 'claude_code', model: 'claude-opus-4-7',   uncached_input_tokens: 1000, cache_read_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 }, output_tokens: 500 },
        { product: 'claude_code', model: 'claude-sonnet-4-6', uncached_input_tokens: 200, output_tokens: 80 },
        // ungrouped totals — must be skipped
        { product: null, model: null, uncached_input_tokens: 9999, output_tokens: 9999 },
      ],
    },
    {
      starting_at: '2026-05-02T00:00:00Z',
      results: [
        { product: 'claude_code', model: 'claude-opus-4-7', uncached_input_tokens: 500, output_tokens: 200 },
      ],
    },
  ],
}

const cases = [
  ['shape: source=live + period passthrough + file=null', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    if (r.source !== 'live') throw new Error(`source: ${r.source}`)
    if (r.period.starting_date !== '2026-05-01') throw new Error(`period.start: ${r.period.starting_date}`)
    if (r.period.ending_date !== '2026-05-02') throw new Error(`period.end: ${r.period.ending_date}`)
    if (r.file !== null) throw new Error(`file: ${r.file}`)
  }],
  ['aggregateCostType: sums per cost_type, sorts desc, skips null, cents→USD', () => {
    const body = { data: [
      { results: [
        { cost_type: 'tokens', amount: '500000' },        // $5000
        { cost_type: 'web_search', amount: '153' },        // $1.53
        { cost_type: null, amount: '999999' },             // ungrouped total — skip
      ] },
      { results: [
        { cost_type: 'tokens', amount: '313924' },         // +$3139.24 → $8139.24
        { cost_type: 'code_execution', amount: '0' },
      ] },
    ] }
    const r = aggregateCostType(body)
    if (r.length !== 3) throw new Error(`len: ${r.length} (null cost_type must be skipped)`)
    if (r[0].cost_type !== 'tokens') throw new Error(`not sorted desc: ${r[0].cost_type}`)
    if (Math.abs(r[0].spend_usd - 8139.24) > 1e-6) throw new Error(`tokens: ${r[0].spend_usd}`)
    if (Math.abs(r[1].spend_usd - 1.53) > 1e-6) throw new Error(`web_search: ${r[1].spend_usd}`)
    if (aggregateCostType({}).length !== 0) throw new Error('empty body should be []')
    if (aggregateCostType(null).length !== 0) throw new Error('null body should be []')
  }],
  ['data_refreshed_at: passes through cost_report value, null when absent', () => {
    const absent = analyticsReportsToCostResp(COST, USAGE, period)
    if (absent.data_refreshed_at !== null) throw new Error(`absent should be null, got: ${absent.data_refreshed_at}`)
    const present = analyticsReportsToCostResp({ ...COST, data_refreshed_at: '2026-06-07T07:56:43Z' }, USAGE, period)
    if (present.data_refreshed_at !== '2026-06-07T07:56:43Z') throw new Error(`passthrough failed: ${present.data_refreshed_at}`)
  }],
  ['rows: 3 (product,model) tuples — opus, sonnet, haiku', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    if (r.rows.length !== 3) throw new Error(`rows.length: ${r.rows.length}`)
    const opus = r.rows.find((x) => x.product === 'claude_code' && x.model === 'claude-opus-4-7')
    if (!opus) throw new Error('no opus row')
    if (opus.user_email !== '') throw new Error(`opus user_email: "${opus.user_email}" (must be empty in live mode)`)
    // spend: (1234.50 + 800.00) cents / 100 = 20.345 USD
    if (Math.abs(opus.total_net_spend_usd - 20.345) > 1e-6) throw new Error(`opus spend: ${opus.total_net_spend_usd}`)
    if (opus.total_gross_spend_usd !== opus.total_net_spend_usd) throw new Error('gross != net')
    // requests across both days: 12 + 8 = 20
    if (opus.total_requests !== 20) throw new Error(`opus requests: ${opus.total_requests}`)
    // tokens: input = (1000 + 100 + 50 + 0) day1 + 500 day2 = 1650
    if (opus.total_prompt_tokens !== 1650) throw new Error(`opus prompt: ${opus.total_prompt_tokens}`)
    // output = 500 + 200 = 700
    if (opus.total_completion_tokens !== 700) throw new Error(`opus completion: ${opus.total_completion_tokens}`)
  }],
  ['cost-only row (no matching usage) appears with 0 tokens', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    const haiku = r.rows.find((x) => x.model === 'claude-haiku-4-5')
    if (!haiku) throw new Error('no haiku row')
    if (Math.abs(haiku.total_net_spend_usd - 0.10) > 1e-6) throw new Error(`haiku spend: ${haiku.total_net_spend_usd}`)
    if (haiku.total_requests !== 2) throw new Error(`haiku requests: ${haiku.total_requests}`)
    if (haiku.total_prompt_tokens !== 0) throw new Error(`haiku prompt: ${haiku.total_prompt_tokens}`)
    if (haiku.total_completion_tokens !== 0) throw new Error(`haiku completion: ${haiku.total_completion_tokens}`)
  }],
  ['ungrouped (null product, null model) results are skipped (no double-count)', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    // Total spend: opus 20.345 + sonnet 0.56 + haiku 0.10 = 21.005, then rounded
    // to 2 decimals via toFixed(2) — JS may produce 21.00 or 21.01 at the half-way
    // boundary depending on IEEE 754 representation, so use tolerance > 0.005.
    if (Math.abs(r.totals.net_spend_usd - 21.005) > 0.011) throw new Error(`totals net: ${r.totals.net_spend_usd}`)
    // The ungrouped row's amount (1290.50 cents = $12.905) MUST NOT be added —
    // if it were, totals would be ~33.91 (21.005 + 12.905). Sanity check.
    if (r.totals.net_spend_usd > 25) throw new Error(`net total too high (ungrouped row leaked?): ${r.totals.net_spend_usd}`)
    // Total requests: 12+5+8+2 = 27 (NOT 27+17 — ungrouped row excluded)
    if (r.totals.requests !== 27) throw new Error(`totals requests: ${r.totals.requests}`)
  }],
  ['daily series: 4 (date, model) entries, sorted by date then model', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    if (!Array.isArray(r.daily)) throw new Error('daily not array')
    // d1: opus + sonnet, d2: opus + haiku → 4 total
    if (r.daily.length !== 4) throw new Error(`daily.length: ${r.daily.length}`)
    if (r.daily[0].date !== '2026-05-01') throw new Error(`daily[0].date: ${r.daily[0].date}`)
    if (r.daily[0].model !== 'claude-opus-4-7') throw new Error(`daily[0].model: ${r.daily[0].model}`)
    // Day 1 opus: spend 12.345, requests 12, input 1150, output 500
    if (Math.abs(r.daily[0].spend - 12.345) > 1e-6) throw new Error(`d1 opus spend: ${r.daily[0].spend}`)
    if (r.daily[0].input !== 1150) throw new Error(`d1 opus input: ${r.daily[0].input}`)
    if (r.daily[0].output !== 500) throw new Error(`d1 opus output: ${r.daily[0].output}`)
    if (r.daily[0].requests !== 12) throw new Error(`d1 opus requests: ${r.daily[0].requests}`)
  }],
  ['totals: distinct_models=3, distinct_products=2, distinct_users=0', () => {
    const r = analyticsReportsToCostResp(COST, USAGE, period)
    if (r.totals.distinct_models !== 3) throw new Error(`models: ${r.totals.distinct_models}`)
    if (r.totals.distinct_products !== 2) throw new Error(`products: ${r.totals.distinct_products}`)
    if (r.totals.distinct_users !== 0) throw new Error(`users (always 0 for live): ${r.totals.distinct_users}`)
    // prompt = 1650 (opus) + 200 (sonnet) + 0 (haiku) = 1850
    if (r.totals.prompt_tokens !== 1850) throw new Error(`prompt total: ${r.totals.prompt_tokens}`)
    // completion = 700 + 80 + 0 = 780
    if (r.totals.completion_tokens !== 780) throw new Error(`completion total: ${r.totals.completion_tokens}`)
  }],
  ['empty inputs → empty rows + zero totals + source=live', () => {
    const r = analyticsReportsToCostResp({ data: [] }, { data: [] }, period)
    if (r.source !== 'live') throw new Error(`source: ${r.source}`)
    if (r.rows.length !== 0) throw new Error(`rows: ${r.rows.length}`)
    if (r.totals.net_spend_usd !== 0) throw new Error(`net: ${r.totals.net_spend_usd}`)
    if (r.totals.distinct_models !== 0) throw new Error(`models: ${r.totals.distinct_models}`)
    if (r.daily.length !== 0) throw new Error(`daily: ${r.daily.length}`)
  }],
  ['amount as decimal string with high precision parses correctly', () => {
    const r = analyticsReportsToCostResp({
      data: [{
        starting_at: '2026-05-01T00:00:00Z',
        results: [{ product: 'p', model: 'm', amount: '44934.093750', requests: 100 }],
      }],
    }, { data: [] }, period)
    // 44934.093750 cents / 100 = 449.34093750 USD → toFixed(4) = 449.3409
    if (Math.abs(r.rows[0].total_net_spend_usd - 449.3409) > 1e-6) throw new Error(`spend: ${r.rows[0].total_net_spend_usd}`)
    // totals rounds to 2 decimals: 449.34
    if (Math.abs(r.totals.net_spend_usd - 449.34) > 1e-6) throw new Error(`total: ${r.totals.net_spend_usd}`)
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
