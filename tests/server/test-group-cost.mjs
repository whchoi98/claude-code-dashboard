// Standalone ESM tests for the RBAC-group cost helpers (server/aws.js):
// labelGroupIds / aggregateGroupCost / deriveGroupMap.
// Runs with: node tests/server/test-group-cost.mjs — exit 0 on success, 1 on failure.
import { labelGroupIds, aggregateGroupCost, deriveGroupMap } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const eqf = (a, b) => Math.abs(a - b) < 1e-6

// ── labelGroupIds ──────────────────────────────────────────────────────────
const L1 = labelGroupIds(['rbac_group_01E6P841R3srigepuDLYh3g8', 'rbac_group_017eovzwWoEdoWtLqbEBsEwb'])
ok('labels use grp- + last-6 suffix', L1['rbac_group_01E6P841R3srigepuDLYh3g8'] === 'grp-LYh3g8')
ok('labels are unique for distinct ids', new Set(Object.values(L1)).size === 2)
// Two ids sharing the same last-6 must get longer (still unique) suffixes.
const L2 = labelGroupIds(['rbac_group_AAAAAAsuffix', 'rbac_group_BBBBBBsuffix'])
ok('suffix collision extends until unique', new Set(Object.values(L2)).size === 2)
ok('empty / null-ish input → {}', Object.keys(labelGroupIds([])).length === 0 && Object.keys(labelGroupIds([null, ''])).length === 0)

// ── aggregateGroupCost ─────────────────────────────────────────────────────
// cost_report grouped by rbac_group_id: rows with a null group id are the
// genuinely-ungrouped remainder (users in no group), NOT a duplicate total.
const G_A = 'rbac_group_01aaaaaaaaaaaaaaaaaaaAAA'
const G_B = 'rbac_group_01bbbbbbbbbbbbbbbbbbbBBB'
const costBody = {
  data_refreshed_at: '2026-07-03T07:00:00Z',
  data: [
    { starting_at: '2026-07-01T00:00:00Z', results: [
      { rbac_group_id: G_A, amount: '10000', requests: 5 },     // $100
      { rbac_group_id: G_B, amount: '2500.5', requests: 2 },    // $25.005
      { rbac_group_id: null, amount: '100', requests: 1 },      // ungrouped $1
    ] },
    { starting_at: '2026-07-02T00:00:00Z', results: [
      { rbac_group_id: G_A, amount: '5000', requests: 3 },      // $50
      { rbac_group_id: null, amount: '50', requests: 1 },       // ungrouped $0.50
    ] },
  ],
}
const agg = aggregateGroupCost(costBody)
ok('groups sorted by spend desc', agg.groups[0].group_id === G_A && agg.groups.length === 2)
ok('cents → USD per group', eqf(agg.groups[0].spend_usd, 150) && eqf(agg.groups[1].spend_usd, 25.005))
ok('requests accumulated per group', agg.groups[0].requests === 8 && agg.groups[1].requests === 2)
ok('every group carries a label', agg.groups.every((g) => g.label && g.label.startsWith('grp-')))
ok('null rows → ungrouped remainder (not dropped)', eqf(agg.ungrouped.spend_usd, 1.5) && agg.ungrouped.requests === 2)
ok('daily series per (date, group)', agg.daily.length === 3 && agg.daily[0].date === '2026-07-01')
ok('daily spend in USD', eqf(agg.daily.find((d) => d.date === '2026-07-02' && d.group_id === G_A).spend, 50))
ok('empty body → empty aggregates', aggregateGroupCost({}).groups.length === 0 && eqf(aggregateGroupCost({}).ungrouped.spend_usd, 0))

// ── deriveGroupMap ─────────────────────────────────────────────────────────
// user_cost_report grouped by rbac_group_id: one row per (actor, group).
// Upstream attribution is any-membership, so map values are ARRAYS of every
// group the user appears in, spend-desc ([0] = max-spend group). A single-
// value collapse dropped whole groups from the tab list whenever they were
// nobody's top group.
const rows = [
  { actor: { type: 'user_actor', email: 'Alice@Acme.com' }, rbac_group_id: G_A, amount: '9000' },
  { actor: { type: 'user_actor', email: 'alice@acme.com' }, rbac_group_id: G_B, amount: '1000' },
  { actor: { type: 'user_actor', email: 'bob@acme.com' },   rbac_group_id: G_B, amount: '500' },
  { actor: { type: 'user_actor', email: 'carol@acme.com' }, rbac_group_id: null, amount: '700' },  // no group → skipped
  { actor: { type: 'api_actor', api_key_id: 'k1' },         rbac_group_id: G_A, amount: '999' },   // no email → skipped
]
const dm = deriveGroupMap(rows)
const labelOf = (gid) => Object.entries(dm.ids).find(([, id]) => id === gid)?.[0]
ok('emails lowercased, memberships spend-desc (max-spend first)',
  dm.map['alice@acme.com'][0] === labelOf(G_A) && dm.map['alice@acme.com'][1] === labelOf(G_B) && !!labelOf(G_A))
