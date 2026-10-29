// Standalone ESM tests for server/directory.js (Compliance directory + Plugins API shapers).
// Runs with: node tests/server/test-directory.mjs — exit 0 on success, 1 on failure.
import { summarizeOrgDirectory, toPluginCatalog, ORGANIZATION_ROLES } from '../../server/directory.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Shapes from the compliance-org-data guide (List organization users +
// List user preferences with include_unset=true).
const raw = {
  org: { uuid: 'o-1', name: 'Acme Engineering', created_at: '2025-06-01T10:00:00Z' },
  users: { ok: true, data: [
    { id: 'u1', email: 'a@x.com', organization_role: 'admin' },
    { id: 'u2', email: 'b@x.com', organization_role: 'user' },
    { id: 'u3', email: 'c@x.com', organization_role: 'user' },
    { id: 'u4', email: 'd@x.com' },
  ] },
  prefs: { ok: true, data: [
    { user: { id: 'u1', email_address: 'a@x.com' }, conversation_preferences: 'Keep answers brief.', cowork_global_instructions: null },
    { user: { id: 'u2', email_address: 'b@x.com' }, conversation_preferences: null, cowork_global_instructions: 'Never delete files.' },
    { user: { id: 'u3', email_address: 'c@x.com' }, conversation_preferences: '   ', cowork_global_instructions: null },
    { user: { id: 'u4', email_address: 'd@x.com' }, conversation_preferences: null, cowork_global_instructions: null },
  ] },
}

const masked = summarizeOrgDirectory(raw)
ok('members = listed organization users', masked.members === 4)
ok('roles counted per organization_role; missing role → unknown', masked.roles.admin === 1 && masked.roles.user === 2 && masked.roles.unknown === 1)
ok('preference counts: whitespace-only text is not "set"', masked.preferences.conversation_set === 1 && masked.preferences.cowork_set === 1
  && masked.preferences.any_set === 2 && masked.preferences.listed === 4)
ok('PRIVACY: a masked session never receives preference text', !('members' in masked.preferences) && !JSON.stringify(masked).includes('Keep answers brief'))
ok('PRIVACY: a masked session never receives member emails', !JSON.stringify(masked).includes('@x.com'))

const admin = summarizeOrgDirectory(raw, { unmask: true })
ok('unmasked admin: only members with saved text are listed', admin.preferences.members.length === 2)
ok('unmasked admin: texts + email carried, blanks normalized to null', admin.preferences.members[0].email === 'a@x.com'
  && admin.preferences.members[0].conversation_preferences === 'Keep answers brief.' && admin.preferences.members[0].cowork_global_instructions === null)

const degraded = summarizeOrgDirectory({ org: raw.org, users: raw.users, prefs: { ok: false, status: 404, data: [] } })
ok('a failed beta preferences walk degrades only that part', degraded.members === 4 && degraded.preferences === null && degraded.errors.preferences === 404)
const noUsers = summarizeOrgDirectory({ org: raw.org, users: { ok: false, status: 403, data: [] }, prefs: raw.prefs })
ok('a 403 on users keeps the preference counts', noUsers.members === null && noUsers.errors.users === 403 && noUsers.preferences.any_set === 2)
ok('documented role list covers the 9 built-in levels', ORGANIZATION_ROLES.length === 9 && ORGANIZATION_ROLES.includes('claude_code_user'))

// Plugins API (GET /v1/organizations/plugins + /plugin_marketplaces).
const { plugins, marketplaces } = toPluginCatalog([
  { id: 'plugin_1', name: 'sales-toolkit', display_name: 'Sales Toolkit', served_version_id: 'pluginver_a', served_version_pinned: true,
    latest_version_id: 'pluginver_b', owner: { type: 'organization' }, marketplace_id: 'marketplace_1',
    organization_installation_preference: 'available', organization_installation_preference_inherited: true,
    content_scan: { status: 'passed' }, reach: 'remote', created_by: { id: 'user_x' }, updated_at: '2026-09-15T14:12:30Z' },
  { id: 'plugin_2', name: 'my-helper', served_version_id: 'pluginver_c', latest_version_id: 'pluginver_c', owner: { type: 'user', user_id: 'user_9' } },
], [{ id: 'marketplace_1', name: 'acme-internal', source: 'github' }])
ok('catalog: marketplace id resolves to its name', plugins[0].marketplace === 'acme-internal')
ok('catalog: a served version behind latest is flagged', plugins[0].update_available === true && plugins[1].update_available === false)
ok('catalog: pinned / installation / scan carried', plugins[0].pinned && plugins[0].installation === 'available' && plugins[0].installation_inherited && plugins[0].scan === 'passed')
ok('catalog: member-owned plugin → owner "user", display name falls back to name', plugins[1].owner === 'user' && plugins[1].display_name === 'my-helper')
ok('catalog: owner user ids and created_by are dropped', !JSON.stringify(plugins).includes('user_9') && !JSON.stringify(plugins).includes('user_x'))
ok('catalog: marketplaces listed with source', marketplaces[0].name === 'acme-internal' && marketplaces[0].source === 'github')
ok('catalog: empty / missing inputs are safe', toPluginCatalog().plugins.length === 0 && toPluginCatalog(null, null).marketplaces.length === 0)

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
