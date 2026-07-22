import { useT } from '../lib/i18n'
import { fmtNum } from '../lib/format'

/**
 * Honest one-line banner for range-endpoint responses that could not cover
 * the whole requested window. The /range family serves the S3 archive first
 * and falls back to the live API within a bounded per-request budget, so a
 * long window can contain days with no data at all: days before the archive
 * began (or beyond the live budget) come back source:'unarchived', upstream
 * failures come back source:'upstream_error' — both zero-filled. Pages label
 * their windows from URL state, so without this banner those zero days would
 * silently read as "no activity".
 */
export type RangeCoverage = {
  requested_days: number
  s3_days: number
  live_days: number
  unarchived_days: number
  error_days: number
}

// `days` is declared so the pages' locally-typed RangeResp objects (which
// don't re-declare `coverage`) still share a property with this prop type —
// TS rejects weak-type assignments with no overlap. Pages that fan out to
// SEVERAL range endpoints (Adoption: skills+connectors+projects) pass an
// array; the banner reports the worst coverage among them.
type Resp = { coverage?: RangeCoverage; days?: unknown[] } | null | undefined
export function RangeCoverageNote({ resp }: { resp?: Resp | Resp[] }) {
  const t = useT()
  const list = (Array.isArray(resp) ? resp : [resp]).map((r) => r?.coverage).filter((c): c is RangeCoverage => !!c)
  const c = list.sort((a, b) => (b.unarchived_days + b.error_days) - (a.unarchived_days + a.error_days))[0]
  if (!c || (c.unarchived_days === 0 && c.error_days === 0)) return null
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
      {t('range.coverage.partial', {
        n: fmtNum(c.unarchived_days + c.error_days),
        total: fmtNum(c.requested_days),
        unarchived: fmtNum(c.unarchived_days),
        errors: fmtNum(c.error_days),
      })}
    </div>
  )
}
