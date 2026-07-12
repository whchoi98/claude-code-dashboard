// Standalone ESM tests for makeTtlCache (server/aws.js) — the success-TTL
// cache with stale-while-revalidate + in-flight dedup used by /cost/live and
// /cost/groups.
// Runs with: node tests/server/test-cost-cache.mjs — exit 0 on success, 1 on failure.
import { makeTtlCache, fetchAllReportPages } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }
const tick = () => new Promise((r) => setImmediate(r))

// Injectable clock
let clock = 0
const now = () => clock

// ── fresh hit serves cache without refetch ─────────────────────────────────
{
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  const fetcher = async () => ({ v: ++calls })
  const a = await cached('k', fetcher)
  clock += 500
  const b = await cached('k', fetcher)
  ok('fresh hit returns cached value with one fetch', a.v === 1 && b.v === 1 && calls === 1)
}

// ── expired hit: stale served immediately, background refresh lands ────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  const fetcher = async () => ({ v: ++calls })
  await cached('k', fetcher)              // v1 at t=0
  clock = 1500                            // expired
  const stale = await cached('k', fetcher)
  ok('expired hit serves stale immediately', stale.v === 1)
  await tick(); await tick()              // let background refresh settle
  const next = await cached('k', fetcher)
  ok('background refresh replaced the entry', next.v === 2 && calls === 2)
}

// ── refresh failure degrades the entry: served copies carry stale:true ─────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  const fetcher = async () => { calls++; if (calls === 2 || calls === 3) throw new Error('flap'); return { v: calls } }
  await cached('k', fetcher)                    // v1 at t=0
  clock = 1500
  const first = await cached('k', fetcher)      // kicks refresh #2 (fails)
  await tick(); await tick()
  const degraded = await cached('k', fetcher)   // failure recorded → marked copy; kicks #3 (fails)
  await tick(); await tick()
  ok('first expired serve is unmarked; post-failure serves carry stale:true',
    first.v === 1 && first.stale === undefined && degraded.v === 1 && degraded.stale === true)
  const kick = await cached('k', fetcher)       // kicks refresh #4 (succeeds)
  await tick(); await tick()
  const recovered = await cached('k', fetcher)
  ok('a successful refresh clears the degraded flag',
    kick.stale === true && recovered.v === 4 && recovered.stale === undefined)
}

// ── beyond maxAge the entry is dropped — failures reach the caller ──────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, maxAgeMs: 3000, now })
  let calls = 0
  const fetcher = async () => { calls++; if (calls > 1) throw new Error('down'); return { v: 1 } }
  await cached('k', fetcher)
  clock = 5000                                  // past maxAge
  let threw = false
  try { await cached('k', fetcher) } catch { threw = true }
  ok('beyond maxAge the stale entry is dropped and the failure propagates', threw && calls === 2)
}

// ── concurrent cold misses share ONE in-flight fetch ───────────────────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const fetcher = async () => { calls++; await gate; return { v: calls } }
  const p1 = cached('k', fetcher)
  const p2 = cached('k', fetcher)
  release()
  const [a, b] = await Promise.all([p1, p2])
  ok('concurrent cold misses dedupe to one fetch', calls === 1 && a.v === 1 && b === a)
}

// ── expired entries dedupe the background refresh too ──────────────────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const fetcher = async () => { calls++; if (calls > 1) await gate; return { v: calls } }
  await cached('k', fetcher)              // v1
  clock = 1500
  await cached('k', fetcher)              // kicks background refresh (held at gate)
  await cached('k', fetcher)              // must NOT kick a second one
  release(); await tick(); await tick()
  ok('expired hits dedupe the background refresh', calls === 2)
}

// ── cold fetch failure propagates and is not cached ────────────────────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  const fetcher = async () => { calls++; if (calls === 1) throw new Error('boom'); return { v: calls } }
  let threw = false
  try { await cached('k', fetcher) } catch { threw = true }
  const after = await cached('k', fetcher)
  ok('cold failure propagates, next call refetches', threw && after.v === 2)
}

// ── cap evicts the oldest entry ─────────────────────────────────────────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 100_000, cap: 2, now })
  const counts = {}
  const f = (k) => async () => { counts[k] = (counts[k] || 0) + 1; return k }
  await cached('a', f('a'))
  await cached('b', f('b'))
  await cached('c', f('c'))   // evicts 'a'
  await cached('a', f('a'))   // must refetch
  await cached('c', f('c'))   // still cached
  ok('cap evicts oldest insertion; survivors stay cached', counts.a === 2 && counts.c === 1)
}

// ── distinct keys are independent ───────────────────────────────────────────
{
  clock = 0
  const cached = makeTtlCache({ ttlMs: 1000, now })
  let calls = 0
  const fetcher = async () => ({ v: ++calls })
  const a = await cached('k1', fetcher)
  const b = await cached('k2', fetcher)
  ok('distinct keys fetch independently', a.v === 1 && b.v === 2 && calls === 2)
}

// ── fetchAllReportPages passes a per-page abort signal (hung-fetch guard) ───
{
  const seen = []
  const fetchImpl = async (_url, opts) => {
    seen.push(opts)
    return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) }
  }
  await fetchAllReportPages('http://upstream.test/report?a=1', { 'x-api-key': 't' }, fetchImpl)
  ok('upstream report pages carry an AbortSignal timeout', seen.length === 1 && seen[0].signal instanceof AbortSignal)
}

console.log(`# cost-cache: ${n - failed}/${n} passed`)
process.exit(failed === 0 ? 0 : 1)
