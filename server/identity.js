// Cognito ID-token verification from the ccd_id cookie (set by the
// Lambda@Edge auth handlers — infra/edge/_shared.template.js) → the caller's
// identity { email, unmask, groups }. The verification checks mirror the
// edge's verifyJwt: JWKS RS256 signature, iss, aud, exp, token_use === 'id'.
// unmask is true ONLY for a fully-valid token whose cognito:groups contains
// UNMASK_GROUP — every failure path (no cookie, malformed, expired, bad
// signature, wrong aud/iss/use, missing config, JWKS outage) fails CLOSED to
// the anonymous masked identity. Node 20 built-in crypto only — no deps.
import crypto from 'node:crypto'

export const UNMASK_GROUP = 'unmasked'
const ANON = Object.freeze({ email: null, unmask: false, groups: [] })
const JWKS_TTL_MS = 60 * 60 * 1000
// The /api-wide middleware awaits this fetch inside EVERY request — it must
// be hard-bounded well under CloudFront's 60s origin timeout (same rationale
// as fetchJson's 30s signal; an unbounded undici fetch hangs ~300s).
const JWKS_FETCH_TIMEOUT_MS = 5_000

const b64urlDecode = (s) => Buffer.from(s, 'base64url')

function cookieValue(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch { return null }
    }
  }
  return null
}

// makeIdentityResolver({ userPoolId, clientId, region, fetchImpl?, nowMs? })
// → async (cookieHeader) => { email, unmask, groups }. JWKS is cached per
// resolver instance for JWKS_TTL_MS (one resolver per process in prod).
export function makeIdentityResolver({ userPoolId, clientId, region, fetchImpl = fetch, nowMs = () => Date.now() } = {}) {
  const issuer = userPoolId && region ? `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` : null
  let jwksCache = null
  let jwksExpiresAt = 0
  let jwksInFlight = null

  const getJwks = async () => {
    if (jwksCache && nowMs() < jwksExpiresAt) return jwksCache
    // In-flight dedup: a SPA boot fires dozens of parallel /api requests
    // before the first cold-cache fetch lands — they must all share one.
    jwksInFlight ||= (async () => {
      const res = await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`jwks fetch ${res.status}`)
      const body = await res.json()
      jwksCache = body
      jwksExpiresAt = nowMs() + JWKS_TTL_MS
      return body
    })().finally(() => { jwksInFlight = null })
    try {
      return await jwksInFlight
    } catch (err) {
      // Stale beats missing: Cognito signing keys effectively never rotate,
      // and serving an expired key set grants nothing (verification still
      // requires a genuine signature) — while failing here would turn a
      // Cognito outage into every request paying a failed round-trip.
      if (jwksCache) return jwksCache
      throw err
    }
  }

  return async function resolve(cookieHeader) {
    if (!issuer || !clientId) return ANON
    const token = cookieValue(cookieHeader, 'ccd_id')
    if (!token) return ANON
    try {
      const parts = token.split('.')
      if (parts.length !== 3) throw new Error('malformed jwt')
      const [h64, p64, s64] = parts
      const header = JSON.parse(b64urlDecode(h64).toString('utf8'))
      const payload = JSON.parse(b64urlDecode(p64).toString('utf8'))
      if (header.alg !== 'RS256') throw new Error(`unsupported alg: ${header.alg}`)

      const jwks = await getJwks()
      const jwk = (jwks.keys || []).find((k) => k.kid === header.kid)
      if (!jwk) throw new Error('kid not in jwks')
      const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
      const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h64}.${p64}`), pubKey, b64urlDecode(s64))
      if (!valid) throw new Error('bad signature')

      if (payload.exp == null || payload.exp <= Math.floor(nowMs() / 1000)) throw new Error('expired')
      if (payload.iss !== issuer) throw new Error('bad issuer')
      if (payload.token_use !== 'id') throw new Error('not an id token')
      if (payload.aud !== clientId) throw new Error('bad aud')

      const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : []
      return { email: payload.email || null, unmask: groups.includes(UNMASK_GROUP), groups }
    } catch {
      return ANON
    }
  }
}
