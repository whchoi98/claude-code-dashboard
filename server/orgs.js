// Multi-org resolution helpers — see the pinned multi-org contract (v1).
// Pure and dependency-free: every function reads process.env lazily so tests
// can mutate the environment between assertions and ECS secret injection is
// picked up without module-load ordering concerns.
//
// Org ids are 'primary' | 'org2'. org2 EXISTS only while
// ANTHROPIC_ANALYTICS_KEY_2 is set — single-org deployments behave exactly
// as before (?org=org2 silently resolves to primary, no org2 warm loops).

export function hasOrg2() {
  return Boolean(process.env.ANTHROPIC_ANALYTICS_KEY_2)
}

// Validate ?org= from an Express request. Absent, invalid, or unknown values
// — and org2 when its key is not configured — all resolve to 'primary'.
export function orgFromReq(req) {
  return req?.query?.org === 'org2' && hasOrg2() ? 'org2' : 'primary'
}

// Analytics key per org. Primary keeps today's fallback chain (the Analytics
// key, or the Admin key when only that is configured).
export function analyticsKeyFor(org) {
  if (org === 'org2') return process.env.ANTHROPIC_ANALYTICS_KEY_2 || undefined
  return process.env.ANTHROPIC_ANALYTICS_KEY || process.env.ANTHROPIC_ADMIN_KEY || undefined
}

// Compliance key per org. Each org falls back to its OWN Analytics key — its
// scopes include read:compliance_activities (verified live 2026-07-03), so a
// dedicated Compliance key is optional. The dedicated key's only extra scope
// (delete:compliance_user_data) is never used here.
export function complianceKeyFor(org) {
  if (org === 'org2') {
    return process.env.ANTHROPIC_COMPLIANCE_KEY_2 || process.env.ANTHROPIC_ANALYTICS_KEY_2 || undefined
  }
  return process.env.ANTHROPIC_COMPLIANCE_KEY || process.env.ANTHROPIC_ANALYTICS_KEY || undefined
}

// Admin key — primary only (no Admin key is provisioned for org2, so the
// /api/admin/* routes stay primary-scoped by contract).
export function adminKeyFor(org) {
  if (org === 'org2') return null
  return process.env.ANTHROPIC_ADMIN_KEY_ADMIN || (
    (process.env.ANTHROPIC_ADMIN_KEY || '').startsWith('sk-ant-admin')
      ? process.env.ANTHROPIC_ADMIN_KEY
      : null
  )
}

// S3 object-key prefix per org. Primary keeps today's legacy paths EXACTLY
// (users/, raw/users/, spend-reports/, group-map/); org2 nests under org2/.
export function s3PrefixFor(org) {
  return org === 'org2' ? 'org2/' : ''
}

// Org descriptors for GET /api/orgs and /api/health. Primary is always
// listed; org2 appears only when its key is configured.
export function orgList() {
  const orgs = [{
    id: 'primary',
    label: process.env.CCD_ORG_LABEL || 'Org 1',
    admin: Boolean(adminKeyFor('primary')),
    compliance: Boolean(complianceKeyFor('primary')),
  }]
  if (hasOrg2()) {
    orgs.push({
      id: 'org2',
      label: process.env.CCD_ORG2_LABEL || 'Org 2',
      admin: Boolean(adminKeyFor('org2')),
      compliance: Boolean(complianceKeyFor('org2')),
    })
  }
  return orgs
}
