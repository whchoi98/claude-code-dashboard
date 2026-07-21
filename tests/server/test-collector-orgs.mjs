// Collector multi-org contract: org selection, S3 prefixes, result-key
// convention (contract 2026-07-21 — primary = legacy names, org2 = org2_*).
// node tests/server/test-collector-orgs.mjs — exit 0 on success, 1 on failure.
import { orgsForRun, orgConfigured, orgS3Prefix, orgKeyPrefix } from '../../collector/handler.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const throws = (fn) => { try { fn(); return false } catch { return true } }

// Start from a clean env — the runner shell may carry keys.
delete process.env.ANTHROPIC_ANALYTICS_KEY_2
delete process.env.ANTHROPIC_ANALYTICS_KEY_2_SECRET_ARN

// ── org selection (default: all configured) ──────────────────────────────
ok('no org2 env → primary only', JSON.stringify(orgsForRun({})) === '["primary"]')
ok('no org2 env → orgConfigured(org2) false', orgConfigured('org2') === false)

process.env.ANTHROPIC_ANALYTICS_KEY_2 = 'sk-test-org2'
ok('org2 key env → both orgs, primary first', JSON.stringify(orgsForRun({})) === '["primary","org2"]')
ok('org2 key env → orgConfigured(org2) true', orgConfigured('org2') === true)

delete process.env.ANTHROPIC_ANALYTICS_KEY_2
process.env.ANTHROPIC_ANALYTICS_KEY_2_SECRET_ARN = 'arn:aws:secretsmanager:x:y:secret:ccd/analytics-key-2'
ok('org2 secret ARN alone also configures org2', JSON.stringify(orgsForRun({})) === '["primary","org2"]')

// ── payload org override (manual single-org runs) ────────────────────────
ok("event.org='org2' limits the run to org2", JSON.stringify(orgsForRun({ org: 'org2' })) === '["org2"]')
ok("event.org='primary' limits the run to primary", JSON.stringify(orgsForRun({ org: 'primary' })) === '["primary"]')
ok('unknown event.org throws (fail loud, no wrong-prefix writes)', throws(() => orgsForRun({ org: 'org3' })))
delete process.env.ANTHROPIC_ANALYTICS_KEY_2_SECRET_ARN
ok('explicit org override is honored even when unconfigured (key resolution fails later)',
  JSON.stringify(orgsForRun({ org: 'org2' })) === '["org2"]')

// ── S3 prefix mapping (primary = legacy paths EXACTLY) ───────────────────
ok("primary S3 prefix is ''", orgS3Prefix('primary') === '')
ok("org2 S3 prefix is 'org2/'", orgS3Prefix('org2') === 'org2/')

// ── results/counts key convention ────────────────────────────────────────
ok('primary result keys are unprefixed', orgKeyPrefix('primary') === '')
ok("org2 result keys carry 'org2_'", orgKeyPrefix('org2') === 'org2_')

console.log(`1..${n}`)
process.exit(failed ? 1 : 0)
