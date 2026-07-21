import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_ORG, useOrg } from './OrgProvider'

export type FetchState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  source?: 'live' | 'mock'
  reason?: string
  /** Re-runs the fetch against the same URL. Used by mutation-triggering UIs
   *  (e.g. CSV upload) that need to invalidate the cached response. */
  refetch: () => Promise<void>
}

/**
 * Appends `org=<id>` to an /api URL (handles existing query strings).
 * The default org is implicit — no param — so single-org deployments keep
 * today's URLs byte-identical. Shared by useFetch and every direct fetch()/
 * POST call site that must be org-scoped.
 */
export function orgParam(url: string, org: string): string {
  if (!org || org === DEFAULT_ORG) return url
  return `${url}${url.includes('?') ? '&' : '?'}org=${encodeURIComponent(org)}`
}

export function useFetch<T>(url: string): FetchState<T> {
  const { org } = useOrg()
  const finalUrl = orgParam(url, org)
  const [state, setState] = useState<Omit<FetchState<T>, 'refetch'>>({ data: null, loading: true, error: null })
  const [nonce, setNonce] = useState(0)
  const lastOrgRef = useRef(org)

  // Render-phase derived-state reset (not an effect): an org switch is a
  // hard scope change, and an effect-based reset would let ONE committed
  // frame paint the previous org's numbers before clearing. Setting state
  // during render makes React re-render before commit — no cross-org frame
  // ever reaches the screen.
  if (lastOrgRef.current !== org) {
    lastOrgRef.current = org
    setState({ data: null, loading: true, error: null })
  }

  const refetch = useCallback(async () => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let aborted = false
    setState((s) => (s.loading ? s : { ...s, loading: true, error: null }))
    fetch(finalUrl)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || body?.message || r.statusText)
        return body
      })
      .then((body) => {
        if (aborted) return
        setState({
          data: body as T,
          loading: false,
          error: null,
          source: body?.source,
          reason: body?.reason,
        })
      })
      .catch((err) => {
        if (aborted) return
        setState({ data: null, loading: false, error: String(err) })
      })
    return () => { aborted = true }
  }, [finalUrl, nonce, org])

  return { ...state, refetch }
}
