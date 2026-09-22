// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CostLive } from '../../src/pages/CostLive'
import { GroupScopeProvider } from '../../src/lib/GroupScopeProvider'
import { I18nProvider } from '../../src/lib/i18n'
import { OrgProvider, useOrg } from '../../src/lib/OrgProvider'
import { setUnmasked } from '../../src/lib/format'

const LIVE = '/api/cost/spend-limits'
const TIMES = `${LIVE}/snapshots`
const HISTORY = `${LIVE}/at`
const DATE = '2026-09-20'
const MEMBERS: {
  email: string
  name: string | null
  spent_usd: number
  limit_usd: number | null
  utilization: number | null
  period: string
  source: string
}[] = [
  {
    email: 'alice@example.test', name: 'Alice Shared', spent_usd: 1234.56789,
    limit_usd: 2000.12345, utilization: 0.617245, period: 'monthly', source: 'spend_limits',
  },
  {
    email: 'bob@example.test', name: 'Bob Shared', spent_usd: 25.12345,
    limit_usd: null, utilization: null, period: 'monthly', source: 'spend_limits',
  },
  {
    email: 'carol@example.test', name: null, spent_usd: 80.00009,
    limit_usd: 100, utilization: 0.8000009, period: 'monthly', source: 'spend_limits',
  },
]

function liveBody(members = MEMBERS) {
  return { source: 'live', period: 'monthly', fetched_at: '2026-09-21T12:00:00Z', members }
}

type PendingRequest = {
  url: URL
  respond: (body: unknown, status?: number) => void
}
let requests: PendingRequest[]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function requestsFor(path: string, org = 'primary') {
  return requests.filter(({ url }) => url.pathname === path && (url.searchParams.get('org') ?? 'primary') === org)
}

function latest(path: string, org = 'primary') {
  const request = requestsFor(path, org).at(-1)
  if (!request) throw new Error(`No request for ${path} (${org})`)
  return request
}

async function respond(request: PendingRequest, body: unknown, status = 200) {
  await act(async () => { request.respond(body, status) })
}

function OrgControls() {
  const { org, setOrg } = useOrg()
  return (
    <nav aria-label="Test organization controls">
      <output aria-label="Current organization">{org}</output>
      <button onClick={() => setOrg('primary')}>Primary organization</button>
      <button onClick={() => setOrg('org2')}>Second organization</button>
    </nav>
  )
}

type Commit = { org: string | null | undefined; text: string }
function mount(url = '/cost-live', commits: Commit[] = []) {
  return render(
    <Profiler id="cost-live" onRender={() => {
      commits.push({
        org: document.querySelector('[aria-label="Current organization"]')?.textContent,
        text: document.body.textContent ?? '',
      })
    }}>
      <MemoryRouter initialEntries={[url]}>
        <I18nProvider>
          <OrgProvider>
            <GroupScopeProvider>
              <OrgControls />
              <CostLive />
            </GroupScopeProvider>
          </OrgProvider>
        </I18nProvider>
      </MemoryRouter>
    </Profiler>,
  )
}

async function loadLive(url = '/cost-live', commits: Commit[] = []) {
  const result = mount(url, commits)
  await respond(latest(LIVE), liveBody())
  expect(screen.getByRole('cell', { name: 'al***@example.test' })).toBeTruthy()
  return result
}

async function pickDate(date = DATE, times = ['0915', '0930']) {
  fireEvent.change(screen.getByLabelText('Pick a date'), { target: { value: date } })
  await respond(latest(TIMES), { date, times })
}

function displayedMembers() {
  const body = within(screen.getByRole('table')).getAllByRole('rowgroup')[1]
  return within(body).getAllByRole('row').map((row) => within(row).getAllByRole('cell')[0].textContent)
}

function captureDownloads() {
  let pendingBlob: Blob
  const files: { filename: string; blob: Blob }[] = []
  // jsdom does not implement downloads; keep CSV serialization real and only
  // intercept the browser handoff so assertions inspect the exported bytes.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { pendingBlob = blob; return 'blob:cost-live-test' }
    static revokeObjectURL() {}
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    files.push({ filename: this.download, blob: pendingBlob })
  })
  return files
}

