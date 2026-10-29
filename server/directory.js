// Pure response shapers for the Compliance directory and Plugins API routes
// (server/index.js). Dependency-free — unit-tested in
// tests/server/test-directory.mjs.

// The built-in membership levels List organization users documents for
// `organization_role` — an axis independent of custom RBAC roles.
export const ORGANIZATION_ROLES = [
  'primary_owner', 'owner', 'admin', 'membership_admin', 'billing',
  'developer', 'claude_code_user', 'user', 'managed',
]

const hasText = (v) => typeof v === 'string' && v.trim().length > 0

/**
 * One linked organization's directory summary.
 *   users — the organization users walk ({ ok, status, data })
 *   prefs — the user_preferences walk with include_unset=true
 * Preference TEXT is user-authored content: it is copied into `members` ONLY
 * when `unmask` comes from a verified 'unmasked' identity (ADR-0020). Every
 * other session receives counts alone — never the text, never per-member rows.
 */
export function summarizeOrgDirectory({ org, users, prefs }, { unmask = false } = {}) {
  const out = {
    uuid: org?.uuid ?? null,
    name: org?.name ?? null,
    members: null,
    roles: null,
    preferences: null,
    errors: {},
  }
  if (users?.ok) {
    const roles = {}
    for (const u of users.data ?? []) {
      const r = u?.organization_role || 'unknown'
      roles[r] = (roles[r] ?? 0) + 1
    }
    out.members = (users.data ?? []).length
    out.roles = roles
  } else if (users) {
    out.errors.users = users.status ?? 0
  }
  if (prefs?.ok) {
    const rows = prefs.data ?? []
    const conversation = rows.filter((r) => hasText(r?.conversation_preferences)).length
    const cowork = rows.filter((r) => hasText(r?.cowork_global_instructions)).length
    const either = rows.filter((r) => hasText(r?.conversation_preferences) || hasText(r?.cowork_global_instructions)).length
    out.preferences = { listed: rows.length, conversation_set: conversation, cowork_set: cowork, any_set: either }
    if (unmask) {
      out.preferences.members = rows
        .filter((r) => hasText(r?.conversation_preferences) || hasText(r?.cowork_global_instructions))
        .map((r) => ({
          email: r?.user?.email_address ?? null,
          conversation_preferences: hasText(r?.conversation_preferences) ? r.conversation_preferences : null,
          cowork_global_instructions: hasText(r?.cowork_global_instructions) ? r.cowork_global_instructions : null,
        }))
    }
  } else if (prefs) {
    out.errors.preferences = prefs.status ?? 0
  }
  return out
}

/**
 * Org plugin catalog rows from the Plugins API (GET /v1/organizations/plugins
 * + /plugin_marketplaces). Only catalog metadata — the owner's user id and
 * `created_by` are dropped (identities have no place on a catalog table).
 */
export function toPluginCatalog(plugins = [], marketplaces = []) {
  const marketName = new Map(
    (marketplaces ?? []).map((m) => [m?.id, m?.display_name || m?.name || m?.id]),
  )
  const rows = (plugins ?? []).map((p) => ({
    id: p?.id ?? null,
    name: p?.name ?? null,
    display_name: p?.display_name || p?.name || p?.id || null,
    owner: p?.owner?.type === 'user' ? 'user' : 'organization',
    marketplace: p?.marketplace_id ? (marketName.get(p.marketplace_id) || p.marketplace_id) : null,
    installation: p?.organization_installation_preference ?? null,
    installation_inherited: p?.organization_installation_preference_inherited === true,
    pinned: p?.served_version_pinned === true,
    // A pinned or lagging served version differs from the newest published one.
    update_available: Boolean(p?.latest_version_id && p?.served_version_id && p.latest_version_id !== p.served_version_id),
    reach: p?.reach ?? null,
    scan: p?.content_scan?.status ?? null,
    updated_at: p?.updated_at ?? null,
  }))
  return {
    plugins: rows,
    marketplaces: (marketplaces ?? []).map((m) => ({
      id: m?.id ?? null,
      name: m?.display_name || m?.name || m?.id || null,
      source: m?.source ?? null,
    })),
  }
}
