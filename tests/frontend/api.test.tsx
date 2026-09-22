import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useFetch } from '../../src/lib/api'
import { MemoryRouter } from 'react-router-dom'
import { OrgProvider, useOrg } from '../../src/lib/OrgProvider'
import type { ReactNode } from 'react'

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useFetch request lifecycle', () => {
  it('cancels obsolete requests and never replaces a new response with an old one', async () => {
    const old = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return url === '/api/old' ? old.promise : Promise.resolve(json({ value: 'new' }))
    }))
    const { result, rerender, unmount } = renderHook(({ url }) => useFetch<{ value: string }>(url), {
      initialProps: { url: '/api/old' },
    })
    rerender({ url: '/api/new' })
    await waitFor(() => expect(result.current.data?.value).toBe('new'))
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => { old.resolve(json({ value: 'old' })) })
    expect(result.current.data?.value).toBe('new')
    unmount()
    expect(signals[1]?.aborted).toBe(true)
  })

  it('treats a successful HTML or malformed response as an error, not empty data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Sign in</html>')))
    const { result } = renderHook(() => useFetch('/api/example'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()
    expect(result.current.error).toMatch(/JSON/i)
  })

  it('includes the HTTP status when an upstream error has no JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })))
    const { result } = renderHook(() => useFetch('/api/example'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toContain('502')
  })

  it('lets callers await a retry until the new data has arrived', async () => {
    const refreshed = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ value: 1 }))
      .mockReturnValueOnce(refreshed.promise))
    const { result } = renderHook(() => useFetch<{ value: number }>('/api/example'))
    await waitFor(() => expect(result.current.data?.value).toBe(1))
    let settled = false
    let retry!: Promise<void>
    await act(async () => {
      retry = result.current.refetch().then(() => { settled = true })
    })
    expect(settled).toBe(false)
    expect(result.current.loading).toBe(true)
    expect(result.current.data?.value).toBe(1)
    await act(async () => {
      refreshed.resolve(json({ value: 2 }))
      await retry
    })
    expect(settled).toBe(true)
    expect(result.current.data?.value).toBe(2)
    expect(result.current.loading).toBe(false)
  })

  it('ends a hung request with a retryable error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const { result } = renderHook(() => useFetch('/api/example'))
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000) })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toMatch(/timed out/i)
    expect(result.current.data).toBeNull()
  })

  it('ignores a late retry from a previous date window', async () => {
    const next = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/new'
      ? next.promise
      : Promise.resolve(json({ value: 'old' }))))
    const { result, rerender } = renderHook(({ url }) => useFetch<{ value: string }>(url), {
      initialProps: { url: '/api/old' },
    })
    await waitFor(() => expect(result.current.data?.value).toBe('old'))
    const oldRetry = result.current.refetch
    rerender({ url: '/api/new' })
    await act(async () => {
      await oldRetry()
      next.resolve(json({ value: 'new' }))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data?.value).toBe('new')
  })

  it('cannot replace a new organization query with a late upload callback from the old organization', async () => {
    const second = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/orgs') return Promise.resolve(json({
        orgs: [{ id: 'primary', label: 'Primary' }, { id: 'org2', label: 'Second' }], default: 'primary',
      }))
      return url.includes('org=org2') ? second.promise : Promise.resolve(json({ value: 'primary' }))
    }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter><OrgProvider>{children}</OrgProvider></MemoryRouter>
    )
    const { result } = renderHook(() => ({ scope: useOrg(), fetch: useFetch<{ value: string }>('/api/groups') }), { wrapper })
    await waitFor(() => expect(result.current.fetch.data?.value).toBe('primary'))
    const oldRetry = result.current.fetch.refetch
    act(() => { result.current.scope.setOrg('org2') })
    await act(async () => {
      await oldRetry()
      second.resolve(json({ value: 'org2' }))
    })
    await waitFor(() => expect(result.current.fetch.loading).toBe(false))
    expect(result.current.fetch.data?.value).toBe('org2')
  })
})
