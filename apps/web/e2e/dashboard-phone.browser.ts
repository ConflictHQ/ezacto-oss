import { expect, test, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!

const visibleCards = '[data-dashboard-card]:not([hidden])'

/** The visible cards' edges, in document order. */
const cardBoxes = (page: Page) =>
  page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map((card) => {
        const rect = card.getBoundingClientRect()
        return { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right }
      }),
    visibleCards,
  )

test('[e2e:phone-week] stacks the dashboard cards in one column at 390px', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/dashboard')
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.locator('[data-dashboard-page]')).toBeVisible()
  // The cards ship hidden and appear once the browser has read each gate; an
  // administrator sees at least two, which is what a stack needs to be a stack.
  await expect(page.locator(visibleCards).nth(1)).toBeVisible()

  // On a laptop the grid lays cards side by side. Without this the phone
  // assertion below would pass on a page that never had a grid.
  const wide = await cardBoxes(page)
  expect(new Set(wide.map((box) => Math.round(box.top))).size).toBeLessThan(wide.length)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(visibleCards).nth(1)).toBeVisible()
  const phone = await cardBoxes(page)
  expect(phone.length).toBeGreaterThanOrEqual(2)
  for (const [index, box] of phone.entries()) {
    // One column: every card starts at the same left edge and stays on screen.
    expect(Math.abs(box.left - phone[0]!.left)).toBeLessThan(1)
    expect(box.right).toBeLessThanOrEqual(390.5)
    // And each sits below the one before it rather than beside it.
    if (index > 0) expect(box.top).toBeGreaterThanOrEqual(phone[index - 1]!.bottom - 0.5)
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
