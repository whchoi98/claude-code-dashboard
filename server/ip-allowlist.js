// IP-allowlist block detection (docs/runbooks/ip-allowlist.md).
//
// Since 2026-11-05 (beta) an organization owner can restrict the org to a
// list of IP ranges in claude.ai > Organization settings > Organization and
// access. The list also covers the Admin API and the Compliance API called
// with a key for that organization: a request from an address outside it is
// refused with HTTP 403 `permission_error`, "Your IP address isn't in this
// organization's allowed range." For this dashboard that is not a key
// problem and retrying never helps — the fix is to add the deployment's
// egress addresses to the list — so it gets its own signal instead of
// drowning in the generic upstream-error paths.
//
// Pure and dependency-free; unit-tested in tests/server/test-ip-allowlist.mjs.
// collector/ip-allowlist.js is a copy (the Lambda bundle holds only collector/).

export function isIpAllowlistBlock(status, body) {
  if (status !== 403) return false
  const err = body?.error
  if (!err || typeof err !== 'object') return false
  return err.type === 'permission_error' && /allowed range/i.test(String(err.message || ''))
}

// A block is reported for this long after it was last seen. The compliance
// prewarm calls upstream every 5 minutes, so a standing block keeps
// refreshing itself; once the list is fixed the next success clears it.
export const IP_BLOCK_TTL_MS = 15 * 60_000

// Remembers, per API key, when Anthropic last refused this server's address.
export function makeIpBlockTracker({ now = Date.now, ttlMs = IP_BLOCK_TTL_MS } = {}) {
  const seen = new Map()   // key → epoch ms of the latest block
  return {
    record(key) { if (key) seen.set(key, now()) },
    clear(key) { if (key) seen.delete(key) },
    blockedAt(key) {
      const at = key ? seen.get(key) : undefined
      if (at === undefined) return null
      if (now() - at > ttlMs) { seen.delete(key); return null }
      return new Date(at).toISOString()
    },
  }
}
