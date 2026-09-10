import { expect, test, type APIRequestContext } from '@playwright/test'

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

const controlBrowserFixture = (
  request: APIRequestContext,
  action: 'team-summary-seed' | 'team-summary-cleanup',
) =>
  request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })

test.afterEach(async ({ request }) => {
  const cleaned = await controlBrowserFixture(request, 'team-summary-cleanup')
  expect(cleaned.status()).toBe(204)
})

/**
 * The regression guard #515 could not write. See #524.
 *
 * The fix stopped `328.25h` overrunning into `284.5h`, and the reason it
 * shipped without a guard is that the acceptance roster was the signed-in owner
 * alone: the strip read `1`, `35h`, `0.75h`, `0.75h`, `0h`, `2.1%`, and a
 * collision assertion over figures that short measures nothing. Run against
 * #515 reverted, with that roster, it passes -- measured, which is what settles
 * it. The seed gives this spec a nine person week that reproduces the demo's
 * own numbers, so there is something here to measure.
 *
 * Two things keep it non-vacuous. It asserts the six figures are present and
 * says what they read before it measures anything, so an empty or a shrunken
 * strip fails here rather than passing quietly. And it measures the painted
 * text rather than the elements: a grid item whose track floor is too small
 * keeps its own box inside the track and spills only its glyphs, so comparing
 * `getBoundingClientRect()` on the six `strong` elements reports no overlap on
 * exactly the layout that is broken. A Range over each figure's text is what
 * reports where the ink actually lands.
 */
const expectedFigures = ['9', '315h', '328.25h', '284.5h', '43.75h', '104.2%']

// The auto-fit track is what failed, and it applies above the 720px breakpoint;
// below it the strip is a fixed two-column grid, which is a different layout
// and worth holding to the same rule. 1180 and 980 are the widths where six
// tracks still fit but each one is at its narrowest.
const viewportWidths = [1440, 1280, 1180, 980, 860, 721, 700, 390]

test('[e2e:team-summary] never prints two utilization figures over one another', async ({
  page,
  request,
}) => {
  const seeded = await controlBrowserFixture(request, 'team-summary-seed')
  expect(seeded.status()).toBe(204)

  await page.clock.setFixedTime(fixtureInstant)
  await page.setViewportSize({ width: 1440, height: 900 })
  // The acceptance run has no network, so the webfont would fail slowly and
  // silently; blocking it makes the metrics the platform's own from the start
  // rather than mid-measurement.
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/team')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const summary = page.locator('[data-team-summary]')
  await expect(summary).toBeVisible()
  const figures = summary.locator('strong')
  // Count first. A strip that rendered nothing is the failure this spec exists
  // to make impossible, and every measurement below is vacuously true over an
  // empty set.
  await expect(figures).toHaveCount(6)
  await expect(figures).toHaveText(expectedFigures)

  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 })
    const overlaps = await page.evaluate(() => {
      const strip = document.querySelector('[data-team-summary]')
      if (strip === null) throw new Error('the team summary strip is not rendered')
      const inked = [...strip.querySelectorAll('strong')].map((figure) => {
        const range = document.createRange()
        range.selectNodeContents(figure)
        return { text: figure.textContent ?? '', box: range.getBoundingClientRect() }
      })
      const found: string[] = []
      for (let left = 0; left < inked.length; left += 1) {
        for (let right = left + 1; right < inked.length; right += 1) {
          const one = inked[left]!
          const other = inked[right]!
          // A half pixel of shared edge is rounding, not an overlap.
          const horizontal =
            Math.min(one.box.right, other.box.right) -
            Math.max(one.box.left, other.box.left)
          const vertical =
            Math.min(one.box.bottom, other.box.bottom) -
            Math.max(one.box.top, other.box.top)
          if (horizontal > 0.5 && vertical > 0.5) {
            found.push(
              `${one.text} [${one.box.left.toFixed(1)}–${one.box.right.toFixed(1)}] over ` +
                `${other.text} [${other.box.left.toFixed(1)}–${other.box.right.toFixed(1)}]`,
            )
          }
        }
      }
      return { count: inked.length, found }
    })
    expect(overlaps.count, `${width}px lost the figures`).toBe(6)
    expect(
      overlaps.found,
      `${width}px prints figures over one another: ${overlaps.found.join(' | ')}`,
    ).toEqual([])
  }
})
