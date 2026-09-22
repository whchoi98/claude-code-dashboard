// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Users } from '../../src/pages/Users'
import { GroupScopeProvider } from '../../src/lib/GroupScopeProvider'
import { I18nProvider, useI18n, type Locale } from '../../src/lib/i18n'
import { OrgProvider, useOrg } from '../../src/lib/OrgProvider'
import { setUnmasked } from '../../src/lib/format'
import type { UserRecord } from '../../src/types'

const USERS = '/api/analytics/users/range'
const TOKENS = '/api/cost/user-tokens'
const GROUPS = {
  source: 'members', file: null,
  groups: ['Engineering', 'Finance', 'Shared'],
  map: {
    'alice@eng.test': 'Engineering',
    'bob@eng.test': ['Engineering', 'Shared'],
    'dina@eng.test': ['Engineering'],
    'edgar@eng.test': ['Engineering'],
    'carol@finance.test': ['Finance'],
  },
  group_ids: { Engineering: 'engineering', Finance: 'finance', Shared: 'shared' },
}

function user(
  email: string,
  loc: number,
  lastActive?: string | null,
  metrics: Partial<{
    messages: number; conversations: number; sessions: number; removed: number;
    commits: number; prs: number; cowork: number; actions: number; design: number;
    accepted: number; rejected: number;
  }> = {},
): UserRecord {
  const n = {
    messages: 0, conversations: 0, sessions: 0, removed: 0, commits: 0,
    prs: 0, cowork: 0, actions: 0, design: 0, accepted: 0, rejected: 0, ...metrics,
  }
  const office = {
    distinct_session_count: 0, message_count: 0, skills_used_count: 0,
    distinct_skills_used_count: 0, connectors_used_count: 0, distinct_connectors_used_count: 0,
  }
  return {
    user: { id: `fixture-${email}`, email_address: email },
    chat_metrics: {
      message_count: n.messages, distinct_conversation_count: n.conversations,
      thinking_message_count: 0, distinct_projects_used_count: 0, distinct_projects_created_count: 0,
      distinct_artifacts_created_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_files_uploaded_count: 0,
    },
    claude_code_metrics: {
      core_metrics: {
        distinct_session_count: n.sessions, commit_count: n.commits, pull_request_count: n.prs,
        lines_of_code: { added_count: loc, removed_count: n.removed },
      },
      tool_actions: {
        edit_tool: { accepted_count: n.accepted, rejected_count: n.rejected },
        multi_edit_tool: { accepted_count: 0, rejected_count: 0 },
        write_tool: { accepted_count: 0, rejected_count: 0 },
        notebook_edit_tool: { accepted_count: 0, rejected_count: 0 },
      },
    },
    office_metrics: { excel: office, powerpoint: office, word: office, outlook: office },
    cowork_metrics: {
      distinct_session_count: n.cowork, action_count: n.actions, dispatch_turn_count: 0,
      message_count: 0, file_edit_count: null, edit_tool_count: null, multi_edit_tool_count: null,
      write_tool_count: null, notebook_edit_tool_count: null, sessions_with_file_edits_count: null,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    design_metrics: {
      distinct_session_count: n.design, distinct_projects_used_count: 0,
      distinct_projects_created_count: 0, message_count: 0,
    },
    web_search_count: 0,
    last_activity_date: lastActive,
  }
}

const FIRST_DAY = [
  user('alice@eng.test', 1234, '2026-08-30', {
    messages: 1000, conversations: 2, sessions: 2, removed: 4, commits: 1, prs: 0,
    cowork: 1, actions: 11, design: 2, accepted: 1, rejected: 1,
  }),
  user('bob@eng.test', 50, '2026-09-07', {
    messages: 20, conversations: 1, sessions: 1, removed: 2, commits: 2, prs: 1,
    cowork: 1, actions: 4, design: 0, accepted: 3, rejected: 1,
  }),
  user('carol@finance.test', 9000, '2026-09-19'),
  user('dina@eng.test', 3000, '2026-09-08'),
  user('edgar@eng.test', 6000, null),
]
const SECOND_DAY = [
  user('alice@eng.test', 66, '2026-09-01', {
    messages: 234, conversations: 3, sessions: 3, removed: 6, commits: 2, prs: 1,
    cowork: 2, actions: 12, design: 1, accepted: 1, rejected: 3,
  }),
  user('bob@eng.test', 25, '2026-09-07', {
    messages: 10, conversations: 2, sessions: 2, prs: 1, actions: 2, design: 1, accepted: 1,
  }),
]
const TOKEN_BODY = {
  users: [
    { email: 'ALICE@ENG.TEST', input_tokens: 1000, output_tokens: 100, requests: 5, cache_hit_rate: 0.123456789 },
    { email: 'bob@eng.test', input_tokens: 0, output_tokens: 0, requests: 0, cache_hit_rate: null },
  ],
}

function rangeBody(
  records = FIRST_DAY,
  start = '2026-09-15',
  end = '2026-09-21',
  secondDay = SECOND_DAY,
) {
  return {
    range: { starting_date: start, ending_date: end },
    days: [
      { date: start, source: 's3', data: records },
      ...(secondDay.length ? [{ date: end, source: 'live', data: secondDay }] : []),
    ],
  }
}

type Request = { url: URL; respond: (body: unknown, status?: number) => void }
let requests: Request[]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function latest(path: string, org = 'primary') {
  const request = requests.filter(({ url }) =>
    url.pathname === path && (url.searchParams.get('org') ?? 'primary') === org,
  ).at(-1)
  if (!request) throw new Error(`No request for ${path} (${org})`)
  return request
}

async function respond(request: Request, body: unknown, status = 200) {
  await act(async () => { request.respond(body, status) })
}

type Commit = { search: string; detail: string | null }
function mountUsers({
  url = '/users?range=7d&group=Engineering',
  locale = 'en',
  commits = [],
}: { url?: string; locale?: Locale; commits?: Commit[] } = {}) {
  localStorage.setItem('ccd.locale', locale)
  let i18n!: ReturnType<typeof useI18n>
  function Controls() {
    const { setOrg } = useOrg()
    const location = useLocation()
    i18n = useI18n()
    return (
      <nav aria-label="Test controls">
        <output data-testid="current-search">{location.search}</output>
        <button type="button" onClick={() => setOrg('org2')}>Second organization</button>
      </nav>
    )
  }
  const view = render(
    <Profiler id="users" onRender={() => {
      commits.push({
        search: document.querySelector('[data-testid="current-search"]')?.textContent ?? '',
        detail: document.querySelector('aside h2')?.textContent ?? null,
      })
    }}>
      <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <I18nProvider>
          <OrgProvider>
            <GroupScopeProvider>
              <Controls />
              <main aria-label="Users page"><Users /></main>
            </GroupScopeProvider>
          </OrgProvider>
        </I18nProvider>
      </MemoryRouter>
    </Profiler>,
  )
  return { ...view, t: ((key, params) => i18n.t(key, params)) as typeof i18n.t }
}

async function loadUsers(options: Parameters<typeof mountUsers>[0] = {}) {
  const view = mountUsers(options)
  const org = new URL(options.url ?? '/users', 'http://dashboard.test').searchParams.get('org') ?? 'primary'
  await respond(latest('/api/groups', org), GROUPS)
  await respond(latest(TOKENS, org), TOKEN_BODY)
  await respond(latest(USERS, org), rangeBody())
  return view
}

function displayedUsers() {
  const body = within(screen.getByRole('table')).getAllByRole('rowgroup')[1]
  return within(body).getAllByRole('row').map((row) => within(row).getAllByRole('cell')[0].textContent)
}

function routeParams() {
  return new URLSearchParams(screen.getByTestId('current-search').textContent!)
}

function captureDownloads() {
  let pendingBlob: Blob
  const files: { filename: string; blob: Blob }[] = []
  // Only the browser download handoff is intercepted. The page, formatter,
  // CSV serializer and Blob all execute normally.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { pendingBlob = blob; return 'blob:users-test' }
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
  // These fixtures contain no embedded delimiters; serializer escaping has
  // its own tests. Inspect independent field values, not serializeCsv output.
  const [headers, ...data] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')))
  return { text, headers, rows: data.map((cells) => Object.fromEntries(headers.map((key, i) => [key, cells[i]]))) }
}

beforeEach(() => {
  // Leave setImmediate real for jsdom FileReader.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'))
  setUnmasked(false)
  requests = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
    if (url.pathname === '/api/health') {
      return Promise.resolve(json({
        ok: true, analyticsKey: 'analytics', adminKey: 'admin',
        apiUrl: 'https://api.example.test', apiVersion: 'fixture',
        dataConstraints: {
          firstAvailableDate: '2026-01-01', bufferDays: 3, maxLookbackDays: 90,
          summariesMaxRangeDays: 31, rateLimitPerMinute: 60,
        },
      }))
    }
    if (url.pathname === '/api/cost/users') return Promise.resolve(json({ users: [] }))
    if (url.pathname === '/api/analytics/skills/range') return Promise.resolve(json({ days: [] }))
    if (!['/api/groups', USERS, TOKENS].includes(url.pathname)) throw new Error(`Unexpected fetch: ${url}`)
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      requests.push({
        url,
        respond: (body, status = 200) => {
          signal?.removeEventListener('abort', abort)
          resolve(json(body, status))
        },
      })
    })
  }))
})

