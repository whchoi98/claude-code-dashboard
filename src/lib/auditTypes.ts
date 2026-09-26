// Compliance activity-feed classification shared by the Audit (Compliance)
// and Executive pages. Type names are taken from the Compliance API activity
// enum (GET /v1/compliance/activities `activity_types[]`, 514 values as of
// 2026-09) plus the Access Transparency types documented on their own page
// (`anthropic_access`, `cmek_preserve`). The earlier hand-written sets used
// names the API never emits (user_signed_in_sso, project_deleted, …), so the
// Login KPI counted nothing. Unknown types stay 'info' — the feed adds types
// continuously and the docs ask integrations to pass them through.

// Security-relevant administrative changes, credential events and access by
// parties outside the org's own users.
export const RISK_TYPES: ReadonlySet<string> = new Set([
  // membership & roles
  'claude_user_role_updated',
  'org_user_invite_sent', 'org_user_invite_deleted', 'org_user_deleted',
  'scim_user_deleted',
  'rbac_role_created', 'rbac_role_updated', 'rbac_role_deleted',
  'rbac_role_permission_added', 'rbac_role_permission_removed', 'rbac_role_grant_updated',
  'rbac_role_assigned', 'rbac_role_unassigned',
  'role_assignment_granted', 'role_assignment_revoked',
  // identity provider / SSO
  'org_sso_toggled', 'org_sso_connection_deleted', 'org_sso_connection_deactivated',
  'org_sso_provisioning_mode_changed', 'org_sso_group_role_mappings_updated',
  'sso_login_failed', 'magic_link_login_failed',
  // credentials
  'api_key_created', 'platform_api_key_created',
  'admin_api_key_created', 'admin_api_key_updated', 'admin_api_key_deleted',
  'scoped_api_key_updated', 'scoped_api_key_deleted',
  // data leaving the org / exports
  'org_data_export_started', 'org_data_export_completed', 'org_data_export_accessed',
  'org_members_exported', 'audit_log_export_started', 'audit_log_export_accessed',
  'claude_artifact_external_sharing_permission_updated',
  // org-wide security & retention settings
  'org_compliance_api_settings_updated',
  'org_ip_restriction_created', 'org_ip_restriction_updated', 'org_ip_restriction_deleted',
  'org_domain_verified', 'org_domain_removed',
  'org_claude_code_data_sharing_enabled', 'org_claude_code_zero_data_retention_disabled',
  'platform_workspace_inference_data_retention_disabled',
  'org_bulk_delete_initiated',
  'claude_project_deleted',
  // inference hooks (policy enforcement signals)
  'inference_hooks_request_denied', 'inference_hooks_request_failed_open',
  'inference_hooks_circuit_breaker_tripped',
  'inference_hooks_config_updated', 'inference_hooks_config_deleted',
  // trust & safety / integrity
  'abuse_decision_received', 'ghe_webhook_signature_invalid',
  // Access Transparency: human access by Anthropic staff, CMEK preservation
  'anthropic_access', 'cmek_preserve',
])

// Successful sign-ins and sign-outs. Failed attempts are RISK above;
// `*_initiated` steps are not logins.
export const LOGIN_TYPES: ReadonlySet<string> = new Set([
  'sso_login_succeeded', 'magic_link_login_succeeded', 'social_login_succeeded',
  'user_logged_out',
])

export type AuditCategory = 'risk' | 'login' | 'info'

export function auditCategory(type: string): AuditCategory {
  if (RISK_TYPES.has(type)) return 'risk'
  if (LOGIN_TYPES.has(type)) return 'login'
  return 'info'
}

// Actor union of the activity feed: 11 documented `actor.type` values, each
// with its own identifying fields. Unknown future types keep their raw type.
export type AuditActor = {
  type: string
  email_address?: string | null
  unauthenticated_email_address?: string | null
  user_id?: string
  api_key_id?: string
  admin_api_key_id?: string
  service_account_id?: string
  directory_id?: string
  issuer?: string | null
  subject?: string | null
  service?: string | null
  external_client_id?: string
  provider?: { type?: string; account_id?: string; subscription_id?: string; project_number?: string; subject?: string | null } | null
  ip_address?: string | null
  user_agent?: string | null
}

// Credential-driven (non-interactive) actors — the "API calls" KPI.
export const MACHINE_ACTOR_TYPES: ReadonlySet<string> = new Set([
  'api_actor', 'admin_api_key_actor', 'service_account_actor',
  'federated_identity_actor', 'federated_actor', 'attested_device_actor',
])

function providerId(p: AuditActor['provider']): string {
  if (!p) return ''
  return [p.type, p.account_id ?? p.subscription_id ?? p.project_number ?? p.subject ?? ''].filter(Boolean).join(':')
}

// Stable grouping key per actor (Top actors, unique-actor count). Raw emails
// stay unmasked here — callers mask at render time.
export function actorKey(a: AuditActor | undefined | null): string {
  if (!a) return 'unknown'
  switch (a.type) {
    case 'user_actor': return a.email_address || a.user_id || 'unknown user'
    case 'api_actor': return a.api_key_id || 'unknown key'
    case 'admin_api_key_actor': return a.admin_api_key_id || 'unknown admin key'
    case 'service_account_actor': return a.service_account_id || 'unknown service account'
    case 'scim_directory_sync_actor': return `scim:${a.directory_id ?? '?'}`
    case 'federated_identity_actor': return `federated:${a.issuer ?? '?'}#${a.subject ?? '?'}`
    case 'federated_actor': return `federated:${providerId(a.provider) || '?'}`
    case 'attested_device_actor': return `device:${a.external_client_id ?? '?'}`
    case 'unauthenticated_user_actor': return a.unauthenticated_email_address || `anon:${a.ip_address ?? '?'}`
    case 'anthropic_actor': return 'Anthropic'
    case 'system_actor': return `system${a.service ? `:${a.service}` : ''}`
    default: return a.email_address || a.user_id || a.api_key_id || a.type || 'unknown'
  }
}

const ACTOR_ICON: Record<string, string> = {
  user_actor: '👤', api_actor: '🔑', admin_api_key_actor: '🛡️', service_account_actor: '🤖',
  scim_directory_sync_actor: '🔄', federated_identity_actor: '🪪', federated_actor: '🪪',
  attested_device_actor: '📱', unauthenticated_user_actor: '❔', anthropic_actor: '🏢', system_actor: '⚙️',
}

// Display label: icon + identity, with any email passed through `mask`.
export function actorLabel(a: AuditActor | undefined | null, mask: (email: string) => string): string {
  if (!a) return 'unknown'
  const key = actorKey(a)
  const shown = key.includes('@') ? mask(key) : key
  return `${ACTOR_ICON[a.type] ?? '•'} ${shown}`
}

// Activities whose `filename` / `title` the feed has returned empty since
// 2026-09-24 (retroactively): files, project documents and artifacts. Names
// now require the content endpoints under read:compliance_user_data.
export function isNameRedactedType(type: string): boolean {
  return /^(claude|design|platform)_/.test(type) && /(^|_)(file|artifact|document)(_|$)/.test(type)
}
