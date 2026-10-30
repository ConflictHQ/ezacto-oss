import { expect, test } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('Browser fixture credentials are required')
}

// Either nothing was open to begin with, or every open entry already holds what the rule gives.
const nothingToChange = /Nothing to recalculate|no open entries/

test('[e2e:rounding] sets the rule, previews a recalculation and applies exactly that preview', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/settings/company#time')
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.locator('[data-sign-in-form]').getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const form = page.locator('[data-rounding-form]')
  await expect(form).toBeVisible()
  // Saving a rule says what it does and what it does not.
  await form.getByLabel('Direction').selectOption('up')
  await form.getByLabel('Increment').selectOption('60')
  await form.getByRole('button', { name: 'Save rounding' }).click()
  await expect(page.locator('[data-rounding-result]')).toHaveText(
    'Saved. New time is rounded up to 1 hour. Time already saved keeps its hours.',
  )

  // The rule outlives the page.
  await page.reload()
  await expect(page.locator('[data-rounding-form]')).toBeVisible()
  await expect(page.locator('[data-rounding-mode]')).toHaveValue('up')
  await expect(page.locator('[data-rounding-minutes]')).toHaveValue('60')

  // The preview writes nothing; the apply names it.
  const recalculate = page.locator('[data-rounding-recalculate]')
  await expect(recalculate).toBeVisible()
  await recalculate.getByRole('button', { name: 'Preview' }).click()
  const output = page.locator('[data-rounding-preview-output]')
  await expect(output.locator('li').first()).toBeVisible()
  const apply = page.locator('[data-rounding-apply]')
  if (await apply.isVisible()) {
    await expect(output).toContainText('would change')
    await apply.click()
    await expect(page.locator('[data-rounding-recalculate-result]')).toContainText('Recalculated')
  } else {
    await expect(output).toContainText(nothingToChange)
  }

  // Whatever it did, there is now nothing left for the same rules to change.
  await recalculate.getByRole('button', { name: 'Preview' }).click()
  await expect(output).toContainText(nothingToChange)
  await expect(apply).toBeHidden()
})
