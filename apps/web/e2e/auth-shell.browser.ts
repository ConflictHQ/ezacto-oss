import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const timestamp = '2026-08-28T12:00:00.000Z'
const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

if (fixtureEmail === undefined || fixturePassword === undefined) {
  throw new Error('browser fixture credentials are unavailable')
}

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

const tabTo = async (page: Page, target: Locator, limit = 20): Promise<void> => {
  for (let press = 0; press < limit; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(
    `keyboard traversal did not reach ${await target.evaluate((element) => element.outerHTML)}`,
  )
}

const expectPhoneControl = async (control: Locator): Promise<void> => {
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

const expectNoPageOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
  }))
  expect(dimensions.clientWidth).toBe(390)
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
}

test('[e2e:phone-week] renders and operates browser auth at 390px', async ({
  page,
}) => {
  let signedIn = false
  let revoked = false
  const protectedRequests: string[] = []

  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  )
  await page.route('**/auth/sign-in', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({
      email: 'owner@example.test',
      password: fixturePassword,
    })
    signedIn = true
    await fulfillJson(route, {
      data: {
        status: 'authenticated',
        user_id: 7,
        profile: 'administrator',
        manager_grants: [],
      },
    })
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/whoami') {
      await fulfillJson(
        route,
        signedIn
          ? {
              data: {
                user_id: 7,
                profile: 'administrator',
                manager_grants: [],
                authentication: { kind: 'session' },
              },
            }
          : {
              error: {
                code: 'authentication_required',
                message: 'Authentication is required.',
                fields: [],
              },
              request_id: 'browser-acceptance',
            },
        signedIn ? 200 : 401,
      )
      return
    }
    if (path === '/api/v1/sessions' && request.method() === 'GET') {
      await fulfillJson(route, {
        data: [
          {
            id: 11,
            created_at: timestamp,
            last_seen_at: timestamp,
            idle_expires_at: timestamp,
            absolute_expires_at: timestamp,
            revoked_at: null,
            revocation_reason: null,
            current: true,
          },
        ],
      })
      return
    }
    if (path === '/api/v1/sessions/11' && request.method() === 'DELETE') {
      signedIn = false
      revoked = true
      await fulfillJson(route, {
        data: {
          id: 11,
          created_at: timestamp,
          last_seen_at: timestamp,
          idle_expires_at: timestamp,
          absolute_expires_at: timestamp,
          revoked_at: timestamp,
          revocation_reason: 'user_revoked',
          current: false,
        },
      })
      return
    }
    if (
      path === '/api/v1/projects' ||
      path === '/api/v1/tasks' ||
      path === '/api/v1/time-entries'
    ) {
      protectedRequests.push(path)
      await fulfillJson(route, {
        data: [],
        page: { next_cursor: null },
        links: { next: null },
      })
      return
    }
    await fulfillJson(route, { error: { code: 'unexpected_test_request' } }, 500)
  })

  await page.goto('/')
  await expect(page).toHaveTitle('ezacto — Time')
  await expect(page.locator('meta[name="ezacto-release"]')).toHaveAttribute(
    'content',
    'browser-cookie-e2e',
  )

  const email = page.getByLabel('Email')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  await expectPhoneControl(email)
  await expectPhoneControl(password)
  await expectPhoneControl(signIn)
  await expectNoPageOverflow(page)
  expect(protectedRequests).toEqual([])
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Log time' })).toBeDisabled()

  await tabTo(page, email)
  await page.keyboard.type('owner@example.test')
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
  await page.keyboard.type(fixturePassword)
  await page.keyboard.press('Tab')
  await expect(signIn).toBeFocused()
  await page.keyboard.press('Enter')

  const identity = page.locator('[data-current-identity]')
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(identity).toContainText('User #7')
  await expect(identity).toContainText('administrator')
  await expectPhoneControl(signOut)
  await expectNoPageOverflow(page)
  await expect.poll(() => [...protectedRequests]).toEqual(
    expect.arrayContaining([
      '/api/v1/projects',
      '/api/v1/tasks',
      '/api/v1/time-entries',
    ]),
  )

  await tabTo(page, signOut)
  await expect(signOut).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(email).toBeVisible()
  await expect(email).toBeFocused()
  expect(revoked).toBe(true)
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  await expectNoPageOverflow(page)
})

