const nf = new Intl.NumberFormat('en-US')
const cf = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const pf = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })

export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : nf.format(n))

export const fmtCompact = (n: number | null | undefined) => {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return nf.format(n)
}

export const fmtCents = (cents: number | null | undefined) => (cents == null ? '—' : cf.format(cents / 100))

export const fmtPct = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : pf.format(x))

export const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const acceptRate = (a: number, r: number) => {
  const t = a + r
  return t === 0 ? null : a / t
}

/**
 * Privacy-preserving email mask.
 * Keeps the first 2 chars of the local part, replaces the rest with '*',
 * and keeps the domain visible.
 *   alice.kim@acme.com  →  al*******@acme.com
 *   brian.park@acme.com →  br*********@acme.com
 *   ab@x.com            →  ab@x.com        (local part ≤ 2 chars: returned
 *   a@x.com             →  a@x.com          unchanged — nothing to mask
 *                                            without erasing the whole local)
 */
// Identity-aware masking (ADR-0020): main.tsx resolves GET /api/me BEFORE
// React mounts and flips this flag for the Cognito 'unmasked' group. Fixed
// pre-mount, so every maskEmail call site behaves consistently without
// re-render plumbing; the server decides (fail-closed) — this flag only
// mirrors its verdict for display.
let UNMASKED = false
export function setUnmasked(v: boolean): void { UNMASKED = v }
// For maskers that live outside this module (Compliance's maskEmailsInText
// handles %40-encoded emails inside recorded url/request_body text) — they
// must follow the same identity verdict as maskEmail.
export function isUnmasked(): boolean { return UNMASKED }

export function maskEmail(email: string | null | undefined): string {
  if (!email) return ''
  if (UNMASKED) return email
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return email
  const masked = local.slice(0, 2) + '*'.repeat(Math.max(3, local.length - 2))
  return masked + domain
}

/**
 * Map a range-day `source` value to the PageHeader badge domain. Every
 * non-mock source ('live', 's3', or a degraded day inside real data) is
 * REAL data — the old inline cast rendered 's3'/'unarchived' first days as
 * a "Mock" badge. Mock only ever appears on keyless dev servers.
 */
export function badgeSource(source: string | undefined): 'live' | 'mock' | undefined {
  if (!source) return undefined
  return source === 'mock' ? 'mock' : 'live'
}
