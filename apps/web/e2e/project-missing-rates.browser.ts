import { expect, test } from '@playwright/test'

test('[e2e #1166] repairs old unpriced time only after an explicit preview and confirmation', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-sign-in-form]')).not.toBeVisible()
  const fixture = await page.evaluate(async () => {
    const write = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch('/api/v1' + path, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(path + ': ' + JSON.stringify(json))
      return json.data
    }
    const client = await write('/clients', { name: 'Missing-rate acceptance', currency: 'USD' })
    const project = await write('/projects', {
      name: 'Missing-rate acceptance',
      client_id: client.id,
      billing_method: 'time_materials',
      bill_by: 'project',
    })
    // Project creation staffs its creator. Reuse that assignment.
    await write('/task-assignments', { project_id: project.id, task_id: 1, billable: true })
    const entry = await write('/time-entries', {
      project_id: project.id,
      task_id: 1,
      spent_date: '2026-08-30',
      seconds: 3600,
      notes: 'Unpriced acceptance time',
    })
    if (entry.billable_rate_cents !== null) throw new Error('fixture must start unpriced')
    const refused = await fetch('/api/v1/invoice-generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        client_id: client.id,
        from: '2026-08-30',
        to: '2026-08-30',
        project_ids: [project.id],
        time_summary_type: 'project',
        expense_summary_type: null,
      }),
    })
    const problem = await refused.json()
    if (
      refused.status !== 422 ||
      problem.error.fields[0]?.code !== 'missing_billable_rate' ||
      problem.error.fields[0]?.field !== `project_ids.${project.id}` ||
      !problem.error.fields[0]?.message.includes('bills by project but has no hourly rate')
    ) {
      throw new Error('missing-rate failure must name the project and explain its rate source')
    }
    await write('/projects/' + project.id, { hourly_rate_cents: 1000 }, 'PATCH')
    return { projectId: project.id, entryId: entry.id, cost: entry.cost_rate_cents }
  })
  await page.goto(`/projects/${fixture.projectId}`)
  const button = page.locator('[data-project-missing-rates]')
  await expect(button).toHaveText('Preview missing rates')
  const snapshot = () =>
    page.evaluate(
      async (id) => (await (await fetch('/api/v1/time-entries/' + id)).json()).data,
      fixture.entryId,
    )
  expect((await snapshot()).billable_rate_cents).toBeNull()
  await button.click()
  await expect(button).toHaveText('Confirm repair of 1 entry')
  await expect(page.locator('[data-project-facts]')).toContainText('$10.00/hour')
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await snapshot()).billable_rate_cents).toBeNull()
  await page
    .locator('[data-project-facts]')
    .screenshot({ path: '/tmp/ezacto-1166-rate-preview.png' })
  await button.click()
  await expect(page.locator('[data-project-facts]')).toContainText('1 entry repaired')
  expect(await snapshot()).toMatchObject({
    billable_rate_cents: 1000,
    cost_rate_cents: fixture.cost,
    invoice_id: null,
  })
  const draft = await page.evaluate(async (projectId) => {
    const project = (await (await fetch('/api/v1/projects/' + projectId)).json()).data
    const response = await fetch('/api/v1/invoice-generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        client_id: project.client_id,
        from: '2026-08-30',
        to: '2026-08-30',
        project_ids: [projectId],
        time_summary_type: 'project',
        expense_summary_type: null,
      }),
    })
    if (!response.ok) throw new Error('draft failed: ' + (await response.text()))
    return (await response.json()).data
  }, fixture.projectId)
  expect(draft.amount_cents).toBe(1000)
  await expect(button).toHaveText('Preview missing rates')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
