// @vitest-environment jsdom
import { type PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DateRangeControl } from '../../src/components/DateRangeControl'
import { I18nProvider, useI18n, type Locale } from '../../src/lib/i18n'
import { useDateRange, type DateRange, type DateRangeOptions, type Preset } from '../../src/lib/useDateRange'

const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true }
const defaultRange: DateRange = {
  preset: '7d',
  startingDate: '2026-09-15',
  endingDate: '2026-09-21',
  days: 7,
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-21T00:30:00Z'))
  localStorage.setItem('ccd.locale', 'en')
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Date range tests must not access an API')
  }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  localStorage.removeItem('ccd.locale')
})

function mountRange(url = '/', defaultPreset?: Preset, options: DateRangeOptions = {}) {
  return renderHook(() => ({
    ...useDateRange(defaultPreset, options),
    search: useLocation().search,
  }), {
    wrapper: ({ children }: PropsWithChildren) => (
      <MemoryRouter initialEntries={[url]} future={routerFuture}>{children}</MemoryRouter>
    ),
  })
}

function customUrl(start: string, end: string) {
  return `/?${new URLSearchParams({ range: 'custom', start, end })}`
}

function selectedRange(): DateRange {
  return JSON.parse(screen.getByTestId('selected-range').textContent!)
}

function selectedSearch() {
  return new URLSearchParams(screen.getByTestId('selected-search').textContent!)
}

function mountPicker({
  url = '/?range=7d&org=demo&group=engineering',
  locale = 'en',
  defaultPreset,
  freshEnd,
}: { url?: string; locale?: Locale; defaultPreset?: Preset; freshEnd?: boolean } = {}) {
  localStorage.setItem('ccd.locale', locale)
  let i18n!: ReturnType<typeof useI18n>

  function Page() {
    const { range } = useDateRange(defaultPreset, { freshEnd })
    const location = useLocation()
    i18n = useI18n()
    return (
      <>
        <DateRangeControl defaultPreset={defaultPreset} freshEnd={freshEnd} />
        <output data-testid="selected-range">{JSON.stringify(range)}</output>
        <output data-testid="selected-search">{location.search}</output>
        <button type="button">Outside the picker</button>
      </>
    )
  }

  const view = render(
    <MemoryRouter initialEntries={[url]} future={routerFuture}>
      <I18nProvider><Page /></I18nProvider>
    </MemoryRouter>,
  )

  return {
    ...view,
    t: ((key, params) => i18n.t(key, params)) as typeof i18n.t,
    openDraft() {
      const trigger = screen.getByText('…', { selector: 'button' })
      fireEvent.click(trigger)
      // Native date inputs have no implicit textbox role. Exercise their real
      // values independently of the labels, which are tested separately below.
      const [start, end] = view.container.querySelectorAll<HTMLInputElement>('input[type="date"]')
      return { trigger, start, end }
    },
  }
}

