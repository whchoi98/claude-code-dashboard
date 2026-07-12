import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useFetch } from '../lib/api'

type GroupsResp = {
  // 'live' = admin-uploaded CSV · 'members' = real RBAC membership from the
  // Compliance members endpoint · 'auto' = spend-derived fallback from
  // user_cost_report × rbac_group_id · 'empty' = none available
  source: 'live' | 'members' | 'auto' | 'empty'
  file: string | null
  groups: string[]
  // lowercased email → group(s). CSV path sends a single string; the
  // members/auto paths send every membership as an array because filtering
  // is any-membership — a single-value collapse dropped groups that were
  // nobody's top group from the tab list entirely.
  map: Record<string, string | string[]>
}

export type GroupScopeData = {
  groups: string[]
  map: Record<string, string[]>   // normalized: always arrays
  hasMap: boolean
  loading: boolean
  refetch: () => Promise<void>
}

const EMPTY: GroupScopeData = { groups: [], map: {}, hasMap: false, loading: false, refetch: async () => {} }

const GroupScopeContext = createContext<GroupScopeData>(EMPTY)

/** Reads the shared group map from context. Consumed by useGroupScope. */
export function useGroupScopeData(): GroupScopeData {
  return useContext(GroupScopeContext)
}

/**
 * Fetches the admin email→group mapping (`GET /api/groups`) ONCE and shares it
 * via context, so the GroupTabs on every scoped page read one request and
 * a single refetch (after upload) refreshes all consumers.
 */
export function GroupScopeProvider({ children }: { children: ReactNode }) {
  const { data, loading, refetch } = useFetch<GroupsResp>('/api/groups')
  const value = useMemo<GroupScopeData>(() => {
    const groups = data?.groups ?? []
    const map = Object.fromEntries(
      Object.entries(data?.map ?? {}).map(([email, g]) => [email, Array.isArray(g) ? g : [g]]),
    )
    // Any non-empty source lights up the tabs — new server-side sources
    // (e.g. 'members', added 2026-07) must not silently disable the map.
    const hasMap = !!data && data.source !== 'empty' && groups.length > 0
    return { groups, map, hasMap, loading, refetch }
  }, [data, loading, refetch])
  return <GroupScopeContext.Provider value={value}>{children}</GroupScopeContext.Provider>
}
