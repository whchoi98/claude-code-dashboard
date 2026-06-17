import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useFetch } from '../lib/api'

type GroupsResp = {
  source: 'live' | 'empty'
  file: string | null
  groups: string[]
  map: Record<string, string>   // lowercased email → group
}

export type GroupScopeData = {
  groups: string[]
  map: Record<string, string>
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
 * via context, so the sidebar control + every scoped page read one request and
 * a single refetch (after upload) refreshes all consumers.
 */
export function GroupScopeProvider({ children }: { children: ReactNode }) {
  const { data, loading, refetch } = useFetch<GroupsResp>('/api/groups')
  const value = useMemo<GroupScopeData>(() => {
    const groups = data?.groups ?? []
    const map = data?.map ?? {}
    return { groups, map, hasMap: data?.source === 'live' && groups.length > 0, loading, refetch }
  }, [data, loading, refetch])
  return <GroupScopeContext.Provider value={value}>{children}</GroupScopeContext.Provider>
}
