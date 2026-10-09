import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('EZACTO_BROWSER_FIXTURE_EMAIL and EZACTO_BROWSER_FIXTURE_PASSWORD are required')
}

const origin = `http://127.0.0.1:${process.env.EZACTO_BROWSER_PORT ?? '4173'}`
// The grounds, as the browser computes them: #0C111C, #2A303C and #FFFFFF.
const darkGround = 'rgb(12, 17, 28)'
const dimGround = 'rgb(42, 48, 60)'
const lightGround = 'rgb(255, 255, 255)'

const prefer = (context: BrowserContext, name: string, value: string): Promise<void> =>
  context.addCookies([{ name, value, url: origin }])

/**
 * The ground the page is painted on: the sign-in card while the sign-in page
 * shows (the document itself wears the panel's surface there), the body once
 * the app does.
 */
const groundOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const gateway = document.querySelector<HTMLElement>('[data-auth-gateway]')
    const card = gateway !== null && !gateway.hidden ? gateway.querySelector('.auth-card') : null
    return getComputedStyle(card ?? document.body).backgroundColor
  })

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
  await page.locator('[data-sign-in-form]').getByLabel('Password', { exact: true }).fill(fixturePassword)
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

  // Dim the same way, under either operating system, with the browser's own
  // controls told it is dark.
  await prefer(context, 'ezacto_scheme', 'dim')
  for (const system of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: system })
    await page.goto('/')
    expect(await groundOf(page)).toBe(dimGround)
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    ).toBe('dark')
  }
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

    // Asking for Dark outright is, and it gets the built-in dark scheme. Dim
    // behaves the same way.
    await prefer(context, 'ezacto_scheme', 'dark')
    await page.goto('/')
    expect(await groundOf(page)).toBe(darkGround)
    await prefer(context, 'ezacto_scheme', 'dim')
    await page.goto('/')
    expect(await groundOf(page)).toBe(dimGround)
  } finally {
    await page.evaluate(() => fetch('/api/v1/settings/theme', { method: 'DELETE' }))
    await context.clearCookies({ name: 'ezacto_scheme' })
  }
})

/** WCAG contrast between two colours as the browser computes them, `rgb(…)`. */
const contrastOf = (first: string, second: string): number => {
  const luminance = (color: string): number => {
    const [red, green, blue] = (color.match(/\d+(?:\.\d+)?/gu) ?? []).slice(0, 3).map((part) => {
      const channel = Number(part) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

test('[e2e:scheme] edges every blue fill in Dim so it stands off the slate, label still white', async ({
  page,
  context,
}) => {
  // The action blue stands 2.7:1 off Dim's slate, short of the 3:1 a control's
  // boundary owes. The fill keeps its blue and its white label; its edge is the
  // reading blue -- a border on a button, an inset ring on the sidebar's tile.
  await prefer(context, 'ezacto_nav', 'sidebar')
  await prefer(context, 'ezacto_scheme', 'dim')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await signIn(page)
  const dim = await page.evaluate(() => {
    const button = getComputedStyle(document.querySelector<HTMLElement>('[data-time-log-time]')!)
    const current = document.querySelector<HTMLElement>("[data-app-nav] .primary-nav a[aria-current='page']")!
    const tile = getComputedStyle(current.querySelector<HTMLElement>('.ez-icon')!)
    return {
      ground: getComputedStyle(document.body).backgroundColor,
      fill: button.backgroundColor,
      edge: button.borderTopColor,
      label: button.color,
      row: getComputedStyle(current).backgroundColor,
      tileFill: tile.backgroundColor,
      ring: tile.boxShadow,
    }
  })
  expect(dim.ground).toBe(dimGround)
  expect(contrastOf(dim.fill, dim.ground)).toBeLessThan(3)
  expect(contrastOf(dim.edge, dim.ground)).toBeGreaterThanOrEqual(3)
  expect(dim.label).toBe('rgb(255, 255, 255)')
  expect(dim.ring).toContain(dim.edge)
  expect(dim.ring).toContain('inset')
  expect(contrastOf(dim.edge, dim.row)).toBeGreaterThanOrEqual(3)
  expect(dim.tileFill).toBe(dim.fill)

  // Light and dark have no use for it: there the edge is the fill.
  for (const scheme of ['light', 'dark']) {
    await prefer(context, 'ezacto_scheme', scheme)
    await page.goto('/')
    await expect(page.locator('[data-time-log-time]')).toBeVisible()
    const { fill, edge } = await page.evaluate(() => {
      const button = getComputedStyle(document.querySelector<HTMLElement>('[data-time-log-time]')!)
      return { fill: button.backgroundColor, edge: button.borderTopColor }
    })
    expect(edge, scheme).toBe(fill)
  }
  await context.clearCookies({ name: 'ezacto_scheme' })
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
  // Explicit, so the spec means the same under EZACTO_BROWSER_NAV=topbar. Wide
  // enough that the top bar still shows its sections (they fold below 1300).
  await prefer(context, 'ezacto_nav', 'sidebar')
  await page.setViewportSize({ width: 1440, height: 800 })
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
  expect((await box(page, '[data-app-nav]')).width).toBe(1440)
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

/**
 * Everything in the header that sticks out of it, or has text cut off inside a
 * box that hides overflow -- except the timer chip's label, whose job is to
 * ellipsize, and the labels kept for screen readers alone.
 */
const headerFaults = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-app-nav]')!
    const edge = header.getBoundingClientRect()
    const faults: string[] = []
    for (const element of header.querySelectorAll<HTMLElement>('*')) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || getComputedStyle(element).visibility === 'hidden') continue
      // Inside a box clipped to nothing on purpose -- a label kept for screen
      // readers -- nothing is drawn, so where it would have been is moot.
      let forReaders = false
      for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).clipPath === 'inset(50%)') forReaders = true
      }
      if (forReaders) continue
      const name = `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''}`
      if (box.right > edge.right + 0.5 || box.left < edge.left - 0.5) {
        faults.push(`outside ${name} ${Math.round(box.left)}-${Math.round(box.right)}`)
      }
      const clipping = getComputedStyle(element).overflow !== 'visible'
      if (clipping && !element.matches('[data-timer-label]') && element.scrollWidth > element.clientWidth + 1) {
        faults.push(`clipped ${name}`)
      }
    }
    return faults
  })

