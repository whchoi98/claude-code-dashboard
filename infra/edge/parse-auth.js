// CloudFront viewer-request for /parseauth.
// Cognito redirects the user back here with `?code=...&state=...`.
// We exchange the code for tokens and set HttpOnly cookies, then send the
// user back to the originally-requested page (encoded in state).

'use strict'
const shared = require('./_shared.js')

exports.handler = async (event) => {
  const req = event.Records[0].cf.request

  const qs = new URLSearchParams(req.querystring || '')
  const code  = qs.get('code')
  const state = qs.get('state')
  const error = qs.get('error')

  if (error) {
    return shared.htmlError(400, `<h2>Login error</h2><p><b>${error}</b>: ${qs.get('error_description') || ''}</p><p><a href="/">Try again</a></p>`)
  }
  if (!code) {
    return shared.htmlError(400, `<h2>Missing authorization code</h2><p><a href="/">Return home</a></p>`)
  }

  const host = req.headers.host && req.headers.host[0] && req.headers.host[0].value
  const redirectUri = `https://${host}/parseauth`
  const basic = Buffer.from(`${shared.CONFIG.clientId}:${shared.CONFIG.clientSecret}`).toString('base64')

  const tokRes = await fetch(shared.ENDPOINTS.token, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  })

  if (!tokRes.ok) {
    const detail = await tokRes.text()
    return shared.htmlError(500, `<h2>Token exchange failed</h2><pre>${detail.slice(0, 400)}</pre>`)
  }
  const tokens = await tokRes.json()

  // Sanity: verify id_token before accepting
  try { await shared.verifyJwt(tokens.id_token, 'id') }
  catch (e) { return shared.htmlError(500, `<h2>Invalid id_token</h2><p>${e.message}</p>`) }

  let returnTo = '/'
  try {
    if (state) {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
      if (typeof decoded.r === 'string' && decoded.r.startsWith('/')) returnTo = decoded.r
    }
  } catch (_e) {}

  const accessMaxAge = tokens.expires_in || 3600
  return shared.redirect(returnTo, {
    'set-cookie': [
      { key: 'Set-Cookie', value: shared.setCookieHeader(shared.COOKIE.access,  tokens.access_token, { maxAge: accessMaxAge }) },
      { key: 'Set-Cookie', value: shared.setCookieHeader(shared.COOKIE.id,      tokens.id_token,     { maxAge: accessMaxAge }) },
      { key: 'Set-Cookie', value: shared.setCookieHeader(shared.COOKIE.refresh, tokens.refresh_token, { maxAge: 30 * 24 * 3600 }) },
    ],
  })
}
