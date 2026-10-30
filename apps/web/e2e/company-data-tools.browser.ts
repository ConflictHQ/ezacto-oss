import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!,
  fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
test('[e2e #67] company exports use real reports and the bulk catalog only opens review workflows', async ({
  page,
}, testInfo) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/settings/company#import-export')
  expect(
    (
      await page.request.post('/__ezacto_browser_fixture__/start-end', {
        data: { action: 'sign-in-rate-reset' },
        headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
      })
    ).status(),
  ).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-settings-data-content]')).toBeVisible()
  const marker = 'Company data export fixture ' + crypto.randomUUID()
  const created = await page.evaluate(async (notes) => {
    const response = await fetch('/api/v1/time-entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        task_id: 1,
        spent_date: '2027-01-15',
        seconds: 900,
        notes,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, marker)
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const entry = created.body.data as { id: number }
  try {
    const mutations: string[] = []
    page.on('request', (request) => {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()))
        mutations.push(request.url())
    })
    const form = page.locator('[data-settings-data-export]')
    await form.getByLabel('From', { exact: true }).fill('2027-01-01')
    await form.getByLabel('Through', { exact: true }).fill('2027-01-31')
    const reportRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/v1/reports/detailed-time/export',
    )
    const downloaded = page.waitForEvent('download')
    await form.getByRole('button', { name: 'Time CSV', exact: true }).click()
    const request = await reportRequest,
      query = new URL(request.url()).searchParams
    expect(query.get('audience')).toBe('client')
    expect(query.get('from')).toBe('2027-01-01')
    expect(query.get('to')).toBe('2027-01-31')
    const file = await downloaded
    expect(file.suggestedFilename()).toMatch(/\.csv$/u)
    expect(await readFile((await file.path())!, 'utf8')).toContain(marker)
    await page.getByRole('link', { name: 'Bulk actions', exact: true }).click()
    await expect(page.locator('[data-settings-bulk-actions]')).toBeVisible()
    await expect(page.locator('[data-settings-bulk-actions] li')).toHaveCount(4)
    await expect(page.locator('[data-settings-bulk-status]')).toHaveText(
      'Opening a workflow does not apply an action.',
    )
    expect(mutations).toEqual([])
    await page.getByRole('link', { name: 'Import and export', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-settings-data-content]')).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)
    await page
      .locator('[data-settings-section="import-export"]')
      .screenshot({ path: testInfo.outputPath('company-data-phone.png') })
  } finally {
    expect(
      await page.evaluate(
        async (id) => (await fetch(`/api/v1/time-entries/${id}`, { method: 'DELETE' })).status,
        entry.id,
      ),
    ).toBe(200)
  }
})
