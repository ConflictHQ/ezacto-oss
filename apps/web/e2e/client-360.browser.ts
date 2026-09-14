import { expect, test } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
const fixtureInstant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT

if (
  fixtureEmail === undefined ||
  fixturePassword === undefined ||
  fixtureInstant === undefined
) {
  throw new Error('browser fixture credentials are unavailable')
}

/**
 * The guard the unit suite cannot write, for the failure it already missed.
 *
 * Client 360 shipped with a merge that dropped one `</section>`. The markup
 * stayed valid -- the browser simply nested everything after the missing tag
 * inside the panel above it, which carries `hidden` until its own data loads.
 * A third of the page disappeared. Seven hundred and twenty-four unit tests
 * passed, because every one of them asks a controller what it painted rather
 * than asking a browser what is on screen, and the controller painted exactly
 * what it was asked to.
 *
 * So this asserts two separate things, and the second is the one that matters:
 * every panel is visible, and no panel is inside another. The first alone
 * passes on the broken page for any panel that happens to be above the missing
 * tag; the second fails on it at the first nested panel, whatever `hidden` is
 * doing at the time.
 */
const panels = [
  { name: 'facts', selector: '.client-facts' },
  { name: 'client 360', selector: '[data-client-360]' },
  { name: 'projects', selector: '.client-projects' },
  { name: 'contacts', selector: '.client-contacts' },
] as const

test('[e2e:client-360] draws every panel of the client page, none inside another', async ({
  page,
}) => {
  await page.clock.setFixedTime(fixtureInstant)
  await page.setViewportSize({ width: 1440, height: 900 })
  // No network on the acceptance run, so the webfont would fail slowly and
  // silently rather than not at all.
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/clients/1')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // The name first. A page that never loaded its client has every panel absent
  // rather than nested, and would satisfy the nesting check vacuously.
  await expect(page.locator('[data-client-detail-name]')).toHaveText(
    'Browser Acceptance Client',
  )

  for (const panel of panels) {
    await expect(
      page.locator(panel.selector),
      `the ${panel.name} panel is not on the page`,
    ).toBeVisible()
  }

  const nested = await page.evaluate(
    (selectors: readonly string[]) =>
      selectors.flatMap((selector) => {
        const element = document.querySelector(selector)
        if (element === null) return [`${selector} is missing`]
        return selectors
          .filter((other) => other !== selector)
          .filter((other) => {
            const container = document.querySelector(other)
            return container !== null && container.contains(element)
          })
          .map((other) => `${selector} is inside ${other}`)
      }),
    panels.map((panel) => panel.selector),
  )
  expect(nested, `panels nested inside one another: ${nested.join(' | ')}`).toEqual([])

  // The rollup's own three blocks, which are what the panel exists to show. A
  // 360 panel that renders its heading and no figures is the same defect one
  // level down.
  const figures = page.locator('[data-client-360-figures]')
  await expect(figures).toBeVisible()
  for (const heading of ['Open invoices', 'Retainer balance', 'Node budget burn']) {
    await expect(
      figures.getByRole('heading', { name: heading }),
      `the rollup is missing its ${heading} block`,
    ).toBeVisible()
  }
})
