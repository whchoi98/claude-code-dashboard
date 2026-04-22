import { useEffect, useState } from 'react'

export type FetchState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  source?: 'live' | 'mock'
  reason?: string
}

export function useFetch<T>(url: string): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null })
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
  }, [url])
  return state
}
