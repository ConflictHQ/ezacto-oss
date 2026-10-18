import { readFile } from 'node:fs/promises'
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
 * The detailed time report, downloaded the way somebody sends it to a client
 * at the end of the month: one client, the month, every entry, Export, PDF.
 *
 * The unit suite proves each half -- the menu asks for the request the table
 * was drawn from, the server renders the file -- against stand-ins for the
 * other. This is the one place both halves meet a browser that actually saves
 * a file: the fetch, the blob, the anchor and the name it is saved under.
 */
test('[e2e:report-export] downloads the detailed time report as the PDF a client is sent', async ({
  page,
}) => {
  await page.clock.setFixedTime(fixtureInstant)
  await page.setViewportSize({ width: 1440, height: 900 })
  // No network on the acceptance run, so the webfont would fail slowly and
  // silently rather than not at all.
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto(
    '/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&client_id=1&grain=entry&hours=all',
  )
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // The report first: the file is a second request for this table, so a page
  // that never drew it would be exporting nothing in particular. Its total is
  // read off the screen rather than written down here, because the specs
  // before this one share the fixture's database and add and claim entries.
  await expect(page.locator('[data-report-status]')).toHaveText('Report loaded.')
  const footer = await page.locator('.report-detailed-table tfoot').innerText()
  // The first figure: a Rounded hours column, where one is drawn, follows it.
  const total = /(\d+\.\d{2})/u.exec(footer)?.[1]
  expect(total, `no total in the table footer: ${footer}`).toBeDefined()
  const toggle = page.locator('[data-detailed-export-toggle]')
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(page.locator('[data-detailed-export-notes="client"]')).toBeChecked()

  const name = 'detailed-time-2026-08-01-to-2026-08-31-browser-acceptance-client.pdf'
  const served = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/reports/detailed-time/export',
  )
  const saved = page.waitForEvent('download')
  await page.locator('[data-detailed-export-format="pdf"]').click()

  const response = await served
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/pdf')
  expect(response.headers()['content-disposition']).toBe(`attachment; filename="${name}"`)
  expect(response.headers()['cache-control']).toBe('no-store')
  // The request is the table's: its client, its period, every entry, and the
  // client's notes unless somebody asked for the internal ones.
  const asked = new URL(response.url()).searchParams
  expect(Object.fromEntries(asked)).toMatchObject({
    from: '2026-08-01',
    to: '2026-08-31',
    client_id: '1',
    grain: 'entry',
    format: 'pdf',
    audience: 'client',
  })

  const download = await saved
  expect(download.suggestedFilename()).toBe(name)
  const path = await download.path()
  const bytes = await readFile(path)
  const text = bytes.toString('latin1')
  expect(text.startsWith('%PDF-')).toBe(true)
  // Headed by the client, its person banded, adding up to the table's total.
  expect(text).toContain('(Detailed time report) Tj')
  expect(text).toContain('(Browser Acceptance Client) Tj')
  expect(text).toContain('(Browser Owner) Tj')
  expect(text).toContain(`(${total!} Hours) Tj`)
  await expect(page.locator('[data-report-status]')).toHaveText(`Downloaded ${name}.`)
})
