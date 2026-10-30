import { expect, test, type Page } from '@playwright/test'

const signIn = async (page: Page) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.goto('/')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-timer-chip]')).toBeEnabled()
  await expect(page.locator('[data-timer-label]')).toHaveText('Start timer')
}

for (const width of [390, 1280]) {
  for (const profile of ['administrator', 'member']) {
    test(`empty project/task guidance is usable for ${profile} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      // Keep a real person/project assignment while removing all usable task pairs.
      await page.route('**/api/v1/time-entry-options*', (route) =>
        route.fulfill({ json: { data: [], links: { next: null } } }),
      )
      await page.route('**/api/v1/whoami', async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        await route.fulfill({ response, json: { ...body, data: { ...body.data, profile } } })
      })
      await signIn(page)
      const chip = page.locator('[data-timer-chip]')
      await expect(chip).toBeVisible()
      const box = await chip.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await chip.click()
      const dialog = page.locator('[data-row-dialog]')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('heading', { name: 'Start timer' })).toBeVisible()
      await expect(dialog.locator('[data-row-empty]')).toContainText('Set up a project and task')
      await expect(dialog.locator('[data-row-project]')).toBeHidden()
      await expect(dialog.locator('[data-row-task]')).toBeHidden()
      await expect(dialog.getByRole('button', { name: 'Add row', exact: true })).toBeHidden()
      if (profile === 'administrator') {
        await expect(dialog.locator('[data-row-setup]')).toBeVisible()
        await expect(dialog.locator('[data-row-setup]')).toHaveAttribute(
          'href',
          /\/projects\/\d+#project-tasks-heading/,
        )
      } else {
        await expect(dialog.locator('[data-row-setup]')).toBeHidden()
        await expect(dialog.locator('[data-row-empty-reason]')).toContainText(
          'Ask a project manager',
        )
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await page.locator('[data-add-row-trigger]').click()
      await expect(dialog.getByRole('heading', { name: 'Add project and task' })).toBeVisible()
      await expect(dialog.locator('[data-row-empty]')).toBeVisible()
      await expect(dialog.locator('[data-row-project]')).toBeHidden()
      await expect(dialog.locator('[data-row-task]')).toBeHidden()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      if (profile === 'administrator') {
        await page.screenshot({ path: `/tmp/ezacto-1165-guidance-${width}.png`, animations: 'disabled' })
        await dialog.locator('[data-row-setup]').click()
        await expect(
          page.getByRole('heading', { name: 'Assigned tasks', exact: true }),
        ).toBeVisible()
        await expect(page.getByRole('button', { name: 'Assign task', exact: true })).toBeVisible()
      }
    })
  }
}

test('an assigned task starts and stops a real timer from the header', async ({ page }) => {
  await signIn(page)
  await page.locator('[data-timer-chip]').click()
  const editor = page.locator('[data-entry-dialog]')
  await expect(editor).toBeVisible()
  await expect(editor.locator('[data-entry-project]')).not.toHaveValue('')
  await expect(editor.locator('[data-entry-task]')).not.toHaveValue('')
  await editor.locator('[data-entry-note-input]').fill('Testing the assigned task timer')
  await editor.getByRole('button', { name: 'Start timer', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(page.locator('[data-timer-chip]')).toHaveAttribute('data-state', 'running')
  await page.locator('[data-timer-chip]').click()
  await expect(editor.locator('[data-stop-timer]')).toBeVisible()
  const aged = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'age-running-timer' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(aged.status()).toBe(204)
  await editor.locator('[data-stop-timer]').click()
  await expect(page.locator('[data-timer-chip]')).toHaveAttribute('data-state', 'stopped')
})
