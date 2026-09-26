// Pure helpers for the /v1/compliance/activities walk (index.js
// walkActivities). Standalone — no imports from index.js (which boots the
// server) — so tests/server/test-compliance-walk.mjs can import it directly.

// Upstream page size for the live audit walk. The API accepts up to 5000;
// 1000 keeps a page around a megabyte (inside the 30s per-page abort)
// while cutting the 2000-event preset walk from 20 requests to 2 — and every
// request is itself a `compliance_api_accessed` event in the org's own feed,
// the dominant share of which was this dashboard's prewarm. Must stay FIXED
// within one walk: the cursor is bound to the query that produced it.
export const AUDIT_UPSTREAM_PAGE = 1000

// Real YYYY-MM-DD calendar day — query values can be arrays or junk, and a
// bad day must never reach Date math (toISOString throws RangeError).
function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function nextDay(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Server-side time window (documented `created_at.{gte,lt}`, RFC 3339) for a
// walk whose window ends BEFORE today (UTC). Windows ending today — every
// DateRangeControl preset — stay unfiltered on purpose: the four preset walks
// then send identical upstream params and share one after_id chain through
// the fetchJson page cache, and the newest-first walk already stops at their
// lower bound. A past window without the filter walked from "now" and hit the
// record cap long before reaching the requested days (0 events + cap banner).
export function activitiesWindowParams(startingDate, endingDate, today) {
  if (!isDay(endingDate) || endingDate >= today) return {}
  return {
    ...(isDay(startingDate) ? { 'created_at.gte': `${startingDate}T00:00:00Z` } : {}),
    'created_at.lt': `${nextDay(endingDate)}T00:00:00Z`,
  }
}

// Documented cursor contract: pass the response's `last_id` as the next
// `after_id` and treat it as opaque ("do not construct cursors from object
// IDs"). Falls back to the page's last event id for an envelope without it.
export function nextActivitiesCursor(body, pageData) {
  if (typeof body?.last_id === 'string' && body.last_id) return body.last_id
  const last = Array.isArray(pageData) ? pageData[pageData.length - 1] : undefined
  return last?.id
}
