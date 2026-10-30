import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

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
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
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

const controlBrowserFixture = (
  request: APIRequestContext,
  action: 'client-360-seed' | 'client-360-cleanup',
) =>
  request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })

/**
 * Issue 65's acceptance, in figures: a three-level tree (Root > Child >
 * Grandchild, billed in USD, EUR and USD) whose money sits at every level, and
 * the exact per-currency rollup each node's 360 owes. The seed is in
 * browser-worker-harness.mjs (`client-360-seed`); the numbers below are the
 * sum of the rows it writes, worked out by hand there.
 *
 * Text is compared whole, cell by cell, so a blended total or a stray extra
 * currency row fails rather than passes by containing the right substring.
 */
test.describe('[e2e:client-360] rollups on the three-level fixture', () => {
  // A failed spec must not leave a tree behind for the next one to count.
  test.beforeEach(async ({ request }) => {
    const seeded = await controlBrowserFixture(request, 'client-360-seed')
    expect(seeded.status()).toBe(204)
  })
  test.afterEach(async ({ request }) => {
    const cleaned = await controlBrowserFixture(request, 'client-360-cleanup')
    expect(cleaned.status()).toBe(204)
  })

  const openClient = async (page: Page, id: number, name: string): Promise<void> => {
    await page.goto(`/clients/${id}`)
    await expect(page.locator('[data-client-detail-name]')).toHaveText(name)
    await expect(page.locator('[data-client-360-figures]')).toBeVisible()
  }

  const rowCells = (page: Page, block: string, key: string) =>
    page.locator(`${block} tr[data-row-key="${key}"] td`)

  test('the root carries its grandchild invoices, retainers and burn, per currency', async ({
    page,
  }) => {
    await page.clock.setFixedTime(fixtureInstant)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
    await page.goto('/clients/9300')
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
    await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.locator('[data-client-detail-name]')).toHaveText('Browser 360 Root')
    await expect(page.locator('[data-client-360-figures]')).toBeVisible()
    await expect(page.locator('[data-client-360-scope]')).toContainText(
      'Rolled up across 3 clients',
    )

    // Open invoices: Root 100.00 (overdue) + Grandchild 75.00 in USD; Child
    // 250.00 in EUR. The Grandchild's 999.00 draft is owed by nobody.
    const invoices = '[data-client-360-invoices]'
    await expect(page.locator(`${invoices} tr[data-row]`)).toHaveCount(2)
    await expect(rowCells(page, invoices, 'USD')).toHaveText([
      'USD',
      '2 invoices',
      '$175.00',
      '$100.00 (1 invoice)',
    ])
    await expect(rowCells(page, invoices, 'EUR')).toHaveText([
      'EUR',
      '1 invoice',
      '€250.00',
      'None',
    ])

    // Retainer balances: money in each currency, hours on their own line.
    const retainers = '[data-client-360-retainers]'
    await expect(page.locator(`${retainers} tr[data-row]`)).toHaveCount(3)
    await expect(rowCells(page, retainers, 'money:USD')).toHaveText([
      'Money',
      'USD',
      '2 retainers',
      '$700.00',
    ])
    await expect(rowCells(page, retainers, 'money:EUR')).toHaveText([
      'Money',
      'EUR',
      '1 retainer',
      '€300.00',
    ])
    await expect(rowCells(page, retainers, 'hours:')).toHaveText([
      'Hours',
      '—',
      '1 retainer',
      '10 hours',
    ])

    // Burn: labour cost is in the organization's currency whatever the client
    // bills in, so the Child's half hour lands in USD; its expense stays EUR.
    const burn = '[data-client-360-burn]'
    await expect(page.locator(`${burn} tr[data-row]`)).toHaveCount(2)
    await expect(rowCells(page, burn, 'USD')).toHaveText([
      'USD',
      '$82.50',
      '$40.00',
      '$122.50',
    ])
    await expect(rowCells(page, burn, 'EUR')).toHaveText([
      'EUR',
      '€0.00',
      '€30.00',
      '€30.00',
    ])

    // The leaf rolls up only itself, and keeps worked-for (the Child) apart
    // from bill-to (the Root).
    await openClient(page, 9302, 'Browser 360 Grandchild')
    await expect(page.locator('[data-client-detail-parent]')).toHaveText('Browser 360 Child')
    await expect(page.locator('[data-client-detail-bill-to]')).toHaveText('Browser 360 Root')
    await expect(page.locator('[data-client-360-scope]')).toContainText('nothing under it')
    await expect(page.locator(`${invoices} tr[data-row]`)).toHaveCount(1)
    await expect(rowCells(page, invoices, 'USD')).toHaveText([
      'USD',
      '1 invoice',
      '$75.00',
      'None',
    ])
    await expect(page.locator(`${retainers} tr[data-row]`)).toHaveCount(1)
    await expect(rowCells(page, retainers, 'money:USD')).toHaveText([
      'Money',
      'USD',
      '1 retainer',
      '$200.00',
    ])
    await expect(page.locator(`${burn} tr[data-row]`)).toHaveCount(1)
    await expect(rowCells(page, burn, 'USD')).toHaveText([
      'USD',
      '$12.50',
      '$15.00',
      '$27.50',
    ])
  })
})
