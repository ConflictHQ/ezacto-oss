import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('EZACTO_BROWSER_FIXTURE_EMAIL and EZACTO_BROWSER_FIXTURE_PASSWORD are required')
}

const origin = 'http://127.0.0.1:4173'
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
