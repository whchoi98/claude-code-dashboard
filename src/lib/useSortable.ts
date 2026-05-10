import { useState, useMemo, useCallback } from 'react'

/**
 * Reusable column-sort state for dashboard tables.
 *
 * Click a column → if it's the active column, flip asc/desc; otherwise
 * switch to that column with the column's `defaultDir` (or 'desc').
 * `null`/`undefined` values are always pushed to the bottom regardless
 * of direction so they don't pollute the visible top of the leaderboard.
 *
 * Usage:
 *   const accessors = {
 *     user:    (u) => u.email,             // string
 *     score:   (u) => u.score,             // number
 *     spend:   (u) => u.spend_usd,
 *     cost_per_loc: (u) => u.cost_per_loc, // nullable
 *   }
 *   const { rows, sortKey, sortDir, toggle } = useSortable(users, accessors, {
 *     initialKey: 'score',
 *     initialDir: 'desc',
 *   })
 *   <SortableTh label="Score" k="score" sortKey={sortKey} sortDir={sortDir} onClick={toggle} />
 */
export type SortDir = 'asc' | 'desc'
export type SortValue = string | number | null | undefined

export interface SortableOptions<K extends string> {
  initialKey: K
  initialDir?: SortDir
}

export function useSortable<T, K extends string>(
  items: T[],
  accessors: Record<K, (item: T) => SortValue>,
  opts: SortableOptions<K>,
) {
  const [sortKey, setSortKey] = useState<K>(opts.initialKey)
  const [sortDir, setSortDir] = useState<SortDir>(opts.initialDir ?? 'desc')

  const toggle = useCallback((k: K) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      setSortDir(opts.initialDir ?? 'desc')
    }
  }, [sortKey, opts.initialDir])

  const rows = useMemo(() => {
    const get = accessors[sortKey]
    if (!get) return items
    const dirMul = sortDir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      // Nulls always last regardless of direction
      const aNull = av == null
      const bNull = bv == null
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dirMul
      return String(av).localeCompare(String(bv)) * dirMul
    })
  }, [items, accessors, sortKey, sortDir])

  return { rows, sortKey, sortDir, toggle }
}
