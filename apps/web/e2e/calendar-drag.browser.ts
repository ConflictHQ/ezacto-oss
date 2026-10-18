import { expect, test, type Locator, type Page } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('Browser fixture credentials are required')
}

test.use({ viewport: { width: 1280, height: 900 } })

const HOUR = 48

/** Where an hour of today's column is on screen, wherever the page is scrolled. */
const yAt = async (column: Locator, minutes: number): Promise<number> => {
  const box = await column.boundingBox()
  if (box === null) throw new Error('the calendar column is not drawn')
  return box.y + (minutes / 60) * HOUR
}

const drag = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

// The fixture's organization tracks duration: the case where what the calendar
// creates carries a clock for the first time. The entry is removed through the
// editor at the end, so the rest of the suite sees the books it expects.
test('[e2e:calendar] drag creates, moves and resizes a timed entry in a duration organization', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/?view=calendar')
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.locator('[data-sign-in-form]').getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const column = page.locator('.cal-col[data-today="true"]')
  await expect(column).toBeVisible()
  await page.locator('[data-calendar-scroll]').evaluate((node, top) => {
    node.scrollTop = top
  }, 8 * HOUR - 8)
  const box = (await column.boundingBox())!
  const x = box.x + box.width / 2

  // Drag across the clock from 10:00 to 11:00: a draft, then the editor with
  // the times set and focus in Notes.
  await drag(page, { x, y: await yAt(column, 10 * 60 + 3) }, { x, y: await yAt(column, 11 * 60) })
  const dialog = page.locator('[data-entry-dialog]')
  await expect(dialog).toBeVisible()
  await expect(page.locator('[data-calendar-draft]')).toBeVisible()
  await expect(dialog.locator('[data-entry-start]')).toHaveValue('10:00 AM')
  await expect(dialog.locator('[data-entry-end]')).toHaveValue('11:00 AM')
  await expect(dialog.locator('[data-entry-note-input]')).toBeFocused()

  // Esc discards the draft; nothing was created.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-calendar-draft]')).toHaveCount(0)
  await expect(page.locator('[data-calendar-block]')).toHaveCount(0)

  // The same drag again, saved with Enter in Notes.
  await drag(page, { x, y: await yAt(column, 10 * 60 + 3) }, { x, y: await yAt(column, 11 * 60) })
  await page.locator('[data-entry-note-input]').fill('Calendar drag')
  await page.keyboard.press('Enter')
  const block = page.locator('[data-calendar-block]')
  await expect(block).toHaveCount(1)
  await expect(block).toContainText('10:00 AM')
  await expect(block).toContainText('11:00 AM')

  // Dragging from clear space into an occupied slot makes an overlap; nothing
  // is refused or shifted.
  await drag(page, { x, y: await yAt(column, 9 * 60) }, { x, y: await yAt(column, 10 * 60 + 30) })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-entry-start]')).toHaveValue('9:00 AM')
  await expect(dialog.locator('[data-entry-end]')).toHaveValue('10:30 AM')
  await page.keyboard.press('Escape')
  await expect(block).toHaveCount(1)

  // Keyboard: ArrowDown moves it a quarter hour, Enter saves.
  await block.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(block).toContainText('10:15 AM')
  await expect(block).toContainText('11:15 AM')

  // Drag the bottom edge down half an hour; the end snaps to a quarter.
  const edge = block.locator('[data-calendar-handle="end"]')
  const edgeBox = (await edge.boundingBox())!
  await drag(
    page,
    { x: edgeBox.x + edgeBox.width / 2, y: edgeBox.y + edgeBox.height / 2 },
    { x: edgeBox.x + edgeBox.width / 2, y: edgeBox.y + edgeBox.height / 2 + HOUR / 2 + 3 },
  )
  await expect(block).toContainText('11:45 AM')

  // Clean up through the editor.
  await block.click()
  await dialog.getByRole('button', { name: 'Delete entry' }).click()
  await expect(page.locator('[data-calendar-block]')).toHaveCount(0)
})

test('[e2e:calendar] the Week and Day layout is a per-person cookie the server renders', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/?view=calendar')
  const reset = await page.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(reset.status()).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.locator('[data-sign-in-form]').getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.locator('.cal[data-layout="week"]')).toBeVisible()
  await page.locator('[data-calendar-layout-choice="day"]').click()
  await expect(page.locator('.cal[data-layout="day"]')).toBeVisible()
  await expect(page.locator('.cal-dayhead-number')).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-ez-time-layout', 'day')
  await expect(page.locator('.cal[data-layout="day"]')).toBeVisible()
  await page.locator('[data-calendar-layout-choice="week"]').click()
  await expect(page.locator('.cal[data-layout="week"]')).toBeVisible()
})
