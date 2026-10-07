import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('EZACTO_BROWSER_FIXTURE_EMAIL and EZACTO_BROWSER_FIXTURE_PASSWORD are required')
}

const origin = `http://127.0.0.1:${process.env.EZACTO_BROWSER_PORT ?? '4173'}`
// The two grounds, as the browser computes them: #0C111C and #FFFFFF.
const darkGround = 'rgb(12, 17, 28)'
const lightGround = 'rgb(255, 255, 255)'

const prefer = (context: BrowserContext, name: string, value: string): Promise<void> =>
  context.addCookies([{ name, value, url: origin }])

const groundOf = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

const bandOf = (page: Page): Promise<string> =>
  page.evaluate(
    () => getComputedStyle(document.querySelector<HTMLElement>('.auth-splash')!).backgroundColor,
  )

const signIn = async (page: Page): Promise<void> => {
  // Late in a full run the suite has spent the sign-in limit; this spec is not
  // about the limit, so it starts with a fresh one.
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.locator('[data-sign-in-form]').getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
})

test('[e2e:scheme] follows the operating system until somebody chooses', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  expect(await groundOf(page)).toBe(darkGround)
  // The splash is the band, and it stays a dark band rather than turning into
  // the light strip `ink` became in a dark scheme.
  expect(await bandOf(page)).toBe('rgb(7, 10, 18)')

  await page.emulateMedia({ colorScheme: 'light' })
  expect(await groundOf(page)).toBe(lightGround)
  expect(await bandOf(page)).toBe('rgb(26, 26, 46)')
})

test('[e2e:scheme] paints a chosen scheme without a script, so there is nothing to flash', async ({
  page,
  context,
}) => {
  // With the shell's script refused, the only thing that can make this page
  // dark is the markup the server rendered from the cookie -- which is what it
  // takes for the first paint to be the right one.
  await page.route('**/assets/ezacto.js', (route) => route.abort())
  await page.emulateMedia({ colorScheme: 'light' })
  await prefer(context, 'ezacto_scheme', 'dark')
  const response = await page.goto('/')
  expect(await response!.text()).toContain('data-ez-scheme="dark"')
  expect(await groundOf(page)).toBe(darkGround)

  // And Light holds under a dark operating system.
  await prefer(context, 'ezacto_scheme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  expect(await groundOf(page)).toBe(lightGround)
})

test('[e2e:scheme] keeps an instance palette under System and gives way to an explicit Dark', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await signIn(page)
  const saved = await page.evaluate(async () => {
    const response = await fetch('/api/v1/settings/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ palette: { action: '#1D4ED8' } }),
    })
    return response.status
  })
  expect(saved).toBe(200)
  try {
    // The operator's palette was checked against the light scheme, and an OS
    // set to dark is not a request to stop wearing it.
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-ez-palette', 'instance')
    expect(await groundOf(page)).toBe(lightGround)

    // Asking for Dark outright is, and it gets the built-in dark scheme.
    await prefer(context, 'ezacto_scheme', 'dark')
    await page.goto('/')
    expect(await groundOf(page)).toBe(darkGround)
  } finally {
    await page.evaluate(() => fetch('/api/v1/settings/theme', { method: 'DELETE' }))
    await context.clearCookies({ name: 'ezacto_scheme' })
  }
})

