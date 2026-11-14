// Copy of isIpAllowlistBlock from server/ip-allowlist.js — the Lambda bundle
// holds only this directory. tests/server/test-ip-allowlist.mjs checks the
// two agree. See docs/runbooks/ip-allowlist.md.
//
// HTTP 403 `permission_error` "Your IP address isn't in this organization's
// allowed range." = the organization's IP allowlist refused this function's
// egress address. Not a key problem; retrying never helps.
export function isIpAllowlistBlock(status, body) {
  if (status !== 403) return false
  const err = body?.error
  if (!err || typeof err !== 'object') return false
  return err.type === 'permission_error' && /allowed range/i.test(String(err.message || ''))
}
