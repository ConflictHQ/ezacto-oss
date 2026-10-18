import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Tables that have to fit the width a laptop leaves them beside the sidebar
// (the 2026-10 reskin). The file seeds time and invoices for the fixture's
// administrator, so it is named to run after every spec that counts either.

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
const timeZone = process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE!
const origin = `http://127.0.0.1:${process.env.EZACTO_BROWSER_PORT ?? '4173'}`

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
})

const prefer = async (context: BrowserContext, name: string, value: string | null): Promise<void> => {
  await context.clearCookies({ name })
  if (value !== null) await context.addCookies([{ name, value, url: origin }])
}

const signIn = async (page: Page): Promise<void> => {
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

const api = async (page: Page, path: string, method: string, body: unknown): Promise<unknown> =>
  page.evaluate(
    async ({ path, method, body, key }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`)
      return text === '' ? null : JSON.parse(text)
    },
    { path, method, body, key: `width-fit-${Math.random().toString(36).slice(2)}` },
  )

/** A calendar date this many days from today, where the fixture keeps its books. */
const day = (offset: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(Date.now() + offset * 86_400_000))

/** Arial, which CI's Liberation Sans matches metric for metric, so a width means the same on both. */
const pinFont = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    for (const element of document.querySelectorAll<HTMLElement>(`${selector}, ${selector} *`))
      element.style.fontFamily = 'Arial, sans-serif'
  }, selector)

/** How far the week card, and the grid's own scroller inside it, run past their width. */
const weekOverflow = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.week-surface')!
    const grid = document.querySelector<HTMLElement>('.week-grid-wrap')!
    return { card: card.scrollWidth - card.clientWidth, grid: grid.scrollWidth - grid.clientWidth }
  })

/** The first row as a project whose name is longer than any column will give it. */
const longNames = async (page: Page): Promise<void> => {
  await expect(page.locator('.week-grid-table tbody th').first()).toBeVisible()
  await page.evaluate(() => {
    const label = document.querySelector<HTMLElement>('.week-grid-table tbody th')!
    label.querySelector('strong')!.textContent = 'Northwind Traders Quarterly Retainer Programme'
    label.querySelector('span')!.textContent = 'Discovery workshops and stakeholder interviews'
  })
  await pinFont(page, '.week-surface')
}

test('[e2e:width-fit] fits the week inside its card beside the sidebar at 1280, 1366 and 1440', async ({
  page,
  context,
}) => {
  await prefer(context, 'ezacto_nav', 'sidebar')
  await prefer(context, 'ezacto_sidebar', null)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await signIn(page)
  // Two rows, so the grid has names, hours and totals to lay out.
  for (const [project, hours] of [
    [1, 3],
    [2, 1.25],
  ] as const) {
    await api(page, '/api/v1/time-entries', 'POST', {
      project_id: project,
      task_id: project,
      spent_date: day(0),
      seconds: hours * 3600,
      notes: 'Laid out for the width check',
    })
  }
  await page.goto('/')
  await longNames(page)

  // The grid needed 1129px and scrolled inside its card below a 1468px window
  // beside the sidebar: the Total column sat under the card's edge at 1440.
  // Above the band it keeps its wide layout, and a long name still gives way.
  for (const width of [1280, 1366, 1440, 1600]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await weekOverflow(page), `sidebar at ${width}px`).toEqual({ card: 0, grid: 0 })
  }
  // A day still holds the widest value it takes.
  await page.setViewportSize({ width: 1280, height: 900 })
  const holds = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.week-grid-table .week-cell input')!
    const before = input.value
    input.value = '23:59'
    const fits = input.scrollWidth <= input.clientWidth
    input.value = before
    return fits
  })
  expect(holds).toBe(true)

  // The narrowed rail and the top bar still fit from the widths they did.
  await prefer(context, 'ezacto_sidebar', 'collapsed')
  await page.goto('/')
  await longNames(page)
  expect(await weekOverflow(page), 'rail at 1280px').toEqual({ card: 0, grid: 0 })
  await prefer(context, 'ezacto_sidebar', null)
  await prefer(context, 'ezacto_nav', 'topbar')
  await page.setViewportSize({ width: 1204, height: 900 })
  await page.goto('/')
  await longNames(page)
  expect(await weekOverflow(page), 'top bar at 1204px').toEqual({ card: 0, grid: 0 })
  await prefer(context, 'ezacto_nav', null)
})

test('[e2e:width-fit] keeps every invoice date whole beside the sidebar', async ({ page, context }) => {
  await prefer(context, 'ezacto_nav', 'sidebar')
  await prefer(context, 'ezacto_sidebar', null)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await signIn(page)
  const version = async (id: number): Promise<number> =>
    page.evaluate(async (id) => {
      const body = (await (await fetch(`/api/v1/invoices/${id}`)).json()) as {
        data: { version?: number; invoice?: { version: number } }
      }
      return body.data.invoice?.version ?? body.data.version!
    }, id)
  // One due in a month, and one sent and three weeks overdue, which leads its
  // cell with the date in bold and says how late it is after it.
  for (const invoice of [
    { subject: 'Width check, open', issue: day(-2), due: day(30), send: false },
    { subject: 'Width check, overdue', issue: day(-50), due: day(-21), send: true },
  ]) {
    const created = (await api(page, '/api/v1/invoice-generations', 'POST', {
      kind: 'free_form',
      client_id: 1,
    })) as { data: { id: number } }
    const id = created.data.id
    await api(page, `/api/v1/invoices/${id}/line-items`, 'POST', {
      expected_version: await version(id),
      position: 0,
      kind: 'Service',
      description: invoice.subject,
      quantity: 10,
      unit_price_cents: 15000,
    })
    await api(page, `/api/v1/invoices/${id}`, 'PATCH', {
      expected_version: await version(id),
      subject: invoice.subject,
      issue_date: invoice.issue,
      due_date: invoice.due,
      payment_terms: 'custom',
    })
    if (invoice.send) {
      await api(page, `/api/v1/invoices/${id}/transitions`, 'POST', {
        command: 'send',
        expected_version: await version(id),
      })
    }
  }
  await page.goto('/invoices')
  // Every filter that lists dates, and Past due on its own so an overdue row,
  // with its bold date and its suffix, is certainly on the page.
  for (const filter of ['All', 'Past due']) {
    await page.getByRole('button', { name: filter, exact: true }).click()
    await expect(page.getByRole('button', { name: filter, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('[data-invoice-list] tbody tr').first()).toBeVisible()
    if (filter === 'Past due') {
      await expect(page.locator('[data-invoice-list] .invoice-past-due').first()).toBeVisible()
    }
    await pinFont(page, '[data-invoice-list]')
    await checkDates(page)
  }
})

/** Every Issued and Due date in the list, whole, at 1280, 1366 and 1440. */
const checkDates = async (page: Page): Promise<void> => {
  for (const width of [1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const cut = await page.evaluate(() => {
      const faults: string[] = []
      for (const cell of document.querySelectorAll<HTMLElement>(
        "[data-invoice-list] td[data-column='issued'], [data-invoice-list] td[data-column='due-date']",
      )) {
        const text = cell.textContent ?? ''
        // "Sep 15, 2026", or "Sep 15, 2026 · 22 days past due": the date is
        // what has to show whole, and anything after it may give way to an
        // ellipsis, so it needs room for one.
        const date = text.split(' · ')[0]!
        const words = (cell.querySelector('.invoice-past-due') ?? cell).firstChild
        // A draft has no issue date yet, and nothing to cut.
        if (!(words instanceof Text) || date.trim() === '') continue
        const range = document.createRange()
        range.setStart(words, 0)
        range.setEnd(words, date.length)
        const style = getComputedStyle(cell)
        const room =
          cell.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
        const needed = range.getBoundingClientRect().width + (date.length < text.length ? 14 : 0)
        if (needed > room + 0.5) faults.push(`${cell.dataset.column} ${text}: ${Math.round(needed)} > ${room}`)
      }
      return faults
    })
    expect(cut, `${width}px`).toEqual([])
  }
}
