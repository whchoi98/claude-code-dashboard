// Standalone ESM test for the IP-allowlist block detector (server/ip-allowlist.js):
// recognizing Anthropic's "your IP isn't in this organization's allowed range"
// refusal and remembering it per API key for /api/health.
// Runs with: node tests/server/test-ip-allowlist.mjs — exit 0 on success, 1 on failure.
import { isIpAllowlistBlock, makeIpBlockTracker, IP_BLOCK_TTL_MS } from '../../server/ip-allowlist.js'
import { isIpAllowlistBlock as collectorDetect } from '../../collector/ip-allowlist.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const blocked = { type: 'error', error: { type: 'permission_error', message: "Your IP address isn't in this organization's allowed range." } }

ok('the documented 403 permission_error is a block', isIpAllowlistBlock(403, blocked))
ok('curly-apostrophe wording still matches', isIpAllowlistBlock(403, { error: { type: 'permission_error', message: 'Your IP address isn’t in this organization’s allowed range.' } }))
ok('a scope 403 is not a block', !isIpAllowlistBlock(403, { error: { type: 'permission_error', message: 'This API key does not have the read:compliance_org_data scope.' } }))
ok('the same text on another status is not a block', !isIpAllowlistBlock(400, blocked) && !isIpAllowlistBlock(200, blocked))
ok('missing or odd bodies are not a block', !isIpAllowlistBlock(403, null) && !isIpAllowlistBlock(403, { raw: '<html>' }) && !isIpAllowlistBlock(403, 'x'))
ok('the collector copy agrees with the server copy', collectorDetect(403, blocked) && !collectorDetect(403, null) && !collectorDetect(429, blocked))

{
  let t = 1_000_000
  const tr = makeIpBlockTracker({ now: () => t })
  ok('nothing recorded → not blocked', tr.blockedAt('sk-key-A') === null)
  tr.record('sk-key-A')
  ok('a recorded block is reported with its time', tr.blockedAt('sk-key-A') === new Date(1_000_000).toISOString())
  ok('blocks are tracked per key', tr.blockedAt('sk-key-B') === null)
  t += IP_BLOCK_TTL_MS - 1
  ok('the block stays reported inside the TTL', tr.blockedAt('sk-key-A') !== null)
  t += 2
  ok('…and expires when nothing refreshes it', tr.blockedAt('sk-key-A') === null)
  tr.record('sk-key-A')
  tr.clear('sk-key-A')
  ok('a later success clears it at once', tr.blockedAt('sk-key-A') === null)
  ok('an undefined key is ignored', (tr.record(undefined), tr.blockedAt(undefined)) === null)
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${n - failed}/${n}`)
process.exit(failed === 0 ? 0 : 1)
