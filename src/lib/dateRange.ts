const DAY_MS = 86_400_000

export const FIRST_AVAILABLE = '2026-01-01'
// Keep in sync with MAX_RANGE_DAYS in server/index.js. This limits the
// inclusive window length, not how far back archived dates may be selected.
const MAX_RANGE_DAYS = 366

export function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

export function shiftDateUtc(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function daysBetweenUtc(start: string, end: string) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS + 1
}

function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  // Date parsing can roll February 30 into March; the round trip rejects it.
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

type DateRangeIssue =
  | { key: 'range.invalid' | 'range.order'; params?: undefined }
  | { key: 'range.bounds'; params: { start: string; end: string } }

export function validateCustomRange(
  start: string | null | undefined,
  end: string | null | undefined,
  maxEnd: string,
): DateRangeIssue | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return { key: 'range.invalid' }
  if (start > end) return { key: 'range.order' }
  if (start < FIRST_AVAILABLE || end > maxEnd) {
    return { key: 'range.bounds', params: { start: FIRST_AVAILABLE, end: maxEnd } }
  }
  if (daysBetweenUtc(start, end) > MAX_RANGE_DAYS) {
    return {
      key: 'range.bounds',
      params: { start: shiftDateUtc(end, -(MAX_RANGE_DAYS - 1)), end },
    }
  }
  return null
}
