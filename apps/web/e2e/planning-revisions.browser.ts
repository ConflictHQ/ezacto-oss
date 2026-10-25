import { expect, test, type Page } from '@playwright/test'

// Browser fetch uses the same secure loopback session transport as the application.
const nativeRequest = async (page: Page, method: string, path: string, options?: { headers?: Record<string, string>; data?: unknown }) => {
  const result = await page.evaluate(async ({ method, path, data }) => {
    const response = await fetch(path, {
      method, credentials: 'same-origin',
      ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
    })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }, { method, path, data: options?.data })
  return { status: () => result.status, json: async () => result.body }
}

for (const kind of ['allocation', 'time-off'] as const) {
  test(`[e2e #1190] two editors preserve a stale ${kind} draft and review the saved revision`, async ({ page, context }) => {
    await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
    await page.route('https://fonts.googleapis.com/**', route => route.abort())
    await page.goto('/capacity')
    await page.request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action: 'sign-in-rate-reset' }, headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    })
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
    await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
    const firstCapacity = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/capacity' && response.status() === 200)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const baseline = await (await firstCapacity).json() as { data: { weeks: string[]; people: { user_id: number; weeks: { tracked_seconds: number; planned_seconds: number; time_off_seconds: number }[] }[] } }
    const from = baseline.data.weeks[0]!
    const to = new Date(Date.parse(from + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10)
    const endpoint = kind === 'allocation' ? '/api/v1/allocations' : '/api/v1/time-off'
    const origin = new URL(page.url()).origin
    const headers = { origin }
    let projectId: number | undefined
    let rowId: number | undefined
    let second: Awaited<ReturnType<typeof context.newPage>> | undefined
    try {
      if (kind === 'allocation') {
        const response = await nativeRequest(page, 'POST', '/api/v1/projects', { headers, data: {
          client_id: 1, name: 'Planning revision fixture ' + crypto.randomUUID(), billing_method: 'time_materials', bill_by: 'people',
        } })
        expect(response.status()).toBe(201)
        projectId = (await response.json()).data.id
      }
      const created = await nativeRequest(page, 'POST', endpoint, { headers, data: {
        user_id: 1, start_date: from, end_date: to,
        ...(kind === 'allocation' ? { project_id: projectId, planned_seconds_per_week: 2 * 3600 } : { kind: 'vacation', seconds_per_day: 2 * 3600 }),
      } })
      expect(created.status()).toBe(201)
      const initial = (await created.json()).data as { id: number; version: number }
      rowId = initial.id
      expect(initial.version).toBe(0)
      await page.reload()
      second = await context.newPage()
      await second.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!)
      await second.route('https://fonts.googleapis.com/**', route => route.abort())
      await second.goto('/capacity')
      const table = kind === 'allocation' ? '[data-planning-allocations]' : '[data-planning-timeoff]'
      const form = kind === 'allocation' ? '[data-planning-allocation-form]' : '[data-planning-timeoff-form]'
      const status = kind === 'allocation' ? '[data-planning-allocation-status]' : '[data-planning-timeoff-status]'
      const label = kind === 'allocation' ? 'Save allocation' : 'Save time off'
      for (const editor of [page, second]) {
        const row = editor.locator(`${table} tbody tr[data-row-key="${rowId}"]`)
        await expect(row).toBeVisible()
        await row.getByRole('button', { name: /^Edit / }).click()
      }
      await page.locator(form + ' input[name="hours"]').fill('8')
      await second.locator(form + ' input[name="hours"]').fill('3.75')
      const firstWrite = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${rowId}` && response.request().method() === 'PATCH')
      await page.locator(form).getByRole('button', { name: label, exact: true }).click()
      const firstResult = await firstWrite
      expect(firstResult.status()).toBe(200)
      expect((await firstResult.json()).data.version).toBe(1)
      const staleWrite = second.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${rowId}` && response.request().method() === 'PATCH')
      const refreshedCapacity = second.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/capacity' && response.status() === 200)
      await second.locator(form).getByRole('button', { name: label, exact: true }).click()
      expect((await staleWrite).status()).toBe(409)
      await expect(second.locator(status)).toContainText('Your edits are kept')
      await expect(second.locator(form + ' input[name="hours"]')).toHaveValue('3.75')
      const refreshed = await (await refreshedCapacity).json()
      const metric = kind === 'allocation' ? 'planned_seconds' : 'time_off_seconds'
      expect(refreshed.data.people.find((person: { user_id: number }) => person.user_id === 1).weeks[0][metric])
        .toBeGreaterThan(baseline.data.people.find(person => person.user_id === 1)!.weeks[0]![metric])
      const saved = await (await nativeRequest(second, 'GET', `${endpoint}/${rowId}`)).json()
      expect(saved.data.version).toBe(1)
      expect(kind === 'allocation' ? saved.data.planned_seconds_per_week : saved.data.seconds_per_day).toBe(8 * 3600)
      await second.getByRole('button', { name: 'Reload saved values (replaces these edits)', exact: true }).click()
      await expect(second.locator(form + ' input[name="hours"]')).toHaveValue('8')
      await second.locator(form + ' input[name="hours"]').fill('5')
      const reviewedWrite = second.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${rowId}` && response.request().method() === 'PATCH')
      await second.locator(form).getByRole('button', { name: label, exact: true }).click()
      const reviewedResult = await reviewedWrite
      expect(reviewedResult.status()).toBe(200)
      expect((await reviewedResult.json()).data.version).toBe(2)
      const currentCapacity = await (await nativeRequest(second, 'GET', `/api/v1/capacity?from=${from}&to=${to}`)).json()
      expect(currentCapacity.data.people.find((person: { user_id: number }) => person.user_id === 1).weeks[0].tracked_seconds)
        .toBe(baseline.data.people.find(person => person.user_id === 1)!.weeks[0]!.tracked_seconds)
    } finally {
      if (rowId !== undefined) {
        const current = await nativeRequest(page, 'GET', `${endpoint}/${rowId}`)
        if (current.status() === 200) await nativeRequest(page, 'DELETE', `${endpoint}/${rowId}`, { headers, data: { version: (await current.json()).data.version } })
      }
      if (projectId !== undefined) await nativeRequest(page, 'DELETE', `/api/v1/projects/${projectId}`, { headers })
      await second?.close()
    }
  })
}
