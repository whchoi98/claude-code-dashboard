// Collector compliance archiver: bounded per-day walk (collectComplianceDay).
// node tests/server/test-collector-compliance.mjs — exit 0 on success, 1 on failure.
import {
  collectComplianceDay, COMPLIANCE_ARCHIVE_PAGE, COMPLIANCE_REDACTION_GUARD_BEFORE,
} from '../../collector/handler.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const DAY = '2026-09-25'
const ev = (id, t = `${DAY}T12:00:00Z`) => ({ id, type: 'claude_chat_viewed', created_at: t })

// Scripted upstream: returns the queued bodies in order, recording params.
function scripted(bodies) {
  const calls = []
  const fetchPage = async (params) => { calls.push(params); return bodies[calls.length - 1] }
  return { calls, fetchPage }
}

// ── happy path: two pages, documented cursor ─────────────────────────────
{
  const { calls, fetchPage } = scripted([
    { data: [ev('a1'), ev('a2')], has_more: true, last_id: 'cursor_opaque_1' },
    { data: [ev('a3')], has_more: false, last_id: 'cursor_opaque_2' },
  ])
  const r = await collectComplianceDay(DAY, fetchPage)
  ok('complete when a page answers has_more:false', r.complete === true && r.stop === 'end_of_window')
  ok('collects every event across pages', r.events.map((e) => e.id).join(',') === 'a1,a2,a3')
  ok('first page carries the bounded UTC-day window',
    calls[0]['created_at.gte'] === `${DAY}T00:00:00Z` && calls[0]['created_at.lt'] === '2026-09-26T00:00:00Z')
  ok('page size is the archive page size', calls[0].limit === COMPLIANCE_ARCHIVE_PAGE)
  ok('first page has no cursor', !('after_id' in calls[0]))
  ok('next page uses the response last_id (opaque cursor)', calls[1].after_id === 'cursor_opaque_1')
  ok('window params stay fixed across pages',
    calls[1]['created_at.gte'] === calls[0]['created_at.gte'] && calls[1].limit === calls[0].limit)
}

// ── cursor fallback when last_id is absent ───────────────────────────────
{
  const { calls, fetchPage } = scripted([
    { data: [ev('b1'), ev('b2')], has_more: true },
    { data: [], has_more: false },
  ])
  const r = await collectComplianceDay(DAY, fetchPage)
  ok('missing last_id falls back to the last event id', calls[1].after_id === 'b2')
  ok('trailing empty page with has_more:false still completes', r.complete === true && r.events.length === 2)
}

// ── incomplete outcomes never claim completeness ─────────────────────────
{
  const { fetchPage } = scripted([{ data: [], has_more: true }])
  const r = await collectComplianceDay(DAY, fetchPage)
  ok('empty page that still claims has_more is incomplete', r.complete === false && r.stop === 'empty_page')
}
{
  const { fetchPage } = scripted([
    { data: [ev('c1')], has_more: true, last_id: 'x1' },
    { data: [ev('c2')], has_more: true, last_id: 'x2' },
  ])
  const r = await collectComplianceDay(DAY, fetchPage, { pagesCap: 2 })
  ok('page cap reached → incomplete', r.complete === false && r.stop === 'pages')
}
{
  const { calls, fetchPage } = scripted([{ data: [ev('d1')], has_more: false }])
  const r = await collectComplianceDay(DAY, fetchPage, { timeLeft: () => 30_000 })
  ok('low Lambda budget → incomplete before any request', r.complete === false && r.stop === 'time' && calls.length === 0)
}
{
  const { fetchPage } = scripted([{ has_more: false }])
  let threw = false
  try { await collectComplianceDay(DAY, fetchPage) } catch { threw = true }
  ok('malformed body (no data array) throws instead of reading as an empty day', threw)
}

// ── completeness needs a SHORT page, not the has_more flag alone ───────────
{
  const { calls, fetchPage } = scripted([
    { data: [ev('f1'), ev('f2')], has_more: false, last_id: 'k1' },   // full page (pageSize 2)
    { data: [], has_more: false },
  ])
  const r = await collectComplianceDay(DAY, fetchPage, { pageSize: 2 })
  ok('a full page with has_more:false is confirmed with one more request', r.complete === true && calls.length === 2 && calls[1].after_id === 'k1')
}
{
  const { calls, fetchPage } = scripted([{ data: [ev('g1')], last_id: 'k' }, { data: [] }])
  const r = await collectComplianceDay(DAY, fetchPage, { pageSize: 2 })
  ok('missing has_more + short page → confirmed by an empty page', r.complete === true && r.events.length === 1 && calls.length === 2)
}
{
  const { calls, fetchPage } = scripted([
    { data: [ev('h1'), ev('h2')], last_id: 'k2' },   // missing has_more, full page
    { data: [ev('h3')], has_more: false },
  ])
  const r = await collectComplianceDay(DAY, fetchPage, { pageSize: 2 })
  ok('missing has_more + full page → keeps paging', calls.length === 2 && r.complete === true && r.events.length === 3)
}
{
  const { fetchPage } = scripted([{ data: [ev('i1')], has_more: true, last_id: 'k3' }, { data: [], has_more: true }])
  const r = await collectComplianceDay(DAY, fetchPage, { pageSize: 2 })
  ok('a short page that still claims has_more:true is not trusted as the end', r.complete === false && r.stop === 'empty_page')
}

{
  // Server silently caps the page below the requested size AND drops has_more.
  const { calls, fetchPage } = scripted([
    { data: [ev('j1')], last_id: 'c1' },
    { data: [ev('j2')], last_id: 'c2' },
    { data: [] },
  ])
  const r = await collectComplianceDay(DAY, fetchPage, { pageSize: 5 })
  ok('a capped page without has_more is not mistaken for the end', r.complete === true && r.events.length === 2 && calls.length === 3)
}

// ── defensive day filter ─────────────────────────────────────────────────
{
  const { fetchPage } = scripted([
    { data: [ev('e1'), ev('e2', '2026-09-24T23:59:59Z')], has_more: false },
  ])
  const r = await collectComplianceDay(DAY, fetchPage)
  ok('events outside the UTC day are not bucketed into it', r.events.length === 1 && r.events[0].id === 'e1')
}

// ── redaction guard constant ─────────────────────────────────────────────
ok('redaction guard covers every day that may still hold names (≤ 2026-09-23)', COMPLIANCE_REDACTION_GUARD_BEFORE === '2026-09-24')
ok('redaction guard never blocks a normal T-1/T-2 run from 2026-09-26 on', '2026-09-24' >= COMPLIANCE_REDACTION_GUARD_BEFORE)

console.log(`1..${n}`)
process.exit(failed ? 1 : 0)
