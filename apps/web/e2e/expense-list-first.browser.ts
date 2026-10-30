import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test.describe(`expense list first at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })
    test('[e2e #995] opens a preserved draft, keeps errors visible and closes only after real creation', async ({
      page,
    }, info) => {
      test.setTimeout(90_000)
      await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
      await page.goto('/expenses')
      await page.request.post('/__ezacto_browser_fixture__/start-end', {
        data: { action: 'sign-in-rate-reset' },
        headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
      })
      await page
        .locator('[data-sign-in-form]')
        .getByLabel('Email')
        .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
      await page
        .getByLabel('Password', { exact: true })
        .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      const panel = page.locator('[data-expense-create-panel]')
      const open = page.locator('[data-expense-create-open]')
      const close = page.locator('[data-expense-create-close]')
      const form = page.locator('[data-expense-create-form]')
      await expect(open).toBeEnabled()
      await expect(panel).toBeHidden()
      expect((await page.locator('[data-expense-list]').boundingBox())!.y).toBeLessThan(1300)
      await open.focus()
      await page.keyboard.press('Enter')
      await expect(form.getByRole('combobox', { name: 'Project', exact: true })).toBeFocused()
      await expect(open).toHaveAttribute('aria-expanded', 'true')
      await form
        .getByRole('combobox', { name: 'Project', exact: true })
        .selectOption({ label: '[BROWSER] Browser Acceptance Project' })
      await form
        .getByRole('combobox', { name: 'Category', exact: true })
        .selectOption({ label: 'Travel' })
      await form.getByLabel('Date', { exact: true }).fill('2026-08-25')
      await form.getByLabel('Amount', { exact: true }).fill('19.95')
      const notes = `Owned list-first acceptance ${width}`
      await form.getByLabel('Notes', { exact: true }).fill(notes)
      expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await close.click()
      await expect(panel).toBeHidden()
      await expect(open).toBeFocused()
      await open.press('Enter')
      await expect(form.getByLabel('Notes', { exact: true })).toHaveValue(notes)
      let posts = 0
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/v1/expenses', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        posts++
        if (posts === 1)
          return route.fulfill({
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'validation_failed',
                message: 'Review this expense before saving.',
                fields: [],
              },
            }),
          })
        await pending
        return route.continue()
      })
      await form.getByRole('button', { name: 'Add expense', exact: true }).click()
      await expect(panel).toBeVisible()
      await expect(page.locator('[data-expense-create-result]')).toHaveText(
        'Review this expense before saving.',
      )
      await expect(page.locator('[data-expense-create-result]')).toBeFocused()
      await expect(form.getByLabel('Notes', { exact: true })).toHaveValue(notes)
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/expenses' &&
          response.request().method() === 'POST' &&
          response.status() === 201,
      )
      await form.getByRole('button', { name: 'Add expense', exact: true }).click()
      await expect(close).toBeDisabled()
      await expect(open).toBeDisabled()
      await expect(form.getByLabel('Notes', { exact: true })).toBeDisabled()
      release()
      const response = await saved
      expect(response.status()).toBe(201)
      const id = Number((await response.json()).data.id)
      await expect(panel).toBeHidden()
      await expect(open).toBeEnabled()
      await expect(open).toBeFocused()
      await expect(page.locator('[data-expense-create-notice]')).toContainText('Expense added.')
      await expect(page.locator('[data-expense-create-notice] a')).toHaveAttribute(
        'href',
        `/expenses/${id}`,
      )
      await expect(form.getByLabel('Notes', { exact: true })).toHaveValue('')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: info.outputPath(`expense-list-first-${width}.png`),
        fullPage: true,
      })
      const deleted = await page.evaluate(
        async (id) => (await fetch(`/api/v1/expenses/${id}`, { method: 'DELETE' })).status,
        id,
      )
      expect([200, 204]).toContain(deleted)
    })
  })
}
