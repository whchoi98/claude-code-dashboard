import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { apiFixture, mockApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ccd.locale', 'en'))
  await mockApi(page)
})

const pages = [
  ['/', 'Overview'], ['/exec', 'Executive Snapshot'], ['/users', 'Users'],
  ['/trends', 'Trends'], ['/claude-code', 'Claude Code'], ['/claude-chat', 'Claude Chat'],
  ['/cowork', 'Cowork'], ['/agentic', 'How agentic is the work?'], ['/office', 'Office'],
  ['/design', 'Design'], ['/productivity', 'Productivity'], ['/user-productivity', 'User Productivity'],
  ['/user-search', 'User Search'], ['/adoption', 'Adoption'], ['/cost', 'Cost'],
  ['/cost-live', 'Cost Live (MTD)'], ['/compliance', 'Audit'], ['/analyze', 'Analyze'],
  ['/archive', 'Archive'], ['/changelog', 'Changelog'],
]

for (const [path, title] of pages) {
  test(`renders ${path} without errors or page overflow`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${path}?range=7d`)
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible()
    const main = page.getByRole('main')
    await expect(main.getByRole('alert')).toHaveCount(0)
    await expect(main).not.toContainText('NaN')
    const widths = await main.evaluate((element) => ({ content: element.scrollWidth, viewport: element.clientWidth }))
    expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1)
    expect(errors).toEqual([])
    if (path === '/' || path === '/cost-live') {
      const assets = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
        .map((entry) => ({ file: new URL(entry.name).pathname, bytes: (entry as PerformanceResourceTiming).decodedBodySize })))
      await testInfo.attach('asset-usage', { body: JSON.stringify({ assets, totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) }), contentType: 'application/json' })
    }
    if (path === '/users' || path === '/cost-live') {
      await page.screenshot({ path: testInfo.outputPath('screen.png') })
    }
  })
}

test('recovers from an invalid API response without a full page reload', async ({ page }) => {
  let requests = 0
  await page.route('**/api/analytics/summaries?*', async (route) => {
    requests++
    if (requests === 1) await route.fulfill({ body: '<html>Temporary proxy failure</html>', contentType: 'text/html' })
    else await route.fulfill({ json: apiFixture(new URL(route.request().url())) })
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
  expect(requests).toBe(2)
})

test('validates dates and keeps UTC labels in a western time zone', async ({ page }) => {
  await page.goto('/users?range=custom&start=2026-09-01&end=2026-09-02')
  const control = page.getByRole('button', { name: 'Change date range' })
  await expect(control).toContainText('Sep 1 – Sep 2')
  await control.click()
  const dialog = page.getByRole('dialog', { name: 'Custom range' })
  await dialog.getByLabel('Start', { exact: true }).fill('')
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await dialog.getByLabel('Start', { exact: true }).fill('2026-09-03')
  await expect(dialog.getByRole('alert')).toContainText('end date')
  await dialog.getByLabel('End', { exact: true }).fill('2026-09-04')
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page).toHaveURL(/start=2026-09-03&end=2026-09-04/)
  await expect(control).toContainText('Sep 3 – Sep 4')
})

test('quick navigation preserves group and organization', async ({ page }) => {
  await page.goto('/users?org=org2&group=Engineering&range=14d')
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  const search = page.getByRole('searchbox', { name: 'Find a page' })
  await expect(search).toBeFocused()
  await search.fill('Cost Live')
  await search.press('Enter')
  await expect(page.getByRole('heading', { name: 'Cost Live (MTD)', exact: true })).toBeVisible()
  const url = new URL(page.url())
  expect(url.searchParams.get('org')).toBe('org2')
  expect(url.searchParams.get('group')).toBe('Engineering')
  expect(url.searchParams.has('range')).toBe(false)
})

test('exports only searched rows with masked email and exact spend', async ({ page }) => {
  await page.goto('/cost-live')
  await page.getByRole('searchbox', { name: 'Search members by email or name' }).fill('alice')
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tfoot')).toContainText('$1,234.57')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click()
  const download = await downloadPromise
  const text = await readFile((await download.path())!, 'utf8')
  expect(text).toContain('al***@example.test')
  expect(text).toContain('1234.5678')
  expect(text).not.toContain('alice@example.test')
  expect(text).not.toContain('bob@example.test')
  expect(download.suggestedFilename()).toMatch(/^cost-live_primary_live_.+_UTC\.csv$/)
})

test('sorts the member table using the keyboard', async ({ page }) => {
  await page.goto('/cost-live')
  const sort = page.getByRole('button', { name: 'Sort by User', exact: true })
  await sort.focus()
  await sort.press('Enter')
  await expect(page.locator('tbody tr').first()).toContainText('bo***@example.test')
  await sort.press('Enter')
  await expect(page.locator('tbody tr').first()).toContainText('al***@example.test')
  await expect(page.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending')
})

test('opens and dismisses user details from the keyboard', async ({ page }) => {
  await page.goto('/users')
  const opener = page.getByRole('button', { name: 'View details for al***@example.test', exact: true })
  await opener.focus()
  await opener.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'al***@example.test', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('loads the chat on demand and does not submit an IME composition', async ({ page }) => {
  const chunks: string[] = []
  let submissions = 0
  page.on('request', (request) => {
    if (request.url().includes('/assets/ChatPanel-')) chunks.push(request.url())
    if (request.url().includes('/api/chat/stream')) submissions++
  })
  await page.goto('/cost-live')
  await expect(page.getByRole('heading', { name: 'Cost Live (MTD)' })).toBeVisible()
  expect(chunks).toHaveLength(0)
  const launcher = page.getByRole('button', { name: 'Ask Claude', exact: true })
  await launcher.click()
  const dialog = page.getByRole('dialog', { name: 'Analytics assistant' })
  const input = dialog.getByRole('textbox', { name: 'Ask about your analytics' })
  await input.fill('비용 분석')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  expect(submissions).toBe(0)
  await input.press('Enter')
  await expect(dialog.getByText('Sample response', { exact: true })).toBeVisible()
  expect(submissions).toBe(1)
  expect(chunks.length).toBeGreaterThan(0)
  await input.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(launcher).toBeFocused()
})

test('supports Korean labels and mobile date controls', async ({ page }, testInfo) => {
  await page.addInitScript(() => window.localStorage.setItem('ccd.locale', 'ko'))
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: '사용자', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await page.getByRole('button', { name: '조회 기간 변경' }).click()
  const dialog = page.getByRole('dialog', { name: '기간 직접 선택' })
  await expect(dialog.getByLabel('시작일', { exact: true })).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('korean-date-control.png') })
  await dialog.getByRole('button', { name: '취소', exact: true }).click()
  await page.goto('/changelog')
  await expect(page.getByRole('heading', { name: '변경 내역', exact: true, level: 1 })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('All notable changes to this project')
})

test('shows per-product active users from the summaries breakdown', async ({ page }) => {
  await page.goto('/trends?range=7d')
  await expect(page.getByRole('heading', { name: 'Active users by product', exact: true })).toBeVisible()
  const periods = page.getByRole('group', { name: 'Active-user window' })
  await expect(periods.getByRole('button', { name: 'DAU', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await periods.getByRole('button', { name: 'MAU', exact: true }).click()
  await expect(periods.getByRole('button', { name: 'MAU', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const main = page.getByRole('main')
  await expect(main.getByText('Office Agents').first()).toBeVisible()
  // science_* is omitted by the mock → absent products are not drawn as zero.
  await expect(main.getByText('Claude Science')).toHaveCount(0)
})

test('shows skill spend, connector call classes and the third-party plugin bucket', async ({ page }) => {
  await page.goto('/adoption?range=7d')
  const main = page.getByRole('main')
  await expect(main.getByRole('button', { name: /Est\. overage spend/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /Write calls/ })).toBeVisible()
  // Recharts wraps long ticks into word <tspan>s, so match loosely.
  await expect(main.getByText(/Third-party/).first()).toBeVisible()
  await expect(main).not.toContainText('NaN')
})

test('classifies audit events with real activity types and actor kinds', async ({ page }) => {
  await page.goto('/compliance?range=7d')
  const main = page.getByRole('main')
  await expect(main.getByText('Login events').locator('..')).toContainText('1')
  await expect(main.getByText('High-risk events').locator('..')).toContainText('2')
  await expect(main.getByText('apikey_admin_42').first()).toBeVisible()
  await expect(main.getByText('scim:directory_77').first()).toBeVisible()
  await main.getByRole('button', { name: /^claude_file_viewed ·/ }).click()
  await expect(page.getByRole('dialog')).toContainText('no longer returns file, project-document or artifact names')
})

