import { expect, test, type Page } from '@playwright/test'

const control = '/__ezacto_browser_fixture__/start-end'
const headers = { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' }
const choose = async (page: Page) => {
  const dialog = page.locator('[data-entry-dialog]')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-entry-project]')).toHaveValue('')
  await expect(dialog.locator('[data-entry-task]')).toHaveValue('')
  await dialog.locator('[data-entry-project]').selectOption({ label: 'Browser Acceptance Project' })
  await dialog.locator('[data-entry-task]').selectOption({ label: 'Browser Acceptance Task' })
  return dialog
}
const apiPost = async (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const result = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
      return { status: result.status, body: await result.json() }
    },
    { path, body },
  )

for (const width of [390, 1280]) {
  test.describe(`calendar proposals ${width}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 390 })
    test('[e2e:calendar-proposals] reviews owned provisional events through atomic decisions only', async ({
      page,
    }, info) => {
      test.setTimeout(120_000)
      await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
      await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
      const fixture = async (action: string) => {
        const result = await page.request.post(control, { headers, data: { action } })
        expect(result.status()).toBe(204)
      }
      await fixture('calendar-proposals-seed')
      let failList = true,
        acceptedRequests = 0,
        ordinaryWrites = 0,
        reads = 0
      const ranges: string[] = []
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        if (
          /\/api\/v1\/time-entries(?:\/\d+)?(?:\?|$)/.test(request.url()) &&
          ['POST', 'PATCH'].includes(request.method())
        )
          ordinaryWrites++
      })
      const listRoute = /\/api\/v1\/calendar-proposals\?/
      await page.route(listRoute, async (route) => {
        reads++
        if (failList) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'internal_error',
                message: 'Owned fixture read unavailable.',
                fields: [],
              },
              request_id: 'calendar-proposal-owned-fixture',
            }),
          })
          return
        }
        const url = new URL(route.request().url())
        ranges.push(`${url.searchParams.get('from')}:${url.searchParams.get('to')}`)
        url.searchParams.set('per_page', '2')
        await route.continue({ url: url.href })
      })
      // Commit the real atomic acceptance, then lose its response body. The UI
      // must read the canonical decision, never issue an ordinary create.
      await page.route('**/api/v1/calendar-proposals/120101/accept', async (route) => {
        acceptedRequests++
        const result = await route.fetch()
        expect(result.status()).toBe(201)
        await route.fulfill({ response: result, body: '{}' })
      })
      let lockId: number | null = null
      try {
        await page.goto('/?week=2026-08-27')
        await page
          .locator('[data-sign-in-form]')
          .getByLabel('Email')
          .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
        await page
          .getByLabel('Password', { exact: true })
          .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
        await expect(page.locator('[data-week-total]')).not.toHaveText('—')
        expect(reads).toBe(0)
        const before = Number(await page.locator('[data-week-total]').textContent())
        await page
          .locator('[data-time-views]')
          .getByRole('link', { name: 'Calendar', exact: true })
          .click()
        await expect(page.locator('[data-proposal-status]')).toContainText(
          'Owned fixture read unavailable',
        )
        failList = false
        await page.getByRole('button', { name: 'Retry proposals' }).click()
        await expect(page.locator('[data-calendar-proposal="120101"]')).toHaveCount(1)
        expect(reads).toBeGreaterThanOrEqual(3)
        await expect(page.locator('[data-calendar-proposal="120105"]')).toHaveCount(0)
        await expect(page.getByText('Other person private calendar', { exact: true })).toHaveCount(
          0,
        )
        expect(Number(await page.locator('[data-week-total]').textContent())).toBe(before)
        await page.locator('[data-calendar-layout-choice="day"]').click()
        const shownDate = await page
          .locator('[data-calendar-day]')
          .getAttribute('data-calendar-day')
        await expect.poll(() => ranges.at(-1)).toBe(`${shownDate}:${shownDate}`)
        await page.locator('[data-calendar-layout-choice="week"]').click()
        await expect.poll(() => ranges.at(-1)).toBe('2026-08-24:2026-08-30')
        await expect(page.locator('[data-calendar-proposal="120101"]')).toHaveCount(1)
        const block = page.locator('[data-calendar-proposal="120101"]')
        await expect(block).not.toHaveAttribute('data-calendar-entry')
        await block.focus()
        await page.keyboard.press('Enter')
        const dialog = await choose(page)
        for (const target of await dialog
          .locator('.timer-actions button:visible, [data-dialog-close]')
          .all())
          expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(43.99)
        await expect(dialog.locator('[data-entry-date]')).toHaveJSProperty('readOnly', true)
        await expect(dialog.locator('[data-entry-duration-input]')).toHaveJSProperty(
          'readOnly',
          true,
        )
        await expect(dialog.locator('[data-entry-proposal-source]')).toContainText(
          'America/Costa_Rica',
        )
        await dialog
          .locator('[data-entry-note-input]')
          .fill('Owned proposed workshop accepted once')
        await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true })
        await dialog.getByRole('button', { name: 'Accept proposal', exact: true }).click()
        await expect(dialog).toBeHidden()
        await expect(page.locator('[data-calendar-proposal="120101"]')).toHaveCount(0)
        await expect(page.locator('[data-week-total]')).toHaveText(String(before + 1))
        expect(acceptedRequests).toBe(1)
        expect(ordinaryWrites).toBe(0)
        const discard = page.locator('[data-calendar-proposal="120102"]')
        if (width === 390) await discard.tap()
        else await discard.click()
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Discard proposal', exact: true }).click()
        await expect(dialog).toBeHidden()
        await expect(discard).toHaveCount(0)

        const lock = await apiPost(page, '/api/v1/timesheet-locks', {
          locked_through: '2026-08-26',
          reason: 'browser-1201-lock',
        })
        expect(lock.status).toBe(201)
        lockId = lock.body.data.id
        await page.locator('[data-calendar-proposal="120104"]').click()
        await choose(page)
        await dialog.getByRole('button', { name: 'Accept proposal', exact: true }).click()
        await expect(dialog.locator('[data-entry-result]')).toContainText(/lock/i)
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Escape')
        const unlock = await apiPost(page, `/api/v1/timesheet-locks/${lockId}/unlock`, {
          reason: 'Owned fixture acceptance completed',
        })
        expect(unlock.status).toBe(200)
        lockId = null

        await fixture('calendar-proposals-start-end')
        await page.reload()
        await page.locator('[data-calendar-proposal="120103"]').first().click()
        await choose(page)
        await expect(dialog.locator('[data-entry-start]')).toHaveJSProperty('readOnly', true)
        await dialog.getByRole('button', { name: 'Accept proposal', exact: true }).click()
        await expect(dialog.locator('[data-entry-result]')).toContainText('past midnight')
        await page.keyboard.press('Escape')
        const forbidden = await apiPost(page, '/api/v1/calendar-proposals/120105/accept', {
          project_id: 1,
          task_id: 1,
        })
        expect(forbidden.status).toBe(404)

        await fixture('calendar-proposals-dst')
        await page.goto('/?view=calendar&week=2026-11-01')
        for (const [id, text] of [
          [120106, /clock|represent|daylight/i],
          [120107, /minute|precision|represent/i],
        ] as const) {
          await page.locator(`[data-calendar-proposal="${id}"]`).click()
          await choose(page)
          await expect(dialog.locator('[data-entry-billing]')).toBeHidden()
          if (id === 120106) {
            await expect(dialog.locator('[data-entry-proposal-source]')).toContainText('GMT-4')
            await expect(dialog.locator('[data-entry-proposal-source]')).toContainText('GMT-5')
          }
          await dialog.getByRole('button', { name: 'Accept proposal', exact: true }).click()
          await expect(dialog.locator('[data-entry-result]')).toContainText(text)
          await page.keyboard.press('Escape')
        }
        await page.goto('/?view=calendar&week=2026-08-27')
        await expect(page.locator('[data-calendar-proposal="120104"]')).toHaveCount(1)
        const readCount = reads
        await expect(page.locator('[data-time-person]')).toBeVisible()
        await page.locator('[data-time-person]').selectOption('120190')
        await expect(page.locator('[data-calendar-proposals]')).toBeHidden()
        await expect(page.locator('[data-calendar-proposal]')).toHaveCount(0)
        await page.waitForLoadState('networkidle')
        expect(reads).toBe(readCount)
        await page.locator('[data-time-person]').selectOption('')
        await expect(page.locator('[data-calendar-proposal="120104"]')).toHaveCount(1)
        const beforeBusiness = reads
        await page.goto('/projects')
        await expect(page.locator('[data-calendar-proposal]')).toHaveCount(0)
        await page.waitForLoadState('networkidle')
        expect(reads).toBe(beforeBusiness)
        await page.goto('/?view=calendar&week=2026-08-27')
        await expect(page.locator('[data-calendar-proposal="120104"]')).toHaveCount(1)
        await fixture('calendar-proposals-assert')
        await page.screenshot({ path: info.outputPath(`calendar-${width}.png`), fullPage: true })
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await expect(page.locator('[data-sign-in-form]')).toBeVisible()
        await expect(page.locator('[data-calendar-proposal]')).toHaveCount(0)
        expect(await page.locator('[data-entry-proposal-source]').textContent()).toBe('')
        expect((await page.request.get('/api/v1/calendar-proposals')).status()).toBe(401)
        expect(ordinaryWrites).toBe(0)
        expect(errors).toEqual([])
      } finally {
        if (lockId !== null)
          await apiPost(page, `/api/v1/timesheet-locks/${lockId}/unlock`, {
            reason: 'Owned fixture cleanup',
          }).catch(() => {})
        await fixture('calendar-proposals-cleanup')
      }
    })
  })
}
