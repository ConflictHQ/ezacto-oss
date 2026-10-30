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
  let projectId: number | undefined, allocationId: number | undefined, definitionId: number | undefined
  const demandIds: number[] = []
  let demandReads = 0
  const demandScopes: (string | null)[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/v1/placeholder-allocations') { demandReads++; demandScopes.push(url.searchParams.get('project_id')) }
  })
  let cleanupFailure: unknown
  try {
    const project = await request(page, 'POST', '/api/v1/projects', { client_id: 1, name, billing_method: 'time_materials', bill_by: 'people' })
    expect(project.status).toBe(201); projectId = project.body.data.id
    const start = addCalendarDays(from, 1), end = addCalendarDays(from, 2)
    const allocation = await request(page, 'POST', '/api/v1/allocations', { user_id: 1, project_id: projectId, start_date: start, end_date: end, planned_seconds_per_week: 4442 })
    expect(allocation.status).toBe(201); allocationId = allocation.body.data.id
    const definition = await request(page, 'POST', '/api/v1/planning-placeholders', { name: `Calendar shared role ${crypto.randomUUID()}` })
    expect(definition.status).toBe(201); definitionId = definition.body.data.id
    for (const target of [projectId, 1]) {
      const demand = await request(page, 'POST', '/api/v1/placeholder-allocations', { placeholder_id: definitionId, project_id: target, start_date: start, end_date: end, planned_seconds_per_week: 3600 })
      expect(demand.status).toBe(201); demandIds.push(demand.body.data.id)
    }
    await test.step('Refresh the native calendar after creating the dated allocation', async () => {
      await page.getByRole('button', { name: 'This week', exact: true }).click()
      await expect(page.locator('[data-capacity-status]')).toHaveText('')
    })
    const actual = await test.step('Read the exact scoped project calendar', async () => {
      await controls.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('project')
      await expect(controls.getByRole('combobox', { name: 'Project', exact: true }).locator(`option[value="${projectId}"]`)).toHaveCount(1)
      const projectRead = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/resource-calendar' && url.searchParams.get('project_id') === String(projectId) && response.status() === 200 })
      await controls.getByRole('combobox', { name: 'Project', exact: true }).selectOption(String(projectId))
      return (await (await projectRead).json()).data
    })
    expect(actual.people.find((person: { person_id: number }) => person.person_id === 1).weeks[0]).toMatchObject({ planned_seconds: 4442, tracked_seconds: 0 })
    expect(actual.unassigned).toHaveLength(1)
    expect(actual.unassigned[0].project_id).toBe(projectId)
    await expect(page.locator('[data-capacity-status]')).toHaveText('')
    await expect(page.locator('[data-planning-allocation-form] [name="project_id"]')).toHaveValue(String(projectId))
    const unassigned = page.locator('[data-capacity-placeholders]')
    await expect(unassigned.locator(`[data-placeholder-rows] tbody tr[data-row-key="${demandIds[0]}"]`)).toHaveCount(1)
    await expect(unassigned.locator(`[data-placeholder-rows] tbody tr[data-row-key="${demandIds[1]}"]`)).toHaveCount(0)
    await expect(unassigned.locator('[data-placeholder-rows] tbody tr')).toHaveCount(1)
    expect(demandScopes.at(-1)).toBe(String(projectId))
    const readsBeforePerson = demandReads
    await test.step('Read the selected authorized person', async () => {
      const personRead = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/resource-calendar' && url.searchParams.get('person_id') === '1' && response.status() === 200 })
      await controls.getByRole('combobox', { name: 'Person', exact: true }).selectOption('1')
      expect((await (await personRead).json()).data.unassigned).toEqual([])
    })
    await expect(page.locator('[data-capacity-status]')).toHaveText('')
    await expect(unassigned).toBeHidden()
    expect(demandReads).toBe(readsBeforePerson)
    await expect(page.locator('[data-planning-allocation-form] [name="project_id"]')).toHaveValue(String(projectId))
    await controls.getByRole('combobox', { name: 'Display', exact: true }).focus()
    await controls.getByRole('combobox', { name: 'Display', exact: true }).press('t')
    await controls.getByRole('combobox', { name: 'Display', exact: true }).press('Tab')
    await expect(controls.getByRole('combobox', { name: 'Display', exact: true })).toHaveValue('timeline')
    await expect(controls.getByRole('combobox', { name: 'Display', exact: true })).not.toBeFocused()
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
  } finally {
    try {
      for (const id of demandIds) await request(page, 'DELETE', `/api/v1/placeholder-allocations/${id}`, { version: 0 })
      if (definitionId !== undefined) await request(page, 'DELETE', `/api/v1/planning-placeholders/${definitionId}`, { version: 0 })
      if (allocationId !== undefined) {
        const row = await request(page, 'GET', `/api/v1/allocations/${allocationId}`)
        if (row.status === 200) await request(page, 'DELETE', `/api/v1/allocations/${allocationId}`, { version: row.body.data.version })
      }
      if (projectId !== undefined) await request(page, 'DELETE', `/api/v1/projects/${projectId}`)
    } catch (cleanupError) {
      // Preserve the original failed step; successful tests still require cleanup.
      cleanupFailure = cleanupError
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
})