describe('shared URL date ranges', () => {
  it.each([
    ['invalid text', '2026-09-aa', '2026-09-21'],
    ['non-leap February 29', '2026-02-29', '2026-03-02'],
    ['February overflow', '2026-02-30', '2026-03-02'],
    ['April overflow', '2026-04-31', '2026-05-02'],
    ['zero month', '2026-00-01', '2026-09-21'],
    ['zero day', '2026-09-00', '2026-09-21'],
    ['unpadded month', '2026-9-01', '2026-09-21'],
    ['timestamp instead of date', '2026-09-01T00:00:00Z', '2026-09-21'],
    ['leading whitespace', ' 2026-09-01', '2026-09-21'],
    ['empty start', '', '2026-09-21'],
    ['empty end', '2026-09-15', ''],
    ['invalid end', '2026-09-15', '2026-09-xx'],
    ['reversed dates', '2026-09-20', '2026-09-19'],
    ['before the archive begins', '2025-12-31', '2026-09-21'],
    ['future end', '2026-09-15', '2026-09-22'],
  ])('uses a safe default for %s without normalizing it into another custom range', (_, start, end) => {
    const { result } = mountRange(customUrl(start, end))

    expect(result.current.range).toEqual(defaultRange)
    expect(Number.isFinite(result.current.range.days)).toBe(true)
  })

  it.each([
    '/?range=custom',
    '/?range=custom&start=2026-09-15',
    '/?range=custom&end=2026-09-21',
    '/?range=unrecognized',
  ])('uses the page default for incomplete or unknown selection %s', (url) => {
    const { result } = mountRange(url, '14d')

    expect(result.current.range).toEqual({
      preset: '14d', startingDate: '2026-09-08', endingDate: '2026-09-21', days: 14,
    })
  })

  it('does not turn an invalid custom default into a fake committed custom selection', () => {
    const { result } = mountRange('/?range=custom&start=bad&end=bad', 'custom')
    expect(result.current.range).toEqual(defaultRange)
  })

  it('retains archive history and custom windows longer than 90 days', () => {
    const { result } = mountRange(customUrl('2026-01-01', '2026-09-21'))

    expect(result.current.range).toEqual({
      preset: 'custom', startingDate: '2026-01-01', endingDate: '2026-09-21', days: 264,
    })
  })

  it('accepts a historical 366-day window without imposing a moving lookback floor', () => {
    vi.setSystemTime(new Date('2027-04-01T12:00:00Z'))
    const { result } = mountRange(customUrl('2026-01-01', '2027-01-01'))

    expect(result.current.range).toEqual({
      preset: 'custom', startingDate: '2026-01-01', endingDate: '2027-01-01', days: 366,
    })
  })

  it('falls back when a custom window exceeds the server’s 366-day support', () => {
    vi.setSystemTime(new Date('2027-04-01T12:00:00Z'))
    const { result } = mountRange(customUrl('2026-01-01', '2027-01-02'))

    expect(result.current.range).toEqual({
      preset: '7d', startingDate: '2027-03-26', endingDate: '2027-04-01', days: 7,
    })
  })

  it('accepts a real leap day and counts the inclusive UTC interval', () => {
    vi.setSystemTime(new Date('2028-03-02T12:00:00Z'))
    const { result } = mountRange(customUrl('2028-02-29', '2028-03-01'))

    expect(result.current.range).toEqual({
      preset: 'custom', startingDate: '2028-02-29', endingDate: '2028-03-01', days: 2,
    })
  })

  it.each([
    ['', '2026-09-21'],
    ['2026-02-30', '2026-03-02'],
    ['2026-09-20', '2026-09-19'],
    ['2025-12-31', '2026-01-02'],
    ['2026-09-15', '2026-09-22'],
  ])('does not write invalid custom dates %s / %s to the shared URL', (start, end) => {
    const { result } = mountRange('/?range=7d&org=demo&group=engineering')
    const previousSearch = result.current.search

    act(() => { result.current.setCustom(start, end) })

    expect(result.current.search).toBe(previousSearch)
    expect(result.current.range).toEqual(defaultRange)
  })

  it('preserves other query parameters when applying custom dates and switching presets', () => {
    const { result } = mountRange('/?range=7d&org=demo&group=engineering')

    act(() => { result.current.setCustom('2026-01-01', '2026-09-21') })

    expect(result.current.range.days).toBe(264)
    expect(Object.fromEntries(new URLSearchParams(result.current.search))).toEqual({
      range: 'custom', start: '2026-01-01', end: '2026-09-21', org: 'demo', group: 'engineering',
    })

    act(() => { result.current.setPreset('14d') })

    expect(Object.fromEntries(new URLSearchParams(result.current.search))).toEqual({
      range: '14d', org: 'demo', group: 'engineering',
    })
    expect(result.current.range).toEqual({
      preset: '14d', startingDate: '2026-09-08', endingDate: '2026-09-21', days: 14,
    })
  })
})

describe('preset and UTC contracts', () => {
  it.each([
    [false, '2026-09-18'],
    [true, '2026-09-21'],
  ])('keeps 1d as a single day with freshEnd=%s', (freshEnd, date) => {
    const { result } = mountRange('/?range=1d', '7d', { freshEnd })
    expect(result.current.range).toEqual({
      preset: '1d', startingDate: date, endingDate: date, days: 1,
    })
  })

  it.each([
    ['7d', 7, '2026-09-15'],
    ['14d', 14, '2026-09-08'],
    ['30d', 30, '2026-08-23'],
  ] as const)('keeps %s ending today even with the finalization buffer', (preset, days, startingDate) => {
    const { result } = mountRange(`/?range=${preset}`)
    expect(result.current.range).toEqual({
      preset, startingDate, endingDate: '2026-09-21', days,
    })
  })

  it.each([
    [false, '2026-09-18'],
    [true, '2026-09-21'],
  ])('honors the page’s 1d default on malformed links with freshEnd=%s', (freshEnd, date) => {
    const { result } = mountRange(customUrl('2026-02-30', '2026-03-02'), '1d', { freshEnd })
    expect(result.current.range).toEqual({
      preset: '1d', startingDate: date, endingDate: date, days: 1,
    })
  })

  it.each(['America/Los_Angeles', 'Asia/Seoul', 'Pacific/Kiritimati'])(
    'keeps UTC dates and day counts in %s across midnight and daylight saving',
    (timeZone) => {
      vi.stubEnv('TZ', timeZone)
      const { result, unmount } = mountRange('/?range=7d')
      expect(result.current.range).toEqual(defaultRange)
      unmount()

      const custom = mountRange(customUrl('2026-03-07', '2026-03-09'))
      expect(custom.result.current.range).toEqual({
        preset: 'custom', startingDate: '2026-03-07', endingDate: '2026-03-09', days: 3,
      })
    },
  )
})

