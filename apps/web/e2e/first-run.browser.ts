import { expect, test } from '@playwright/test'

const email = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!
const password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
const instant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT!
const controlPath = '/__ezacto_browser_fixture__/start-end'
const headers = { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' }

test('[e2e:first-run] guides a fresh database through the first saved time entry', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.clock.setFixedTime(instant)
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  const created = await page.request.post(controlPath, {
    headers,
    data: { action: 'first-run-create', password },
  })
  expect(created.status()).toBe(204)
  try {
    await page.goto('/')
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const checklist = page.locator('[data-first-run-checklist]')
    await expect(checklist).toBeVisible()
    await expect(checklist.locator('li')).toHaveCount(6)
    await expect(checklist.locator('[data-complete="true"]')).toHaveCount(0)
    const post = async (path: string, body: unknown) => {
      const response = await page.evaluate(
        async ({ path, body }) => {
          const result = await fetch(`/api/v1${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          return { status: result.status, body: await result.json() }
        },
        { path, body },
      )
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(201)
      return response.body.data
    }
    const check = async (count: number) => {
      await checklist.getByRole('button', { name: 'Check setup again' }).click()
      await expect(checklist.locator('[data-complete="true"]')).toHaveCount(count)
    }
    const client = await post('/clients', { name: 'First real client' })
    await check(1)
    const project = await post('/projects', {
      client_id: client.id,
      name: 'First real project',
      billing_method: 'non_billable',
    })
    // The owner is automatically assigned by the native project creator.
    await check(3)
    const task = await post('/tasks', { name: 'First real task', billable_by_default: false })
    await check(4)
    await post('/task-assignments', { project_id: project.id, task_id: task.id })
    await check(5)
    await page.screenshot({ path: test.info().outputPath('first-run-phone.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.screenshot({ path: test.info().outputPath('first-run-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      checklist.locator(`a[href="/projects/${project.id}#project-tasks-heading"]`),
    ).toBeVisible()
    await checklist.getByRole('button', { name: 'Dismiss setup guide' }).click()
    await expect(checklist).toBeHidden()
    await page.reload()
    await expect(page.locator('[data-authenticated-shell]')).toBeVisible()
    await expect(checklist).toBeHidden()
    await page.getByRole('button', { name: 'Help: setup guide' }).click()
    await expect(checklist).toBeVisible()
    await expect(checklist.locator('[data-complete="true"]')).toHaveCount(5)
    await post('/time-entries', {
      project_id: project.id,
      task_id: task.id,
      spent_date: instant.slice(0, 10),
      seconds: 60,
      notes: 'My first saved entry',
    })
    await page.reload()
    await expect(page.locator('[data-authenticated-shell]')).toBeVisible()
    await expect(checklist).toBeHidden()
    await page.getByRole('button', { name: 'Help: setup guide' }).click()
    await expect(checklist.locator('[data-complete="true"]')).toHaveCount(6)
    await expect(checklist).toContainText('Your first time entry is saved')
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((node) => node.clientWidth),
    )
  } finally {
    expect(
      (
        await page.request.post(controlPath, { headers, data: { action: 'first-run-reset' } })
      ).status(),
    ).toBe(204)
  }
})
