import { expect, test, type Page } from '@playwright/test'
import { addCalendarDays, shortDate } from '../src/capacity/model.js'

const request = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async args => {
  const response = await fetch(args.path, { method: args.method, credentials: 'same-origin', ...(args.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(args.body) }) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}, { method, path, body })

test('[e2e #1192] phone calendar uses organization weeks, scoped project/person filters and true allocation dates', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.goto('/capacity')
  await page.request.post('/__ezacto_browser_fixture__/start-end', { data: { action: 'sign-in-rate-reset' }, headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' } })
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/resource-calendar' && response.status() === 200)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const initial = (await (await loaded).json()).data
  await expect(page.locator('[data-capacity-status]')).toHaveText('')
  const from = initial.context.current_week_start as string
  expect(initial.week_starts[0]).toBe(from)
  const controls = page.locator('.resource-calendar-controls')
  const name = `Calendar date fixture ${crypto.randomUUID()}`
  let projectId: number | undefined, allocationId: number | undefined
  let mainError: unknown
  try {
    const project = await request(page, 'POST', '/api/v1/projects', { client_id: 1, name, billing_method: 'time_materials', bill_by: 'people' })
    expect(project.status).toBe(201); projectId = project.body.data.id
    const start = addCalendarDays(from, 1), end = addCalendarDays(from, 2)
    const allocation = await request(page, 'POST', '/api/v1/allocations', { user_id: 1, project_id: projectId, start_date: start, end_date: end, planned_seconds_per_week: 4442 })
    expect(allocation.status).toBe(201); allocationId = allocation.body.data.id
    await test.step('Refresh the native calendar after creating the dated allocation', async () => {
      await page.getByRole('button', { name: 'This week', exact: true }).click()
      await expect(page.locator('[data-capacity-status]')).toHaveText('')
    })
    const actual = await test.step('Read the exact scoped project calendar', async () => {
      await controls.getByLabel('Scope', { exact: true }).selectOption('project')
      await expect(controls.getByLabel('Project', { exact: true }).locator(`option[value="${projectId}"]`)).toHaveCount(1)
      const projectRead = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/resource-calendar' && url.searchParams.get('project_id') === String(projectId) && response.status() === 200 })
      await controls.getByLabel('Project', { exact: true }).selectOption(String(projectId))
      return (await (await projectRead).json()).data
    })
    expect(actual.people.find((person: { person_id: number }) => person.person_id === 1).weeks[0]).toMatchObject({ planned_seconds: 4442, tracked_seconds: 0 })
    await expect(page.locator('[data-capacity-status]')).toHaveText('')
    await test.step('Read the selected authorized person', async () => {
      const personRead = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/resource-calendar' && url.searchParams.get('person_id') === '1' && response.status() === 200 })
      await controls.getByLabel('Person', { exact: true }).selectOption('1')
      await personRead
    })
    await controls.getByLabel('Display', { exact: true }).focus()
    await controls.getByLabel('Display', { exact: true }).press('ArrowDown')
    await expect(controls.getByLabel('Display', { exact: true })).toHaveValue('timeline')
    const timeline = page.locator('.resource-calendar-timeline')
    await expect(timeline).toBeVisible()
    await expect(timeline).toContainText(name)
    await expect(timeline).toContainText(`${shortDate(start)} to ${shortDate(end)}`)
    await expect(timeline.locator('.resource-calendar-track > span')).toHaveCount(1)
    for (const control of await page.locator('.resource-calendar-controls select:visible, [data-capacity-page] .team-period button:visible').all()) {
      const box = await control.boundingBox(); expect(box).not.toBeNull(); expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('resource-calendar-phone-timeline.png'), fullPage: true })
  } catch (error) {
    mainError = error
    throw error
  } finally {
    try {
      if (allocationId !== undefined) {
        const row = await request(page, 'GET', `/api/v1/allocations/${allocationId}`)
        if (row.status === 200) await request(page, 'DELETE', `/api/v1/allocations/${allocationId}`, { version: row.body.data.version })
      }
      if (projectId !== undefined) await request(page, 'DELETE', `/api/v1/projects/${projectId}`)
    } catch (cleanupError) {
      // Preserve the original failed step; successful tests still require cleanup.
      if (mainError === undefined) throw cleanupError
    }
  }
})
