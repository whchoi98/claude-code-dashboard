import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

/** One selectable Anthropic organization, as reported by GET /api/orgs. */
export type OrgInfo = {
  id: string
  label: string
  admin: boolean
  compliance: boolean
}

type OrgsResp = { orgs: OrgInfo[]; default: string }

type OrgContextValue = {
  /** Resolved org id — 'primary' unless a known non-default org is selected. */
  org: string
  /** Switches the org (URL-synced ?org=). Always resets ?group= — group maps are per org. */
  setOrg: (id: string) => void
  orgs: OrgInfo[]
  loading: boolean
}

export const DEFAULT_ORG = 'primary'

const OrgContext = createContext<OrgContextValue>({
  org: DEFAULT_ORG,
  setOrg: () => {},
  orgs: [],
  loading: false,
})

// Module-level promise so /api/orgs is fetched exactly once per app load
// (StrictMode double-mounts the provider in dev; both mounts share this).
let orgsPromise: Promise<OrgsResp> | null = null
function fetchOrgsOnce(): Promise<OrgsResp> {
  if (!orgsPromise) {
    orgsPromise = fetch('/api/orgs')
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || body?.message || r.statusText)
        return body as OrgsResp
      })
      .catch(() => {
        // Don't cache failures; fall back to single-org behavior (no switcher,
        // no org param) — byte-identical to a pre-multi-org deployment.
        orgsPromise = null
        return { orgs: [], default: DEFAULT_ORG }
      })
  }
  return orgsPromise
}

/** Reads the current org selection. Safe default ('primary') outside the provider. */
export function useOrg(): OrgContextValue {
  return useContext(OrgContext)
}

/**
 * Fetches the org list (`GET /api/orgs`) ONCE and exposes the URL-synced
 * `?org=` selection via context. Wraps <Routes> in App.tsx OUTSIDE
 * GroupScopeProvider, because the email→group map is per org (the group
 * provider's fetch re-runs whenever the org changes — see useFetch).
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const [orgs, setOrgs] = useState<OrgInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let aborted = false
    fetchOrgsOnce().then((body) => {
      if (aborted) return
      setOrgs(Array.isArray(body.orgs) ? body.orgs : [])
      setLoading(false)
    })
    return () => { aborted = true }
  }, [])

  const rawOrg = params.get('org') ?? ''
  // While the list is loading, accept the raw param optimistically so a
  // bookmarked ?org= deep link fetches the right org from the first request
  // (the server coerces unknown org ids to primary anyway). Once loaded,
  // an invalid/unknown id resolves to 'primary' — EXCEPT when the list is
  // empty because /api/orgs itself failed (a real 2-org deployment with a
  // transient error): downgrading then would silently render PRIMARY data
  // under an org2 deep link, so keep honoring the raw param and let the
  // server enforce validity.
  const org = !rawOrg
    ? DEFAULT_ORG
    : loading || orgs.length === 0
      ? rawOrg
      : orgs.some((o) => o.id === rawOrg)
        ? rawOrg
        : DEFAULT_ORG

  const setOrg = useCallback((id: string) => {
    const next = new URLSearchParams(params)
    if (!id || id === DEFAULT_ORG) next.delete('org')
    else next.set('org', id)
    // Group maps are per org — a carried-over selection would silently
    // mis-filter the new org's data, so switching always resets to All.
    next.delete('group')
    setParams(next, { replace: true })
  }, [params, setParams])

  const value = useMemo<OrgContextValue>(
    () => ({ org, setOrg, orgs, loading }),
    [org, setOrg, orgs, loading],
  )
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}
