import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`[e2e:skip-navigation] skips to each real page and fences sign-in at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
    await page.goto('/')
    const skip = page.getByRole('link', { name: 'Skip navigation', exact: true })
    await expect(skip).toHaveCount(0)
    await page.evaluate(() => {
      document.body.tabIndex = -1
      document.body.focus()
    })
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab')
      expect(
        await page
          .locator('[data-app-skip-link]')
          .evaluate((link) => link === document.activeElement),
      ).toBe(false)
    }
    const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action: 'sign-in-rate-reset' },
      headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    })
    expect(reset.status()).toBe(204)
    await page
      .locator('[data-sign-in-form]')
      .getByLabel('Email')
      .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
    await page
      .getByLabel('Password', { exact: true })
      .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
    for (const [path, selector] of [
      ['/', '[data-app-content]'],
      ['/expenses', '[data-expense-list-page]'],
    ]) {
      await page.goto(path!)
      await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
      await expect(skip).not.toBeFocused()
      expect(await skip.evaluate((link) => getComputedStyle(link).clipPath)).toBe('inset(50%)')
      const before = await page.evaluate(() => ({ url: location.href, history: history.length }))
      await page.evaluate(() => {
        document.body.tabIndex = -1
        document.body.focus()
      })
      await page.keyboard.press('Tab')
      await expect(skip).toBeFocused()
      expect(await skip.evaluate((link) => getComputedStyle(link).clipPath)).toBe('none')
      const geometry = await skip.evaluate((link) => {
        const bounds = link.getBoundingClientRect()
        const style = getComputedStyle(link)
        return {
          top: bounds.top,
          height: bounds.height,
          outline: style.outlineWidth,
          transition: style.transitionDuration,
        }
      })
      expect(geometry.top).toBeGreaterThanOrEqual(0)
      expect(geometry.height).toBeGreaterThanOrEqual(44)
      expect(geometry.outline).toBe('3px')
      expect(geometry.transition).toBe('0s')
      await page.keyboard.press('Enter')
      await expect(page.locator(selector!)).toBeFocused()
      await expect(page.locator(selector!)).toHaveAttribute('tabindex', '-1')
      expect(await skip.evaluate((link) => getComputedStyle(link).clipPath)).toBe('inset(50%)')
      await page.evaluate(() => window.scrollTo(0, 180))
      await page.screenshot({
        path: info.outputPath(`unfocused-${path === '/' ? 'week' : 'expenses'}-${width}.png`),
        fullPage: true,
      })
      expect(await page.evaluate(() => ({ url: location.href, history: history.length }))).toEqual(
        before,
      )
    }
  })
}
