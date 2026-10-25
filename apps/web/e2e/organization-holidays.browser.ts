import { expect, test } from '@playwright/test'
test('[e2e #1007] organization holidays reduce capacity once and can be edited and removed', async ({
  page,
}, info) => {
  await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/capacity')
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
  const root = page.locator('[data-organization-holidays]'),
    grid = page.locator('[data-capacity-grid]')
  await expect(root).toBeVisible()
  await expect(page.locator('[data-placeholder-assign-form]')).toBeHidden()
  const visibleControls = await page.locator('.capacity-form input:not([type="hidden"]):visible, .capacity-form select:visible, .capacity-form button:visible, [data-capacity-current]:visible').all()
  expect(visibleControls.length).toBeGreaterThan(0)
  for (const control of visibleControls) {
    const box = await control.boundingBox()
    expect(box, 'visible capacity control has a target').not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
  const thisWeek = page.locator('[data-capacity-current]')
  expect((await thisWeek.boundingBox())!.width).toBeGreaterThan(100)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const baseline = await page.evaluate(
    async () =>
      (
        await (await fetch('/api/v1/capacity?from=2026-08-31&to=2026-09-06')).json()
      ).data.people.find((p: { user_id: number }) => p.user_id === 1).weeks[0]
        .available_capacity_seconds,
  )
  await root.getByLabel('Holiday date', { exact: true }).fill('2026-08-31')
  await root
    .getByLabel('Holiday name', { exact: true })
    .fill('Office closed ' + crypto.randomUUID())
  await root.getByRole('button', { name: 'Add holiday', exact: true }).click()
  await expect(root.locator('[data-holiday-table] tbody tr')).toHaveCount(1)
  await expect(grid).toContainText('7h time off')
  const result = await page.evaluate(
    async () =>
      (
        await (await fetch('/api/v1/capacity?from=2026-08-31&to=2026-09-06')).json()
      ).data.people.find((p: { user_id: number }) => p.user_id === 1).weeks[0]
        .available_capacity_seconds,
  )
  expect(result).toBe(baseline - 7 * 3600)
  await root.getByRole('button', { name: 'Edit holiday', exact: true }).click()
  await root.getByLabel('Holiday name', { exact: true }).fill('Updated office holiday')
  await root.getByRole('button', { name: 'Save holiday', exact: true }).click()
  await expect(root.locator('[data-holiday-table]')).toContainText('Updated office holiday')
  await page.screenshot({
    path: info.outputPath('organization-holidays-phone.png'),
    fullPage: true,
  })
  await root.locator('[data-holiday-table] summary').click()
  await root.getByRole('button', { name: 'Remove holiday', exact: true }).click()
  const dialog = root.locator('[data-holiday-delete-dialog]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove holiday', exact: true }).click()
  await expect(root.locator('[data-holiday-table]')).toContainText(
    'No organization holidays in these weeks.',
  )
  await expect(grid).not.toContainText('7h time off')
})
