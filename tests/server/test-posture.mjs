// Standalone ESM test for the Security posture shaper (server/posture.js),
// which turns GET /v1/compliance/organizations/{uuid}/security_posture into
// the /api/compliance/security-posture payload.
// Runs with: node tests/server/test-posture.mjs — exit 0 on success, 1 on failure.
import { summarizePosture, POSTURE_RATINGS } from '../../server/posture.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const control = (id, section, rating, over = {}) => ({
  id, display_name: `Name of ${id}`, section, setting_name: id, status: rating, rating,
  current_value: 'Off', desired_state: 'On', attestation: null, ...over,
})
const body = {
  type: 'security_posture',
  organization_id: '91012d09-e48b-438e-a489-1bebfd8fa6f9',
  evaluated_at: '2026-11-13T23:53:14.998115Z',
  comments_status: 'not_enabled',
  controls: [
    control('allowed_invite_domains', 'identity_access', 'descriptive', { current_value: 'example.com', desired_state: null }),
    control('sso_enabled', 'identity_access', 'failed'),
    control('number_of_admins', 'identity_access', 'passed', { current_value: '3', desired_state: '10 or fewer owners' }),
    control('rbac_least_privilege_roles', 'identity_access', 'not_attested', { current_value: null, desired_state: 'Completed' }),
    control('compliance_api_enabled', 'data_privacy', 'passed', { current_value: 'On' }),
    control('directory_sync_enabled', 'data_privacy', 'passed', {
      status: 'failed_check_accepted_risk',
      attestation: {
        state: 'in_force', attested_at: '2026-10-20T15:04:00.220114Z', comment: 'because reasons',
        attested_by: { type: 'user_actor', user_id: 'user_01WxYzAbCdEfGhJkMnPqRsTu' },
      },
    }),
    control('scim_group_mappings', 'data_privacy', 'descriptive', { status: 'not_applicable', current_value: null, desired_state: null }),
  ],
}

const out = summarizePosture(body)
ok('rating order is worst first', POSTURE_RATINGS.join() === 'failed,not_attested,passed,descriptive')
ok('counts every control by rating', out.total === 7 && out.counts.failed === 1 && out.counts.not_attested === 1
  && out.counts.passed === 3 && out.counts.descriptive === 2)
ok('rated = controls with a pass/fail/not-attested verdict', out.rated === 5)
ok('evaluated_at passes through', out.evaluated_at === '2026-11-13T23:53:14.998115Z')
ok('sections keep the upstream order', out.sections.map((s) => s.section).join() === 'identity_access,data_privacy')
ok('each section carries its own counts', out.sections[0].counts.failed === 1 && out.sections[0].counts.passed === 1
  && out.sections[1].counts.passed === 2 && out.sections[1].counts.failed === 0)
ok('controls sort worst rating first inside a section', out.sections[0].controls.map((c) => c.rating).join() === 'failed,not_attested,passed,descriptive')
ok('equal ratings keep the upstream order', out.sections[1].controls.map((c) => c.id).join() === 'compliance_api_enabled,directory_sync_enabled,scim_group_mappings')
{
  const c = out.sections[0].controls[0]
  ok('a control keeps id, name, status, current and recommended values', c.id === 'sso_enabled' && c.name === 'Name of sso_enabled'
    && c.status === 'failed' && c.current_value === 'Off' && c.desired_state === 'On' && c.attestation === null)
}
{
  const c = out.sections[1].controls.find((x) => x.id === 'directory_sync_enabled')
  ok('an attestation keeps its state and time', c.attestation?.state === 'in_force' && c.attestation.attested_at === '2026-10-20T15:04:00.220114Z')
  ok('who attested and the comment never leave the server', !JSON.stringify(out).includes('user_01WxYz') && !JSON.stringify(out).includes('because reasons')
    && !('attested_by' in c.attestation) && !('comment' in c.attestation))
  ok('an accepted risk is flagged (passed while the check fails)', c.accepted_risk === true && out.counts.accepted_risk === 1)
  ok('other controls are not flagged as accepted risk', out.sections[0].controls.every((x) => x.accepted_risk === false))
}

// ── tolerance ───────────────────────────────────────────────────────────────
{
  const odd = summarizePosture({ controls: [
    { id: 'future_control', section: 'new_section', rating: 'something_new', status: 'something_new' },
    { id: 'no_section', rating: 'failed' },
    null,
  ] })
  ok('an unknown rating is kept on the control and counted as not rated', odd.sections[0].controls[0].rating === 'something_new' && odd.counts.descriptive === 1)
  ok('a missing display name falls back to the id', odd.sections[0].controls[0].name === 'future_control')
  ok('a control without a section lands in "other"', odd.sections.some((s) => s.section === 'other' && s.controls[0].id === 'no_section'))
  ok('a null control is skipped', odd.total === 2)
}
{
  const empty = summarizePosture(null)
  ok('a missing body yields an empty summary', empty.total === 0 && empty.sections.length === 0 && empty.counts.failed === 0 && empty.evaluated_at === null)
}
{
  const long = summarizePosture({ controls: [control('x', 's', 'descriptive', { current_value: 'a'.repeat(900), desired_state: 42 })] })
  const c = long.sections[0].controls[0]
  ok('long values are capped', c.current_value.length <= 301 && c.current_value.endsWith('…'))
  ok('non-string values are stringified', c.desired_state === '42')
}

{
  const b = { controls: [control('primary_owner', 's', 'descriptive', { current_value: 'Owner: jane.doe@acme.com', desired_state: 'Ask someone@acme.com' })] }
  const mask = (s) => s.replace(/[\w.]+@/g, '***@')
  const masked = summarizePosture(b, { maskText: mask }).sections[0].controls[0]
  ok('emails inside control values are masked for a masked viewer', masked.current_value === 'Owner: ***@acme.com' && masked.desired_state === 'Ask ***@acme.com')
  const raw = summarizePosture(b).sections[0].controls[0]
  ok('…and left as sent when no masker is given (unmasked viewer)', raw.current_value === 'Owner: jane.doe@acme.com')
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${n - failed}/${n}`)
process.exit(failed === 0 ? 0 : 1)