afterEach(() => {
  cleanup()
  setUnmasked(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Users CSV reflects the visible table', () => {
  it('exports group, search and dormant matches in the current sort order with raw metrics and masked emails', async () => {
    const files = captureDownloads()
    const view = await loadUsers()
    fireEvent.change(screen.getByPlaceholderText(view.t('users.search')), { target: { value: '  ENG.TEST ' } })
    fireEvent.click(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }))
    fireEvent.click(screen.getByRole('button', { name: view.t('table.sort', { column: view.t('users.col.loc') }) }))
    expect(displayedUsers()).toEqual(['bo***@eng.test', 'al***@eng.test'])

    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))

    expect(files).toHaveLength(1)
    expect(files[0].filename).toContain('primary')
    expect(files[0].filename).toContain('2026-09-15')
    expect(files[0].filename).toContain('2026-09-21')
    const csv = await readCsv(files[0].blob)
    expect(csv.rows.map((row) => row.email)).toEqual(['bo***@eng.test', 'al***@eng.test'])
    expect(csv.rows[0]).toMatchObject({
      org: 'primary', group: 'Engineering', starting_date: '2026-09-15', ending_date: '2026-09-21',
      loc_added: '75', acceptance_rate: '0.8', cache_hit_rate: '', last_active_date: '2026-09-07',
    })
    expect(csv.rows[1]).toMatchObject({
      messages: '1234', conversations: '5', sessions: '5', loc_added: '1300', loc_removed: '10',
      commits: '3', pull_requests: '1', cowork_sessions: '3', cowork_actions: '23', design_sessions: '3',
      acceptance_rate: '0.3333333333333333', cache_hit_rate: '0.123456789', last_active_date: '2026-09-01',
    })
    expect(csv.text).not.toContain('alice@eng.test')
    expect(csv.text).not.toContain('bob@eng.test')
    expect(csv.text).not.toMatch(/carol|dina|edgar/)
  })

  it('uses the identity-aware formatter for unmasked viewers as well', async () => {
    setUnmasked(true)
    const files = captureDownloads()
    const view = await loadUsers()
    fireEvent.change(screen.getByPlaceholderText(view.t('users.search')), { target: { value: 'Alice' } })

    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))

    expect(displayedUsers()).toEqual(['alice@eng.test'])
    expect((await readCsv(files[0].blob)).rows.map((row) => row.email)).toEqual(['alice@eng.test'])
  })

  it('omits last-active from old archives and ignores an unavailable dormant filter after changing dates', async () => {
    const files = captureDownloads()
    const view = await loadUsers()
    fireEvent.click(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }))
    fireEvent.click(screen.getByRole('button', { name: view.t('range.custom') }))
    fireEvent.change(screen.getByLabelText(view.t('range.start')), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText(view.t('range.end')), { target: { value: '2026-01-02' } })
    fireEvent.click(screen.getByRole('button', { name: view.t('range.apply') }))
    const oldRecords = [user('alice@eng.test', 10), user('bob@eng.test', 20)]
    await respond(latest(TOKENS), { users: [] })
    await respond(latest(USERS), rangeBody(oldRecords, '2026-01-01', '2026-01-02', []))

    expect(displayedUsers()).toEqual(['bo***@eng.test', 'al***@eng.test'])
    expect(screen.queryByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: new RegExp(view.t('users.col.last_active')) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))

    const csv = await readCsv(files[0].blob)
    expect(csv.headers).not.toContain('last_active_date')
    expect(csv.rows.map((row) => row.email)).toEqual(['bo***@eng.test', 'al***@eng.test'])
    expect(csv.rows[0]).toMatchObject({ starting_date: '2026-01-01', ending_date: '2026-01-02' })
    expect(files[0].filename).toContain('2026-01-01')
    expect(files[0].filename).toContain('2026-01-02')
  })

  it('does not export a stale date window or join the previous window’s cache percentages', async () => {
    const files = captureDownloads()
    const view = await loadUsers()

    fireEvent.click(screen.getByText('14d', { selector: 'button' }))

    const pendingExport = screen.queryByRole<HTMLButtonElement>('button', { name: view.t('table.export') })
    expect(pendingExport == null || pendingExport.disabled).toBe(true)
    expect(files).toHaveLength(0)
    await respond(latest(USERS), rangeBody([user('alice@eng.test', 42, '2026-09-01')], '2026-09-08', '2026-09-21', []))
    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))
    const csv = await readCsv(files[0].blob)

    expect(csv.rows).toHaveLength(1)
    expect(csv.rows[0]).toMatchObject({
      starting_date: '2026-09-08', ending_date: '2026-09-21', loc_added: '42', cache_hit_rate: '',
    })
    expect(files[0].filename).toContain('2026-09-08')
    await respond(latest(TOKENS), {
      users: [{ email: 'alice@eng.test', input_tokens: 100, output_tokens: 10, requests: 1, cache_hit_rate: 0.987654321 }],
    })
    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))
    expect((await readCsv(files[1].blob)).rows[0].cache_hit_rate).toBe('0.987654321')
  })

  it('waits for the group map before allowing export from a group deep link', async () => {
    const files = captureDownloads()
    const view = mountUsers()
    await respond(latest(TOKENS), TOKEN_BODY)
    await respond(latest(USERS), rangeBody())

    const button = screen.getByRole<HTMLButtonElement>('button', { name: view.t('table.export') })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(files).toHaveLength(0)

    await respond(latest('/api/groups'), GROUPS)
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    const csv = await readCsv(files[0].blob)
    expect(csv.rows).toHaveLength(4)
    expect(csv.rows.every((row) => row.group === 'Engineering')).toBe(true)
    expect(csv.text).not.toContain('finance.test')
  })

  it('exports the resolved organization after an organization switch without reusing old rows', async () => {
    const files = captureDownloads()
    const view = await loadUsers()
    fireEvent.click(screen.getByRole('button', { name: 'Second organization' }))
    expect(screen.queryByRole('table')).toBeNull()
    await respond(latest('/api/groups', 'org2'), GROUPS)
    await respond(latest(TOKENS, 'org2'), { users: [] })
    await respond(latest(USERS, 'org2'), rangeBody([user('zoe@second.test', 99)], '2026-09-15', '2026-09-21', []))

    fireEvent.click(screen.getByRole('button', { name: view.t('table.export') }))

    const csv = await readCsv(files[0].blob)
    expect(csv.rows).toHaveLength(1)
    expect(csv.rows[0]).toMatchObject({ org: 'org2', group: '', email: 'zo***@second.test', loc_added: '99' })
    expect(files[0].filename).toContain('org2')
    expect(csv.text).not.toContain('eng.test')
  })
})

