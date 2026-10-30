import { expect, test } from '@playwright/test'
test('[e2e:email #42] signed feedback changes only its sender and complaint lifts require a recorded review', async ({
  page,
  request,
}) => {
  const seeded = await request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'email-feedback-seed' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(seeded.status()).toBe(200)
  const fixture = (await seeded.json()) as { events: string[]; to: string; cc: string }
  await page.goto('/settings/company#email')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const table = page.locator('[data-settings-email-identities-health]')
  const sender = (address: string) => table.locator(`tr[data-row-key="${address}"]`)
  await expect(sender('feedback-a@example.test')).toBeVisible()
  const beforeB = await sender('feedback-b@example.test').textContent()
  const post = async (payload: string) =>
    page.evaluate(async (body) => {
      const response = await fetch('/webhooks/mailgun', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      return response.status
    }, payload)
  expect(await post(fixture.events[0]!)).toBe(200)
  await page.getByRole('button', { name: 'Refresh email delivery', exact: true }).click()
  await expect(sender('feedback-a@example.test')).toContainText('1 (100.00%)')
  expect(await sender('feedback-b@example.test').textContent()).toBe(beforeB)
  expect(await post(fixture.events[1]!)).toBe(200)
  expect(await post(fixture.events[1]!)).toBe(200)
  await page.getByRole('button', { name: 'Refresh email delivery', exact: true }).click()
  await expect(sender('feedback-b@example.test')).toContainText('Complaint recorded')
  const review = page.locator('[data-email-suppression-review]')
  await expect(review.locator('tbody tr[data-row]')).toHaveCount(2)
  const row = review.locator('tbody tr[data-row]').filter({ hasText: fixture.cc })
  await row.getByRole('button', { name: 'Allow future email', exact: true }).click()
  const dialog = page.locator('[data-email-suppression-dialog]')
  await dialog
    .getByLabel('Reason for allowing delivery again')
    .fill('Recipient requested future invoices after review')
  await dialog.getByRole('button', { name: 'Allow future email', exact: true }).click()
  await expect(dialog.locator('[data-email-suppression-dialog-result]')).toContainText(
    'Type the email address',
  )
  await dialog.getByLabel('Type the email address to acknowledge its complaint').fill(fixture.cc)
  await dialog.getByRole('button', { name: 'Allow future email', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(review.locator('tbody tr[data-row]')).toHaveCount(1)
  await expect(review.locator('[data-email-suppression-result]')).toContainText('was recorded')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
