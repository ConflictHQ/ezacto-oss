import { expect, test, type Page } from '@playwright/test'

const origin = `http://127.0.0.1:${process.env.EZACTO_BROWSER_PORT ?? '4173'}`

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
})

/** The text size is a per-browser preference, applied on the sign-in page too. */
const useTextSize = async (page: Page, size: string | null): Promise<void> => {
  await page.goto('/')
  await page.evaluate((value) => {
    if (value === null) localStorage.removeItem('ezacto.text-size')
    else localStorage.setItem('ezacto.text-size', value)
  }, size)
  await page.goto('/')
  await expect(page.locator('[data-sign-in-form]')).toBeVisible()
}

const layout = (page: Page) =>
  page.evaluate(() => {
    const gateway = document.querySelector<HTMLElement>('[data-auth-gateway]')!.getBoundingClientRect()
    const panel = getComputedStyle(document.querySelector<HTMLElement>('.auth-entry')!).backgroundColor
    return {
      bottom: gateway.bottom,
      height: window.innerHeight,
      width: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      panel,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }
  })

test('[e2e:signin] fills the window at every text size and in every scheme, with nothing beyond it', async ({
  page,
  context,
}) => {
  // A 1000px window lost its bottom 100px to a white strip at the Small text
  // size: `zoom` scaled the layout's 100vh down with everything else.
  await page.setViewportSize({ width: 1860, height: 1000 })
  for (const scheme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'ezacto_scheme', value: scheme, url: origin }])
    for (const size of [null, 'small', 'large', 'larger']) {
      await useTextSize(page, size)
      const measured = await layout(page)
      const label = `${scheme}, text ${size ?? 'default'}`
      expect(measured.bottom, label).toBeGreaterThanOrEqual(measured.height - 0.5)
      // And not past it while the content fits: at Large the page scrolled by
      // the zoom's own excess. At Larger the splash's headline is taller than
      // a 1000px window, and scrolling to it is right.
      if (size !== 'larger') {
        expect(measured.scrollHeight, label).toBeLessThanOrEqual(measured.height + 1)
      }
      // Whatever lies beyond the layout is more of the right panel.
      expect(measured.html, label).toBe(measured.panel)
      expect(measured.body, label).toBe(measured.panel)
    }
  }
  await useTextSize(page, null)
})

test('[e2e:signin] stacks on a 375px phone without a strip or a sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const size of [null, 'larger']) {
    await useTextSize(page, size)
    const measured = await layout(page)
    expect(measured.bottom).toBeGreaterThanOrEqual(measured.height - 0.5)
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.width)
    expect(measured.html).toBe(measured.panel)
  }
  await useTextSize(page, null)
})

test('[e2e:signin] spaces the fields so a focused field never paints over the next label', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useTextSize(page, null)
  const email = page.locator('[data-sign-in-form]').getByLabel('Email')
  await email.focus()
  const geometry = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#ez-sign-in-email')!
    const style = getComputedStyle(input)
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)
    const ringBottom = input.getBoundingClientRect().bottom + reach
    const password = document.querySelector<HTMLLabelElement>('label[for="ez-sign-in-password"]')!
    // The label's own words, not the field inside it.
    const words = document.createRange()
    words.setStart(password.firstChild!, 0)
    words.setEnd(password.firstChild!, password.firstChild!.textContent!.trimEnd().length)
    const button = document.querySelector<HTMLElement>('[data-sign-in-submit]')!.getBoundingClientRect()
    const status = document.querySelector<HTMLElement>('[data-sign-in-result]')!.getBoundingClientRect()
    const field = input.getBoundingClientRect()
    const emailWords = document.createRange()
    const emailLabel = document.querySelector<HTMLLabelElement>('label[for="ez-sign-in-email"]')!
    emailWords.setStart(emailLabel.firstChild!, 0)
    emailWords.setEnd(emailLabel.firstChild!, emailLabel.firstChild!.textContent!.trimEnd().length)
    return {
      outline: style.outlineStyle,
      ringBottom,
      labelTop: words.getBoundingClientRect().top,
      labelToField: field.top - emailWords.getBoundingClientRect().bottom,
      groupGap: password.getBoundingClientRect().top - document.querySelector<HTMLElement>('label[for="ez-sign-in-email"]')!.getBoundingClientRect().bottom,
      statusGap: status.top - button.bottom,
    }
  })
  expect(geometry.outline).not.toBe('none')
  // The ring clears the Password label's words with room to spare.
  expect(geometry.labelTop).toBeGreaterThan(geometry.ringBottom)
  // 16px between field groups, 8px from a label to its field (measured from
  // the words, whose line box adds a little), 12px from the button to the line
  // that reports on it.
  expect(geometry.groupGap).toBeCloseTo(16, 0)
  expect(geometry.labelToField).toBeGreaterThanOrEqual(8)
  expect(geometry.statusGap).toBeCloseTo(12, 0)
})
