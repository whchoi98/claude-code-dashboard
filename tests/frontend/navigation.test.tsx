import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from '../../src/components/Layout'
import { I18nProvider } from '../../src/lib/i18n'
import { OrgProvider } from '../../src/lib/OrgProvider'

function CurrentPage() {
  const location = useLocation()
  return <h1>{location.pathname + location.search}</h1>
}

function renderDashboard(path = '/users?org=org2&group=Team+One&range=14d', broken = false) {
  function BrokenPage(): never { throw new Error('Example rendering failure') }
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <OrgProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route path="*" element={<CurrentPage />} />
              {broken && <Route path="/broken" element={<BrokenPage />} />}
            </Route>
          </Routes>
        </OrgProvider>
      </MemoryRouter>
    </I18nProvider>,
  )
}

function media(desktop: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  media(true)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/api/orgs'
      ? { orgs: [{ id: 'primary', label: 'Primary' }, { id: 'org2', label: 'Second' }], default: 'primary' }
      : { ok: true, analyticsKey: 'none', adminKey: 'none' },
  ), { headers: { 'content-type': 'application/json' } })))
})

describe('dashboard navigation', () => {
  it('finds pages from the keyboard while preserving the organization and group scope', async () => {
    renderDashboard()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByRole('searchbox', { name: 'Find a page' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'Claude Code' } })
    const nav = screen.getByRole('navigation', { name: 'Dashboard pages' })
    expect(within(nav).getAllByRole('link')).toHaveLength(1)
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByRole('heading', { name: '/claude-code?group=Team+One&org=org2' })).toBeTruthy()
    expect((search as HTMLInputElement).value).toBe('')
  })

  it('can clear an empty menu search', () => {
    renderDashboard()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-a-real-page' } })
    expect(screen.getByText('No matching pages')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear page search' }))
    expect(within(screen.getByRole('navigation')).getAllByRole('link').length).toBeGreaterThan(1)
  })

  it('moves the content to the top and updates focus and title after page navigation', () => {
    renderDashboard()
    const main = screen.getByRole('main')
    main.scrollTop = 600
    fireEvent.click(screen.getByRole('link', { name: /Trends DAU/ }))
    expect(main.scrollTop).toBe(0)
    expect(document.activeElement).toBe(main)
    expect(document.title).toContain('Trends')
  })

  it('keeps mobile menu focus inside the drawer and returns it when dismissed', () => {
    media(false)
    renderDashboard()
    const opener = screen.getByRole('button', { name: 'Open menu' })
    opener.focus()
    fireEvent.click(opener)
    const drawer = screen.getByRole('dialog', { name: 'Dashboard pages' })
    expect(drawer.contains(document.activeElement)).toBe(true)
    expect((screen.getByRole('main', { hidden: true }) as HTMLElement & { inert: boolean }).inert).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps navigation usable when a page throws during rendering', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderDashboard('/broken', true)).not.toThrow()
    expect(screen.getByText('This page could not be displayed')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: /Overview KPIs/ }))
    expect(await screen.findByRole('heading', { name: '/' })).toBeTruthy()
    expect(screen.queryByText('This page could not be displayed')).toBeNull()
  })
})
