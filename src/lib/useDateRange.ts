import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Shared date-range state for dashboard pages.
 *
 * Persists in the URL (`?range=7d` or `?start=...&end=...`) so links are
 * copy-pasteable and a page refresh preserves the selection.
 *
 * Respects Analytics API constraints:
 *   - Data starts 2026-01-01
 *   - Data is UTC and refreshes daily — the picker allows up to today,
 *     and the server returns whatever has finalized. The most recent
 *     ~3 days may show partial counts because the upstream Analytics
 *     buffer is still settling. The DateRangeControl footnote spells
 *     this out for the user.
 *   - Max 90-day lookback
 *   - Summaries endpoint max 31-day range
 */

export type Preset = '1d' | '7d' | '14d' | '30d' | 'custom'

export interface DateRange {
  startingDate: string   // inclusive, YYYY-MM-DD
  endingDate:   string   // inclusive, YYYY-MM-DD (for `?date=` single-day calls, use endingDate)
  preset:       Preset
  days:         number   // inclusive day count
}

const FIRST_AVAILABLE = '2026-01-01'

function todayMinusDaysUtc(n: number) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

function clamp(iso: string, min: string, max: string) {
  if (iso < min) return min
  if (iso > max) return max
  return iso
}

function daysBetween(a: string, b: string) {
  const da = new Date(`${a}T00:00:00Z`).getTime()
  const db = new Date(`${b}T00:00:00Z`).getTime()
  return Math.floor((db - da) / 86400000) + 1
}

function presetToDays(p: Preset): number {
  switch (p) {
    case '1d':  return 1
    case '7d':  return 7
    case '14d': return 14
    case '30d': return 30
    default:    return 14
  }
}

export interface DateRangeOptions {
  /**
   * When true, the '1d' preset targets TODAY instead of the most recent
   * finalized day (today−3). Only pages whose data source serves recent
   * partial days should opt in — the cost family has no buffer clamp
   * (~4h refresh watermark), while engagement endpoints clamp server-side
   * to today−3, so an engagement page opting in would render a label/data
   * mismatch. Pass the SAME options to the page's own useDateRange call
   * and to its <DateRangeControl> — each creates its own hook instance.
   */
  freshEnd?: boolean
}

export function useDateRange(defaultPreset: Preset = '7d', { freshEnd = false }: DateRangeOptions = {}) {
  const [params, setParams] = useSearchParams()

  const maxEnd = todayMinusDaysUtc(0)         // today (UTC)
  const maxStart = todayMinusDaysUtc(90)      // 90-day lookback floor

  const rawPreset = (params.get('range') as Preset | null) ?? defaultPreset
  const rawStart = params.get('start')
  const rawEnd = params.get('end')

  const range = useMemo<DateRange>(() => {
    if (rawPreset === 'custom' && rawStart && rawEnd) {
      const s = clamp(rawStart, FIRST_AVAILABLE, maxEnd)
      const e = clamp(rawEnd,   FIRST_AVAILABLE, maxEnd)
      const [startingDate, endingDate] = s <= e ? [s, e] : [e, s]
      return {
        startingDate,
        endingDate,
        preset: 'custom',
        days: daysBetween(startingDate, endingDate),
      }
    }
    const preset: Preset = ['1d', '7d', '14d', '30d'].includes(rawPreset) ? rawPreset : defaultPreset
    const days = presetToDays(preset)
    // '1d' = the GUARANTEED-finalized day (today-3) by default. The server's
    // engagement clamp is dynamic now (typically today−2, see
    // server/freshness.js), so today−3 is a conservative floor, not the real
    // horizon — it stays STATIC on purpose: the compliance prewarm must
    // predict the exact '1d' cache key the frontend sends, and a
    // health-driven dynamic day would desync the two whenever tasks learn
    // different values. Pages with buffer-free sources (Cost —
    // user_cost_report/user_usage_report serve today at a ~4h watermark) opt
    // into freshEnd so '1d' means TODAY. The multi-day presets always end at
    // today and rely on the server's per-endpoint clamping + the "partial
    // recent days" tolerance — THEY get the dynamic horizon's extra day
    // automatically.
    const endingDate = preset === '1d' && !freshEnd ? todayMinusDaysUtc(3) : maxEnd
    const startingDate = clamp(todayMinusDaysUtc(days - 1), FIRST_AVAILABLE, endingDate)
    return { startingDate, endingDate, preset, days }
  }, [rawPreset, rawStart, rawEnd, maxEnd, defaultPreset, freshEnd])

  const setPreset = useCallback((p: Preset) => {
    const next = new URLSearchParams(params)
    if (p === 'custom') {
      next.set('range', 'custom')
    } else {
      next.set('range', p)
      next.delete('start')
      next.delete('end')
    }
    setParams(next, { replace: true })
  }, [params, setParams])

  const setCustom = useCallback((start: string, end: string) => {
    const next = new URLSearchParams(params)
    next.set('range', 'custom')
    next.set('start', start)
    next.set('end', end)
    setParams(next, { replace: true })
  }, [params, setParams])

  return { range, setPreset, setCustom, maxEnd, maxStart, FIRST_AVAILABLE }
}
