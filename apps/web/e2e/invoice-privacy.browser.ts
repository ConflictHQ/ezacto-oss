import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`[e2e:invoice-privacy] internal facts stay off the customer PDF at ${viewport.width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
    const control = (action: string) => request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action }, headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    })
    expect((await control('invoice-generation-seed')).status()).toBe(204)
    try {
      expect((await control('sign-in-rate-reset')).status()).toBe(204)
      await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
      await page.goto('/invoices/new')
      await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
      await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      const wizard = page.locator('[data-invoice-new-dialog]')
      await expect(wizard).toBeVisible()
      for (const project of await wizard.locator('input[name="project"]').all()) {
        await project.setChecked((await project.inputValue()) === '1')
      }
      const expenses = wizard.locator('[data-invoice-expense-summary]')
      if (await expenses.isEnabled()) await expenses.selectOption('')
      await wizard.getByRole('radio', { name: 'Date range' }).check()
      await wizard.getByRole('button', { name: 'Create draft' }).click()
      await expect(page).toHaveURL(/\/invoices\/\d+$/u)
      const number = new URL(page.url()).pathname.split('/').pop()!
      // Record the sent transition locally; this never queues or sends email.
      const sent = await page.evaluate(async (number) => {
        const lookup = await fetch(`/api/v1/invoices?number=${encodeURIComponent(number)}`)
        const { data } = await lookup.json() as { data: { id: number; version: number }[] }
        if (data.length !== 1) throw new Error('expected the generated fixture invoice')
        const response = await fetch(`/api/v1/invoices/${data[0]!.id}/transitions`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ command: 'send', expected_version: data[0]!.version, recipients: [{ name: 'Fixture AP', email: 'ap@example.test' }] }),
        })
        return response.status
      }, number)
      expect(sent).toBe(201)
      await page.reload()
      const invoice = page.locator('[data-invoice-document]')
      const internal = page.locator('[data-invoice-internal]')
      await expect(invoice).toBeVisible()
      await expect(internal.locator('[data-invoice-rounding-fact]')).toBeVisible()
      // The real harness has no Intuit app: preserve that unavailable gate.
      // The populated QuickBooks fact is covered with the controller fixture.
      await expect(internal.locator('[data-invoice-quickbooks-fact]')).toBeHidden()
      await expect(internal.locator('[data-invoice-reminders-fact]')).toBeVisible()
      await expect(invoice.locator('[data-invoice-rounding-fact], [data-invoice-quickbooks-fact], [data-invoice-reminders-fact]')).toHaveCount(0)
      await expect(invoice.locator('[data-invoice-detail-total]')).toHaveText('$75.00')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.emulateMedia({ media: 'print' })
      await expect(internal).toBeHidden()
      await expect(invoice).toBeVisible()
      await expect(invoice.locator('[data-invoice-detail-total]')).toBeVisible()
      await page.pdf({ path: testInfo.outputPath('customer-invoice.pdf') })
    } finally {
      expect((await control('invoice-generation-cleanup')).status()).toBe(204)
    }
  })
}