test('[e2e:scheme] switches from the Theme picker and remembers it across a reload', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/settings/user')
  await signIn(page)
  const picker = page.getByRole('group', { name: 'Theme' })
  await picker.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-ez-scheme', 'dark')
  expect(await groundOf(page)).toBe(darkGround)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-ez-scheme', 'dark')
  expect(await groundOf(page)).toBe(darkGround)
  await expect(picker.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await picker.getByRole('button', { name: 'System', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-ez-scheme', 'system')
  expect((await context.cookies()).some((cookie) => cookie.name === 'ezacto_scheme')).toBe(false)
})

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox()
  expect(rect, selector).not.toBeNull()
  return rect!
}

test('[e2e:nav] marks the section you are in, and lays the same header across the top on request', async ({
  page,
  context,
}) => {
  // Explicit, so the spec means the same under EZACTO_BROWSER_NAV=topbar.
  await prefer(context, 'ezacto_nav', 'sidebar')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/invoices')
  await signIn(page)

  // The sidebar is the default: a fixed column down the left, the content
  // beside it rather than under it.
  const header = page.locator('[data-app-nav]')
  expect(await header.evaluate((element) => getComputedStyle(element).position)).toBe('fixed')
  expect((await box(page, '[data-app-nav]')).width).toBe(248)
  expect((await box(page, '[data-invoice-list-page]')).x).toBeGreaterThanOrEqual(248)
  const invoices = page.locator('.primary-nav').getByRole('link', { name: 'Invoices', exact: true })
  await expect(invoices).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.primary-nav a[aria-current="page"]')).toHaveCount(1)
  // The current section's mark sits on a tile of the action blue.
  expect(
    await invoices.locator('svg').evaluate((icon) => getComputedStyle(icon).backgroundColor),
  ).toBe('rgb(37, 79, 232)')

  // The same header, across the top: same links, same mark, no column.
  await prefer(context, 'ezacto_nav', 'topbar')
  await page.reload()
  await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
  expect(await header.evaluate((element) => getComputedStyle(element).position)).toBe('static')
  expect((await box(page, '[data-app-nav]')).width).toBe(1280)
  await expect(invoices).toHaveAttribute('aria-current', 'page')
  await context.clearCookies({ name: 'ezacto_nav' })
})

test('[e2e:nav] narrows the sidebar to its icons, and the next page opens narrowed', async ({
  page,
  context,
}) => {
  await prefer(context, 'ezacto_nav', 'sidebar')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await signIn(page)
  const toggle = page.getByRole('button', { name: 'Collapse sidebar' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect((await box(page, '[data-app-nav]')).width).toBe(72)
  // Narrowed to marks, the links keep their names.
  await expect(page.locator('.primary-nav').getByRole('link', { name: 'Reports' })).toBeVisible()

  // The server renders the narrowed sidebar from the cookie, so the next page
  // is narrow before any script has run -- there is no wide frame to jump from.
  await page.route('**/assets/ezacto.js', (route) => route.abort())
  const response = await page.goto('/invoices')
  expect(await response!.text()).toContain('data-ez-sidebar="collapsed"')
  expect((await box(page, '[data-app-nav]')).width).toBe(72)
  await page.unroute('**/assets/ezacto.js')
  await context.clearCookies({ name: 'ezacto_sidebar' })
})

for (const layout of ['sidebar', 'topbar'] as const) {
  test(`[e2e:nav] folds the ${layout} into the same drawer on a 375px phone, and keeps focus in it`, async ({
    page,
    context,
  }) => {
    await prefer(context, 'ezacto_nav', layout)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')
    await signIn(page)

    // Below 900px neither layout is a column: the header is the narrow bar,
    // its sections are behind the Menu button, and nothing overflows.
    expect(
      await page.locator('[data-app-nav]').evaluate((element) => getComputedStyle(element).position),
    ).toBe('static')
    await expect(page.locator('.primary-nav')).toBeHidden()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    const trigger = page.locator('[data-menu-trigger]')
    const drawer = page.locator('[data-menu-dialog]')
    await trigger.click()
    await expect(drawer).toBeVisible()
    // A drawer from the left edge, the full height of the screen -- measured
    // once its slide-in has landed.
    await expect.poll(async () => (await box(page, '[data-menu-dialog]')).x).toBe(0)
    const rect = await box(page, '[data-menu-dialog]')
    expect(rect.height).toBeGreaterThanOrEqual(812 - 1)
    expect(rect.width).toBeLessThanOrEqual(375)
    await expect(drawer.getByRole('link', { name: 'Time', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(drawer.getByRole('link', { name: 'Time', exact: true })).toBeFocused()

    // Round the drawer more than once: Tab never reaches the page behind it.
    // Between the last control and the first, focus may sit with the browser,
    // which is not an escape.
    const landed: string[] = []
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab')
      landed.push(
        await page.evaluate(() => {
          const active = document.activeElement
          if (active === null || active === document.body) return 'browser'
          return document.querySelector('[data-menu-dialog]')?.contains(active) === true
            ? 'drawer'
            : active.outerHTML.slice(0, 80)
        }),
      )
    }
    expect(landed.filter((place) => place !== 'drawer' && place !== 'browser')).toEqual([])
    expect(landed.filter((place) => place === 'drawer').length).toBeGreaterThan(30)

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(trigger).toBeFocused()
    await context.clearCookies({ name: 'ezacto_nav' })
  })
}
