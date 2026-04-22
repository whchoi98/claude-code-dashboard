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
 *   - 3-day buffer → ending date clamped to today - 3
 *   - Max 90-day lookback
 *   - Summaries endpoint max 31-day range
 */

export type Preset = '7d' | '14d' | '30d' | 'custom'

export interface DateRange {
  startingDate: string   // inclusive, YYYY-MM-DD
  endingDate:   string   // inclusive, YYYY-MM-DD (for `?date=` single-day calls, use endingDate)
  preset:       Preset
  days:         number   // inclusive day count
}

const FIRST_AVAILABLE = '2026-01-01'
const BUFFER_DAYS = 3

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
    case '7d':  return 7
    case '14d': return 14
    case '30d': return 30
    default:    return 14
  }
}

export function useDateRange(defaultPreset: Preset = '14d') {
  const [params, setParams] = useSearchParams()

  const maxEnd = todayMinusDaysUtc(BUFFER_DAYS)
  const maxStart = todayMinusDaysUtc(BUFFER_DAYS + 90)

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
    const preset: Preset = ['7d', '14d', '30d'].includes(rawPreset) ? rawPreset : defaultPreset
    const days = presetToDays(preset)
    const endingDate = maxEnd
    const startingDate = clamp(todayMinusDaysUtc(BUFFER_DAYS + days - 1), FIRST_AVAILABLE, endingDate)
    return { startingDate, endingDate, preset, days }
  }, [rawPreset, rawStart, rawEnd, maxEnd, defaultPreset])

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
