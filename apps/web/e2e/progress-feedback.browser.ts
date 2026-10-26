import { expect, test } from '@playwright/test'

test('shows pending, refused and completed saves with reduced-motion feedback', async ({ page }, testInfo) => {
  await page.goto('/settings/user#reminders')
  await page.locator('[data-sign-in-form]').getByLabel('Email', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const save = page.getByRole('button', { name: 'Save my reminders', exact: true })
  const result = page.locator('[data-settings-notifications-result]')
  await expect(save).toBeVisible()
  await expect(page.locator('[data-settings-notifications] [data-settings-notifications-status]')).toBeEmpty()
  let release!: () => void
  let calls = 0
  let refuse = true
  await page.route('**/api/v1/profile/notifications', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    calls++
    await new Promise<void>(resolve => { release = resolve })
    if (refuse) {
      await route.fulfill({ status: 422, json: { error: { message: 'Review reminder settings.', fields: [{ message: 'Review reminder settings.' }] } } })
    } else {
      await route.fulfill({ status: 200, json: { data: { ...route.request().postDataJSON(), updated_at: '2026-10-26T12:00:00Z' } } })
    }
  })
  await save.click()
  await expect.poll(() => calls).toBe(1)
  await expect(result).toHaveText('Saving…')
  await expect(result).toHaveAttribute('aria-busy', 'true')
  await expect(save).toBeDisabled()
  expect(await result.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('auth-spin')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await result.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none')
  await page.screenshot({ path: testInfo.outputPath('pending-save-reduced-motion.png'), fullPage: true })
  release()
  await expect(result).toHaveText('Review reminder settings.')
  await expect(result).toHaveAttribute('aria-busy', 'false')
  await expect(save).toBeEnabled()
  refuse = false
  await save.click()
  await expect.poll(() => calls).toBe(2)
  release()
  await expect(result).toHaveText('Saved.')
  await expect(result).toHaveAttribute('aria-busy', 'false')
  await expect(save).toBeEnabled()
  await save.click()
  await expect.poll(() => calls).toBe(3)
  await page.goto('/')
  release()
  await expect(page.locator('[data-settings-notifications-result]')).not.toBeVisible()
  expect(calls).toBe(3)
})
