// CloudFront viewer-request for /signout.
// Clears our cookies and redirects to Cognito's /logout which then bounces
// the user back to the site root with no session.

'use strict'
const shared = require('./_shared.js')

exports.handler = async (event) => {
  const req = event.Records[0].cf.request
  const host = req.headers.host && req.headers.host[0] && req.headers.host[0].value

  const u = new URL(shared.ENDPOINTS.logout)
  u.searchParams.set('client_id',  shared.CONFIG.clientId)
  u.searchParams.set('logout_uri', `https://${host}/`)

  return shared.redirect(u.toString(), {
    'set-cookie': [
      { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.access)  },
      { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.id)      },
      { key: 'Set-Cookie', value: shared.clearCookieHeader(shared.COOKIE.refresh) },
    ],
  })
}
