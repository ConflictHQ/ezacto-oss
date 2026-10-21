import { test, expect } from '@playwright/test'
test('[e2e:approval #1009] explains and saves the optional review window and disables it again', async ({
  page,
}) => {
  let state = {
    enabled: false,
    window_days: null as number | null,
    clock_starts_at: 'submitted_at',
    effective_from: null as string | null,
    approval_module_enabled: true,
  }
  const writes: unknown[] = []
  await page.route('**/api/v1/settings/timesheet-auto-approval', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      writes.push(body)
      state = {
        ...state,
        ...body,
        effective_from: body.enabled ? (state.effective_from ?? '2026-10-21T12:00:00.000Z') : null,
      }
    }
    return route.fulfill({ json: { data: state } })
  })
  await page.goto('/settings/company#approval')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const form = page.locator('[data-auto-approval-form]')
  await expect(form).toBeVisible()
  await expect(page.locator('[data-auto-approval-enabled]')).not.toBeChecked()
  await expect(page.locator('[data-auto-approval-since]')).toContainText(
    'does not approve weeks that are already waiting',
  )
  await page.locator('[data-auto-approval-enabled]').check()
  await form.getByRole('button', { name: 'Save automatic approval', exact: true }).click()
  await expect(page.locator('[data-auto-approval-result]')).toContainText('Choose how many days')
  expect(writes).toHaveLength(0)
  await page.locator('[data-auto-approval-days]').fill('3')
  await form.getByRole('button', { name: 'Save automatic approval', exact: true }).click()
  await expect(page.locator('[data-auto-approval-result]')).toHaveText('Saved.')
  await expect(page.locator('[data-auto-approval-since]')).toContainText('2026-10-21')
  await page.locator('[data-auto-approval-enabled]').uncheck()
  await form.getByRole('button', { name: 'Save automatic approval', exact: true }).click()
  await expect(page.locator('[data-auto-approval-result]')).toHaveText('Saved.')
  expect(writes).toEqual([
    { enabled: true, window_days: 3 },
    { enabled: false, window_days: 3 },
  ])
})