describe('Users search, counts and empty states', () => {
  it.each(['en', 'ko'] as const)('labels search and counts the scoped results in %s', async (locale) => {
    const view = await loadUsers({ locale })
    const search = screen.getByRole('searchbox', { name: view.t('users.search') })
    expect(search.getAttribute('placeholder')).toBe(view.t('users.search'))
    expect(screen.getByText(view.t('table.count', { shown: 4, total: 4 }))).toBeTruthy()
    const download = screen.getByRole('button', { name: view.t('table.export') })
    expect(download.title).toBe(view.t('table.export_hint'))

    fireEvent.change(search, { target: { value: '  ALICE ' } })

    expect(displayedUsers()).toEqual(['al***@eng.test'])
    expect(screen.getByText(view.t('table.count', { shown: 1, total: 4 }))).toBeTruthy()
    expect(screen.getByText(view.t('table.count', { shown: 1, total: 4 })).closest('[aria-live]'))
      .not.toBeNull()
    if (locale === 'ko') expect(download.textContent).toMatch(/[가-힣]/)
  })

  it('clears search, returns focus to it and preserves the dormant filter and sort', async () => {
    const view = await loadUsers()
    fireEvent.click(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }))
    fireEvent.click(screen.getByRole('button', { name: view.t('table.sort', { column: view.t('users.col.loc') }) }))
    const search = screen.getByPlaceholderText<HTMLInputElement>(view.t('users.search'))
    fireEvent.change(search, { target: { value: 'alice' } })

    fireEvent.click(screen.getByRole('button', { name: view.t('table.clear') }))

    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect(displayedUsers()).toEqual(['bo***@eng.test', 'al***@eng.test'])
    expect(screen.getByText(view.t('table.count', { shown: 2, total: 4 }))).toBeTruthy()
    expect(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }).getAttribute('aria-pressed'))
      .toBe('true')
    expect(routeParams().get('group')).toBe('Engineering')
    expect(routeParams().get('range')).toBe('7d')
  })

  it('distinguishes no matches, disables export and resets only the local filters', async () => {
    const view = await loadUsers()
    fireEvent.click(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }))
    fireEvent.click(screen.getByRole('button', { name: view.t('table.sort', { column: view.t('users.col.loc') }) }))
    fireEvent.change(screen.getByPlaceholderText(view.t('users.search')), { target: { value: 'absent' } })

    expect(screen.getByText(view.t('table.no_matches'))).toBeTruthy()
    expect(screen.queryByText(view.t('common.empty'))).toBeNull()
    expect(screen.getByText(view.t('table.count', { shown: 0, total: 4 }))).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: view.t('table.export') }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: view.t('table.reset') }))

    expect(displayedUsers()).toEqual(['bo***@eng.test', 'al***@eng.test', 'di***@eng.test', 'ed***@eng.test'])
    expect(screen.getByPlaceholderText<HTMLInputElement>(view.t('users.search')).value).toBe('')
    expect(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }).getAttribute('aria-pressed'))
      .toBe('false')
    expect(routeParams().get('group')).toBe('Engineering')
    expect(routeParams().get('range')).toBe('7d')
    expect(screen.getByText(view.t('table.count', { shown: 4, total: 4 }))).toBeTruthy()
  })

  it('can reset an empty dormant-only result when the email query is blank', async () => {
    const view = await loadUsers({ url: '/users?range=7d&group=Finance' })
    fireEvent.click(screen.getByRole('button', { name: view.t('users.dormant.toggle', { days: 14 }) }))
    expect(screen.getByText(view.t('table.no_matches'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: view.t('table.reset') }))

    expect(displayedUsers()).toEqual(['ca***@finance.test'])
    expect(routeParams().get('group')).toBe('Finance')
  })

  it('reports no underlying data separately from filters with no matches', async () => {
    const view = mountUsers()
    await respond(latest('/api/groups'), GROUPS)
    await respond(latest(TOKENS), { users: [] })
    await respond(latest(USERS), rangeBody([], '2026-09-15', '2026-09-21', []))

    expect(screen.getByText(view.t('common.empty'))).toBeTruthy()
    expect(screen.queryByText(view.t('table.no_matches'))).toBeNull()
    expect(screen.queryByRole('button', { name: view.t('table.reset') })).toBeNull()
    expect(screen.getByText(view.t('table.count', { shown: 0, total: 0 }))).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: view.t('table.export') }).disabled).toBe(true)
  })
})

