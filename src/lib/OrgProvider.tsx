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
  /**
   * Switches the org (URL-synced ?org=, persisted to localStorage so the next
   * visit restores it). Always resets ?group= — group maps are per org.
   */
  setOrg: (id: string) => void
  orgs: OrgInfo[]
  loading: boolean
}

export const DEFAULT_ORG = 'primary'

const STORAGE_KEY = 'ccd.org'

/**
 * Restores the last switcher-picked org into ?org= when the URL doesn't pin
 * one. Called from main.tsx BEFORE React mounts — a synchronous
 * history.replaceState means the Router sees the restored org from the very
 * first render, so page useFetch effects (which run BEFORE parent provider
 * effects) never fire a wasted primary-org round. The URL stays the single
 * source of truth: an id that turns out unknown resolves to 'primary' below,
 * exactly like an invalid deep link, and an explicit ?org= always wins.
 * A ?group=-carrying URL also skips the restore: primary is URL-implicit
 * (orgParam/setOrg/withGroup all omit the param), so a shared or bookmarked
 * link like /users?group=TeamA is a PRIMARY view pinned by its group filter —
 * hijacking it to the stored org would silently swap both the org and the
 * scope. Group maps are per org, so honoring the group means honoring primary.
 */
export function restoreOrgSelection() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (url.searchParams.get('org') || url.searchParams.get('group')) return
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (!saved || saved === DEFAULT_ORG) return
  url.searchParams.set('org', saved)
  window.history.replaceState(window.history.state, '', url)
}

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
 * `?org=` selection via context. Switcher picks persist to localStorage and
 * are restored into the URL on the next visit (URL param always wins).
 * Wraps <Routes> in App.tsx OUTSIDE GroupScopeProvider, because the
 * email→group map is per org (the group provider's fetch re-runs whenever
 * the org changes — see useFetch).
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const [orgs, setOrgs] = useState<OrgInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let aborted = false
    fetchOrgsOnce().then((body) => {
      if (aborted) return
      const list = Array.isArray(body.orgs) ? body.orgs : []
      setOrgs(list)
      setLoading(false)
      // Drop a stored org the server no longer knows (e.g. 'org2' after a
      // single-org rollback). The switcher only renders with 2+ orgs, so
      // without this cleanup there is no UI path that stops the pre-mount
      // restore from re-injecting a dead ?org= on every fresh visit. An
      // empty list means /api/orgs itself failed — keep the preference then.
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved && list.length > 0 && !list.some((o) => o.id === saved)) {
        window.localStorage.removeItem(STORAGE_KEY)
      }
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
    // Remember the explicit choice so the next visit starts on the same org
    // (read back by the mount-time restore effect above). Deliberately NOT
    // written for deep-linked ?org= visits — only switcher clicks are a
    // stated preference.
    window.localStorage.setItem(STORAGE_KEY, id || DEFAULT_ORG)
  }, [params, setParams])

  const value = useMemo<OrgContextValue>(
    () => ({ org, setOrg, orgs, loading }),
    [org, setOrg, orgs, loading],
  )
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}
