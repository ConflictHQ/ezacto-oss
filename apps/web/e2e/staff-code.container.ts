import { expect, test } from '@playwright/test'
test('Secure HttpOnly staff-code requester binding works with the localhost browser cookie jar', async ({
  page,
  context,
  request
}) => {
  await page.goto('/')
  const response = await page.evaluate(async () => {
    const r = await fetch('/auth/magic-link', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'code-owner@example.test', flow: 'app' })
    })
    return r.status
  })
  expect(response).toBe(202)
  const first = (await context.cookies()).find(
    (cookie) => cookie.name === '__Host-ezacto_staff_code'
  )
  expect(Boolean(first?.httpOnly && first.secure && first.path === '/')).toBe(true)
  expect(await page.evaluate(() => document.cookie.includes('__Host-ezacto_staff_code'))).toBe(
    false
  )
  let code: string | null = null
  for (let attempt = 0; attempt < 50 && !code; attempt++) {
    const mail = await request.get('/__owned_code_mail', {
      headers: { 'x-owned-proof': process.env.EZACTO_STAFF_CODE_FIXTURE_NONCE! }
    })
    code = (await mail.json()).code
    if (!code) await page.waitForTimeout(50)
  }
  expect(Boolean(code)).toBe(true)
  const status = await page.evaluate(async (code) => {
    const r = await fetch('/auth/magic-link/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'code-owner@example.test', code })
    })
    return r.status
  }, code)
  expect(status).toBe(200)
  expect(
    (await context.cookies()).some((cookie) => cookie.name === '__Host-ezacto_staff_code')
  ).toBe(false)
  const native = await page.evaluate(async () => {
    const r = await fetch('/api/v1/whoami', { credentials: 'include' })
    return { status: r.status, profile: (await r.json()).data?.profile }
  })
  expect(native).toEqual({ status: 200, profile: 'administrator' })
})

test('current mobile API functions use the browser cookie jar without JSON changes', async ({
  page,
  request
}) => {
  test.skip(!process.env.EZACTO_STAFF_CODE_MOBILE_SOURCE, 'Optional owned mobile source acceptance')
  await page.goto('/')
  await page.addScriptTag({ url: '/__owned_mobile_client.js' })
  await page.evaluate(async () => {
    await (
      window as unknown as {
        ownedMobileClient: { requestMagicLink(server: string, email: string): Promise<void> }
      }
    ).ownedMobileClient.requestMagicLink(location.origin, 'mobile-code-owner@example.test')
  })
  let code: string | null = null
  for (let attempt = 0; attempt < 50 && !code; attempt++) {
    const mail = await request.get('/__owned_code_mail?email=mobile-code-owner%40example.test', {
      headers: { 'x-owned-proof': process.env.EZACTO_STAFF_CODE_FIXTURE_NONCE! }
    })
    code = (await mail.json()).code
    if (!code) await page.waitForTimeout(50)
  }
  expect(Boolean(code)).toBe(true)
  const result = await page.evaluate(async (code) => {
    const token = await (
      window as unknown as {
        ownedMobileClient: {
          signInWithMagicLinkCode(
            server: string,
            email: string,
            code: string,
            name: string
          ): Promise<string>
        }
      }
    ).ownedMobileClient.signInWithMagicLinkCode(
      location.origin,
      'mobile-code-owner@example.test',
      code!,
      'Owned browser proof'
    )
    const who = await fetch('/api/v1/whoami', { headers: { authorization: `Bearer ${token}` } })
    return {
      tokenIssued: token.startsWith('ezacto_'),
      status: who.status,
      profile: (await who.json()).data?.profile
    }
  }, code)
  expect(result).toEqual({ tokenIssued: true, status: 200, profile: 'administrator' })
})
