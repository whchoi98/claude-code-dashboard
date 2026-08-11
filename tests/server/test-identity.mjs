// identity.js contract: Cognito ID-token verification from the ccd_id cookie
// → { email, unmask, groups }. unmask=true ONLY for a fully-valid token whose
// cognito:groups contains 'unmasked'; every failure path is fail-closed
// (unmask:false, email:null). JWKS is fetched via an injectable fetchImpl and
// cached across resolves.
// node tests/server/test-identity.mjs — exit 0 on success, 1 on failure.
import crypto from 'node:crypto'
import { makeIdentityResolver } from '../../server/identity.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// ── Fixtures: RSA keypair + hand-rolled RS256 JWT signer ───────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const { publicKey: otherPub, privateKey: otherPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
void otherPub

const REGION = 'ap-northeast-2'
const POOL = 'ap-northeast-2_TestPool1'
const CLIENT = 'testclientid123'
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`
const KID = 'test-key-1'

const b64url = (buf) => Buffer.from(buf).toString('base64url')
function signToken(payload, { key = privateKey, kid = KID } = {}) {
  const header = { alg: 'RS256', kid, typ: 'JWT' }
  const h64 = b64url(JSON.stringify(header))
  const p64 = b64url(JSON.stringify(payload))
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h64}.${p64}`), key)
  return `${h64}.${p64}.${b64url(sig)}`
}

const nowSec = Math.floor(Date.now() / 1000)
const claims = (over = {}) => ({
  token_use: 'id',
  iss: ISSUER,
  aud: CLIENT,
  exp: nowSec + 3600,
  email: 'admin@whchoi.net',
  'cognito:groups': ['unmasked'],
  ...over,
})

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }
let jwksFetches = 0
const fetchJwksOk = async (url) => {
  jwksFetches++
  if (!url.startsWith(ISSUER)) throw new Error(`unexpected jwks url: ${url}`)
  return { ok: true, json: async () => ({ keys: [jwk] }) }
}

const resolver = () => makeIdentityResolver({
  userPoolId: POOL, clientId: CLIENT, region: REGION, fetchImpl: fetchJwksOk,
})

const cookieFor = (token) => `foo=bar; ccd_id=${encodeURIComponent(token)}; other=1`

// ── Happy paths ─────────────────────────────────────────────────────────────
{
  const resolve = resolver()
  const id = await resolve(cookieFor(signToken(claims())))
  ok('valid token + unmasked group → unmask true', id.unmask === true)
  ok('valid token → email extracted', id.email === 'admin@whchoi.net')
  ok('valid token → groups exposed', Array.isArray(id.groups) && id.groups.includes('unmasked'))
}
{
  const resolve = resolver()
  const id = await resolve(cookieFor(signToken(claims({ 'cognito:groups': undefined, email: 'demo@whchoi.net' }))))
  ok('valid token WITHOUT groups claim → unmask false', id.unmask === false)
  ok('groupless token still identifies email', id.email === 'demo@whchoi.net')
}
{
  const resolve = resolver()
  const id = await resolve(cookieFor(signToken(claims({ 'cognito:groups': ['admins'] }))))
  ok('valid token with OTHER group → unmask false', id.unmask === false)
}

// ── Fail-closed paths (every one must yield unmask:false, email:null) ──────
const failClosed = async (name, cookieHeader, opts) => {
  const resolve = opts?.resolver || resolver()
  const id = await resolve(cookieHeader)
  ok(`${name} → unmask false`, id.unmask === false)
  ok(`${name} → email null`, id.email === null)
}

await failClosed('no cookie header', undefined)
await failClosed('cookie header without ccd_id', 'foo=bar; session=abc')
await failClosed('malformed token', cookieFor('not.a.jwt-at-all'))
await failClosed('expired token', cookieFor(signToken(claims({ exp: nowSec - 10 }))))
await failClosed('wrong signature (other key)', cookieFor(signToken(claims(), { key: otherPriv })))
await failClosed('wrong aud', cookieFor(signToken(claims({ aud: 'someone-else' }))))
await failClosed('wrong issuer', cookieFor(signToken(claims({ iss: 'https://evil.example.com/pool' }))))
await failClosed('access token (token_use mismatch)', cookieFor(signToken(claims({ token_use: 'access' }))))
await failClosed('kid not in jwks', cookieFor(signToken(claims(), { kid: 'unknown-kid' })))

