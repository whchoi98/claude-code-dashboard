// flattenActivity contract: stable envelope columns + lossless payload.
// node tests/server/test-flatten-activity.mjs — exit 0 on success, 1 on failure.
import { flattenActivity } from '../../collector/flatten.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// user_actor event with a type-specific field (claude_file_id)
const userEvent = {
  id: 'activity_01AAA',
  type: 'claude_file_viewed',
  created_at: '2026-07-15T00:52:49.432924Z',
  actor: {
    type: 'user_actor',
    email_address: 'alice@acme.com',
    user_id: 'user_01BBB',
    ip_address: '10.0.0.1',
    user_agent: 'Mozilla/5.0',
  },
  organization_id: 'org_01CCC',
  claude_file_id: 'claude_file_01DDD',
  filename: null,
}
const u = flattenActivity(userEvent)
ok('envelope: id/type/created_at', u.id === 'activity_01AAA' && u.type === 'claude_file_viewed' && u.created_at === userEvent.created_at)
ok('actor columns extracted', u.actor_type === 'user_actor' && u.actor_email === 'alice@acme.com' && u.actor_user_id === 'user_01BBB' && u.actor_ip_address === '10.0.0.1' && u.actor_user_agent === 'Mozilla/5.0')
ok('api_key_id null for user_actor', u.actor_api_key_id === null)
ok('organization_id carried', u.organization_id === 'org_01CCC')
ok('payload is lossless JSON of the original', JSON.stringify(JSON.parse(u.payload)) === JSON.stringify(userEvent))
ok('payload keeps type-specific fields', JSON.parse(u.payload).claude_file_id === 'claude_file_01DDD')

// api_actor event (no email/user_id)
const apiEvent = {
  id: 'activity_01EEE',
  type: 'compliance_api_accessed',
  created_at: '2026-07-15T01:58:00.268882Z',
  actor: { type: 'api_actor', api_key_id: 'apikey_01FFF', ip_address: '43.2.1.1' },
  organization_id: null,
  request_method: 'GET',
  status_code: 200,
}
const a = flattenActivity(apiEvent)
ok('api_actor: key id extracted, email null', a.actor_api_key_id === 'apikey_01FFF' && a.actor_email === null && a.actor_user_id === null)
ok('null organization_id preserved as null', a.organization_id === null)

// degenerate: missing actor entirely
const bare = flattenActivity({ id: 'x', type: 't', created_at: 'c' })
ok('missing actor → all actor columns null, no throw', bare.actor_type === null && bare.actor_email === null && bare.actor_api_key_id === null)
ok('missing org → null', bare.organization_id === null)

console.log(`1..${n}`)
process.exit(failed ? 1 : 0)
