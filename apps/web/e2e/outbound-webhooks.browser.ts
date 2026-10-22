import { expect, test } from '@playwright/test'
test('[e2e #107] administrator manages a signed endpoint and clears once-only secrets', async ({
  page,
}, info) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/settings/company#webhooks')
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
  const section = page.locator('[data-settings-section="webhooks"]')
  await expect(section).toBeVisible()
  await expect(section.locator('[data-webhooks-create]')).toBeVisible()
  await section
    .getByLabel('HTTPS endpoint URL')
    .fill('https://receiver.example/events/' + crypto.randomUUID())
  await section.getByLabel('invoice.created', { exact: true }).check()
  await section.getByRole('button', { name: 'Create endpoint', exact: true }).click()
  const secret = section.locator('[data-webhooks-secret]')
  await expect(secret).toBeVisible()
  expect(await secret.getByLabel('Signing secret', { exact: true }).inputValue()).toMatch(
    /^ezwh_[A-Za-z0-9_-]{43}$/,
  )
  await secret.getByRole('button', { name: 'I saved the secret' }).click()
  await expect(secret.getByLabel('Signing secret', { exact: true })).toHaveValue('')
  await section.locator('[data-webhooks-subscriptions] summary').click()
  await section.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(section.getByRole('cell', { name: 'Paused', exact: true })).toBeVisible()
  await section.locator('[data-webhooks-subscriptions] summary').click()
  await section.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(section.getByRole('cell', { name: 'Active', exact: true })).toBeVisible()
  await section.locator('[data-webhooks-subscriptions] summary').click()
  await section.getByRole('button', { name: 'Rotate secret', exact: true }).click()
  const dialog = section.locator('[data-webhooks-action]')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Old secret overlap in seconds').fill('0')
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(secret).toBeVisible()
  await secret.getByRole('button', { name: 'I saved the secret' }).click()
  await expect(section.locator('[data-webhooks-status]')).toHaveText(
    'New matching events are queued for signed delivery.',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: info.outputPath('webhooks-phone.png'), fullPage: true })
  await section.locator('[data-webhooks-subscriptions] summary').click()
  await section.getByRole('button', { name: 'Delete', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(section.getByText('No webhook endpoints yet.', { exact: true })).toBeVisible()
})
