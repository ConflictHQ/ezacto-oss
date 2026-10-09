import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const release = process.env.EZACTO_EXPECTED_RELEASE!

test('deployed demo signs in, navigates, persists a client and signs out', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === 'https://ezacto.io' && response.status() >= 500) {
      errors.push(`${response.status()} ${url.pathname}`)
    }
  })
  const health = await request.get('/healthz')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({ release })
  const navigation = await page.goto('/')
  expect(navigation?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-demo-deployment', '')
  await expect(page.locator('meta[name="ezacto-release"]')).toHaveAttribute('content', release)
  await page.getByRole('button', { name: 'Fill in administrator', exact: true }).click()
  await page.locator('[data-sign-in-form]').getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-authenticated-shell]')).toBeVisible()
  await expect(page.locator('[data-week-total]')).not.toHaveText('—')

  const uniqueName = `Deployment E2E ${randomUUID()}`
  let clientId: number | undefined
  try {
    for (const [path, heading, api] of [
      ['/projects', 'Projects', '/api/v1/projects'],
      ['/invoices', 'Invoices', '/api/v1/invoices'],
      ['/clients', 'Clients', '/api/v1/clients'],
    ]) {
      const loaded = page.waitForResponse(response =>
        new URL(response.url()).pathname === api && response.request().method() === 'GET')
      expect((await page.goto(path!))?.ok()).toBe(true)
      expect((await loaded).ok()).toBe(true)
      await expect(page.getByRole('heading', { name: heading!, exact: true })).toBeVisible()
      await expect(page.locator('[data-authenticated-shell]')).toBeVisible()
    }
    await page.getByRole('button', { name: 'Add client', exact: true }).click()
    const form = page.locator('[data-client-form]')
    await form.getByLabel('Name', { exact: true }).fill(uniqueName)
    const created = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/v1/clients' && response.request().method() === 'POST')
      .then(async response => {
        expect(response.status()).toBe(201)
        const body = await response.json() as { data: { id: number; name: string } }
        clientId = body.data.id
        expect(body.data.name).toBe(uniqueName)
        expect(Number.isSafeInteger(clientId)).toBe(true)
      })
    await form.getByRole('button', { name: 'Add client', exact: true }).click()
    await created
    await expect(page.locator('[data-client-tree]')).toContainText(uniqueName)
    await page.goto(`/clients/${clientId}`)
    await expect(page.locator('[data-client-detail-name]')).toHaveText(uniqueName)
    // Catch the real-world regression where malformed markup hid entire panels.
    for (const selector of ['.client-facts', '[data-client-360]', '.client-projects', '.client-contacts']) {
      await expect(page.locator(selector)).toBeVisible()
    }
  } finally {
    if (clientId !== undefined) {
      // Delete only the id returned by this run, after verifying its unique marker.
      const cleanup = await page.evaluate(async ({ id, name }) => {
        const current = await fetch(`/api/v1/clients/${id}`)
        if (!current.ok) return { read: current.status, deleted: 0 }
        const body = await current.json() as { data: { name: string } }
        if (body.data.name !== name) return { read: current.status, deleted: 0 }
        const deleted = await fetch(`/api/v1/clients/${id}`, { method: 'DELETE' })
        return { read: current.status, deleted: deleted.status }
      }, { id: clientId, name: uniqueName })
      expect(cleanup).toEqual({ read: 200, deleted: 204 })
    }
  }
  await page.locator('[data-logout]').click()
  await expect(page.locator('[data-auth-gateway]')).toBeVisible()
  const signedOut = await page.evaluate(async () => (await fetch('/api/v1/whoami')).status)
  expect(signedOut).toBe(401)
  expect(await (await request.get('/healthz')).json()).toMatchObject({ release })
  expect(errors).toEqual([])
})
