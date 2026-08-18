// CloudFront viewer-request for the DEFAULT behavior.
// - Valid access-token cookie? → pass to origin.
// - Expired but refresh-token present? → /refreshauth for a silent refresh.
// - No tokens at all? → redirect to Cognito /oauth2/authorize.

'use strict'
const shared = require('./_shared.js')

exports.handler = async (event) => {
  const req = event.Records[0].cf.request
  const uri = req.uri || '/'

  // These behaviors have their own Lambda@Edge — defense in depth if
  // someone accidentally attaches check-auth everywhere.
  if (uri.startsWith('/parseauth')   ||
      uri.startsWith('/refreshauth') ||
      uri.startsWith('/signout')) {
    return req
  }

  // Non-sensitive PWA/static brand assets (2026-08-18 PWA spec): iOS fetches
  // apple-touch-icon — and sometimes the manifest — OUTSIDE the page's
  // cookie context when adding to the home screen; a 302-to-Cognito here
  // degrades the home-screen icon to a page screenshot. EXACT-match
  // allowlist only (brand tile PNGs + manifest, no data): everything else
  // stays gated.
  if (/^\/(apple-touch-icon\.png|icon-192\.png|icon-512\.png|icon-512-maskable\.png|manifest\.webmanifest|claude\.svg)$/.test(uri)) {
    return req
  }

  const cookies = shared.parseCookies(req.headers)
  const accessToken = cookies[shared.COOKIE.access]

  try {
    if (!accessToken) throw new Error('no access token')
    await shared.verifyJwt(accessToken, 'access')
    return req
  } catch (_err) {
    const returnTo = uri + (req.querystring ? '?' + req.querystring : '')

    // Silent refresh path
    if (cookies[shared.COOKIE.refresh]) {
      return shared.redirect(`/refreshauth?return=${encodeURIComponent(returnTo)}`)
    }

    // Full login: send user to Cognito /authorize
    const host = req.headers.host && req.headers.host[0] && req.headers.host[0].value
    const callback = `https://${host}/parseauth`
    const state = Buffer.from(JSON.stringify({ r: returnTo })).toString('base64url')

    const u = new URL(shared.ENDPOINTS.authorize)
    u.searchParams.set('client_id',     shared.CONFIG.clientId)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('scope',         'openid email profile')
    u.searchParams.set('redirect_uri',  callback)
    u.searchParams.set('state',         state)

    return shared.redirect(u.toString())
  }
}
