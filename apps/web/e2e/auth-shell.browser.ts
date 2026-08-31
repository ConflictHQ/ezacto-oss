import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const timestamp = '2026-08-28T12:00:00.000Z'
const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
const fixtureInstant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT
const fixtureTimeZone = process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE

if (
  fixtureEmail === undefined ||
  fixturePassword === undefined ||
  fixtureInstant === undefined ||
  fixtureTimeZone === undefined
) {
  throw new Error('browser fixture credentials are unavailable')
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(fixtureInstant)
})

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
  let signInAttempts = 0
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
    signInAttempts += 1
    if (signInAttempts === 1) {
      await fulfillJson(
        route,
        {
          error: {
            code: 'invalid_credentials',
            message: 'server detail is not rendered',
            fields: [],
          },
          request_id: 'browser-acceptance',
        },
        401,
      )
      return
    }
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
      path === '/api/v1/time-entry-options' ||
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
  await expect(page).toHaveTitle('ezacto — Sign in')
  await expect(page.locator('meta[name="ezacto-release"]')).toHaveAttribute(
    'content',
    'browser-cookie-e2e',
  )

  const email = page.getByLabel('Email')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  const authGateway = page.locator('[data-auth-gateway]')
  const authenticatedShell = page.locator('[data-authenticated-shell]')
  await expect(authGateway).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
  await expect(page.locator('.topbar')).toBeHidden()
  await expectPhoneControl(email)
  await expectPhoneControl(password)
  await expectPhoneControl(signIn)
  await expectNoPageOverflow(page)
  expect(protectedRequests).toEqual([])
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  await expect(
    authenticatedShell.locator('[data-command-trigger]').last(),
  ).toBeDisabled()

  await tabTo(page, email)
  await page.keyboard.type('owner@example.test')
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
  await page.keyboard.type(fixturePassword)
  await page.keyboard.press('Tab')
  await expect(signIn).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.locator('[data-sign-in-result]')).toHaveText(
    'Email or password is incorrect.',
  )
  await expect(password).toHaveValue('')
  await expect(signIn).toBeEnabled()
  await expect(authGateway).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
  expect(protectedRequests).toEqual([])
  await expect(page.locator('[data-sign-in-result]')).not.toContainText(
    'server detail is not rendered',
  )

  await password.fill(fixturePassword)
  await signIn.click()

  const identity = page.locator('[data-current-identity]')
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(authGateway).toBeHidden()
  await expect(authenticatedShell).toBeVisible()
  await expect(page).toHaveTitle('ezacto — Time')
  await expect(identity).toContainText('User #7')
  await expect(identity).toContainText('administrator')
  await expectPhoneControl(signOut)
  await expectNoPageOverflow(page)
  await expect.poll(() => [...protectedRequests]).toEqual(
    expect.arrayContaining([
      '/api/v1/projects',
      '/api/v1/tasks',
      '/api/v1/time-entry-options',
      '/api/v1/time-entries',
    ]),
  )

  await tabTo(page, signOut)
  await expect(signOut).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(email).toBeVisible()
  await expect(email).toBeFocused()
  await expect(authGateway).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
  await expect(page).toHaveTitle('ezacto — Sign in')
  expect(revoked).toBe(true)
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  await expectNoPageOverflow(page)

  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('.auth-splash')).toBeVisible()
  await expect(page.locator('.auth-card')).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
  const desktopCard = await page.locator('.auth-card').boundingBox()
  expect(desktopCard).not.toBeNull()
  expect(desktopCard!.x + desktopCard!.width).toBeLessThanOrEqual(1280)
})

