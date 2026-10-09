import { expect, test } from '@playwright/test'

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

test('business row actions stay discoverable on touch and keyboard', async ({ page, context }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.goto('/tasks')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const action = page.locator('.data-table-action').first()
  await expect(action).toBeVisible()
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(action).toHaveCSS('opacity', '1')
    const box = await action.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(48)
    expect(box!.width).toBeGreaterThanOrEqual(48)
  }
  const region = page.locator('.data-table-scroll').first()
  await page.keyboard.press('Tab')
  await region.focus()
  await expect(region).toBeFocused()
  await expect(region).toHaveAttribute('role', 'region')
  await expect(region).toHaveCSS('outline-style', 'solid')
  const summary = page.locator('.data-table-overflow > summary').first()
  await summary.click()
  const menu = page.locator('.data-table-overflow[open]').first()
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Archive', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('.data-table-overflow[open]')).toHaveCount(0)
  await expect(summary).toBeFocused()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(action).toHaveCSS('transition-duration', '0s')
  await page.setViewportSize({ width: 390, height: 844 })
  for (const scheme of ['light', 'dark']) {
    await context.addCookies([{ name: 'ezacto_scheme', value: scheme, url: page.url() }])
    await page.reload()
    await expect(action).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `/tmp/ezacto-web-polish-${scheme}.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  }
})
