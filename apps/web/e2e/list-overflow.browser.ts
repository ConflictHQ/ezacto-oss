import { expect, test } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('EZACTO_BROWSER_FIXTURE_EMAIL and EZACTO_BROWSER_FIXTURE_PASSWORD are required')
}

/**
 * Every list screen, at the narrowest phone this product claims to support.
 *
 * `expectNoPageOverflow` already guarded two of these, and the toolbar defect it
 * caught was present on all five — the three without a test simply had nobody
 * looking. Fixing only the screens whose tests failed is what let the same
 * defect come back on /tasks after it was fixed on /clients.
 *
 * The face is pinned rather than left to the platform. The acceptance run blocks
 * the webfont, so each OS falls back to its own default: a Mac's is narrow
 * enough to hide 8px of overflow that Linux CI sees. Pinning the widest
 * plausible fallback makes the assertion mean the same thing everywhere, so a
 * developer catches this before pushing rather than after.
 */
const listScreens = [
  '/tasks',
  '/clients',
  '/projects',
  '/team',
  '/invoices',
  // The retainers pane is hidden on /invoices, so scanning that page says
  // nothing about it. Naming it here is also what would have caught the 500
  // this screen shipped behind: the fixture workspace has no retainers, which
  // is exactly the state the endpoint used to fail on.
  '/invoices/retainers',
]

for (const path of listScreens) {
  test(`[e2e:phone-lists] ${path} fits a 390px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
    await page.goto(path)
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
    await page.getByLabel('Password').fill(fixturePassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForTimeout(1200)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*')))
        element.style.fontFamily = 'Verdana, sans-serif'
    })

    const report = await page.evaluate(() => {
      const doc = document.documentElement
      const offenders: string[] = []
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const rect = element.getBoundingClientRect()
        if (rect.right <= doc.clientWidth + 0.5) continue
        // Content inside a scroll container scrolls there instead of widening
        // the page, so it is not what the page-level assertion is about.
        let clipped = false
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX
          if (overflowX === 'auto' || overflowX === 'hidden' || overflowX === 'scroll') {
            clipped = true
            break
          }
        }
        if (!clipped)
          offenders.push(
            `${element.tagName.toLowerCase()}.${String(element.className) || '(none)'} right=${rect.right.toFixed(1)}`,
          )
      }
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders }
    })

    // Naming the offender is the difference between "the page is 6px too wide"
    // and knowing which element to fix; the first cost a round to diagnose.
    expect(report.offenders, `${path} overflows: ${report.offenders.join(' | ')}`).toEqual([])
    expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth)
  })
}
