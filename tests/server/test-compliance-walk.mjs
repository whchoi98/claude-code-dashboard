// Standalone ESM tests for the Compliance activities walk helpers
// (server/compliance.js). Runs with: node tests/server/test-compliance-walk.mjs
// — exit 0 on success, 1 on failure.
import { AUDIT_UPSTREAM_PAGE, activitiesWindowParams, nextActivitiesCursor } from '../../server/compliance.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const TODAY = '2026-09-26'

// ── activitiesWindowParams ──────────────────────────────────────────────────
ok('today-ending window stays unfiltered (preset walks share one page chain)',
  same(activitiesWindowParams('2026-09-20', TODAY, TODAY), {}))
ok('window ending after today (clock skew) stays unfiltered',
  same(activitiesWindowParams('2026-09-20', '2026-09-27', TODAY), {}))
ok('no ending date → unfiltered', same(activitiesWindowParams('2026-09-20', undefined, TODAY), {}))
ok('past window → created_at range, upper bound exclusive at next midnight',
  same(activitiesWindowParams('2026-08-01', '2026-08-07', TODAY), {
    'created_at.gte': '2026-08-01T00:00:00Z',
    'created_at.lt': '2026-08-08T00:00:00Z',
  }))
ok('past window across a month boundary', activitiesWindowParams('2026-08-25', '2026-08-31', TODAY)['created_at.lt'] === '2026-09-01T00:00:00Z')
ok('yesterday-ending window is a past window', activitiesWindowParams('2026-09-25', '2026-09-25', TODAY)['created_at.gte'] === '2026-09-25T00:00:00Z')
ok('past window without a start → upper bound only',
  same(activitiesWindowParams(undefined, '2026-09-01', TODAY), { 'created_at.lt': '2026-09-02T00:00:00Z' }))

ok('malformed ending date → unfiltered, never throws', same(activitiesWindowParams('2026-08-01', '2026-08-07T00:00:00Z', TODAY), {}))
ok('array ending date → unfiltered', same(activitiesWindowParams('2026-08-01', ['2026-08-07', 'x'], TODAY), {}))
ok('impossible calendar day → unfiltered', same(activitiesWindowParams('2026-02-01', '2026-02-31', TODAY), {}))
ok('malformed start is dropped, valid past end kept',
  same(activitiesWindowParams('08-01', '2026-08-07', TODAY), { 'created_at.lt': '2026-08-08T00:00:00Z' }))

// ── nextActivitiesCursor ────────────────────────────────────────────────────
const page = [{ id: 'activity_new' }, { id: 'activity_old' }]
ok('documented last_id wins over the last event id', nextActivitiesCursor({ last_id: 'opaque_cursor_1' }, page) === 'opaque_cursor_1')
ok('missing last_id falls back to the last event id', nextActivitiesCursor({}, page) === 'activity_old')
ok('null last_id falls back', nextActivitiesCursor({ last_id: null }, page) === 'activity_old')
ok('empty page + no last_id → undefined', nextActivitiesCursor({}, []) === undefined)

// ── page size ───────────────────────────────────────────────────────────────
ok('upstream page stays within the documented max (5000)', AUDIT_UPSTREAM_PAGE >= 100 && AUDIT_UPSTREAM_PAGE <= 5000)
ok('2000-event preset walk needs at most 2 upstream requests', Math.ceil(2000 / AUDIT_UPSTREAM_PAGE) <= 2)

console.log(failed === 0 ? `\n# all ${n} tests passed` : `\n# ${failed}/${n} tests FAILED`)
process.exit(failed === 0 ? 0 : 1)
