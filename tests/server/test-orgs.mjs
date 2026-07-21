// orgs.js contract: org resolution, per-org key fallback chains, S3 prefixes,
// and the /api/orgs descriptor list. orgs.js reads process.env LAZILY, so each
// section resets the environment to a known state before asserting.
// node tests/server/test-orgs.mjs — exit 0 on success, 1 on failure.
import {
  hasOrg2, orgFromReq, analyticsKeyFor, complianceKeyFor,
  adminKeyFor, s3PrefixFor, orgList,
} from '../../server/orgs.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Wipe every env var orgs.js reads, then apply overrides. Values below are
// short obvious fakes — nothing resembling a real key.
const ENV_KEYS = [
  'ANTHROPIC_ANALYTICS_KEY', 'ANTHROPIC_ADMIN_KEY', 'ANTHROPIC_ADMIN_KEY_ADMIN',
  'ANTHROPIC_COMPLIANCE_KEY', 'ANTHROPIC_ANALYTICS_KEY_2', 'ANTHROPIC_COMPLIANCE_KEY_2',
  'CCD_ORG_LABEL', 'CCD_ORG2_LABEL',
]
const reset = (overrides = {}) => {
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, overrides)
}

// ── hasOrg2 / orgFromReq ────────────────────────────────────────────────────
reset()
ok('hasOrg2 false without ANTHROPIC_ANALYTICS_KEY_2', hasOrg2() === false)
ok('orgFromReq: absent org → primary', orgFromReq({ query: {} }) === 'primary')
ok('orgFromReq: missing query object → primary', orgFromReq({}) === 'primary')
ok('orgFromReq: org2 WITHOUT key → primary (silent fallback)', orgFromReq({ query: { org: 'org2' } }) === 'primary')
ok('orgFromReq: unknown org value → primary', orgFromReq({ query: { org: 'bogus' } }) === 'primary')

