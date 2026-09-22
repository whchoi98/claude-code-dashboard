import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider, useI18n } from '../../src/lib/i18n'
import { restoreOrgSelection } from '../../src/lib/OrgProvider'
import { ErrorState } from '../../src/components/LoadingState'
import { SortableTh } from '../../src/components/SortableTh'
import { useSortable } from '../../src/lib/useSortable'
import { fmtDate } from '../../src/lib/format'

describe('recovery and keyboard controls', () => {
  it('offers a localized retry action without reloading the application', () => {
    const retry = vi.fn()
    render(<I18nProvider><ErrorState error="HTTP 503" onRetry={retry} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
  })

  it('exposes sorting as a focusable button and announces the sort direction', () => {
    function Table() {
      const { rows, sortKey, sortDir, toggle } = useSortable(
        [{ value: 5 }, { value: null }, { value: 2 }],
        { value: (row) => row.value },
        { initialKey: 'value', initialDir: 'desc' },
      )
      return (
        <table>
          <thead><tr><SortableTh label="Value" k="value" sortKey={sortKey} sortDir={sortDir} onClick={toggle} /></tr></thead>
          <tbody>{rows.map((row) => <tr key={String(row.value)}><td>{row.value ?? '—'}</td></tr>)}</tbody>
        </table>
      )
    }
    render(<I18nProvider><Table /></I18nProvider>)
    const button = screen.getByRole('button', { name: 'Sort by Value' })
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(button)
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending')
    expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['2', '5', '—'])
  })
})

describe('browser preferences', () => {
  it('still starts when the browser blocks localStorage access', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError')
    })
    expect(() => restoreOrgSelection()).not.toThrow()
    function Locale() {
      const { locale, setLocale } = useI18n()
      return <button onClick={() => setLocale('ko')}>{locale}</button>
    }
    render(<I18nProvider><Locale /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'en' }))
    expect(screen.getByRole('button', { name: 'ko' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('ko')
  })

  it('formats analytics dates in UTC, including for viewers west of UTC', () => {
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      expect(fmtDate('2026-09-21')).toBe('Sep 21')
      expect(fmtDate('2026-09-21T00:00:00Z')).toBe('Sep 21')
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})