describe('Users detail selection stays in scope', () => {
  it('provides a focusable native email button that opens the real detail panel without exposing raw identities', async () => {
    const view = await loadUsers()
    const button = screen.getByRole('button', { name: view.t('table.open_user', { user: 'al***@eng.test' }) })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.outerHTML).not.toContain('alice@eng.test')
    button.focus()
    expect(document.activeElement).toBe(button)

    // jsdom does not synthesize Enter's native click default action.
    act(() => { button.click() })

    expect(screen.getByRole('heading', { level: 2, name: 'al***@eng.test' })).toBeTruthy()
    expect(screen.getByRole('button', { name: view.t('common.close') })).toBeTruthy()
  })

  it('never commits an out-of-group detail panel and does not resurrect it when returning to All', async () => {
    const commits: Commit[] = []
    const view = await loadUsers({ commits })
    fireEvent.click(screen.getByText('al***@eng.test').closest('tr')!)
    expect(screen.getByRole('heading', { level: 2, name: 'al***@eng.test' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Finance' }))

    expect(screen.queryByRole('heading', { level: 2, name: 'al***@eng.test' })).toBeNull()
    const financeCommits = commits.filter((commit) => new URLSearchParams(commit.search).get('group') === 'Finance')
    expect(financeCommits.length).toBeGreaterThan(0)
    expect(financeCommits.every((commit) => commit.detail === null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: view.t('group.all') }))
    expect(screen.queryByRole('heading', { level: 2, name: 'al***@eng.test' })).toBeNull()
  })

  it('keeps a selected member who also belongs to the newly selected group', async () => {
    await loadUsers()
    fireEvent.click(screen.getByText('bo***@eng.test').closest('tr')!)

    fireEvent.click(screen.getByRole('button', { name: 'Shared' }))

    expect(displayedUsers()).toEqual(['bo***@eng.test'])
    expect(screen.getByRole('heading', { level: 2, name: 'bo***@eng.test' })).toBeTruthy()
  })

  it('does not reopen a previous organization’s selected email after new data arrives', async () => {
    const commits: Commit[] = []
    await loadUsers({ commits })
    fireEvent.click(screen.getByText('al***@eng.test').closest('tr')!)
    fireEvent.click(screen.getByRole('button', { name: 'Second organization' }))
    await respond(latest('/api/groups', 'org2'), GROUPS)
    await respond(latest(TOKENS, 'org2'), { users: [] })
    await respond(latest(USERS, 'org2'), rangeBody([user('alice@eng.test', 1)], '2026-09-15', '2026-09-21', []))

    expect(displayedUsers()).toEqual(['al***@eng.test'])
    expect(screen.queryByRole('heading', { level: 2, name: 'al***@eng.test' })).toBeNull()
    const org2Commits = commits.filter((commit) => new URLSearchParams(commit.search).get('org') === 'org2')
    expect(org2Commits.every((commit) => commit.detail === null)).toBe(true)
  })
})

async function animationFrames() {
  await act(async () => {
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()
  })
}

describe('Users detail dialog keyboard lifecycle', () => {
  it.each(['en', 'ko'] as const)('focuses the close button and returns to the opener on Escape in %s', async (locale) => {
    const view = await loadUsers({ locale })
    const opener = screen.getByRole('button', { name: view.t('table.open_user', { user: 'al***@eng.test' }) })
    opener.focus()
    fireEvent.click(opener)
    const close = screen.getByRole('button', { name: view.t('common.close') })

    await animationFrames()

    expect(document.activeElement).toBe(close)
    const dialog = screen.getByRole('dialog', { name: 'al***@eng.test' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.closest('main')).toBe(screen.getByRole('main', { name: 'Users page' }))
    expect(dialog.closest('[inert]')).toBeNull()
    expect(dialog.outerHTML).not.toContain('alice@eng.test')

    expect(fireEvent.keyDown(close, { key: 'Escape' })).toBe(false)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dialog.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.querySelector('button')).toBeNull()
    expect(document.activeElement).toBe(opener)
    // A closed dialog must release its document-wide keyboard listener.
    expect(fireEvent.keyDown(opener, { key: 'Tab' })).toBe(true)
  })

  it.each([false, true])('traps Tab with shiftKey=%s while the detail request is pending', async (shiftKey) => {
    const view = await loadUsers()
    const opener = screen.getByRole('button', { name: view.t('table.open_user', { user: 'al***@eng.test' }) })
    opener.focus()
    fireEvent.click(opener)
    await animationFrames()
    const close = screen.getByRole('button', { name: view.t('common.close') })
    close.focus()

    // jsdom has no native Tab navigation. Preventing its default action and
    // choosing the destination verifies the trap rather than jsdom's inertia.
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey })).toBe(false)
    expect(document.activeElement).toBe(close)

    const outside = screen.getByRole('button', { name: 'Second organization' })
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab', shiftKey })).toBe(false)
    expect(document.activeElement).toBe(close)
  })

  it('does not steal focus when the parent callback, selected email or successful response changes', async () => {
    const view = await loadUsers()
    const opener = screen.getByRole('button', { name: view.t('table.open_user', { user: 'al***@eng.test' }) })
    opener.focus()
    fireEvent.click(opener)
    await animationFrames()
    const dialog = screen.getByRole('dialog', { name: 'al***@eng.test' })
    dialog.focus()
    expect(document.activeElement).toBe(dialog)

    // Updating the real page recreates its inline onClose callback.
    fireEvent.change(screen.getByRole('searchbox', { name: view.t('users.search') }), { target: { value: 'eng.test' } })
    await animationFrames()
    expect(document.activeElement).toBe(dialog)
    expect(screen.getByRole('button', { name: view.t('table.clear') })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: view.t('table.open_user', { user: 'bo***@eng.test' }) }))
    await animationFrames()
    expect(screen.getByRole('dialog', { name: 'bo***@eng.test' })).toBe(dialog)
    expect(document.activeElement).toBe(dialog)

    // An empty successful detail response renders its served dates without
    // needing a browser layout engine for Recharts. Metrics stay real in the
    // CSV tests and the browser checks with non-empty detail responses.
    await respond(latest(USERS), {
      range: { starting_date: '2026-09-15', ending_date: '2026-09-18' }, days: [],
    })
    await animationFrames()
    expect(within(dialog).getByText('Sep 15 – Sep 18')).toBeTruthy()
    expect(document.activeElement).toBe(dialog)
    expect(dialog.outerHTML).not.toContain('bob@eng.test')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('restores focus when the close button is activated', async () => {
    const view = await loadUsers()
    const opener = screen.getByRole('button', { name: view.t('table.open_user', { user: 'bo***@eng.test' }) })
    opener.focus()
    fireEvent.click(opener)
    await animationFrames()
    const close = screen.getByRole('button', { name: view.t('common.close') })
    close.focus()

    fireEvent.click(close)

    expect(screen.queryByRole('heading', { level: 2, name: 'bo***@eng.test' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