test('[e2e:browser-auth] issues and revokes a real D1-backed browser session', async ({
  context,
  page,
}) => {
  let leakedToConsole = false
  let leakedToUrl = false
  const protectedResponses = new Map<string, number>()
  const timeEntryWrites: Array<{ method: string; body: unknown }> = []

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
    const path = new URL(value).pathname
    if (
      path.startsWith('/api/v1/time-entries') &&
      (request.method() === 'POST' || request.method() === 'PATCH')
    ) {
      timeEntryWrites.push({
        method: request.method(),
        body: request.postDataJSON(),
      })
    }
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
      path === '/api/v1/time-entry-options' ||
      path === '/api/v1/time-entries'
    ) {
      protectedResponses.set(path, response.status())
    }
  })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())

  await page.goto('/')
  expect(
    await page.evaluate(() => {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      return {
        instant: now.toISOString(),
        localDate: `${year}-${month}-${day}`,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }
    }),
  ).toEqual({
    instant: '2026-08-31T01:00:00.000Z',
    localDate: '2026-08-30',
    timeZone: 'America/Costa_Rica',
  })
  const email = page.getByLabel('Email')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  const authGateway = page.locator('[data-auth-gateway]')
  const authenticatedShell = page.locator('[data-authenticated-shell]')
  await expect(email).toBeVisible()
  await expect(authGateway).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
  await expect(page.locator('[data-auth-action]:not([disabled])')).toHaveCount(0)
  expect(protectedResponses.get('/api/v1/whoami')).toBe(401)

  await email.fill(fixtureEmail)
  await password.fill(fixturePassword)
  await signIn.click()
  await expect(password).toHaveValue('')

  const identity = page.locator('[data-current-identity]')
  await expect(authGateway).toBeHidden()
  await expect(authenticatedShell).toBeVisible()
  await expect(identity).toContainText('User #1')
  await expect(identity).toContainText('administrator')
  await expect(page.locator('[data-day-rows]')).toContainText('Browser Acceptance Project')
  await expect(page.locator('[data-day-rows]')).toContainText('Browser Acceptance Task')
  await expect(page.locator('[data-day-label]')).toHaveText('Sunday, Aug 30')
  await expect(page.locator('[data-week-total]')).toHaveText('0:45')
  await expect(page.locator('[data-entry-note="1"]')).toHaveText(
    'First line\nSecond line with delivery detail',
  )
  await expect(page.locator('[data-entry-note="2"]')).toHaveText('Separate follow-up')

  // A real assignment pair can be added as a row without creating a time entry
  // until the user enters duration.
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  const rowForm = page.locator('[data-row-form]')
  await rowForm.getByLabel('Project').selectOption('2')
  await expect(rowForm.getByLabel('Task')).toHaveValue('2')
  await rowForm.getByRole('button', { name: 'Add row', exact: true }).click()
  await expect(page.locator('[data-session-message]')).toHaveText(
    'Project/task row added. Enter time to save it.',
  )
  const secondaryCell = page.locator('[data-day-list] input[data-cell-key^="2:2:"]')
  await expect(secondaryCell).toBeFocused()
  expect(timeEntryWrites).toEqual([])

  // Submitting the same pair focuses its existing row rather than duplicating it.
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  await rowForm.getByLabel('Project').selectOption('2')
  await rowForm.getByRole('button', { name: 'Add row', exact: true }).click()
  await expect(page.locator('[data-session-message]')).toHaveText(
    'That project/task row already exists; it is focused now.',
  )
  await expect(secondaryCell).toBeFocused()

  // The browser must reject a forged cross-product which the options endpoint
  // never returned; it must not reach D1 or supplemental-row storage.
  await page.getByRole('button', { name: 'Add row', exact: true }).click()
  await rowForm.getByLabel('Project').selectOption('1')
  await rowForm.getByLabel('Task').evaluate((select) => {
    const taskSelect = select as HTMLSelectElement
    const forged = document.createElement('option')
    forged.value = '2'
    forged.textContent = 'Browser Secondary Task'
    taskSelect.append(forged)
    taskSelect.value = '2'
  })
  await rowForm.getByRole('button', { name: 'Add row', exact: true }).click()
  await expect(page.locator('[data-row-dialog]')).toBeVisible()
  await expect(page.locator('[data-row-result]')).toHaveText(
    'Choose an available project and task.',
  )
  expect(timeEntryWrites).toEqual([])
  expect(
    await page.evaluate(() =>
      Object.values(globalThis.localStorage).some((value) =>
        value.includes('{"projectId":1,"taskId":2}'),
      ),
    ),
  ).toBe(false)
  await rowForm.getByRole('button', { name: 'Close' }).click()

  await page.reload()
  await expect(secondaryCell).toHaveValue('')
  await expect(
    page.locator('[data-day-list] input[data-cell-key^="1:2:"]'),
  ).toHaveCount(0)
  expect(timeEntryWrites).toEqual([])

  // This exact assignment requires eight note characters. The duration remains
  // in the cell while the accessible dialog gathers a valid note, and no
  // incomplete write reaches D1.
  await secondaryCell.fill('0.25')
  await secondaryCell.press('Enter')
  const noteDialog = page.locator('[data-note-dialog]')
  const noteInput = noteDialog.getByLabel('Note')
  await expect(noteDialog).toBeVisible()
  await expect(noteInput).toBeFocused()
  await expect(noteInput).toHaveValue('')
  await expect(noteInput).toHaveAttribute('required', '')
  await expect(noteInput).toHaveAttribute('minlength', '8')
  await expect(noteInput).toHaveAttribute('maxlength', '10000')
  await expect(page.locator('[data-note-hint]')).toContainText(
    'at least 8 characters',
  )
  await expect(secondaryCell).toHaveValue('0.25')
  expect(timeEntryWrites).toEqual([])

  await noteInput.fill('short')
  await noteDialog.getByRole('button', { name: 'Save note' }).click()
  await expect(noteDialog).toBeVisible()
  await expect(page.locator('[data-note-result]')).toContainText(
    'at least 8 characters',
  )
  expect(timeEntryWrites).toEqual([])

  await noteInput.fill('Added row delivery note')
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/time-entries' &&
      response.request().method() === 'POST',
  )
  await noteDialog.getByRole('button', { name: 'Save note' }).click()
  expect((await created).ok()).toBe(true)
  await expect(noteDialog).toBeHidden()
  await expect(page.locator('[data-week-total]')).toHaveText('1:00')
  await expect(
    page.locator('[data-day-rows] .day-row').filter({ hasText: 'Browser Secondary Project' }),
  ).toContainText('Added row delivery note')
  expect(timeEntryWrites).toEqual([
    {
      method: 'POST',
      body: expect.objectContaining({ notes: 'Added row delivery note' }),
    },
  ])

  // Both the D1 entry/note and the locally remembered row survive a full reload;
  // the rejected cross-product remains absent.
  await page.reload()
  await expect(page.locator('[data-week-total]')).toHaveText('1:00')
  await expect(page.locator('[data-entry-note="1"]')).toHaveText(
    'First line\nSecond line with delivery detail',
  )
  await expect(page.locator('[data-entry-note="2"]')).toHaveText('Separate follow-up')
  const reloadedSecondary = page
    .locator('[data-day-rows] .day-row')
    .filter({ hasText: 'Browser Secondary Project' })
  await expect(reloadedSecondary.locator('input[data-cell-key^="2:2:"]')).toHaveValue('0.25')
  await expect(reloadedSecondary.locator('[data-entry-note]')).toHaveText('Added row delivery note')
  await expect(page.locator('[data-day-list] input[data-cell-key^="1:2:"]')).toHaveCount(0)
  await expect
    .poll(() => Object.fromEntries(protectedResponses))
    .toMatchObject({
      '/api/v1/whoami': 200,
      '/api/v1/projects': 200,
      '/api/v1/tasks': 200,
      '/api/v1/time-entry-options': 200,
      '/api/v1/time-entries': 200,
    })

  // Native form submission must recover when the user switches from a
  // required-note assignment to an optional one. A stale minlength attribute
  // must never prevent the new exact pair from reaching explicit validation.
  const writesBeforeTimer = timeEntryWrites.length
  await page.locator('[data-timer-chip]').click()
  const timerDialog = page.locator('[data-timer-dialog]')
  const timerProject = timerDialog.getByLabel('Project')
  const timerTask = timerDialog.getByLabel('Task')
  const timerNote = timerDialog.getByLabel('Note')
  const startTimer = timerDialog.getByRole('button', {
    name: 'Start timer',
    exact: true,
  })
  await timerProject.fill('SECONDARY')
  await timerTask.fill('Browser Secondary Task')
  await startTimer.click()
  await expect(page.locator('[data-timer-result]')).toContainText(
    'at least 8 characters',
  )
  await expect(timerNote).toHaveAttribute('required', '')
  await expect(timerNote).toHaveAttribute('minlength', '8')
  expect(timeEntryWrites).toHaveLength(writesBeforeTimer)

  await timerProject.fill('BROWSER')
  await timerTask.fill('Browser Acceptance Task')
  await expect(timerNote).not.toHaveAttribute('required', '')
  await expect(timerNote).toHaveAttribute('minlength', '0')
  const timerStarted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/time-entries' &&
      response.request().method() === 'POST',
  )
  await startTimer.click()
  expect((await timerStarted).ok()).toBe(true)
  await expect(page.locator('[data-timer-result]')).toHaveText('Timer started.')
  expect(timeEntryWrites).toHaveLength(writesBeforeTimer + 1)

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
  await expect(authGateway).toBeVisible()
  await expect(authenticatedShell).toBeHidden()
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
