import { expect, test, type Page } from '@playwright/test'
import { addCalendarDays } from '../src/capacity/model.js'

const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async input => {
  const response = await fetch(input.path, { method: input.method, ...(input.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body) }) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}, { method, path, body })
const control = (page: Page, action: string) => page.request.post('/__ezacto_browser_fixture__/start-end', { data: { action }, headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' } })
const setup = async (page: Page) => {
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await control(page, 'sign-in-rate-reset'); await page.goto('/capacity')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-capacity-status]')).toHaveText('')
  const context = (await api(page, 'GET', '/api/v1/resource-calendar/context')).body.data
  const project = await api(page, 'POST', '/api/v1/projects', { client_id: 1, name: `Gesture owned ${crypto.randomUUID()}`, bill_by: 'people', billing_method: 'time_materials' })
  expect(project.status).toBe(201)
  const from = context.current_week_start as string
  const created = await api(page, 'POST', '/api/v1/allocations', { user_id: 1, project_id: project.body.data.id, start_date: addCalendarDays(from, 1), end_date: addCalendarDays(from, 2), planned_seconds_per_week: 4442 })
  expect(created.status).toBe(201)
  await page.getByRole('button', { name: 'This week', exact: true }).click()
  await expect(page.locator('[data-capacity-status]')).toHaveText('')
  await page.locator('.resource-calendar-controls').getByRole('combobox', { name: 'Display', exact: true }).selectOption('timeline')
  const item = page.locator('.resource-calendar-allocation').filter({ hasText: project.body.data.name })
  await expect(item).toBeVisible()
  const fingerprint = async () => { const response = await control(page, 'planning-business-fingerprint'); expect(response.status()).toBe(200); return response.json() }
  const baseline = await fingerprint()
  let writes = 0
  const commands: string[] = []
  page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/allocations/${created.body.data.id}`) { writes++; commands.push(request.headers()['idempotency-key'] ?? '') } })
  const cleanup = async () => {
    const row = await api(page, 'GET', `/api/v1/allocations/${created.body.data.id}`)
    if (row.status === 200) expect((await api(page, 'DELETE', `/api/v1/allocations/${created.body.data.id}`, { version: row.body.data.version })).status).toBe(200)
    expect((await api(page, 'DELETE', `/api/v1/projects/${project.body.data.id}`)).status).toBe(204)
  }
  return { item, from, id: created.body.data.id as number, created: created.body.data, cleanup, fingerprint, baseline, writes: () => writes, commands }
}

test('[#1193] keyboard date review saves exact weekly seconds and cancels without a command on a phone', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  const f = await setup(page)
  let cleanupFailure: unknown
  try {
    const move = f.item.getByRole('button', { name: 'Move dates', exact: true })
    await move.focus(); await move.press('Enter')
    const form = page.getByRole('form', { name: 'Review allocation dates', exact: true })
    await expect(form.getByLabel('New start date')).toBeFocused()
    await form.getByLabel('New start date').fill(addCalendarDays(f.from, 8)); await form.getByLabel('New end date').fill(addCalendarDays(f.from, 9))
    await form.getByRole('button', { name: 'Preview dates', exact: true }).click()
    await expect(form).toContainText('All affected weeks reviewed')
    await expect(form).toContainText('4442 seconds'); expect(f.writes()).toBe(0)
    await form.getByLabel('New end date').press('Escape'); await expect(form).toHaveCount(0); await expect(move).toBeFocused(); expect(f.writes()).toBe(0)
    await move.press('Enter'); await expect(form.getByLabel('New start date')).toBeFocused()
    await form.getByLabel('New start date').fill(addCalendarDays(f.from, 8)); await form.getByLabel('New end date').fill(addCalendarDays(f.from, 9)); await form.getByRole('button', { name: 'Preview dates', exact: true }).click()
    await expect(form.getByRole('button', { name: 'Save date change', exact: true })).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('allocation-phone-preview.png'), fullPage: true })
    await form.getByRole('button', { name: 'Save date change', exact: true }).focus(); await form.getByRole('button', { name: 'Save date change', exact: true }).press('Enter')
    await expect(page.locator('[data-capacity-status]')).toHaveText('Allocation dates saved.')
    expect(f.writes()).toBe(1); expect(f.commands[0]).toMatch(/^[a-f0-9-]{36}$/)
    expect((await api(page, 'GET', `/api/v1/allocations/${f.id}`)).body.data).toMatchObject({ start_date: addCalendarDays(f.from, 8), end_date: addCalendarDays(f.from, 9), planned_seconds_per_week: 4442, version: 1 })
    for (const button of await f.item.locator('.allocation-date-actions button').all()) { const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44) }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await f.fingerprint()).toEqual(f.baseline)
    await page.screenshot({ path: info.outputPath('allocation-phone-keyboard.png'), fullPage: true })
  } finally { try { await f.cleanup() } catch (error) { cleanupFailure = error } }
  if (cleanupFailure !== undefined) throw cleanupFailure
})

test('[#1193] native pointer move and resize review, Escape and conflict preserve server state and unsaved forms', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const f = await setup(page)
  let cleanupFailure: unknown
  try {
    const drag = async (action: 'move' | 'start' | 'end', days: number, escape = false) => {
      const before = f.writes()
      const button = f.item.locator(`[data-allocation-gesture="${action}"]`); await button.scrollIntoViewIfNeeded()
      const box = (await button.boundingBox())!, track = (await f.item.locator('.resource-calendar-track').boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + track.width / 56 * days, box.y + box.height / 2, { steps: 5 })
      expect(f.writes()).toBe(before)
      if (escape) await page.keyboard.press('Escape')
      await page.mouse.up()
    }
    await drag('move', 7, true); await expect(page.locator('[data-allocation-date-review]')).toHaveCount(0); expect(f.writes()).toBe(0)
    await drag('move', 7)
    const form = page.getByRole('form', { name: 'Review allocation dates', exact: true })
    await expect(form.getByLabel('New start date')).toHaveValue(addCalendarDays(f.from, 8)); await expect(form.getByLabel('New end date')).toHaveValue(addCalendarDays(f.from, 9))
    await expect(form.getByRole('button', { name: 'Preview dates', exact: true })).toBeEnabled(); await form.getByRole('button', { name: 'Preview dates', exact: true }).click(); await expect(form.getByRole('button', { name: 'Save date change', exact: true })).toBeEnabled(); await form.getByRole('button', { name: 'Save date change', exact: true }).click()
    await expect(page.locator('[data-capacity-status]')).toHaveText('Allocation dates saved.'); expect(f.writes()).toBe(1)
    await drag('end', 2); await expect(form.getByLabel('New end date')).toHaveValue(addCalendarDays(f.from, 11)); await expect(form.getByLabel('New start date')).toHaveValue(addCalendarDays(f.from, 8))
    await expect(form.getByRole('button', { name: 'Preview dates', exact: true })).toBeEnabled(); await form.getByRole('button', { name: 'Preview dates', exact: true }).click(); await expect(form.getByRole('button', { name: 'Save date change', exact: true })).toBeEnabled()
    // An independent real command races the reviewed expected revision.
    expect((await api(page, 'PATCH', `/api/v1/allocations/${f.id}`, { version: 1, end_date: addCalendarDays(f.from, 12) })).status).toBe(200)
    const draft = page.locator('[data-planning-allocation-form] [name="hours"]'); await draft.fill('9.123')
    await form.getByRole('button', { name: 'Save date change', exact: true }).click(); await expect(form).toContainText('Your dates are kept')
    await expect(form.getByLabel('New end date')).toHaveValue(addCalendarDays(f.from, 11)); await expect(draft).toHaveValue('9.123')
    expect((await api(page, 'GET', `/api/v1/allocations/${f.id}`)).body.data).toMatchObject({ end_date: addCalendarDays(f.from, 12), planned_seconds_per_week: 4442, version: 2 })
    expect(await f.fingerprint()).toEqual(f.baseline)
  } finally { try { await f.cleanup() } catch (error) { cleanupFailure = error } }
  if (cleanupFailure !== undefined) throw cleanupFailure
})

test.describe('allocation touch form', () => {
  test.use({ hasTouch: true })
  test('[#1193] touch save and cancel keep exact hours; sign-out removes an unsaved review', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const f = await setup(page)
    let signedOut = false, cleanupFailure: unknown
    try {
      const move = f.item.getByRole('button', { name: 'Move dates', exact: true })
      await move.tap()
      const form = page.getByRole('form', { name: 'Review allocation dates', exact: true })
      await expect(form.getByRole('button', { name: 'Preview dates', exact: true })).toBeEnabled()
      await form.getByLabel('New end date').fill(addCalendarDays(f.from, 3)); await form.getByRole('button', { name: 'Preview dates', exact: true }).tap()
      await expect(form.getByRole('button', { name: 'Save date change', exact: true })).toBeEnabled(); await form.getByRole('button', { name: 'Save date change', exact: true }).tap()
      await expect(page.locator('[data-capacity-status]')).toHaveText('Allocation dates saved.'); expect(f.writes()).toBe(1)
      await move.tap(); await expect(form).toBeVisible(); await form.getByRole('button', { name: 'Cancel date change', exact: true }).tap(); await expect(form).toHaveCount(0); expect(f.writes()).toBe(1)
      await move.tap(); await expect(form.getByRole('button', { name: 'Preview dates', exact: true })).toBeEnabled(); await form.getByLabel('New end date').fill(addCalendarDays(f.from, 4)); await form.getByRole('button', { name: 'Preview dates', exact: true }).tap()
      await expect(form.getByRole('button', { name: 'Save date change', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'Sign out', exact: true }).tap(); signedOut = true
      await expect(page.locator('[data-sign-in-form]')).toBeVisible(); await expect(form).toHaveCount(0); expect(f.writes()).toBe(1)
      expect(await f.fingerprint()).toEqual(f.baseline)
    } finally {
      try {
        if (signedOut) {
          await control(page, 'sign-in-rate-reset')
          await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
          await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
          await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.locator('[data-sign-in-form]')).toBeHidden()
        }
        await f.cleanup()
      } catch (error) { cleanupFailure = error }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure
  })
})