/**
 * Every section an administrator sees. The shell is shown before it knows what
 * the session may open, and reveals Approvals, the directory, Invoices and
 * Payments as each answer lands, so for a few frames after sign-in the nav is
 * shorter and narrower than it settles at. Measured in that window, the bar has
 * room it will not have, and two boxes read a frame apart can disagree by a
 * whole row.
 */
const everySection = (page: Page) =>
  expect(page.locator('[data-app-nav] .primary-nav a:visible')).toHaveCount(8)

/** Arial, which CI's Liberation Sans matches metric for metric, so a width means the same on both. */
const pinHeaderFont = (page: Page) =>
  page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-app-nav], [data-app-nav] *'))
      element.style.fontFamily = 'Arial, sans-serif'
  })

/** The widest the chip ever gets: a running timer whose label runs past its 320px cap. */
const longestTimer = (page: Page) =>
  page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('[data-timer-chip]')!
    chip.dataset.state = 'running'
    chip.querySelector('[data-timer-label]')!.textContent =
      'Browser Acceptance Project / Browser Acceptance Task with a long name'
    chip.querySelector('[data-timer-elapsed]')!.textContent = '12:34:56'
  })

test('[e2e:nav] fits the top bar at every width, at each band edge', async ({ page, context }) => {
  // An administrator sees every section, so this is the widest the bar gets.
  await prefer(context, 'ezacto_nav', 'topbar')
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto('/')
  await signIn(page)
  await everySection(page)
  for (const width of [1920, 1700, 1699, 1520, 1519, 1440, 1439, 1300, 1299, 1140, 900, 721]) {
    await page.setViewportSize({ width, height: 900 })
    await pinHeaderFont(page)
    await longestTimer(page)
    expect(await headerFaults(page), `${width}px`).toEqual([])
  }
  // Search is a field from 1520 and its magnifier below, and keeps its name
  // either way.
  const search = page.locator('[data-app-nav] [data-command-trigger]')
  await page.setViewportSize({ width: 1520, height: 900 })
  await expect(search.locator('.command-trigger-label')).toBeVisible()
  await page.setViewportSize({ width: 1519, height: 900 })
  await expect(search.locator('.command-trigger-label')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Search and commands' })).toBeVisible()
  // Which leaves a running timer its name at 1440. With the field there the
  // chip had 37px of label, "Bro…"; without it, about 180.
  await page.setViewportSize({ width: 1440, height: 900 })
  await pinHeaderFont(page)
  await longestTimer(page)
  const label = await page
    .locator('[data-app-nav] [data-timer-label]')
    .evaluate((element) => element.clientWidth)
  expect(label).toBeGreaterThanOrEqual(140)
  await context.clearCookies({ name: 'ezacto_nav' })
})

test('[e2e:nav] gives search a row of its own in the sidebar, ring and all', async ({
  page,
  context,
}) => {
  await prefer(context, 'ezacto_nav', 'sidebar')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await signIn(page)
  await everySection(page)
  await pinHeaderFont(page)
  await longestTimer(page)
  expect(await headerFaults(page)).toEqual([])

  const search = page.locator('[data-app-nav] [data-command-trigger]')
  // All three from one layout, so a late reflow cannot put them a row apart.
  const { searchBox, money, menu } = await page.evaluate(() => {
    const rect = (selector: string) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect()
      return { x, y, width, height }
    }
    return {
      searchBox: rect('[data-app-nav] [data-command-trigger]'),
      money: rect('[data-money-toggle]'),
      menu: rect('[data-menu-trigger]'),
    }
  })
  // The column's whole width, less its 10px padding each side, and $ and Menu
  // together on the row under it.
  expect(searchBox.width).toBeCloseTo(248 - 1 - 20, 0)
  expect(money.y).toBeGreaterThan(searchBox.y + searchBox.height - 1)
  expect(Math.abs(money.y - menu.y)).toBeLessThan(1)
  // The chip says which key: the command key on a Mac, Ctrl elsewhere.
  const chip = (await search.locator('.command-shortcut').textContent())?.replace(/\s/gu, ' ')
  expect(['⌘K', 'Ctrl K']).toContain(chip)

  // The focus ring is drawn inside the column, not cut off by its edge.
  await search.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(search).toBeFocused()
  const ring = await search.evaluate((element) => {
    const style = getComputedStyle(element)
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)
    const rect = element.getBoundingClientRect()
    const column = element.closest('[data-app-nav]')!.getBoundingClientRect()
    return {
      style: style.outlineStyle,
      left: rect.left - reach - column.left,
      right: column.right - (rect.right + reach),
    }
  })
  expect(ring.style).not.toBe('none')
  expect(ring.left).toBeGreaterThanOrEqual(0)
  expect(ring.right).toBeGreaterThanOrEqual(0)

  // Narrowed to icons, search is its magnifier and keeps its name.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Search and commands' })).toBeVisible()
  expect((await box(page, '[data-app-nav] [data-command-trigger]')).width).toBe(48)
  expect(await headerFaults(page)).toEqual([])
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await context.clearCookies({ name: 'ezacto_sidebar' })
})

