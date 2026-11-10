import { expect, test } from '@playwright/test'

test('[e2e:money-preference #745] restores the saved choice across a real page reload', async ({ page, request }) => {
  const reset = await request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.goto('/')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const toggle = page.locator('[data-money-toggle]')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-money', 'hidden')
  expect(await page.evaluate(() => localStorage.getItem('ezacto.money-display'))).toBe('hidden')
  await page.reload()
  await expect(toggle).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-money', 'hidden')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(page.locator('html')).not.toHaveAttribute('data-money', 'hidden')
})