async function readCsv(blob: Blob) {
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
  // Fixtures contain no embedded delimiters/newlines; quoted and unquoted
  // serializers are both valid here. Escaping itself belongs to csv.test.ts.
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')))
  const [headers, ...rows] = lines
  return { text, rows: rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]]))) }
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function setPageHidden(hidden: boolean) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
  fireEvent(document, new Event('visibilitychange'))
}

beforeEach(() => {
  // Keep setImmediate real: jsdom's FileReader uses it to read exported blobs.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'))
  localStorage.setItem('ccd.locale', 'en')
  setUnmasked(false)
  requests = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://dashboard.test')
    if (url.pathname === '/api/orgs') {
      return Promise.resolve(json({
        default: 'primary',
        orgs: [
          { id: 'primary', label: 'Primary', admin: true, compliance: true },
          { id: 'org2', label: 'Second', admin: true, compliance: true },
        ],
      }))
    }
    if (url.pathname === '/api/groups') {
      return Promise.resolve(json({
        source: 'live', file: null, groups: ['Engineering', 'Finance'],
        map: {
          'alice@example.test': ['Engineering'], 'bob@example.test': ['Engineering'],
          'carol@example.test': ['Finance'],
        },
      }))
    }
    if (url.pathname === TIMES && !url.searchParams.has('date')) {
      return Promise.resolve(json({ dates: [DATE] }))
    }
    if (![LIVE, TIMES, HISTORY].includes(url.pathname)) throw new Error(`Unexpected fetch: ${url}`)
    return new Promise<Response>((resolve) => {
      requests.push({ url, respond: (body, status = 200) => resolve(json(body, status)) })
    })
  }))
})

