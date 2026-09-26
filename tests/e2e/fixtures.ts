import type { Page } from '@playwright/test'
import { generateMock } from '../../server/mock.js'

export const today = new Date().toISOString().slice(0, 10)
const nextDate = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)

/** Synthetic, complete API shapes. Every API request stays in the browser test. */
export function apiFixture(url: URL): unknown {
  const params = url.searchParams
  const path = url.pathname
  const secondOrg = params.get('org') === 'org2'
  const emails = secondOrg ? ['carol@example.test', 'david@example.test'] : ['alice@example.test', 'bob@example.test']
  const period = { starting_date: params.get('starting_date') || today, ending_date: params.get('ending_date') || today }
  const members = emails.map((email, index) => ({
    email, name: index ? 'Bob Example' : 'Alice Example', limit_usd: index ? null : 2000,
    spent_usd: index ? 25.12 : 1234.5678, utilization: index ? null : 0.6172839,
    period: 'monthly', source: 'organization_default',
  }))
  const usersFor = (date: string) => generateMock.users(date).data.slice(0, 2).map((row, index) => ({
    ...row,
    user: { ...row.user, email_address: emails[index] },
    last_activity_date: nextDate(today, index ? -20 : -3),
  }))
  if (path === '/api/me') return { email: 'viewer@example.test', unmask: false, groups: [] }
  if (path === '/api/orgs') return {
    orgs: [{ id: 'primary', label: 'Primary', admin: false, compliance: true }, { id: 'org2', label: 'Second', admin: false, compliance: true }],
    default: 'primary',
  }
  if (path === '/api/health') return {
    ok: true, analyticsKey: 'analytics', adminKey: 'none', apiUrl: 'https://example.test',
    apiVersion: '2023-06-01',
    dataConstraints: { firstAvailableDate: '2026-01-01', bufferDays: 3, maxLookbackDays: 90, summariesMaxRangeDays: 366, rateLimitPerMinute: 60 },
  }
  if (path === '/api/groups') return {
    source: 'members', file: null, groups: ['Engineering', 'Design'],
    map: { [emails[0]]: ['Engineering'], [emails[1]]: ['Design'] },
    group_ids: { Engineering: 'grp-engineering', Design: 'grp-design' },
  }
  if (path === '/api/analytics/summaries') return { source: 'live', ...generateMock.summaries(period.starting_date, period.ending_date) }
  if (path === '/api/analytics/users') return { source: 'live', date: params.get('date'), data: usersFor(params.get('date') || today), has_more: false, next_page: null }
  const rangeKind = path.match(/^\/api\/analytics\/(users|skills|connectors|projects|plugins)\/range$/)?.[1]
  if (rangeKind) {
    const days = []
    for (let date = period.starting_date; date <= period.ending_date; date = nextDate(date, 1)) {
      days.push({
        date, source: 'live',
        data: rangeKind === 'users' ? usersFor(date) : generateMock[rangeKind](date).data,
      })
    }
    return { range: period, days }
  }
  if (path === '/api/compliance/activities') return {
    source: 'live', has_more: false, stop_reason: 'has_more=false', partial: false, total_fetched: 4, in_window: 4,
    // Real activity-enum types and actor shapes (Compliance API reference).
    data: [
      { id: 'event-1', type: 'sso_login_succeeded', created_at: `${today}T09:00:00Z`, actor: { type: 'user_actor', email_address: emails[0], user_id: 'user_1' }, organization_id: 'test-org' },
      { id: 'event-2', type: 'admin_api_key_created', created_at: `${today}T08:30:00Z`, actor: { type: 'admin_api_key_actor', admin_api_key_id: 'apikey_admin_42' }, organization_id: 'test-org' },
      { id: 'event-3', type: 'claude_file_viewed', created_at: `${today}T08:00:00Z`, actor: { type: 'user_actor', email_address: emails[1], user_id: 'user_2' }, organization_id: 'test-org', claude_file_id: 'claude_file_0123456789ab', filename: null },
      { id: 'event-4', type: 'scim_user_deleted', created_at: `${today}T07:00:00Z`, actor: { type: 'scim_directory_sync_actor', directory_id: 'directory_77', workos_event_id: 'evt_1' }, organization_id: 'test-org' },
    ],
  }
  const rows = emails.map((user_email, index) => ({
    user_email, account_uuid: `sample-${index}`, product: 'claude_code', model: 'claude_sonnet_4_6',
    total_requests: 10, total_prompt_tokens: 2000, total_completion_tokens: 500,
    total_net_spend_usd: members[index].spent_usd, total_gross_spend_usd: members[index].spent_usd,
  }))
  if (path === '/api/cost/live' || path === '/api/cost/csv') return {
    source: path.endsWith('/csv') ? 'csv' : 'live', file: null, last_modified: `${today}T12:00:00Z`,
    data_refreshed_at: `${today}T12:00:00Z`, period, rows, rbac_group_id: params.get('rbac_group_id') || undefined,
    daily: [{ date: period.ending_date, model: 'claude_sonnet_4_6', spend: 1259.6878, input: 4000, output: 1000, requests: 20 }],
    totals: { requests: 20, prompt_tokens: 4000, completion_tokens: 1000, net_spend_usd: 1259.6878, gross_spend_usd: 1259.6878, distinct_users: 2, distinct_models: 1, distinct_products: 1 },
    token_tiers: { uncached: 1000, cache_read: 2000, cache_creation: 1000, output: 1000, input_total: 4000, cache_hit_rate: 0.5 },
  }
  if (path === '/api/cost/users') return {
    source: 'live', period, users: members.map((member, index) => ({
      email: member.email, name: member.name, user_id: `user-${index}`, deleted: false,
      net_spend_usd: member.spent_usd, gross_spend_usd: member.spent_usd, requests: 10,
      by_model: [{ model: 'claude_sonnet_4_6', spend_usd: member.spent_usd, requests: 10 }],
      by_product: [{ product: 'claude_code', spend_usd: member.spent_usd, requests: 10 }],
    })),
  }
  if (path === '/api/cost/user-tokens') return {
    source: 'live', period, users: emails.map((email) => ({
      email, input_tokens: 2000, output_tokens: 500, total_tokens: 2500, requests: 10,
      uncached_tokens: 500, cache_read_tokens: 1000, cache_creation_tokens: 500, cache_hit_rate: 0.5,
    })),
  }
  if (path === '/api/cost/efficiency') return {
    source: 'live+analytics', period, user_count: 0, users: [],
    totals: { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0, avg_cost_per_loc: null, avg_cost_per_commit: null },
  }
  if (path === '/api/cost/groups') return {
    source: 'live', period, groups: [{ group_id: 'grp-engineering', label: 'Engineering', spend_usd: 1234.5678, requests: 10 }],
    ungrouped: { spend_usd: 25.12, requests: 10 },
  }
  if (path === '/api/cost/uploads') return { source: 's3', files: [] }
  if (path === '/api/cost/spend-limits') return { source: 'live', period: 'monthly', fetched_at: `${today}T12:00:00Z`, members }
  if (path === '/api/cost/spend-limits/snapshots') return params.get('date')
    ? { date: params.get('date'), times: ['0900', '1200'] }
    : { dates: [nextDate(today, -1), today] }
  if (path === '/api/cost/spend-limits/at') return {
    source: 'archive', period: 'monthly', fetched_at: `${params.get('date')}T12:00:00Z`,
    snapshot: { date: params.get('date'), time: params.get('time') || 'EOD' }, approx: !params.has('time'), members,
  }
  throw new Error(`Unmocked API request: ${path}`)
}

export async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/chat/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: text\ndata: {"text":"Sample response"}\n\nevent: done\ndata: {"ok":true}\n\n',
      })
      return
    }
    await route.fulfill({ json: apiFixture(url) })
  })
}