describe('date input validation', () => {
  it.each([
    ['cleared start', 'start', '', 'range.invalid'],
    ['cleared end', 'end', '', 'range.invalid'],
    ['impossible native date', 'start', '2026-02-30', 'range.invalid'],
    ['reversed dates', 'end', '2026-09-14', 'range.order'],
    ['before the archive', 'start', '2025-12-31', 'range.bounds'],
    ['future end', 'end', '2026-09-22', 'range.bounds'],
  ] as const)('disables Apply and leaves the selection intact for %s', (_, field, value, messageKey) => {
    const picker = mountPicker()
    const draft = picker.openDraft()
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: picker.t('range.apply') })

    fireEvent.change(draft[field], { target: { value } })

    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(selectedRange()).toEqual(defaultRange)
    expect(selectedSearch().get('range')).toBe('7d')
    expect(screen.getByRole('alert').textContent).toBe(
      picker.t(messageKey, { start: '2026-01-01', end: '2026-09-21' }),
    )
    expect(draft[field].getAttribute('aria-invalid')).toBe('true')
    expect(draft[field].getAttribute('aria-describedby')?.split(' '))
      .toContain(screen.getByRole('alert').id)
    if (value === '2026-02-30') expect(draft.start.value).toBe('')
  })

  it('enables Apply after correcting an input and commits both dates atomically', () => {
    const picker = mountPicker()
    const { trigger, start } = picker.openDraft()
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: picker.t('range.apply') })
    fireEvent.change(start, { target: { value: '' } })
    expect(apply.disabled).toBe(true)

    fireEvent.change(start, { target: { value: '2026-01-01' } })
    expect(apply.disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(apply)

    expect(selectedRange()).toEqual({
      preset: 'custom', startingDate: '2026-01-01', endingDate: '2026-09-21', days: 264,
    })
    expect(Object.fromEntries(selectedSearch())).toEqual({
      range: 'custom', org: 'demo', group: 'engineering', start: '2026-01-01', end: '2026-09-21',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('allows a custom single-day selection including today', () => {
    const picker = mountPicker()
    const { start } = picker.openDraft()
    fireEvent.change(start, { target: { value: '2026-09-21' } })
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: picker.t('range.apply') })

    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    expect(selectedRange()).toEqual({
      preset: 'custom', startingDate: '2026-09-21', endingDate: '2026-09-21', days: 1,
    })
  })

  it('uses the server window cap relative to the chosen dates, including old archive dates', () => {
    vi.setSystemTime(new Date('2027-04-01T12:00:00Z'))
    const picker = mountPicker()
    const { start, end } = picker.openDraft()
    fireEvent.change(start, { target: { value: '2026-01-01' } })
    fireEvent.change(end, { target: { value: '2027-01-02' } })
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: picker.t('range.apply') })

    expect(apply.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(
      picker.t('range.bounds', { start: '2026-01-02', end: '2027-01-02' }),
    )

    fireEvent.change(end, { target: { value: '2027-01-01' } })
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    expect(selectedRange()).toEqual({
      preset: 'custom', startingDate: '2026-01-01', endingDate: '2027-01-01', days: 366,
    })
  })
})