afterEach(() => {
  cleanup()
  setUnmasked(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Cost Live freshness', () => {
  const staleNotice = 'Showing previously fetched data. Refresh to check for updates.'
  const refreshError = 'Last refresh failed — showing the previous snapshot'

  it('preserves KPI and table values for HTTP 200 stale data and clears the notice after a fresh response', async () => {
    mount()
    await respond(latest(LIVE), { ...liveBody(), stale: true })

    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,339.69')
    expect(displayedMembers()).toEqual(['al***@example.test', 'ca***@example.test', 'bo***@example.test'])
    expect(screen.getByText(staleNotice)).toBeTruthy()
    expect(screen.queryByText(refreshError)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    await respond(latest(LIVE), liveBody())
    expect(screen.queryByText(staleNotice)).toBeNull()
  })

  it('shows only the refresh error when a stale last-good response survives a failed refresh', async () => {
    mount()
    await respond(latest(LIVE), { ...liveBody(), stale: true })
    expect(screen.getByText(staleNotice)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    await respond(latest(LIVE), { error: 'Temporary upstream failure' }, 503)

    expect(screen.queryByText(staleNotice)).toBeNull()
    expect(screen.getAllByText(refreshError)).toHaveLength(1)
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,339.69')
    expect(screen.getByRole('cell', { name: 'al***@example.test' })).toBeTruthy()
  })

  it.each([
    ['2026-09-20T23:45:30Z', '2026-09-20 23:45:30 UTC'],
    ['2026-09-21T08:45:30+09:00', '2026-09-20 23:45:30 UTC'],
  ])('shows the previous UTC date and full time for fetched_at %s', async (fetched_at, expected) => {
    mount()
    await respond(latest(LIVE), { ...liveBody(), fetched_at })

    expect(screen.getByText(`As of ${expected} · Spend Limits API (real-time)`)).toBeTruthy()
  })

  it('uses the source note for an invalid fetched_at timestamp', async () => {
    mount()
    await respond(latest(LIVE), { ...liveBody(), fetched_at: 'invalid timestamp' })

    expect(screen.getByText('Spend Limits API (real-time)')).toBeTruthy()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
    expect(screen.getByRole('table')).toBeTruthy()
  })
})

describe('Cost Live organization and history boundaries', () => {
  it('never commits the previous organization’s last-good values after an org switch, even if the new fetch fails', async () => {
    const commits: Commit[] = []
    await loadLive('/cost-live', commits)

    fireEvent.click(screen.getByRole('button', { name: 'Second organization' }))

    const secondOrgCommits = commits.filter(({ org }) => org === 'org2')
    expect(secondOrgCommits.length).toBeGreaterThan(0)
    expect(secondOrgCommits.every(({ text }) => !text.includes('al***@example.test') && !text.includes('$1,339.69'))).toBe(true)
    expect(screen.queryByRole('table')).toBeNull()
    await respond(latest(LIVE, 'org2'), { error: 'Second organization is unavailable' }, 503)
    expect(screen.getByText(/Second organization is unavailable/)).toBeTruthy()
    expect(screen.queryByText('al***@example.test')).toBeNull()
  })

  it('preserves the same organization’s live last-good payload when a refresh fails', async () => {
    await loadLive()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(latest(LIVE).url.searchParams.get('fresh')).toBe('1')

    await respond(latest(LIVE), { error: 'Temporary upstream failure' }, 503)

    expect(screen.getByText('Last refresh failed — showing the previous snapshot')).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'al***@example.test' })).toBeTruthy()
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,339.69')
  })

  it.each(['0915', 'EOD'])('does not fall back to live values while history %s loads or fails', async (time) => {
    await loadLive()
    await pickDate()
    fireEvent.change(screen.getByRole('combobox', { name: 'Time…' }), { target: { value: time } })

    expect(screen.queryByRole('table')).toBeNull()
    expect(latest(HISTORY).url.searchParams.get('date')).toBe(DATE)
    expect(latest(HISTORY).url.searchParams.get('time')).toBe(time === 'EOD' ? null : time)
    await respond(latest(HISTORY), { error: 'Archive is unavailable' }, 503)
    expect(screen.getByText(/Archive is unavailable/)).toBeTruthy()
    expect(screen.queryByText('al***@example.test')).toBeNull()
  })

  it('removes the previous date’s archived times on the first commit for a new date', async () => {
    const commits: Commit[] = []
    await loadLive('/cost-live', commits)
    await pickDate()
    expect(screen.getByRole('option', { name: '09:15 UTC' })).toBeTruthy()
    commits.length = 0

    fireEvent.change(screen.getByLabelText('Pick a date'), { target: { value: '2026-09-19' } })

    expect(commits.length).toBeGreaterThan(0)
    expect(commits.every(({ text }) => !text.includes('09:15 UTC'))).toBe(true)
    expect(screen.queryByRole('option', { name: '09:15 UTC' })).toBeNull()
    await respond(latest(TIMES), { date: '2026-09-19', times: ['1200'] })
    expect(screen.getByRole('option', { name: '12:00 UTC' })).toBeTruthy()
  })

  it('removes the previous organization’s archived times before the new organization replies', async () => {
    const commits: Commit[] = []
    await loadLive('/cost-live', commits)
    await pickDate()
    commits.length = 0

    fireEvent.click(screen.getByRole('button', { name: 'Second organization' }))

    expect(commits.filter(({ org }) => org === 'org2').every(({ text }) => !text.includes('09:15 UTC'))).toBe(true)
    expect(screen.queryByRole('option', { name: '09:15 UTC' })).toBeNull()
  })

  it('hides retained snapshot times when returning to a date whose replacement fetch is still loading', async () => {
    await loadLive()
    await pickDate()
    fireEvent.change(screen.getByLabelText('Pick a date'), { target: { value: '2026-09-19' } })
    fireEvent.change(screen.getByLabelText('Pick a date'), { target: { value: DATE } })

    expect(screen.queryByRole('option', { name: '09:15 UTC' })).toBeNull()

    await respond(latest(TIMES), { date: DATE, times: ['1000'] })
    expect(screen.getByRole('option', { name: '10:00 UTC' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '09:15 UTC' })).toBeNull()
  })

  it.each(['0915', 'EOD'])('retries the selected history %s without switching to a live endpoint', async (time) => {
    await loadLive()
    await pickDate()
    fireEvent.change(screen.getByRole('combobox', { name: 'Time…' }), { target: { value: time } })
    const historyUrl = latest(HISTORY).url.href
    await respond(latest(HISTORY), { error: 'Archive temporarily unavailable' }, 503)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(requestsFor(HISTORY)).toHaveLength(2)
    expect(latest(HISTORY).url.href).toBe(historyUrl)
    expect(requestsFor(LIVE)).toHaveLength(1)
    expect(screen.queryByRole('table')).toBeNull()
    await respond(latest(HISTORY), {
      ...liveBody([{ ...MEMBERS[0], spent_usd: 12.34567 }]),
      snapshot: { date: DATE, time }, approx: time === 'EOD',
    })
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$12.35')
  })
})

