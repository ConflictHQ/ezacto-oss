import { expect, test } from '@playwright/test'

// Real Worker + D1 + generated client; the fixture database is disposable.
test('[e2e:rate-cards #34] publishes dated rates and retires the card without repricing old entries', async ({
  page,
}) => {
  await page.goto('/clients/1')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const section = page.locator('[data-client-rate-card]')
  await expect(section).toBeVisible()
  await expect(section.locator('[data-rate-card-create]')).toBeVisible()
  const snapshots = () =>
    page.evaluate(async () => {
      const response = await fetch('/api/v1/time-entries?per_page=200')
      if (!response.ok) throw new Error(`time entry read failed: ${response.status}`)
      const body = await response.json()
      return body.data.map(
        (entry: {
          id: number
          billable_rate_cents: number | null
          cost_rate_cents: number | null
          invoice_id: number | null
        }) => ({
          id: entry.id,
          billable: entry.billable_rate_cents,
          cost: entry.cost_rate_cents,
          invoice: entry.invoice_id,
        }),
      )
    })
  const before = await snapshots()
  expect(before).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 1, billable: 10000, cost: 5000 })]),
  )
  await section.getByLabel('Card name').fill('Delivery rates')
  await section.getByRole('button', { name: 'Create card for this client', exact: true }).click()
  const version = section.locator('[data-rate-card-version]')
  await expect(version).toBeVisible()
  await version.getByLabel('Hourly amount').fill('150.25')
  await version.getByRole('button', { name: 'Publish version', exact: true }).click()
  await expect(section.locator('[data-rate-card-status]')).toContainText('Saved.')
  await expect(section.locator('[data-rate-card-history]')).toContainText('$150.25')
  const preview = section.locator('[data-rate-card-preview]')
  await preview.getByLabel('Work date').fill('2026-08-30')
  await preview.getByRole('button', { name: 'Preview rate', exact: true }).click()
  await expect(section.locator('[data-rate-card-preview-result]')).toContainText(
    'Delivery rates from Browser Acceptance Client',
  )
  await expect(section.locator('[data-rate-card-preview-result]')).toContainText('$150.25')
  await version.getByLabel('Effective from').fill('2026-09-01')
  await version.getByLabel('Retire this card', { exact: false }).check()
  await version.getByRole('button', { name: 'Publish version', exact: true }).click()
  await expect(section.locator('[data-rate-card-status]')).toContainText('Saved.')
  await expect(section.locator('[data-rate-card-history]')).toContainText('Retired')
  await expect(section.locator('[data-rate-card-history]')).toContainText('$150.25')
  await preview.getByLabel('Work date').fill('2026-09-01')
  await preview.getByRole('button', { name: 'Preview rate', exact: true }).click()
  await expect(section.locator('[data-rate-card-preview-result]')).toContainText('No card matches')
  expect(await snapshots()).toEqual(before)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
