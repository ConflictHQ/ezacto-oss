import { expect, test } from '@playwright/test'

// Browser rendering uses the real shell and sign-in; API authorization and
// ledger reconciliation are exercised separately against SQLite and D1.
test('[e2e:my-payments #100] reads own figures, changes month, and clears them when access is disabled', async ({
  page,
}) => {
  let enabled = true
  await page.route('**/api/v1/me/payments?*', (route) => {
    if (!enabled)
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: 'own_money_disabled',
            message: 'Own money is disabled.',
            fields: [],
          },
        },
      })
    const month = new URL(route.request().url()).searchParams.get('month')!
    return route.fulfill({
      json: {
        data: {
          month,
          hours_seconds: 16200,
          status: month === '2026-08' ? 'partial' : 'pending_review',
          owed: month === '2026-08' ? { amount_cents: 10000, currency: 'USD' } : null,
          paid_cents: month === '2026-08' ? 4000 : 0,
          balance_cents: month === '2026-08' ? 6000 : null,
          payments:
            month === '2026-08'
              ? [{ amount_cents: 4000, currency: 'USD', paid_on: '2026-09-10' }]
              : [],
          upcoming: [
            {
              amount_cents: 5000,
              currency: 'EUR',
              scheduled_on: '2026-10-21',
              status: 'scheduled',
            },
          ],
        },
      },
    })
  })
  await page.route('**/api/v1/me/staff-invoices?*', (route) =>
    route.fulfill({
      json: {
        data: { month: '2026-08', people: [] },
      },
    }),
  )
  await page.goto('/my-payments')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My payments', exact: true })).toBeVisible()
  const month = page.locator('[data-my-payments-month]')
  await month.fill('2026-08')
  await month.dispatchEvent('change')
  await expect(page.locator('[data-my-payments-summary]')).toContainText('USD 100.00')
  await expect(page.locator('[data-my-payments-receipts]')).toContainText('USD 40.00')
  await expect(page.locator('[data-my-payments-upcoming]')).toContainText('EUR 50.00')
  await month.fill('2026-09')
  await month.dispatchEvent('change')
  await expect(page.locator('[data-my-payments-summary]')).toContainText('Pending review')
  await expect(page.locator('[data-my-payments-summary]')).not.toContainText('USD')
  enabled = false
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('[data-my-payments-status]')).toHaveText(
    'Your organization has not enabled this view.',
  )
  await expect(page.locator('[data-my-payments-content]')).toBeHidden()
  await expect(page.locator('[data-my-payments-upcoming]')).toBeEmpty()
})