describe('Cost Live search and CSV', () => {
  it.each(['  ALICE@EXAMPLE.TEST  ', '  aLiCe ShArEd  '])('searches email/name with %j while preserving the whole-group KPI', async (query) => {
    await loadLive('/cost-live?group=Engineering')
    expect(displayedMembers()).toEqual(['al***@example.test', 'bo***@example.test'])
    expect(screen.getByText('2 of 2 members')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search members by email or name' }), { target: { value: query } })

    expect(displayedMembers()).toEqual(['al***@example.test'])
    expect(screen.getByText('1 of 2 members')).toBeTruthy()
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,259.69')
    expect(screen.getByText('Filtered total · 1 members').closest('tr')?.textContent).toContain('$1,234.57')

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(displayedMembers()).toEqual(['al***@example.test', 'bo***@example.test'])
    expect(screen.getByText('2 of 2 members')).toBeTruthy()
    expect(screen.getByText('Total (2 members)').closest('tr')?.textContent).toContain('$1,259.69')
  })

  it('distinguishes no matches from an empty group and resets only the search', async () => {
    await loadLive('/cost-live?group=Engineering')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'does-not-exist' } })

    expect(screen.getByText('No members match your search')).toBeTruthy()
    expect(screen.queryByText('No members in this scope')).toBeNull()
    expect(screen.getByText('0 of 2 members')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download CSV' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,259.69')

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))

    expect(displayedMembers()).toEqual(['al***@example.test', 'bo***@example.test'])
    expect(screen.getByText('2 of 2 members')).toBeTruthy()
  })

  it('exports only the group/search matches in table sort order, retaining raw amounts and masked identities', async () => {
    const files = captureDownloads()
    await loadLive('/cost-live?group=Engineering')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shared' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Spent (MTD)' }))
    expect(displayedMembers()).toEqual(['bo***@example.test', 'al***@example.test'])

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))

    expect(files).toHaveLength(1)
    expect(files[0].filename).toContain('primary')
    expect(files[0].filename).toContain('live')
    expect(files[0].filename).toContain('2026-09-21')
    const csv = await readCsv(files[0].blob)
    expect(csv.rows.map((row) => row.email)).toEqual(['bo***@example.test', 'al***@example.test'])
    expect(csv.rows.map((row) => row.spent_usd)).toEqual(['25.12345', '1234.56789'])
    expect(csv.rows.map((row) => row.limit_usd)).toEqual(['', '2000.12345'])
    expect(csv.rows.map((row) => row.utilization)).toEqual(['', '0.617245'])
    expect(csv.rows[0]).toMatchObject({
      org: 'primary', group: 'Engineering', view: 'live', date_utc: '2026-09-21',
      time_utc: '12:00:00', fetched_at: '2026-09-21T12:00:00Z', period: 'monthly',
    })
    expect(csv.text).not.toContain('alice@example.test')
    expect(csv.text).not.toContain('Alice Shared')
    expect(csv.text).not.toContain('carol')
  })

  it('allows unmasked identities only when the real identity-aware formatter permits them', async () => {
    setUnmasked(true)
    const files = captureDownloads()
    mount()
    await respond(latest(LIVE), liveBody())
    expect(screen.getByRole('cell', { name: 'alice@example.test' })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Alice' } })

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))

    const csv = await readCsv(files[0].blob)
    expect(csv.rows.map((row) => row.email)).toEqual(['alice@example.test'])
  })

  it.each(['0915', 'EOD'])('exports the selected history %s with its date, time and organization', async (time) => {
    const files = captureDownloads()
    mount('/cost-live?org=org2')
    await respond(latest(LIVE, 'org2'), liveBody())
    fireEvent.change(screen.getByLabelText('Pick a date'), { target: { value: DATE } })
    await respond(latest(TIMES, 'org2'), { date: DATE, times: ['0915'] })
    fireEvent.change(screen.getByRole('combobox', { name: 'Time…' }), { target: { value: time } })
    await respond(latest(HISTORY, 'org2'), {
      ...liveBody([{ ...MEMBERS[0], spent_usd: 12.34567, limit_usd: null, utilization: null }]),
      snapshot: { date: DATE, time }, approx: time === 'EOD',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))

    expect(files[0].filename).toContain('org2')
    expect(files[0].filename).toContain(DATE)
    expect(files[0].filename).toContain(time)
    const csv = await readCsv(files[0].blob)
    expect(csv.rows).toHaveLength(1)
    expect(csv.rows[0]).toMatchObject({
      org: 'org2', view: time === 'EOD' ? 'eod' : 'snapshot', date_utc: DATE,
      time_utc: time === 'EOD' ? 'EOD' : '09:15:00', spent_usd: '12.34567',
      limit_usd: '', utilization: '', approximate: time === 'EOD' ? 'true' : 'false',
    })
  })
})

