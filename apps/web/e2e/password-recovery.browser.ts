import { randomBytes } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
const delivery = async (request: APIRequestContext): Promise<string> => {
  const response = await request.post('/__ezacto_browser_fixture__/password-reset', {
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { token: string }).token
}

test('resets a real OSS credential from an emailed-link handoff and revokes the old session', async ({ page, request }) => {
  test.setTimeout(90000)
  // Earlier browser specs share this account and can spend its sign-in budget.
  // Start this three-attempt credential lifecycle with the existing fixture reset.
  const admission = await request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'sign-in-rate-reset' },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })
  expect(admission.status()).toBe(204)
  const initial = await request.post('/auth/sign-in', { data: { email: fixtureEmail, password: fixturePassword } })
  expect(initial.status()).toBe(200)
  // The API request context does not retain Secure cookies on this HTTP
  // loopback harness. Forward the issued cookie explicitly for revocation proof.
  const oldCookie = initial.headers()['set-cookie']?.split(';', 1)[0]
  expect(Boolean(oldCookie)).toBe(true)
  const oldSession = { headers: { cookie: oldCookie! } }
  expect((await request.get('/api/v1/whoami', oldSession)).status()).toBe(200)
  const nextPassword = randomBytes(32).toString('base64url')
  const token = await delivery(request)
  try {
    await page.goto('/#auth=password-reset&token=' + encodeURIComponent(token))
    await expect(page.locator('[data-password-reset-form]')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    await page.locator('#ez-password-reset-password').fill(nextPassword)
    await page.locator('#ez-password-reset-confirm').fill(nextPassword)
    await page.locator('[data-password-reset-form] [type="submit"]').click()
    await expect(page.locator('[data-sign-in-result]')).toContainText('Password reset.')
    expect((await request.get('/api/v1/whoami', oldSession)).status()).toBe(401)
    const oldLogin = await request.post('/auth/sign-in', { data: { email: fixtureEmail, password: fixturePassword } })
    expect(oldLogin.status()).toBe(401)
    await page.locator('#ez-sign-in-email').fill(fixtureEmail)
    await page.locator('#ez-sign-in-password').fill(nextPassword)
    await page.locator('[data-sign-in-submit]').click()
    await expect(page.locator('[data-authenticated-shell]')).toBeVisible()
    expect(await page.locator('#ez-password-reset-password').inputValue()).toBe('')
    const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    expect(storage.includes(token) || storage.includes(nextPassword)).toBe(false)
  } finally {
    // Restore the shared fixture so subsequent browser specs retain their login.
    const restored = await request.post('/auth/password/reset', { data: { token: await delivery(request), password: fixturePassword } })
    expect(restored.status()).toBe(200)
  }
})
