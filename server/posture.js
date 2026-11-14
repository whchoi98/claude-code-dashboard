// Pure shaper for GET /api/compliance/security-posture.
//
// Upstream: GET /v1/compliance/organizations/{uuid}/security_posture (beta,
// 2026-11-05; scope read:compliance_org_data) — the current result of every
// control on the claude.ai "Security posture" page (Security Center). One
// call reads one organization, takes NO query parameters and is not
// paginated. Each control has a `rating` (passed | failed | not_attested |
// descriptive), a finer `status` (e.g. failed_check_accepted_risk,
// not_applicable), `current_value` / `desired_state` strings and an optional
// `attestation`.
//
// Emails inside `current_value` / `desired_state` are masked unless the
// caller passes no `maskText` (a verified unmasked viewer, ADR-0020).
//
// What is dropped on purpose: `attestation.attested_by` (a member's user id)
// and `attestation.comment` (free text a person typed) — the docs class both
// as personal data, and the card needs neither. Unit-tested in
// tests/server/test-posture.mjs.

// Worst first — the order sections list their controls in.
export const POSTURE_RATINGS = ['failed', 'not_attested', 'passed', 'descriptive']

const VALUE_MAX = 300
// Control values are free-form display strings; one that names a person by
// email follows the dashboard's masking rule like every other email
// (`maskText` = the server's email masker, omitted for an unmasked viewer).
const text = (v, maskText) => {
  if (v == null) return null
  const raw = typeof v === 'string' ? v : String(v)
  const s = maskText ? maskText(raw) : raw
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s
}
const emptyCounts = () => ({ failed: 0, not_attested: 0, passed: 0, descriptive: 0 })
// A rating this code does not know stays on the control (the docs ask
// integrations to pass unknown values through) and counts as "not rated".
const bucket = (rating) => (POSTURE_RATINGS.includes(rating) ? rating : 'descriptive')
const rank = (rating) => POSTURE_RATINGS.indexOf(bucket(rating))

export function summarizePosture(body, { maskText = null } = {}) {
  const controls = (Array.isArray(body?.controls) ? body.controls : []).filter((c) => c && typeof c === 'object')
  const counts = { ...emptyCounts(), accepted_risk: 0 }
  const sections = new Map()   // section id → { section, counts, controls } in upstream order
  for (const c of controls) {
    const rating = c.rating ?? 'descriptive'
    // "Passed" on an accepted risk means the control is NOT in place — the
    // organization chose to accept that. Worth telling apart from a real pass.
    const acceptedRisk = rating === 'passed' && /accepted_risk/.test(String(c.status || ''))
    counts[bucket(rating)] += 1
    if (acceptedRisk) counts.accepted_risk += 1
    const id = c.section || 'other'
    const sec = sections.get(id) ?? { section: id, counts: emptyCounts(), controls: [] }
    sec.counts[bucket(rating)] += 1
    sec.controls.push({
      id: c.id ?? null,
      name: c.display_name || c.id || null,
      rating,
      status: c.status ?? rating,
      accepted_risk: acceptedRisk,
      current_value: text(c.current_value, maskText),
      desired_state: text(c.desired_state, maskText),
      attestation: c.attestation
        ? { state: c.attestation.state ?? null, attested_at: c.attestation.attested_at ?? null }
        : null,
    })
    sections.set(id, sec)
  }
  for (const sec of sections.values()) {
    // Array.prototype.sort is stable: equal ratings keep the upstream order.
    sec.controls.sort((a, b) => rank(a.rating) - rank(b.rating))
  }
  return {
    evaluated_at: body?.evaluated_at ?? null,
    total: controls.length,
    rated: counts.failed + counts.not_attested + counts.passed,
    counts,
    sections: [...sections.values()],
  }
}