reset({ ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2' })
ok('hasOrg2 true with ANTHROPIC_ANALYTICS_KEY_2', hasOrg2() === true)
ok('orgFromReq: org2 WITH key → org2', orgFromReq({ query: { org: 'org2' } }) === 'org2')
ok('orgFromReq: absent org still primary when org2 exists', orgFromReq({ query: {} }) === 'primary')
ok('orgFromReq: case-sensitive (ORG2 → primary)', orgFromReq({ query: { org: 'ORG2' } }) === 'primary')
ok('orgFromReq: repeated ?org= (array) → primary', orgFromReq({ query: { org: ['org2', 'org2'] } }) === 'primary')

// ── analyticsKeyFor ─────────────────────────────────────────────────────────
reset({ ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1', ANTHROPIC_ADMIN_KEY: 'fake-admin-1' })
ok('analytics primary: ANTHROPIC_ANALYTICS_KEY wins over admin', analyticsKeyFor('primary') === 'fake-analytics-1')
reset({ ANTHROPIC_ADMIN_KEY: 'fake-admin-1' })
ok('analytics primary: falls back to ANTHROPIC_ADMIN_KEY', analyticsKeyFor('primary') === 'fake-admin-1')
reset()
ok('analytics primary: undefined when nothing configured', analyticsKeyFor('primary') === undefined)
reset({ ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2', ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1' })
ok('analytics org2: reads ANTHROPIC_ANALYTICS_KEY_2', analyticsKeyFor('org2') === 'fake-analytics-2')
reset({ ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1' })
ok('analytics org2: never falls back to primary keys', analyticsKeyFor('org2') === undefined)

// ── complianceKeyFor ────────────────────────────────────────────────────────
reset({ ANTHROPIC_COMPLIANCE_KEY: 'fake-compliance-1', ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1' })
ok('compliance primary: dedicated key wins', complianceKeyFor('primary') === 'fake-compliance-1')
reset({ ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1' })
ok('compliance primary: falls back to analytics key', complianceKeyFor('primary') === 'fake-analytics-1')
reset()
ok('compliance primary: undefined when nothing configured', complianceKeyFor('primary') === undefined)
reset({ ANTHROPIC_COMPLIANCE_KEY_2: 'fake-compliance-2', ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2' })
ok('compliance org2: dedicated _2 override wins', complianceKeyFor('org2') === 'fake-compliance-2')
reset({ ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2' })
ok('compliance org2: falls back to ANTHROPIC_ANALYTICS_KEY_2', complianceKeyFor('org2') === 'fake-analytics-2')
reset({ ANTHROPIC_COMPLIANCE_KEY_2: 'fake-compliance-2' })
ok('compliance primary: never reads the _2 vars', complianceKeyFor('primary') === undefined)
reset({ ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1', ANTHROPIC_COMPLIANCE_KEY: 'fake-compliance-1' })
ok('compliance org2: never falls back to primary keys', complianceKeyFor('org2') === undefined)

// ── adminKeyFor ─────────────────────────────────────────────────────────────
reset({ ANTHROPIC_ADMIN_KEY_ADMIN: 'fake-admin-dedicated' })
ok('admin primary: ANTHROPIC_ADMIN_KEY_ADMIN wins', adminKeyFor('primary') === 'fake-admin-dedicated')
reset({ ANTHROPIC_ADMIN_KEY: 'sk-ant-admin-fake' })
ok('admin primary: sk-ant-admin-prefixed ANTHROPIC_ADMIN_KEY accepted', adminKeyFor('primary') === 'sk-ant-admin-fake')
reset({ ANTHROPIC_ADMIN_KEY: 'fake-not-an-admin-key' })
ok('admin primary: non-admin-prefixed ANTHROPIC_ADMIN_KEY rejected → null', adminKeyFor('primary') === null)
reset()
ok('admin primary: null when nothing configured', adminKeyFor('primary') === null)
reset({ ANTHROPIC_ADMIN_KEY_ADMIN: 'fake-admin-dedicated', ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2' })
ok('admin org2: always null (admin routes stay primary-only)', adminKeyFor('org2') === null)

// ── s3PrefixFor ─────────────────────────────────────────────────────────────
ok('s3 prefix primary: empty (legacy paths exactly)', s3PrefixFor('primary') === '')
ok('s3 prefix org2: org2/', s3PrefixFor('org2') === 'org2/')

// ── orgList ─────────────────────────────────────────────────────────────────
reset({ ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1' })
let list = orgList()
ok('orgList single-org: exactly one entry', list.length === 1)
ok('orgList single-org: primary shape', list[0].id === 'primary' && list[0].label === 'Org 1')
ok('orgList single-org: admin=false without admin key', list[0].admin === false)
ok('orgList single-org: compliance=true via analytics fallback', list[0].compliance === true)
ok('orgList: admin/compliance are booleans', typeof list[0].admin === 'boolean' && typeof list[0].compliance === 'boolean')

reset()
list = orgList()
ok('orgList with no keys at all: primary still listed', list.length === 1 && list[0].id === 'primary')
ok('orgList with no keys: compliance=false', list[0].compliance === false)

reset({
  ANTHROPIC_ANALYTICS_KEY: 'fake-analytics-1',
  ANTHROPIC_ADMIN_KEY_ADMIN: 'fake-admin-dedicated',
  ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2',
  CCD_ORG_LABEL: 'Acme Corp',
  CCD_ORG2_LABEL: 'Beta Org',
})
list = orgList()
ok('orgList two-org: two entries, primary first', list.length === 2 && list[0].id === 'primary' && list[1].id === 'org2')
ok('orgList two-org: custom labels applied', list[0].label === 'Acme Corp' && list[1].label === 'Beta Org')
ok('orgList two-org: primary admin=true with dedicated admin key', list[0].admin === true)
ok('orgList two-org: org2 admin always false', list[1].admin === false)
ok('orgList two-org: org2 compliance=true via its analytics key', list[1].compliance === true)

reset({ ANTHROPIC_ANALYTICS_KEY_2: 'fake-analytics-2' })
list = orgList()
ok('orgList: org2 default label', list[1].label === 'Org 2')

console.log(`1..${n}`)
process.exit(failed ? 1 : 0)
