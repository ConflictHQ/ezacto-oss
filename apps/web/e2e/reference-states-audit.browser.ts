import { expect, test, type Route } from '@playwright/test'
import type { TimeEntry } from '@conflict-hq/ezacto-client'
import { formatDuration, weekDates } from '../src/week-grid/model.js'

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
      await fixture('client-360-cleanup')
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE!,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!))
      const part = (type: string) => parts.find(value => value.type === type)!.value
      const spentDate = `${part('year')}-${part('month')}-${part('day')}`
      const weekPath = `/?week=${spentDate}`
      let submitted = false
      const expenses = /\/api\/v1\/expenses(?:\?.*)?$/
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let requested!: () => void
      const seen = new Promise<void>(resolve => { requested = resolve })
      const failExpenseRead = async (route: Route) => {
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
        await page.goto(weekPath)
        await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
        await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
        const whoami = await page.request.get('/api/v1/whoami')
        expect(whoami.status()).toBe(200)
        const { data: identity } = await whoami.json()
        const settingsResponse = await page.request.get('/api/v1/time-entry-settings')
        expect(settingsResponse.status()).toBe(200)
        const { data: settings } = await settingsResponse.json()
        const dates = weekDates(spentDate, settings.week_start_day)
        const readWeek = async () => {
          const entries: TimeEntry[] = []
          const seenCursors = new Set<string>()
          let cursor: string | null = null
          do {
            const query = new URLSearchParams({
              user_id: String(identity.user_id), from: dates[0]!, to: dates[6]!, per_page: '200',
            })
            if (cursor !== null) query.set('cursor', cursor)
            const response = await page.request.get(`/api/v1/time-entries?${query}`)
            expect(response.status()).toBe(200)
            const body = await response.json()
            expect(Array.isArray(body.data)).toBe(true)
            entries.push(...body.data)
            expect(body).toHaveProperty('next_cursor')
            cursor = body.next_cursor
            if (cursor !== null) {
              expect(typeof cursor).toBe('string')
              expect(seenCursors.has(cursor)).toBe(false)
              seenCursors.add(cursor)
            }
          } while (cursor !== null)
          return entries.sort((left, right) => left.id - right.id)
        }
        // Earlier cases own additional legitimate entries in this shared native D1.
        // Preserve them and prove the audit adds exactly its three entries (1.75h).
        const baseline = await readWeek()
        await fixture('client-360-seed')
        const populated = await readWeek()
        const ownedIds = new Set([9300, 9301, 9302])
        const owned = populated.filter(entry => ownedIds.has(entry.id))
        expect(owned.map(entry => entry.id)).toEqual([9300, 9301, 9302])
        expect(owned.reduce((total, entry) => total + entry.seconds, 0)).toBe(6300)
        expect(populated.filter(entry => !ownedIds.has(entry.id))).toEqual(baseline)
        const expectedSeconds = baseline.reduce((total, entry) => total + entry.seconds, 6300)
        await page.goto(weekPath)
        await expect(page.locator('[data-week-total]')).toHaveText(
          formatDuration(expectedSeconds, settings.time_format),
        )
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
        const fixedFee = page.locator('[data-report-fixed-fee-field]')
        expect((await fixedFee.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        const checkbox = await fixedFee.locator('input').boundingBox()
        expect(checkbox!.width).toBeLessThanOrEqual(24)
        expect(checkbox!.height).toBeLessThanOrEqual(24)
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
          await page.goto(weekPath)
          await expect(page.locator('[data-unsubmit-timesheet]')).toBeVisible()
          await page.locator('[data-unsubmit-timesheet]').click()
          await expect(page.locator('[data-unsubmit-timesheet]')).toBeHidden()
        }
        await fixture('client-360-cleanup')
      }
    })
  })
}
