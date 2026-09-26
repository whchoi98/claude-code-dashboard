// Standalone ESM tests for the dynamic engagement-freshness tracker
// (server/freshness.js). Runs with: node tests/server/test-freshness.mjs —
// exit 0 on success, 1 on failure.
import {
  parseLatestAvailable,
  recordEngagementLatest,
  engagementMaxDay,
  engagementBufferDays,
  keyTag,
  summariesUpstreamParams,
  summariesRetryParams,
  summariesShortfallParams,
  isCalendarDay,
  _resetFreshness,
} from '../../server/freshness.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const TODAY = '2026-09-01'
const KEY = 'sk-ant-api01-xxxxxxxxxxxxxxxxABCD1234'

// ── parseLatestAvailable ─────────────────────────────────────────────────────
// Exact upstream message shape (probed live 2026-09-01).
ok('parses the live 400 message',
  parseLatestAvailable('Latest available data for this query is 2026-08-30.') === '2026-08-30')
ok('case-insensitive', parseLatestAvailable('latest available data for this query is 2026-08-30') === '2026-08-30')
ok('null on unrelated message', parseLatestAvailable('starting_at must be before ending_at') === null)
ok('null on empty/undefined', parseLatestAvailable(undefined) === null && parseLatestAvailable('') === null)
ok('null when no date follows', parseLatestAvailable('Latest available data for this query is tomorrow') === null)

// ── record + max day ─────────────────────────────────────────────────────────
_resetFreshness()
ok('fallback is today−3 before anything is learned',
  engagementMaxDay(KEY, TODAY) === '2026-08-29')
ok('fallback bufferDays is 3', engagementBufferDays(KEY, TODAY) === 3)

ok('records a valid served day', recordEngagementLatest(KEY, '2026-08-30', TODAY) === true)
ok('learned day wins over fallback', engagementMaxDay(KEY, TODAY) === '2026-08-30')
ok('bufferDays follows the learned day', engagementBufferDays(KEY, TODAY) === 2)

ok('records today−1 (probe 200 ceiling)', recordEngagementLatest(KEY, '2026-08-31', TODAY) === true)
ok('max day advances', engagementMaxDay(KEY, TODAY) === '2026-08-31')

// ── validation guards ────────────────────────────────────────────────────────
ok('rejects a future day', recordEngagementLatest(KEY, '2026-09-02', TODAY) === false)
ok('rejects a day beyond the sanity lag', recordEngagementLatest(KEY, '2026-08-20', TODAY) === false)
ok('rejects non-ISO garbage', recordEngagementLatest(KEY, '08/30/2026', TODAY) === false)
ok('guarded records leave the learned value intact', engagementMaxDay(KEY, TODAY) === '2026-08-31')

// A learned value that ages past the sanity window (probe dead for days)
// falls back instead of dragging every window into the past.
ok('stale learned value falls back to today−3',
  engagementMaxDay(KEY, '2026-09-10') === '2026-09-07')

// ── per-key isolation ────────────────────────────────────────────────────────
_resetFreshness()
const KEY2 = 'sk-ant-api01-yyyyyyyyyyyyyyyyWXYZ9876'
recordEngagementLatest(KEY, '2026-08-30', TODAY)
ok('other keys keep the fallback', engagementMaxDay(KEY2, TODAY) === '2026-08-29')
ok('keyless (mock dev) keeps the fallback', engagementMaxDay(undefined, TODAY) === '2026-08-29')
ok('keyTag is the last 8 chars', keyTag(KEY) === 'ABCD1234')
ok('keyTag handles missing keys', keyTag(undefined) === 'nokey' && keyTag('') === 'nokey')

// Month/UTC boundary: learned yesterday, calendar moved on — still honored
// while inside the sanity window.
_resetFreshness()
recordEngagementLatest(KEY, '2026-08-30', '2026-08-31')
ok('yesterday-learned value still serves today', engagementMaxDay(KEY, '2026-09-01') === '2026-08-30')

