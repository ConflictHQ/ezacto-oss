import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const timestamp = '2026-08-28T12:00:00.000Z'

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
      password: 'correct horse battery staple',
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
    'unknown',
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
  await page.keyboard.type('correct horse battery staple')
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
