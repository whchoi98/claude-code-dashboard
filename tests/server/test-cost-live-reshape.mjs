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