test('[e2e:browser-auth] issues and revokes a real D1-backed browser session', async ({
  context,
  page,
}) => {
  let leakedToConsole = false
  let leakedToUrl = false
  const protectedResponses = new Map<string, number>()

  page.on('console', (message) => {
    const value = message.text()
    if (
      value.includes(fixtureEmail) ||
      value.includes(fixturePassword) ||
      value.includes('ezacto_session_')
    ) {
      leakedToConsole = true
    }
  })
  page.on('request', (request) => {
    const value = request.url()
    if (
      value.includes(fixtureEmail) ||
      value.includes(fixturePassword) ||
      value.includes('ezacto_session_')
    ) {
      leakedToUrl = true
    }
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (
      path === '/api/v1/whoami' ||
      path === '/api/v1/projects' ||
      path === '/api/v1/tasks' ||
      path === '/api/v1/time-entries'
    ) {
      protectedResponses.set(path, response.status())
    }
  })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())

  await page.goto('/')
  const email = page.getByLabel('Email')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(email).toBeVisible()
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  expect(protectedResponses.get('/api/v1/whoami')).toBe(401)

  await email.fill(fixtureEmail)
  await password.fill(fixturePassword)
  await signIn.click()
  await expect(password).toHaveValue('')

  const identity = page.locator('[data-current-identity]')
  await expect(identity).toContainText('User #1')
  await expect(identity).toContainText('administrator')
  await expect(page.locator('[data-day-rows]')).toContainText(
    'Browser Acceptance Project',
  )
  await expect(page.locator('[data-day-rows]')).toContainText(
    'Browser Acceptance Task',
  )
  await expect(page.locator('[data-week-total]')).toHaveText('0:30')
  await expect.poll(() => Object.fromEntries(protectedResponses)).toMatchObject({
    '/api/v1/whoami': 200,
    '/api/v1/projects': 200,
    '/api/v1/tasks': 200,
    '/api/v1/time-entries': 200,
  })

  const browserSession = (await context.cookies()).find(
    (cookie) => cookie.name === '__Host-ezacto_session',
  )
  if (browserSession === undefined) {
    throw new Error('the real sign-in response did not install a session cookie')
  }
  expect({
    httpOnly: browserSession.httpOnly,
    secure: browserSession.secure,
    sameSite: browserSession.sameSite,
  }).toEqual({ httpOnly: true, secure: true, sameSite: 'Lax' })
  const replayCookie = `${browserSession.name}=${browserSession.value}`

  const storageIsCredentialFree = await page.evaluate(
    ({ emailValue, passwordValue }) => {
      const storedMaterial = [
        ...Object.entries(globalThis.localStorage).flat(),
        ...Object.entries(globalThis.sessionStorage).flat(),
      ]
      return storedMaterial.every(
        (value) =>
          !value.includes(emailValue) &&
          !value.includes(passwordValue) &&
          !value.includes('ezacto_session_'),
      )
    },
    { emailValue: fixtureEmail, passwordValue: fixturePassword },
  )
  expect(storageIsCredentialFree).toBe(true)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(email).toBeVisible()
  await expect(email).toBeFocused()
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === '__Host-ezacto_session',
    ),
  ).toBe(false)

  const replay = await context.request.get('/api/v1/whoami', {
    headers: { cookie: replayCookie },
  })
  expect(replay.status()).toBe(401)
  expect(await replay.json()).toMatchObject({
    error: { code: 'authentication_required' },
  })
  expect(leakedToConsole).toBe(false)
  expect(leakedToUrl).toBe(false)
})
