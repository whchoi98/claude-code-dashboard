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

// Test hook — module state would otherwise leak between test cases.
export function _resetFreshness() {
  learned.clear()
}
