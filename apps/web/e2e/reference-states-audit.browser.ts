import { expect, test } from '@playwright/test'

const control = '/__ezacto_browser_fixture__/start-end'
const controlHeaders = { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' }

for (const width of [390, 1280]) {
  test.describe(`reference states ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'light' : 'dark' })
    test('[audit #995] preserves native populated, loading, error, retry and approval states', async ({ page, browser }, info) => {
      test.setTimeout(120_000)
      await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
      await page.route('https://fonts.googleapis.com/**', route => route.abort())
      const fixture = async (action: string) => {
        const result = await page.request.post(control, { headers: controlHeaders, data: { action } })
        expect(result.status()).toBe(204)
      }
      await fixture('sign-in-rate-reset')
      await fixture('client-360-seed')
      let submitted = false
      const expenses = /\/api\/v1\/expenses(?:\?.*)?$/
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let requested!: () => void
      const seen = new Promise<void>(resolve => { requested = resolve })
      const failExpenseRead = async (route: import('@playwright/test').Route) => {
        requested()
        await held
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({
          error: { code: 'internal_error', message: 'The request could not be completed.', fields: [] },
          request_id: 'reference-audit-fixture',
        }) })
      }
      const capture = async (screen: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await page.screenshot({ path: info.outputPath(`${screen}-${width}.png`), fullPage: true })
      }
      try {
        await page.goto('/')
        await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
        await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        // Two baseline entries (0.75h) plus the three 360 fixtures (1.75h).
        await expect(page.locator('[data-week-total]')).toHaveText('2.5')
        await capture('populated-week')

        await page.locator('[data-submit-timesheet]').click()
        await expect(page.locator('[data-unsubmit-timesheet]')).toBeVisible()
        submitted = true
        await page.goto('/approvals')
        await expect(page.locator('[data-approval-queue]')).toContainText('Browser')
        for (const target of await page.locator('.approval-filters select, .approval-filters button').all())
          expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        await capture('populated-approvals')

        await page.goto('/invoices')
        await expect(page.locator('[data-invoice-list]')).toContainText('B360-1')
        await capture('populated-invoices')

        await page.route(expenses, failExpenseRead)
        await page.goto('/expenses?from=2026-08-01&to=2026-08-31')
        await seen
        await expect(page.locator('[data-expense-list-status]')).toHaveText('Loading expenses…')
        await capture('loading-expenses')
        release()
        await expect(page.locator('[data-expense-list-status]')).toContainText('The request could not be completed.')
        await expect(page.locator('[data-expense-list-retry]')).toBeVisible()
        await capture('error-expenses')
        await page.unroute(expenses, failExpenseRead)
        await page.locator('[data-expense-list-retry]').click()
        await expect(page.locator('[data-expense-list] tbody tr[data-row]')).toHaveCount(3)
        await capture('populated-expenses')

        await page.goto('/reports?report=time&from=2026-08-01&to=2026-08-31')
        await expect(page.locator('[data-report-results]')).toContainText('Browser 360')
        await capture('populated-reports')

        const anonymous = await browser.newContext()
        try {
          const response = await anonymous.request.get(`${info.project.use.baseURL}/api/v1/time-entries`)
          expect(response.status()).toBe(401)
        } finally { await anonymous.close() }
      } finally {
        release()
        await page.unroute(expenses, failExpenseRead)
        if (submitted) {
          await page.goto('/')
          await expect(page.locator('[data-unsubmit-timesheet]')).toBeVisible()
          await page.locator('[data-unsubmit-timesheet]').click()
          await expect(page.locator('[data-unsubmit-timesheet]')).toBeHidden()
        }
        await fixture('client-360-cleanup')
      }
    })
  })
}
