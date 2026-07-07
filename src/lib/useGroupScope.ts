import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useGroupScopeData } from './GroupScopeProvider'

/** Sentinel group value: users NOT present in the uploaded mapping. */
export const UNMAPPED = '__unmapped__'

/**
 * Global group-scope state. Combines the shared email→groups map (provided
 * once by GroupScopeProvider, values normalized to membership arrays) with a
 * URL-synced `?group=` selection. `inGroup(email)` is the predicate every
 * scoped page applies in its per-user aggregation:
 *   - group === ''            → All (everyone)
 *   - group === UNMAPPED      → email NOT in the mapping
 *   - else                    → map[email_lower] includes group (any-membership)
 */
export function useGroupScope() {
  const [params, setParams] = useSearchParams()
  const { groups, map, hasMap, loading, refetch } = useGroupScopeData()

  const rawGroup = params.get('group') ?? ''
  // Fall back to "All" if the selected name is no longer present in the map.
  const group = rawGroup === UNMAPPED || groups.includes(rawGroup) ? rawGroup : ''

  const setGroup = useCallback((g: string) => {
    const next = new URLSearchParams(params)
    if (!g) next.delete('group')
    else next.set('group', g)
    setParams(next, { replace: true })
  }, [params, setParams])

  const inGroup = useCallback((email: string | null | undefined): boolean => {
    if (!group) return true
    const e = (email ?? '').toLowerCase()
    // own-key check (not `in`) so an email literally named "toString" etc.
    // can't match a prototype member and be miscounted as mapped.
    if (group === UNMAPPED) return !Object.prototype.hasOwnProperty.call(map, e)
    return Object.prototype.hasOwnProperty.call(map, e) && map[e].includes(group)
  }, [group, map])

  return { group, setGroup, groups, hasMap, loading, inGroup, refetch }
}