ok('single-group user maps to a one-element array', dm.map['bob@acme.com'].length === 1 && dm.map['bob@acme.com'][0] === labelOf(G_B))
ok('ungrouped + api_actor rows skipped', !('carol@acme.com' in dm.map) && Object.keys(dm.map).length === 2)
ok('groups = sorted unique labels present in map', dm.groups.length === 2 && [...dm.groups].sort().join() === dm.groups.join())
ok('group that is nobody\'s top group still appears in groups', (() => {
  // G_B is only ever a secondary membership here — it must survive.
  const d = deriveGroupMap([
    { actor: { email: 'a@x.com' }, rbac_group_id: G_A, amount: '900' },
    { actor: { email: 'a@x.com' }, rbac_group_id: G_B, amount: '100' },
    { actor: { email: 'b@x.com' }, rbac_group_id: G_A, amount: '800' },
    { actor: { email: 'b@x.com' }, rbac_group_id: G_B, amount: '50' },
  ])
  return d.groups.length === 2
})())
ok('ids is label → full group id lookup', Object.values(dm.ids).includes(G_A) && Object.values(dm.ids).includes(G_B))
ok('empty / non-array → empty map', deriveGroupMap(null).groups.length === 0 && deriveGroupMap([]).groups.length === 0)
ok('non-numeric amount → treated as 0 (no NaN poisoning)', (() => {
  const d = deriveGroupMap([
    { actor: { email: 'x@y.com' }, rbac_group_id: G_A, amount: 'abc' },
    { actor: { email: 'x@y.com' }, rbac_group_id: G_B, amount: '100' },
  ])
  return d.map['x@y.com'][0] === Object.entries(d.ids).find(([, id]) => id === G_B)?.[0]
})())

// Real group names (from GET /v1/compliance/groups) override grp- labels.
const named = deriveGroupMap(rows, { [G_A]: 'Engineering', [G_B]: 'Marketing' })
ok('names map overrides grp- labels', named.map['alice@acme.com'][0] === 'Engineering' && named.map['bob@acme.com'][0] === 'Marketing')
ok('multi-group user carries every named membership', named.map['alice@acme.com'].join() === 'Engineering,Marketing')
ok('ids lookup keyed by real name', named.ids['Engineering'] === G_A)
ok('partial names map: unnamed ids keep grp- fallback', (() => {
  const d = deriveGroupMap(rows, { [G_A]: 'Engineering' })
  return d.map['alice@acme.com'][0] === 'Engineering' && d.map['bob@acme.com'][0].startsWith('grp-')
})())
ok('duplicate group names disambiguated with id suffix', (() => {
  const d = deriveGroupMap(rows, { [G_A]: 'Team', [G_B]: 'Team' })
  const labels = new Set([d.map['alice@acme.com'][0], d.map['bob@acme.com'][0]])
  return labels.size === 2 && [...labels].every((l) => l.startsWith('Team'))
})())
ok('suffix collision among same-named groups extends until unique (labels stay invertible)', (() => {
  // Three groups named 'Team' whose ids all share the same trailing 4 chars.
  const rows3 = [
    { actor: { email: 'p@x.com' }, rbac_group_id: 'rbac_group_0001zz99', amount: '3' },
    { actor: { email: 'q@x.com' }, rbac_group_id: 'rbac_group_0002zz99', amount: '2' },
    { actor: { email: 'r@x.com' }, rbac_group_id: 'rbac_group_0003zz99', amount: '1' },
  ]
  const names = { rbac_group_0001zz99: 'Team', rbac_group_0002zz99: 'Team', rbac_group_0003zz99: 'Team' }
  const d = deriveGroupMap(rows3, names)
  return d.groups.length === 3 && Object.keys(d.ids).length === 3
})())

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
