import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
const fixtureInstant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT
const fixtureTimeZone = process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE

if (
  fixtureEmail === undefined ||
  fixturePassword === undefined ||
  fixtureInstant === undefined ||
  fixtureTimeZone === undefined
) {
  throw new Error('browser fixture credentials are unavailable')
}

const controlBrowserFixture = (
  request: APIRequestContext,
  action: 'teammate-time-seed' | 'teammate-time-cleanup',
) =>
  request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })

test.afterEach(async ({ request }) => {
  const cleaned = await controlBrowserFixture(request, 'teammate-time-cleanup')
  expect(cleaned.status()).toBe(204)
})

/** The fixture's own day where the browser runs: the day the seed files the entry on. */
const fixtureDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: fixtureTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(fixtureInstant))

const teammateCell = (page: Page) =>
  page.locator(`[data-week-grid] input[data-cell-key="1:1:${fixtureDay}"]`)

const openTeammateWeek = async (page: Page): Promise<void> => {
  const picker = page.locator('[data-time-person]')
  await expect(picker).toBeVisible()
  await expect(picker).toBeEnabled()
  await picker.selectOption({ label: 'Rosa Fictional' })
  await expect(page.locator('[data-time-person-banner-text]')).toHaveText(
    "Editing Rosa Fictional's timesheet",
  )
}

/**
 * Issue 917, the case that filed it: an administrator removes a teammate's
 * entry, and it is gone from that teammate's week.
 *
 * The unit suites prove each half against stand-ins -- the picker asks for
 * the teammate's week, the report row asks before it deletes, the API lets an
 * administrator and nobody else through. This is where they meet the real
 * Worker and D1: the entry is seen in the teammate's week, deleted from its
 * Detailed time row through the in-page confirmation, and read back absent
 * from the same week. Cells are found by their date key rather than their
 * column, because other specs move the week's start day.
 */
test("[e2e:teammate-time] an administrator deletes a teammate's entry and it leaves their week", async ({
  page,
  request,
}) => {
  const seeded = await controlBrowserFixture(request, 'teammate-time-seed')
  expect(seeded.status()).toBe(204)

  await page.clock.setFixedTime(fixtureInstant)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // Her week first, so the absence at the end is a change and not a week that
  // never showed the entry.
  await openTeammateWeek(page)
  await expect(teammateCell(page)).toHaveValue(/^(?:1\.25|1:15)$/u)

  // The correction, from the row of Detailed time that shows her hour.
  await page.goto(
    '/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&user_id=9101&grain=entry',
  )
  await expect(page.locator('[data-report-status]')).toHaveText('Report loaded.')
  const remove = page.locator('button[data-report-entry-delete="91011"]')
  await expect(remove).toBeVisible()
  await remove.click()
  const dialog = page.locator('[data-report-entry-delete-dialog]')
  await expect(dialog).toBeVisible()
  await expect(page.locator('[data-report-entry-delete-body]')).toContainText(
    "Rosa Fictional's 1.25 hours",
  )
  await page.locator('[data-report-entry-delete-submit]').click()
  await expect(dialog).toBeHidden()
  await expect(remove).toHaveCount(0)
  await expect(page.locator('[data-report-results]')).toContainText(
    'No time was tracked under these filters.',
  )

  // And her week no longer holds it.
  await page.goto('/')
  await openTeammateWeek(page)
  await expect(page.locator('[data-week-grid-rows]')).toContainText(
    'No rows yet. Add a project/task row or copy last week.',
  )
  await expect(teammateCell(page)).toHaveCount(0)
})
