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
  type Snapshot = Omit<FetchState<T>, 'refetch'> & { org: string; url: string }
  const [state, setState] = useState<Snapshot>({
    org, url: finalUrl, data: null, loading: true, error: null,
  })
  const requestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
  const currentScopeRef = useRef({ org, url: finalUrl })
  currentScopeRef.current = { org, url: finalUrl }

  // Return the real request promise so upload/delete callers can await the
  // refreshed list. A new request supersedes the previous one, even when
  // several manual retries happen before React commits another render.
  const refetch = useCallback(async () => {
    // An upload can finish after the user has changed org/window or left the
    // page. Its captured callback must not cancel the current scope's request.
    if (!mountedRef.current || currentScopeRef.current.org !== org || currentScopeRef.current.url !== finalUrl) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    // CloudFront's origin read timeout is 60 seconds. Leave room for the
    // response, but don't leave a disconnected browser on an endless spinner.
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 65_000)
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true })
    setState((previous) => ({
      ...(previous.org === org ? previous : { data: null }),
      org, url: finalUrl, loading: true, error: null,
    }))
    try {
      const response = await fetch(finalUrl, { signal: controller.signal })
      const body = await response.json().catch(() => {
        if (response.ok) throw new Error(`Invalid JSON response (HTTP ${response.status}).`)
        return null
      })
      if (!response.ok) {
        const message = body?.error || body?.message
        throw new Error(typeof message === 'string' ? message : `HTTP ${response.status} ${response.statusText}`.trim())
      }
      if (body == null || typeof body !== 'object') {
        throw new Error(`Invalid JSON response (HTTP ${response.status}).`)
      }
      if (controller.signal.aborted || requestRef.current !== controller) return
      setState({
        org, url: finalUrl, data: body as T, loading: false, error: null,
        source: body.source, reason: body.reason,
      })
    } catch (err) {
      if (requestRef.current !== controller || (controller.signal.aborted && !timedOut)) return
      setState({
        org, url: finalUrl, data: null, loading: false,
        error: timedOut ? 'Request timed out. Please try again.' : err instanceof Error ? err.message : String(err),
      })
    } finally {
      clearTimeout(timeout)
    }
  }, [finalUrl, org])

  useEffect(() => {
    mountedRef.current = true
    void refetch()
    return () => {
      mountedRef.current = false
      requestRef.current?.abort()
    }
  }, [refetch])

  // Scope changes are visible during render, before effects can run: never
  // commit old-org data. Same-org data stays available during refresh (Cost's
  // existing SWR UI), but is marked loading from the very first new-URL frame.
  if (state.org !== org) return { data: null, loading: true, error: null, refetch }
  const { org: _org, url: _url, ...values } = state
  return {
    ...values,
    loading: state.loading || state.url !== finalUrl,
    error: state.url === finalUrl ? state.error : null,
    refetch,
  }
}