test('[e2e:nav] highlights the command bar row Enter acts on in the selected tint', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await signIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.locator('[data-command-dialog]')
  const query = dialog.getByRole('combobox', { name: 'Command' })
  await expect(query).toBeFocused()
  await page.keyboard.type('inv')
  const highlighted = dialog.locator('[data-command-option][aria-selected="true"]')
  await expect(highlighted).toHaveText('Invoices')
  // #EFF3FF, the selected tint, with the focus colour down its edge.
  expect(await highlighted.evaluate((row) => getComputedStyle(row).backgroundColor)).toBe(
    'rgb(239, 243, 255)',
  )
  await expect(query).toHaveAttribute('aria-activedescendant', (await highlighted.getAttribute('id'))!)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('[e2e:text-size] keeps the drawer and the command bar inside the window at the largest text', async ({
  page,
}) => {
  // The text size is a `zoom`, which scales viewport units with everything
  // else: at Larger the drawer was 412px wide on a 375px phone and the command
  // bar ran 80px past the bottom of a 720px window.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('ezacto.text-size', 'larger'))
  await page.goto('/')
  await signIn(page)
  await page.locator('[data-menu-trigger]').click()
  const drawer = page.locator('[data-menu-dialog]')
  await expect(drawer).toBeVisible()
  await expect.poll(async () => (await box(page, '[data-menu-dialog]')).x).toBe(0)
  const drawerBox = await box(page, '[data-menu-dialog]')
  expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(375)
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.locator('[data-time-log-time]').click()
  const command = page.locator('[data-command-dialog]')
  await expect(command).toBeVisible()
  await page.waitForTimeout(250)
  const commandBox = await box(page, '[data-command-dialog]')
  expect(commandBox.y + commandBox.height).toBeLessThanOrEqual(720)
  expect(commandBox.x + commandBox.width).toBeLessThanOrEqual(1280)
  await page.keyboard.press('Escape')
  await page.evaluate(() => localStorage.removeItem('ezacto.text-size'))
})
