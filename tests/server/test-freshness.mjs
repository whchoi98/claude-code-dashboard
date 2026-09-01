// Standalone ESM tests for the dynamic engagement-freshness tracker
// (server/freshness.js). Runs with: node tests/server/test-freshness.mjs —
// exit 0 on success, 1 on failure.
import {
  parseLatestAvailable,
  recordEngagementLatest,
  engagementMaxDay,
  engagementBufferDays,
  keyTag,
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

console.log(failed === 0 ? `\n# all ${n} tests passed` : `\n# ${failed}/${n} tests FAILED`)
process.exit(failed === 0 ? 0 : 1)
