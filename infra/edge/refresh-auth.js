// CloudFront viewer-request for /refreshauth.
// Called when check-auth detects an expired access token but a refresh
// token still exists. Swaps the refresh token for a new access/id token.

'use strict'
const shared = require('./_shared.js')

exports.handler = async (event) => {
  const req = event.Records[0].cf.request
  const qs = new URLSearchParams(req.querystring || '')
  let returnTo = decodeURIComponent(qs.get('return') || '/')
  if (!returnTo.startsWith('/')) returnTo = '/'

  const cookies = shared.parseCookies(req.headers)
  const refresh = cookies[shared.COOKIE.refresh]
  if (!refresh) return shared.redirect(returnTo)  // check-auth will reroute to /authorize

  const basic = Buffer.from(`${shared.CONFIG.clientId}:${shared.CONFIG.clientSecret}`).toString('base64')
  const tokRes = await fetch(shared.ENDPOINTS.token, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refresh,
    }).toString(),
  })

  if (!tokRes.ok) {
    // Refresh failed — clear cookies so check-auth sends user to /authorize.
    return shared.redirect(returnTo, {
      'set-cookie': [
        { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.access)  },
        { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.id)      },
        { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.refresh) },
      ],
    })
  }

  const tokens = await tokRes.json()
  const accessMaxAge = tokens.expires_in || 3600

  // Cognito's refresh grant does NOT rotate the refresh_token; keep it.
  return shared.redirect(returnTo, {
    'set-cookie': [
      { key: 'Set-Cookie', value: shared.setCookieHeader(shared.COOKIE.access, tokens.access_token, { maxAge: accessMaxAge }) },
      { key: 'Set-Cookie', value: shared.setCookieHeader(shared.COOKIE.id,     tokens.id_token,     { maxAge: accessMaxAge }) },
    ],
  })
}