// ── Missing config: resolver must fail closed WITHOUT fetching JWKS ────────
{
  const before = jwksFetches
  const resolve = makeIdentityResolver({ userPoolId: '', clientId: CLIENT, region: REGION, fetchImpl: fetchJwksOk })
  const id = await resolve(cookieFor(signToken(claims())))
  ok('missing userPoolId → unmask false', id.unmask === false)
  ok('missing userPoolId → no JWKS fetch', jwksFetches === before)
}

// ── JWKS caching: two resolves share one fetch ──────────────────────────────
{
  const before = jwksFetches
  const resolve = resolver()
  await resolve(cookieFor(signToken(claims())))
  await resolve(cookieFor(signToken(claims({ email: 'demo@whchoi.net', 'cognito:groups': undefined }))))
  ok('JWKS fetched once across two resolves', jwksFetches === before + 1)
}

// ── JWKS fetch failure: fail closed, not thrown ─────────────────────────────
{
  const resolve = makeIdentityResolver({
    userPoolId: POOL, clientId: CLIENT, region: REGION,
    fetchImpl: async () => { throw new Error('network down') },
  })
  const id = await resolve(cookieFor(signToken(claims())))
  ok('JWKS fetch failure → unmask false (no throw)', id.unmask === false)
}

// ── JWKS availability hardening (adversarial-review findings) ───────────────
// (a) The fetch must carry an abort signal — the /api-wide middleware awaits
// this in EVERY request path; an unbounded undici fetch (~300s headers
// timeout) would hang all /api traffic past CloudFront's 60s origin timeout.
{
  let seenSignal = null
  const resolve = makeIdentityResolver({
    userPoolId: POOL, clientId: CLIENT, region: REGION,
    fetchImpl: async (_url, opts) => { seenSignal = opts?.signal; return { ok: true, json: async () => ({ keys: [jwk] }) } },
  })
  await resolve(cookieFor(signToken(claims())))
  ok('JWKS fetch carries an AbortSignal', seenSignal instanceof AbortSignal)
}
// (b) Concurrent cold-cache resolves share ONE in-flight JWKS fetch — a SPA
// boot fires dozens of parallel /api requests before the first fetch lands.
{
  let fetches = 0
  const resolve = makeIdentityResolver({
    userPoolId: POOL, clientId: CLIENT, region: REGION,
    fetchImpl: async () => {
      fetches++
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, json: async () => ({ keys: [jwk] }) }
    },
  })
  const [a, b, c] = await Promise.all([
    resolve(cookieFor(signToken(claims()))),
    resolve(cookieFor(signToken(claims()))),
    resolve(cookieFor(signToken(claims()))),
  ])
  ok('concurrent cold resolves dedupe to one JWKS fetch', fetches === 1)
  ok('deduped resolves all verify', a.unmask && b.unmask && c.unmask)
}
// (c) A failed refresh serves the STALE cached JWKS instead of failing every
// request during a Cognito outage — Cognito signing keys effectively never
// rotate, so stale-beats-missing is strictly better for availability and
// grants nothing (verification still requires a genuine signature).
{
  let now = 1_000_000_000_000
  let fail = false
  const resolve = makeIdentityResolver({
    userPoolId: POOL, clientId: CLIENT, region: REGION, nowMs: () => now,
    fetchImpl: async () => {
      if (fail) throw new Error('cognito outage')
      return { ok: true, json: async () => ({ keys: [jwk] }) }
    },
  })
  const tokenAt = (sec) => cookieFor(signToken(claims({ exp: sec + 3600 })))
  const first = await resolve(tokenAt(now / 1000))
  now += 2 * 60 * 60 * 1000   // past the 1h JWKS TTL
  fail = true
  const second = await resolve(tokenAt(now / 1000))
  ok('stale JWKS served when refresh fails', first.unmask === true && second.unmask === true)
}

console.log(`\n${n - failed}/${n} passed`)
process.exit(failed ? 1 : 0)
