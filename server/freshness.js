// Dynamic engagement-freshness tracker.
//
// The Analytics *engagement* family (users, summaries, skills, connectors,
// projects, plugins) rejects dates newer than its finalization horizon with
// HTTP 400 naming the newest served day ("Latest available data for this
// query is YYYY-MM-DD"). That horizon used to be a fixed 3 days; since
// 2026-08 it is typically 2 days (docs: a day aggregates at 10:00 UTC the
// following day) and Anthropic documents it as variable — clients are told
// to parse the 400 rather than hardcode a lag. This module records the
// newest served day per API key, learned from the hourly probe in index.js
// and opportunistically from any 400 that names a day, so
// clampAnalyticsEnd() tracks the real horizon instead of a conservative
// constant.
//
// Standalone on purpose: no imports from index.js (which boots the server),
// so tests can import it directly like the other pure server modules.

const FALLBACK_BUFFER_DAYS = 3

// A learned day lagging more than this behind today is treated as an
// upstream pipeline anomaly (docs: gaps well past the typical lag indicate a
// pipeline failure). Clamping to it would silently shrink every window, so
// engagementMaxDay() falls back to the static buffer and lets the per-day
// routes surface upstream errors instead.
const MAX_LEARNED_LAG_DAYS = 7

const learned = new Map() // key tag → 'YYYY-MM-DD' newest served engagement day

// Same last-8 tag the fetchJson page cache uses — enough to keep orgs (and
// the Admin key) apart without holding whole secrets in more places.
export function keyTag(key) {
  return typeof key === 'string' && key ? key.slice(-8) : 'nokey'
}

const isIsoDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// "Latest available data for this query is 2026-08-30." → '2026-08-30'
export function parseLatestAvailable(message) {
  const m = /latest available data[^0-9]*(\d{4}-\d{2}-\d{2})/i.exec(String(message ?? ''))
  return m ? m[1] : null
}

// Record a served-day observation. Rejects garbage (future days, non-ISO
// strings, days beyond the sanity lag) so a mangled upstream message can
// never drag the clamp around.
export function recordEngagementLatest(key, date, today) {
  if (!isIsoDay(date) || !isIsoDay(today)) return false
  if (date > today || date < addDays(today, -MAX_LEARNED_LAG_DAYS)) return false
  learned.set(keyTag(key), date)
  return true
}

// Newest engagement day worth requesting for this key. Falls back to the
// static today−3 until something is learned; a learned value that has aged
// past the sanity window (probe dead for days) also falls back.
export function engagementMaxDay(key, today) {
  const hit = learned.get(keyTag(key))
  if (hit && hit <= today && hit >= addDays(today, -MAX_LEARNED_LAG_DAYS)) return hit
  return addDays(today, -FALLBACK_BUFFER_DAYS)
}

// today − engagementMaxDay in whole days (what /api/health reports as
// `bufferDays`).
export function engagementBufferDays(key, today) {
  const max = engagementMaxDay(key, today)
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${max}T00:00:00Z`)) / 86400000)
}

// Strict YYYY-MM-DD naming a real calendar day ('2026-02-31' is not one).
// Query values can be arrays or arbitrary strings; anything else is ignored.
export function isCalendarDay(s) {
  if (!isIsoDay(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Upstream params for /analytics/summaries, whose `ending_date` is EXCLUSIVE
// (docs: "from starting_date (inclusive) to ending_date (exclusive)"; observed
// in the collector's raw sidecar: a [start, today−2) request returns rows
// through today−3). rawStart/rawEnd are the dashboard's INCLUSIVE days; maxDay
// is the learned horizon (engagementMaxDay). Malformed days are treated as
// absent — never passed to Date math (a RangeError here escapes the async
// route and kills the process).
// - A window that reaches the horizon omits `ending_date`: the documented
//   default is "the most recent available day + 1", so the newest served day
//   is included and a conservative fallback horizon can't provoke a 400.
// - An older window sends end + 1.
// lastDay is the inclusive upper bound the caller trims rows to (the
// horizon-reaching form can return days past a rawEnd that sits between the
// fallback horizon and the real one); null means no upper trim.
export function summariesUpstreamParams(rawStart, rawEnd, maxDay) {
  const reqEnd = isCalendarDay(rawEnd) ? rawEnd : null
  const reqStart = isCalendarDay(rawStart) ? rawStart : null
  const end = !reqEnd || reqEnd > maxDay ? maxDay : reqEnd
  const start = reqStart && reqStart <= end ? reqStart : end
  const reachesHorizon = !reqEnd || reqEnd >= maxDay
  return {
    params: reachesHorizon
      ? { starting_date: start }
      : { starting_date: start, ending_date: addDays(end, 1) },
    firstDay: start,
    lastDay: reachesHorizon ? reqEnd : end,
    endInclusive: end,
  }
}

// One retry for a horizon-form request (no ending_date) that still got a 400:
// the error names the latest available day, so ask explicitly for
// [start, latest + 1). Returns null when there is nothing safe to retry.
export function summariesRetryParams(params, latestDay) {
  if (!params || 'ending_date' in params || !isCalendarDay(latestDay)) return null
  const start = isCalendarDay(params.starting_date) && params.starting_date <= latestDay ? params.starting_date : latestDay
  return { starting_date: start, ending_date: addDays(latestDay, 1) }
}

// Self-check for the horizon form (no ending_date sent): if the newest day it
// returned is 2+ days short of the requested inclusive end, the upstream
// default did not behave as documented — ask explicitly for [start, end + 1).
// A one-day shortfall is normal (summaries can trail the users horizon) and
// an empty/short answer to an explicit request is never second-guessed.
export function summariesShortfallParams(params, rows, endInclusive) {
  if (!params || 'ending_date' in params || !Array.isArray(rows) || !isCalendarDay(endInclusive)) return null
  let newest = ''
  for (const r of rows) {
    const d = String(r?.starting_at || '').slice(0, 10)
    if (d > newest) newest = d
  }
  if (newest && newest >= addDays(endInclusive, -1)) return null
  return { starting_date: params.starting_date, ending_date: addDays(endInclusive, 1) }
}

// Test hook — module state would otherwise leak between test cases.
export function _resetFreshness() {
  learned.clear()
}
