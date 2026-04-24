import { useCallback, useEffect, useState } from 'react'

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

export function useFetch<T>(url: string): FetchState<T> {
  const [state, setState] = useState<Omit<FetchState<T>, 'refetch'>>({ data: null, loading: true, error: null })
  const [nonce, setNonce] = useState(0)

  const refetch = useCallback(async () => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let aborted = false
    setState((s) => ({ ...s, loading: true, error: null }))
    fetch(url)
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
  }, [url, nonce])

  return { ...state, refetch }
}