describe('Cost Live refresh controls', () => {
  it('disables manual refresh during initial loading and each pending live refresh', async () => {
    mount()
    let refresh = screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(requestsFor(LIVE)).toHaveLength(1)
    await respond(latest(LIVE), liveBody())

    refresh = screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(false)
    fireEvent.click(refresh)
    expect(requestsFor(LIVE)).toHaveLength(2)
    expect((screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(requestsFor(LIVE)).toHaveLength(2)
    await respond(latest(LIVE), liveBody())
    expect((screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('allows a second completed manual refresh even when the clock has not advanced', async () => {
    await loadLive()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    const firstRefreshUrl = latest(LIVE).url.href
    await respond(latest(LIVE), liveBody())

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))

    expect(requestsFor(LIVE)).toHaveLength(3)
    expect(latest(LIVE).url.searchParams.get('fresh')).toBe('1')
    expect(latest(LIVE).url.href).not.toBe(firstRefreshUrl)
  })

  it('does not start an automatic request while a live refresh is still pending', async () => {
    await loadLive()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))

    await advance(60_000)

    expect(requestsFor(LIVE)).toHaveLength(2)
    await respond(latest(LIVE), liveBody())
    expect(screen.getByRole('cell', { name: 'al***@example.test' })).toBeTruthy()
  })

  it('pauses automatic requests while hidden and refreshes once on becoming visible', async () => {
    await loadLive()
    expect(latest(LIVE).url.searchParams.has('fresh')).toBe(false)
    await advance(60_000)
    expect(requestsFor(LIVE)).toHaveLength(2)
    expect(latest(LIVE).url.searchParams.get('fresh')).toBe('1')
    await respond(latest(LIVE), liveBody())

    setPageHidden(true)
    await advance(180_000)
    expect(requestsFor(LIVE)).toHaveLength(2)

    setPageHidden(false)
    expect(requestsFor(LIVE)).toHaveLength(3)
    expect(latest(LIVE).url.searchParams.get('fresh')).toBe('1')
    await respond(latest(LIVE), liveBody())
    await advance(60_000)
    expect(requestsFor(LIVE)).toHaveLength(4)
  })

  it('keeps auto-refresh off across visibility changes while allowing manual refresh', async () => {
    await loadLive()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-refresh (60s)' }))
    setPageHidden(true)
    await advance(180_000)
    setPageHidden(false)
    expect(requestsFor(LIVE)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(requestsFor(LIVE)).toHaveLength(2)
    await respond(latest(LIVE), liveBody())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-refresh (60s)' }))
    await advance(60_000)
    expect(requestsFor(LIVE)).toHaveLength(3)
  })

  it.each(['0915', 'EOD'])('freezes history %s through timers and visibility changes, and resumes after Back to Live', async (time) => {
    await loadLive()
    await pickDate()
    fireEvent.change(screen.getByRole('combobox', { name: 'Time…' }), { target: { value: time } })
    await respond(latest(HISTORY), {
      ...liveBody([{ ...MEMBERS[0], spent_usd: 12.34567 }]),
      snapshot: { date: DATE, time }, approx: time === 'EOD',
    })

    setPageHidden(true)
    await advance(180_000)
    setPageHidden(false)
    expect(requestsFor(LIVE)).toHaveLength(1)
    expect(requestsFor(HISTORY)).toHaveLength(1)
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$12.35')
    expect(screen.queryByRole('button', { name: 'Refresh now' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Live' }))
    expect(screen.getByText('MTD Total').parentElement?.textContent).toContain('$1,339.69')
    await respond(latest(LIVE), liveBody())
    await advance(60_000)
    expect(requestsFor(LIVE)).toHaveLength(3)
    expect(latest(LIVE).url.searchParams.get('fresh')).toBe('1')
  })
})
