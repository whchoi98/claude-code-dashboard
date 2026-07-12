// Standalone ESM tests for the membership-based group mapping helper
// (server/aws.js): deriveMemberGroupMap — Compliance groups listing +
// per-group members rows → { map, groups, ids }.
// Runs with: node tests/server/test-group-members.mjs — exit 0 on success, 1 on failure.
import { deriveMemberGroupMap } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const G_ENG = { id: 'rbac_group_01aaaaaaaaaaaaaaaaaEng01', name: 'Engineering' }
const G_SEC = { id: 'rbac_group_01bbbbbbbbbbbbbbbbbSec01', name: 'Security' }
const G_NEW = { id: 'rbac_group_01cccccccccccccccccNew01', name: 'Prin-Engineering' }

// ── basic mapping ──────────────────────────────────────────────────────────
const R1 = deriveMemberGroupMap([G_ENG, G_SEC], {
  [G_ENG.id]: [{ user_id: 'user_01', email: 'a@x.com' }, { user_id: 'user_02', email: 'b@x.com' }],
  [G_SEC.id]: [{ user_id: 'user_03', email: 'c@x.com' }],
})
ok('members map to their group label', JSON.stringify(R1.map['a@x.com']) === '["Engineering"]' && JSON.stringify(R1.map['c@x.com']) === '["Security"]')
ok('groups list is sorted labels', JSON.stringify(R1.groups) === '["Engineering","Security"]')
ok('ids is an invertible label→group_id lookup', R1.ids['Engineering'] === G_ENG.id && R1.ids['Security'] === G_SEC.id)

// ── multi-membership → sorted array of every group ─────────────────────────
const R2 = deriveMemberGroupMap([G_ENG, G_SEC], {
  [G_ENG.id]: [{ email: 'dual@x.com' }],
  [G_SEC.id]: [{ email: 'dual@x.com' }],
})
ok('multi-group member carries every membership, label-sorted', JSON.stringify(R2.map['dual@x.com']) === '["Engineering","Security"]')

// ── a memberless group still gets a tab (unlike spend-derive) ──────────────
const R3 = deriveMemberGroupMap([G_ENG, G_NEW], { [G_ENG.id]: [{ email: 'a@x.com' }] })
ok('memberless group still appears in groups', R3.groups.includes('Prin-Engineering'))
ok('memberless group maps nobody', !Object.values(R3.map).flat().includes('Prin-Engineering'))

// ── email normalization + bad rows ─────────────────────────────────────────
const R4 = deriveMemberGroupMap([G_ENG], {
  [G_ENG.id]: [
    { email: '  A@X.com ' },          // trimmed + lowercased
    { email: '' },                    // skipped
    { user_id: 'user_09' },           // no email → skipped
    { email: 'a@x.com' },             // duplicate after normalization → deduped
  ],
})
ok('emails are trimmed + lowercased', JSON.stringify(R4.map['a@x.com']) === '["Engineering"]')
ok('rows without an email are skipped, duplicates deduped', Object.keys(R4.map).length === 1)

// ── duplicate display names disambiguate with an id suffix ─────────────────
const DUP_A = { id: 'rbac_group_01dddddddddddddddddAAA01', name: 'Platform' }
const DUP_B = { id: 'rbac_group_01eeeeeeeeeeeeeeeeeBBB01', name: 'Platform' }
const R5 = deriveMemberGroupMap([DUP_A, DUP_B], {
  [DUP_A.id]: [{ email: 'a@x.com' }],
  [DUP_B.id]: [{ email: 'b@x.com' }],
})
ok('duplicate names get distinct disambiguated labels', new Set(R5.groups).size === 2 && R5.groups.length === 2)
ok('disambiguated ids lookup still resolves both groups', new Set(Object.values(R5.ids)).size === 2)

// ── nameless group falls back to grp-<id suffix> label ─────────────────────
const NONAME = { id: 'rbac_group_01fffffffffffffffffZZZ99' }
const R6 = deriveMemberGroupMap([NONAME], { [NONAME.id]: [{ email: 'z@x.com' }] })
ok('nameless group gets a grp- fallback label', R6.groups[0].startsWith('grp-'))

// ── degenerate inputs never throw ──────────────────────────────────────────
const R7 = deriveMemberGroupMap(null, null)
const R8 = deriveMemberGroupMap([], {})
const R9 = deriveMemberGroupMap([G_ENG], undefined)
ok('null/empty inputs → empty result, no throw',
  R7.groups.length === 0 && Object.keys(R7.map).length === 0 &&
  R8.groups.length === 0 && R9.groups.length === 1 && Object.keys(R9.map).length === 0)

// ── member rows under an unlisted group id are ignored ─────────────────────
const R10 = deriveMemberGroupMap([G_ENG], {
  [G_ENG.id]: [{ email: 'a@x.com' }],
  rbac_group_01notinthelisting00000: [{ email: 'ghost@x.com' }],
})
ok('members of unlisted groups are ignored', !('ghost@x.com' in R10.map))

console.log(`# group-members: ${n - failed}/${n} passed`)
process.exit(failed === 0 ? 0 : 1)