describe('date popup interaction and localization', () => {
  it('names the non-modal dialog and focuses the first date input', () => {
    const picker = mountPicker()
    const { trigger, start } = picker.openDraft()
    const dialog = screen.getByRole('dialog', { name: picker.t('range.custom') })

    expect(document.activeElement).toBe(start)
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
    expect(dialog.getAttribute('aria-modal')).not.toBe('true')
    expect(within(dialog).getByLabelText(picker.t('range.start'))).toBe(start)
    expect(start.min).toBe('2026-01-01')
    expect(start.max).toBe('2026-09-21')
  })

  it.each(['custom', 'summary'] as const)('closes with Escape and returns focus to the %s trigger', (opener) => {
    const picker = mountPicker()
    const trigger = opener === 'custom'
      ? screen.getByText('…', { selector: 'button' })
      : screen.getByRole('button', { name: picker.t('range.change') })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: picker.t('range.custom') })
    const input = within(dialog).getByLabelText(picker.t('range.start'))

    fireEvent.change(input, { target: { value: '2026-09-01' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(selectedRange()).toEqual(defaultRange)

    fireEvent.click(trigger)
    expect(screen.getByLabelText<HTMLInputElement>(picker.t('range.start')).value).toBe('2026-09-15')
  })

  it('discards a cancelled draft before reopening the popup', () => {
    const picker = mountPicker()
    const { trigger, start, end } = picker.openDraft()
    fireEvent.change(start, { target: { value: '' } })
    fireEvent.change(end, { target: { value: '2026-09-20' } })

    fireEvent.click(screen.getByRole('button', { name: picker.t('range.cancel') }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(selectedRange()).toEqual(defaultRange)
    const reopened = picker.openDraft()
    expect(reopened.start.value).toBe('2026-09-15')
    expect(reopened.end.value).toBe('2026-09-21')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes on an outside pointer without applying the draft or taking focus back', () => {
    const picker = mountPicker()
    const { start } = picker.openDraft()
    fireEvent.change(start, { target: { value: '2026-09-01' } })
    const outside = screen.getByRole('button', { name: 'Outside the picker' })

    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The browser focuses the pointer target after pointerdown. Closing the
    // popup must not subsequently move focus back to its trigger.
    act(() => { outside.focus() })
    expect(document.activeElement).toBe(outside)
    expect(selectedRange()).toEqual(defaultRange)
    expect(picker.openDraft().start.value).toBe('2026-09-15')
  })

  it('lets keyboard focus leave the non-modal popup without committing its draft', () => {
    const picker = mountPicker()
    const { start } = picker.openDraft()
    fireEvent.change(start, { target: { value: '2026-09-01' } })
    const outside = screen.getByRole('button', { name: 'Outside the picker' })

    act(() => { outside.focus() })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(selectedRange()).toEqual(defaultRange)
  })

  it('exposes the current selection as the range trigger’s accessible description', () => {
    const picker = mountPicker()
    const trigger = screen.getByRole('button', { name: picker.t('range.change') })
    const descriptionId = trigger.getAttribute('aria-describedby')

    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toContain('Sep 15 – Sep 21')
    expect(document.getElementById(descriptionId!)?.textContent).toContain('(7d)')

    fireEvent.click(screen.getByText('14d', { selector: 'button' }))
    expect(document.getElementById(descriptionId!)?.textContent).toContain('Sep 8 – Sep 21')
    expect(document.getElementById(descriptionId!)?.textContent).toContain('(14d)')
  })

  it('closes the popup when choosing a preset and reopens with the committed interval', () => {
    const picker = mountPicker()
    const { start } = picker.openDraft()
    fireEvent.change(start, { target: { value: '2026-09-01' } })

    fireEvent.click(screen.getByText('14d', { selector: 'button' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(selectedRange()).toEqual({
      preset: '14d', startingDate: '2026-09-08', endingDate: '2026-09-21', days: 14,
    })
    const reopened = picker.openDraft()
    expect(reopened.start.value).toBe('2026-09-08')
    expect(reopened.end.value).toBe('2026-09-21')
  })

  it.each(['en', 'ko'] as const)('uses %s translations for labels, actions and validation', (locale) => {
    const picker = mountPicker({ locale })
    const trigger = screen.getByRole('button', { name: picker.t('range.custom') })
    expect(trigger.title).toBe(picker.t('range.custom'))
    expect(screen.getByText('14d', { selector: 'button' }).title)
      .toBe(picker.t('range.last_days', { days: 14 }))
    expect(screen.getByRole('button', { name: picker.t('range.change') }).title)
      .toBe(picker.t('range.change'))

    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: picker.t('range.custom') })
    const start = within(dialog).getByLabelText(picker.t('range.start'))
    expect(within(dialog).getByLabelText(picker.t('range.end'))).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: picker.t('range.cancel') })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: picker.t('range.apply') })).toBeTruthy()
    fireEvent.change(start, { target: { value: '' } })

    expect(within(dialog).getByRole('alert').textContent).toBe(picker.t('range.invalid'))
    expect(dialog.textContent).not.toMatch(/range\.(custom|start|end|invalid|cancel)/)
    if (locale === 'ko') {
      expect(picker.t('range.custom')).toMatch(/[가-힣]/)
      expect(picker.t('range.invalid')).toMatch(/[가-힣]/)
    }
  })

  it('displays the selected UTC dates west of UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    mountPicker()
    expect(screen.getByText(/Sep 15 – Sep 21/).textContent).toContain('Sep 15 – Sep 21')
  })
})