// ── summariesUpstreamParams (ending_date is EXCLUSIVE upstream) ───────────────
{
  const H = '2026-09-24' // learned horizon (newest served day, inclusive)
  const win = summariesUpstreamParams('2026-09-20', '2026-09-26', H)
  ok('horizon-reaching window omits ending_date (upstream default = latest + 1)',
    JSON.stringify(win.params) === JSON.stringify({ starting_date: '2026-09-20' }))
  ok('horizon-reaching window trims rows to the requested inclusive end', win.firstDay === '2026-09-20' && win.lastDay === '2026-09-26')
  const past = summariesUpstreamParams('2026-09-01', '2026-09-07', H)
  ok('historical window sends end + 1 (exclusive)',
    past.params.starting_date === '2026-09-01' && past.params.ending_date === '2026-09-08' && past.lastDay === '2026-09-07')
  const oneDay = summariesUpstreamParams('2026-09-23', '2026-09-23', H)
  ok("'1d' preset (start = end) is a one-day request, not zero-width",
    oneDay.params.starting_date === '2026-09-23' && oneDay.params.ending_date === '2026-09-24')
  const atH = summariesUpstreamParams('2026-09-24', '2026-09-24', H)
  ok('end exactly at the horizon includes the horizon day', !('ending_date' in atH.params) && atH.lastDay === '2026-09-24')
  const inverted = summariesUpstreamParams('2026-09-30', '2026-09-26', H)
  ok('start past the clamped end pins to the end', inverted.params.starting_date === H && inverted.firstDay === H)
  const noEnd = summariesUpstreamParams('2026-09-20', undefined, H)
  ok('no ending_date → horizon form, no upper filter', !('ending_date' in noEnd.params) && noEnd.lastDay === null && noEnd.endInclusive === H)
  const fallback = summariesUpstreamParams('2026-09-20', '2026-09-24', '2026-09-23')
  ok('conservative fallback horizon still lets the newer requested day through', !('ending_date' in fallback.params) && fallback.lastDay === '2026-09-24')
  // Malformed query days must never reach Date math (a RangeError in the async
  // route would be an unhandled rejection that exits the process).
  let threw = false
  for (const bad of ['2026-09-05T00:00:00Z', '2026-09-1', '0', ['2026-09-01', 'x'], '2026-02-31', '', null]) {
    try {
      const r = summariesUpstreamParams('2026-09-01', bad, H)
      if ('ending_date' in r.params) threw = true   // a bad end must fall back to the horizon form
    } catch { threw = true }
  }
  ok('malformed ending dates → horizon form, never throw', !threw)
  const badStart = summariesUpstreamParams(['a', 'b'], '2026-09-07', H)
  ok('malformed starting date → one-day window at the requested end', badStart.params.starting_date === '2026-09-07' && badStart.params.ending_date === '2026-09-08')
  ok('isCalendarDay rejects impossible days', isCalendarDay('2026-09-24') && !isCalendarDay('2026-02-31') && !isCalendarDay('2026-9-1') && !isCalendarDay(['2026-09-24']))
  // 400 retry for the horizon form
  ok('retry asks explicitly for [start, latest + 1)',
    JSON.stringify(summariesRetryParams({ starting_date: '2026-09-20' }, '2026-09-23')) === JSON.stringify({ starting_date: '2026-09-20', ending_date: '2026-09-24' }))
  ok('retry pins a start past the latest day', summariesRetryParams({ starting_date: '2026-09-25' }, '2026-09-23').starting_date === '2026-09-23')
  ok('no retry for an explicit-end request', summariesRetryParams({ starting_date: '2026-09-01', ending_date: '2026-09-08' }, '2026-09-23') === null)
  ok('no retry without a parsable latest day', summariesRetryParams({ starting_date: '2026-09-20' }, null) === null)
  // Shortfall self-check for the horizon form
  const row = (d) => ({ starting_at: `${d}T00:00:00Z` })
  const hp = { starting_date: '2026-09-18' }
  ok('newest day at the requested end → no re-request', summariesShortfallParams(hp, [row('2026-09-18'), row('2026-09-24')], '2026-09-24') === null)
  ok('one-day shortfall is normal lag → no re-request', summariesShortfallParams(hp, [row('2026-09-23')], '2026-09-24') === null)
  ok('2+ days short → explicit [start, end + 1)',
    JSON.stringify(summariesShortfallParams(hp, [row('2026-09-18')], '2026-09-24')) === JSON.stringify({ starting_date: '2026-09-18', ending_date: '2026-09-25' }))
  ok('empty horizon answer → explicit re-request', summariesShortfallParams(hp, [], '2026-09-24')?.ending_date === '2026-09-25')
  ok('explicit requests are never second-guessed', summariesShortfallParams({ starting_date: '2026-09-18', ending_date: '2026-09-20' }, [], '2026-09-19') === null)
}

console.log(failed === 0 ? `\n# all ${n} tests passed` : `\n# ${failed}/${n} tests FAILED`)
process.exit(failed === 0 ? 0 : 1)
