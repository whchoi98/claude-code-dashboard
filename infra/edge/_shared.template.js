// Shared config/helpers inlined into every Lambda@Edge entry.
//
// Lambda@Edge has no env vars, so Cognito identifiers MUST be baked into the
// source zip at deploy time. To avoid committing secrets to git, this file is
// a *template*: the CONFIG block below is a placeholder, and the build
// script (scripts/build-edge.mjs) replaces the sentinel with values pulled
// from Secrets Manager (secret id `ccd/cognito-config`) to produce the real
// `_shared.js` that CDK packages into the Lambda zip.
//
// The generated `_shared.js` is in .gitignore. If you are reading this file
// and looking for the secret — it is not here on purpose.

'use strict'
const crypto = require('crypto')

// Do not inline real values below. The build script replaces the entire
// sentinel expression with a JSON literal. Keep the dummy shape so that
// static analysis / node --check still parses this template.
const CONFIG = /*__CCD_COGNITO_CONFIG__*/{
  userPoolId:     '',
  userPoolRegion: '',
  clientId:       '',
  clientSecret:   '',
  domain:         '',
}/*__END_COGNITO_CONFIG__*/

const ENDPOINTS = {
  jwks:      `https://cognito-idp.${CONFIG.userPoolRegion}.amazonaws.com/${CONFIG.userPoolId}/.well-known/jwks.json`,
  authorize: `https://${CONFIG.domain}.auth.${CONFIG.userPoolRegion}.amazoncognito.com/oauth2/authorize`,
  token:     `https://${CONFIG.domain}.auth.${CONFIG.userPoolRegion}.amazoncognito.com/oauth2/token`,
  logout:    `https://${CONFIG.domain}.auth.${CONFIG.userPoolRegion}.amazoncognito.com/logout`,
  issuer:    `https://cognito-idp.${CONFIG.userPoolRegion}.amazonaws.com/${CONFIG.userPoolId}`,
}

const COOKIE = {
  access:  'ccd_access',
  id:      'ccd_id',
  refresh: 'ccd_refresh',
}

// JWKs cache (per Lambda@Edge container instance, per edge location)
let jwksCache = null
let jwksExpiresAt = 0

async function getJwks() {
  const now = Date.now()
  if (jwksCache && now < jwksExpiresAt) return jwksCache
  const res = await fetch(ENDPOINTS.jwks)
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
  jwksCache = await res.json()
  jwksExpiresAt = now + 5 * 60 * 1000
  return jwksCache
}

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

async function verifyJwt(token, expectedUse /* 'access' | 'id' */) {
  if (!token) throw new Error('no token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed jwt')
  const [h64, p64, s64] = parts
  const header = JSON.parse(b64urlDecode(h64).toString('utf8'))
  const payload = JSON.parse(b64urlDecode(p64).toString('utf8'))

  const jwks = await getJwks()
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('kid not in jwks')
  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${h64}.${p64}`)
  const sig = b64urlDecode(s64)

  const algo = header.alg === 'RS256' ? 'RSA-SHA256' : null
  if (!algo) throw new Error(`unsupported alg: ${header.alg}`)
  const valid = crypto.verify(algo, data, pubKey, sig)
  if (!valid) throw new Error('bad signature')

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp <= now) throw new Error('expired')
  if (payload.iss !== ENDPOINTS.issuer) throw new Error('bad issuer')
  if (expectedUse && payload.token_use !== expectedUse) throw new Error(`expected token_use=${expectedUse}`)
  if (expectedUse === 'access' && payload.client_id !== CONFIG.clientId) throw new Error('bad client_id')
  if (expectedUse === 'id' && payload.aud !== CONFIG.clientId) throw new Error('bad aud')

  return payload
}

function parseCookies(headers) {
  const raw = (headers && headers.cookie) || []
  const out = {}
  for (const c of raw) {
    for (const part of String(c.value).split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) {
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
      }
    }
  }
  return out
}

function setCookieHeader(name, value, opts = {}) {
  const maxAge = opts.maxAge != null ? opts.maxAge : 3600
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
  ]
  return parts.join('; ')
}

function clearCookieHeader(name) {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`
}

function redirect(location, extraHeaders = {}) {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: Object.assign({
      location:        [{ key: 'Location',      value: location }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      pragma:          [{ key: 'Pragma',        value: 'no-cache' }],
    }, extraHeaders),
  }
}

function htmlError(status, body) {
  return {
    status: String(status),
    statusDescription: status === 400 ? 'Bad Request' : 'Error',
    headers: {
      'content-type':  [{ key: 'Content-Type',  value: 'text/html; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
    body: `<!doctype html><html><body style="font:14px system-ui;padding:40px;max-width:600px;margin:auto">${body}</body></html>`,
  }
}

module.exports = {
  CONFIG, ENDPOINTS, COOKIE,
  verifyJwt, parseCookies,
  setCookieHeader, clearCookieHeader,
  redirect, htmlError,
}
