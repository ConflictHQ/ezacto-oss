import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test'

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

type BrowserFixtureAction =
  | 'invoice-generation-cleanup'
  | 'invoice-generation-seed'
  | 'project-directory-cleanup'

const controlBrowserFixture = (
  request: APIRequestContext,
  action: BrowserFixtureAction,
) =>
  request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action },
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
  })

test.afterEach(async ({ request }, testInfo) => {
  const action = testInfo.title.includes('[e2e:project-directory]')
    ? 'project-directory-cleanup'
    : testInfo.title ===
        '[e2e:invoice-cycle] generates a real draft through the authenticated wizard'
      ? 'invoice-generation-cleanup'
      : null
  if (action === null) return
  const cleaned = await controlBrowserFixture(request, action)
  expect(cleaned.status()).toBe(204)
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
    if (path === '/api/v1/time-entry-settings') {
      protectedRequests.push(path)
      await fulfillJson(route, {
        data: {
          time_entry_mode: 'duration',
          time_format: 'decimal',
          clock: '12h',
          week_start_day: 'monday',
        },
        links: { self: '/api/v1/time-entry-settings' },
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
    if (path === '/api/v1/timesheet-submissions') {
      await fulfillJson(route, { error: { code: 'not_found' } }, 404)
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

  const email = page.locator('[data-sign-in-form]').getByLabel('Email')
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
  await expect(page.locator('[data-team-nav]:not([hidden])')).toHaveCount(0)
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

test('[e2e:track-week] uses one editor and submits 12-hour UI times as canonical HH:MM', async ({
  page,
}) => {
  const resources = {
    project: {
      id: 1,
      name: 'Run',
      code: 'RUN',
      created_at: timestamp,
      updated_at: timestamp,
    },
    task: {
      id: 1,
      name: 'RuntimeTask',
      created_at: timestamp,
      updated_at: timestamp,
    },
  }
  let entry = {
    id: 1,
    user_id: 7,
    project_id: 1,
    task_id: 1,
    spent_date: '2026-08-30',
    seconds: 30_600,
    is_running: false,
    timer_started_at: null,
    started_time: '09:05',
    ended_time: '17:35',
    notes: 'Start/end browser entry',
    billable: true,
    budgeted: false,
    approval_status: 'unsubmitted',
    is_billed: false,
    is_locked: false,
    minimum_note_length: 0,
    created_at: timestamp,
    updated_at: timestamp,
  }
  let updateBody: unknown

  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  )
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/whoami') {
      await fulfillJson(route, {
        data: {
          user_id: 7,
          profile: 'administrator',
          manager_grants: [],
          authentication: { kind: 'session' },
        },
      })
      return
    }
    if (url.pathname === '/api/v1/projects') {
      await fulfillJson(route, {
        data: [resources.project],
        page: { next_cursor: null },
        links: { next: null },
      })
      return
    }
    if (url.pathname === '/api/v1/tasks') {
      await fulfillJson(route, {
        data: [resources.task],
        page: { next_cursor: null },
        links: { next: null },
      })
      return
    }
    if (url.pathname === '/api/v1/time-entry-options') {
      await fulfillJson(route, {
        data: [{ project_id: 1, task_id: 1, minimum_note_length: 0 }],
        links: { self: '/api/v1/time-entry-options' },
      })
      return
    }
    if (url.pathname === '/api/v1/time-entry-settings') {
      await fulfillJson(route, {
        data: {
          time_entry_mode: 'start_end',
          time_format: 'hours_minutes',
          clock: '12h',
          week_start_day: 'monday',
        },
        links: { self: '/api/v1/time-entry-settings' },
      })
      return
    }
    if (url.pathname === '/api/v1/time-entries/1' && request.method() === 'PATCH') {
      updateBody = request.postDataJSON()
      entry = { ...entry, ...(updateBody as object) }
      await fulfillJson(route, { data: entry, links: { self: '/api/v1/time-entries/1' } })
      return
    }
    if (url.pathname === '/api/v1/time-entries') {
      const data = url.searchParams.get('is_running') === 'true' ? [] : [entry]
      await fulfillJson(route, {
        data,
        page: { next_cursor: null },
        links: { next: null },
      })
      return
    }
    if (url.pathname === '/api/v1/expenses') {
      await fulfillJson(route, { error: { code: 'not_found' } }, 404)
      return
    }
    if (url.pathname === '/api/v1/timesheet-submissions') {
      await fulfillJson(route, { error: { code: 'not_found' } }, 404)
      return
    }
    if (url.pathname === '/api/v1/timesheet-lock-policy') {
      await fulfillJson(route, { error: { code: 'not_found' } }, 404)
      return
    }
    await fulfillJson(route, { error: { code: 'unexpected_test_request' } }, 500)
  })

  await page.goto('/?view=day&week=2026-08-30')
  const editor = page.locator('[data-entry-dialog]')
  await expect(editor).toHaveCount(1)
  await expect(page.locator('[data-entry-form]')).toHaveCount(1)

  await page
    .locator('[data-day-list] [data-cell-key="1:1:2026-08-30"] .cell-note')
    .click()
  await expect(editor).toHaveAttribute('data-entry-context', 'day')
  await editor.getByRole('button', { name: 'Close' }).click()

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.dataset.timeView = 'week'
  })
  await page
    .locator('[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note')
    .click()
  await expect(editor).toHaveAttribute('data-entry-context', 'week-cell')
  await editor.getByRole('button', { name: 'Close' }).click()

  await page
    .locator('[data-week-grid] [data-cell-key="1:1:2026-08-30"] .cell-note')
    .click()
  await expect(editor).toHaveAttribute('data-entry-context', 'edit')
  await expect(editor.getByLabel('Start')).toHaveValue('9:05 AM')
  await expect(editor.getByLabel('End')).toHaveValue('5:35 PM')
  await editor.getByLabel('Start').fill('10:15 PM')
  await editor.getByLabel('End').fill('1:45 AM')
  await editor.getByRole('button', { name: 'Save entry' }).click()
  await expect(editor).toBeHidden()
  expect(updateBody).toMatchObject({
    started_time: '22:15',
    ended_time: '01:45',
  })
  expect(updateBody).not.toHaveProperty('seconds')
})

test('[e2e:track-week] persists start/end editor changes through the real worker and D1', async ({
  context,
  page,
}) => {
  const fixtureControl = (action: 'seed' | 'reset') =>
    context.request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action },
      headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    })
  const seeded = await fixtureControl('seed')
  expect(seeded.status()).toBe(204)

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
    await page.goto('/?week=2026-08-29')
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
    await page.getByLabel('Password').fill(fixturePassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    const cell = page.locator(
      '[data-week-grid] [data-cell-key="1:1:2026-08-29"]',
    )
    await expect(cell.locator('input')).toHaveValue('8:30')
    await cell.locator('.cell-note').click()
    const editor = page.locator('[data-entry-dialog]')
    await expect(editor).toHaveAttribute('data-entry-context', 'edit')
    await expect(editor.getByLabel('Start')).toHaveValue('9:05 AM')
    await expect(editor.getByLabel('End')).toHaveValue('5:35 PM')

    await editor.getByLabel('Start').fill('10:15 PM')
    await editor.getByLabel('End').fill('1:45 AM')
    const patched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/time-entries/900' &&
        response.request().method() === 'PATCH',
    )
    await editor.getByRole('button', { name: 'Save entry' }).click()
    expect((await patched).ok()).toBe(true)
    await expect(editor).toBeHidden()

    const persisted = await page.evaluate(async () => {
      const response = await fetch('/api/v1/time-entries/900')
      return { body: await response.json(), status: response.status }
    })
    expect(persisted).toMatchObject({
      status: 200,
      body: {
        data: {
          started_time: '22:15',
          ended_time: '01:45',
          seconds: 12_600,
        },
      },
    })

    await page.reload()
    const reloadedCell = page.locator(
      '[data-week-grid] [data-cell-key="1:1:2026-08-29"]',
    )
    await expect(reloadedCell.locator('input')).toHaveValue('3:30')
    await reloadedCell.locator('.cell-note').click()
    await expect(editor.getByLabel('Start')).toHaveValue('10:15 PM')
    await expect(editor.getByLabel('End')).toHaveValue('1:45 AM')
  } finally {
    const reset = await fixtureControl('reset')
    expect(reset.status()).toBe(204)
  }
})

test('[e2e:rate-change] adds a dated rate through the real worker and shows the closed prior period', async ({
  context,
  page,
}) => {
  const fixture = (action: string) =>
    context.request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action },
      headers: {
        'x-ezacto-browser-fixture-control': 'start-end-round-trip',
      },
    })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())

  for (let iteration = 0; iteration < 2; iteration += 1) {
    try {
      const seeded = await fixture('team-rate-seed')
      expect(seeded.status()).toBe(204)
      await page.goto('/team/1')
      // The shell settles into one of two states — the sign-in form, or the
      // person, if the previous iteration's session survived. isVisible()
      // samples immediately and does not wait, so on a loaded runner it read
      // false before the shell had rendered anything at all, skipped the
      // sign-in, and then timed out waiting for a heading behind a form nobody
      // filled in. Wait for whichever state the shell lands in first.
      const signIn = page.locator('[data-sign-in-form]:not([hidden])')
      const person = page.getByRole('heading', { name: 'Browser Owner' })
      await expect(signIn.or(person).first()).toBeVisible()
      if (await signIn.isVisible()) {
        await signIn.getByLabel('Email').fill(fixtureEmail)
        await signIn.getByLabel('Password').fill(fixturePassword)
        await signIn.getByRole('button', { name: 'Sign in', exact: true }).click()
      }

      await expect(person).toBeVisible()
      await expect(page.locator('[data-team-nav]:not([hidden])')).toHaveCount(2)
      await page.getByRole('tab', { name: 'Rates' }).click()
      const billable = page.locator('[data-team-billable-section]')
      await expect(billable).toContainText('2026-08-01 – Ongoing')
      await expectPhoneControl(
        billable.getByRole('button', { name: 'Add rate', exact: true }),
      )
      await billable.getByRole('button', { name: 'Add rate', exact: true }).click()

      const dialog = page.locator('[data-team-rate-dialog]')
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Hourly amount').fill('125.01')
      await dialog.getByLabel('Effective date').fill('2026-08-30')
      const changed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/team/people/1/rates' &&
          response.request().method() === 'POST',
      )
      await dialog.getByRole('button', { name: 'Add billable rate' }).click()
      expect((await changed).status()).toBe(201)

      await expect(dialog).toBeHidden()
      await expect(billable).toContainText('2026-08-01 – 2026-08-29')
      await expect(billable).toContainText('2026-08-30 – Ongoing')
      await expect(billable).toContainText('125.01/hour')
      await expectNoPageOverflow(page)
    } finally {
      expect((await fixture('team-rate-reset')).status()).toBe(204)
      expect((await fixture('team-rate-assert-clean')).status()).toBe(204)
    }
  }
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
  const email = page.locator('[data-sign-in-form]').getByLabel('Email')
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
  // The fixture organisation is decimal, and the week total honours that now
  // rather than always printing H:MM. 45 minutes is 0.75, not 0:45.
  await expect(page.locator('[data-week-total]')).toHaveText('0.75')
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

  // A returning navigation now paints from the cached identity instead of
  // waiting behind the session-check overlay. This DELIBERATELY relaxes what
  // issue 218 specified: controls become available before validation finishes
  // rather than after. It is safe because nothing is authorized on the cache's
  // say-so — every request the shell makes is authorized by the worker against
  // the real cookie, so a dead session fails on its first protected call and
  // drops to the gateway. The overlay path still applies to a cold tab with no
  // cache, and is covered by the shell and browser unit suites.
  const sessionChecks: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/whoami')) sessionChecks.push(request.url())
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const sessionCheckOverlay = page.locator('[data-session-check-overlay]')
  await expect(authGateway).toBeHidden()
  await expect(authenticatedShell).toBeVisible()
  await expect(sessionCheckOverlay).toBeHidden()
  await expect(authenticatedShell).not.toHaveAttribute('inert', '')
  await expect(authenticatedShell).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('[data-auth-action]:not([disabled])')).not.toHaveCount(0)
  // Still validated, just no longer on the critical path.
  await expect.poll(() => sessionChecks.length).toBeGreaterThan(0)
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
  await noteDialog.getByRole('button', { name: 'Log time' }).click()
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
  await noteDialog.getByRole('button', { name: 'Log time' }).click()
  expect((await created).ok()).toBe(true)
  await expect(noteDialog).toBeHidden()
  await expect(page.locator('[data-week-total]')).toHaveText('1.00')
  // The seven-day strip is the week's shape before you read a row, and it has
  // to agree with the grid it sits above — in both views, which is why it lives
  // outside them. It honours the organisation's time format for the same
  // reason the totals do: an hour is 1.00 on a decimal account, not 1:00.
  // A column header is scanned down a row of seven, so the weekday and the date
  // are stacked rather than competing on one line. The first column is the
  // project/task heading and keeps its single line.
  const dayHeadings = page.locator('.week-grid-table thead th:not(:first-child)')
  await expect(dayHeadings.first().locator('[data-weekday]')).toHaveText(/^[A-Z][a-z]{2}$/u)
  // The account formats dates en-US, so the date line is "Aug 24" rather than
  // the "01 Apr" the issue sketches from the old UI. Every other date in the
  // app reads month-first; one column reading day-first would be the odd one.
  await expect(dayHeadings.first().locator('[data-date]')).toHaveText(/^[A-Z][a-z]{2} \d{2}$/u)

  const dayTotals = page.locator('[data-day-totals] li')
  await expect(dayTotals).toHaveCount(7)
  await expect(dayTotals.filter({ has: page.locator('[data-empty]') })).toHaveCount(6)
  await expect(
    dayTotals.filter({ hasNot: page.locator('[data-empty]') }).locator('strong'),
  ).toHaveText('1.00')

  // The strip answers "which day am I short on", so it is also the way to go
  // there. Reading the answer here and then hunting for the day in a separate
  // pair of arrows is the gap this closes.
  const stripDays = page.locator('[data-day-totals] button[data-day-select]')
  await expect(stripDays).toHaveCount(7)
  const selectedBefore = await page
    .locator('[data-day-totals] li[data-selected] button')
    .getAttribute('data-day-select')
  const target = selectedBefore === '3' ? '5' : '3'
  await stripDays.nth(Number(target)).click()
  await expect(page.locator('[data-day-totals] li[data-selected] button')).toHaveAttribute(
    'data-day-select',
    target,
  )
  await expect(stripDays.nth(Number(target))).toHaveAttribute('aria-pressed', 'true')
  await expect(stripDays.nth(Number(selectedBefore))).toHaveAttribute('aria-pressed', 'false')
  // Put the day back: the assertions below read the day view, and this spec
  // continues against the day it started on.
  await stripDays.nth(Number(selectedBefore)).click()
  await expect(page.locator('[data-day-totals] li[data-selected] button')).toHaveAttribute(
    'data-day-select',
    selectedBefore!,
  )
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
  await expect(page.locator('[data-week-total]')).toHaveText('1.00')
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
  // The picker offers what the command line made you type exactly. Tasks narrow
  // to the project once it resolves.
  await expect(page.locator('[data-entry-project-options] option')).not.toHaveCount(0)
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
  await expect(timerDialog).not.toBeVisible()
  expect(timeEntryWrites).toHaveLength(writesBeforeTimer + 1)

  // Starting from the row you already have, rather than retyping the project
  // and task into the command line. POST /time-entries/{id}/restart has been
  // shipped and unused; this is its first consumer. The timer started above is
  // stopped first, because restart starts one and two cannot run at once.
  await page.locator('[data-timer-chip]').click()
  const stopRunning = page.locator('[data-stop-timer]')
  await expect(stopRunning).toBeVisible()
  await stopRunning.click()
  await expect(page.locator('[data-entry-dialog]')).toBeHidden()

  const startRow = page.locator('[data-start-entry]').first()
  await expect(startRow).toBeVisible()
  const restarted = page.waitForResponse(
    (response) =>
      /\/api\/v1\/time-entries\/\d+\/restart$/u.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  )
  await startRow.click()
  expect((await restarted).ok()).toBe(true)
  // The row is running now, so it offers no second Start.
  await expect(page.locator('[data-day-rows] .day-row[data-running="true"]')).toHaveCount(1)
  await expect(
    page.locator('[data-day-rows] .day-row[data-running="true"] [data-start-entry]'),
  ).toHaveCount(0)

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

test('[e2e:client-directory] persists hierarchy, bill-to, contacts, projects, and archives through real D1', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/clients')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.locator('[data-client-tree]')).toContainText(
    'Browser Acceptance Client',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await expectPhoneControl(page.getByRole('button', { name: 'Add client' }))
  await expectPhoneControl(page.getByRole('button', { name: 'Active', exact: true }))
  await expectNoPageOverflow(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByRole('button', { name: 'Add client' }).click()
  const clientDialog = page.locator('[data-client-form-dialog]')
  await clientDialog.getByLabel('Name').fill('Browser Parent Group')
  await clientDialog.getByLabel('Currency').fill('USD')
  await clientDialog.getByLabel('Payment terms').selectOption('net_30')
  await clientDialog.getByRole('button', { name: 'Add client' }).click()
  await expect(clientDialog).toBeHidden()
  await expect(page.locator('[data-client-tree]')).toContainText('Browser Parent Group')

  await page.getByRole('button', { name: 'Add client' }).click()
  await clientDialog.getByLabel('Name').fill('Browser Worked-For Studio')
  await clientDialog.getByLabel('Currency').fill('USD')
  await clientDialog
    .getByLabel('Worked-for parent')
    .selectOption({ label: 'Browser Parent Group' })
  await clientDialog
    .getByLabel('Bill-to client')
    .selectOption({ label: 'Browser Parent Group' })
  await clientDialog.getByRole('button', { name: 'Add client' }).click()
  await expect(clientDialog).toBeHidden()

  const childRow = page
    .locator('[data-client-tree] tbody tr[data-row]')
    .filter({ hasText: 'Browser Worked-For Studio' })
  await expect(childRow).toContainText('Worked-for parent: Browser Parent Group')
  await expect(childRow).toContainText('Bill-to client: Browser Parent Group')
  await childRow.getByRole('link', { name: 'Browser Worked-For Studio' }).click()

  await expect(page.locator('[data-client-detail-parent]')).toHaveText(
    'Browser Parent Group',
  )
  await expect(page.locator('[data-client-detail-bill-to]')).toHaveText(
    'Browser Parent Group',
  )
  const childId = Number(new URL(page.url()).pathname.split('/').at(-1))
  expect(Number.isSafeInteger(childId)).toBe(true)

  const project = await page.evaluate(async (clientId) => {
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        name: 'Browser Client Project',
        code: 'CLIENT',
      }),
    })
    return { status: response.status, body: await response.json() }
  }, childId)
  expect(project.status).toBe(201)

  await page.reload()
  await expect(page.locator('[data-client-projects]')).toContainText(
    '[CLIENT] Browser Client Project',
  )

  await page.getByRole('button', { name: 'Add contact' }).click()
  const contactDialog = page.locator('[data-contact-form-dialog]')
  await contactDialog.getByLabel('First name').fill('Jordan')
  await contactDialog.getByLabel('Last name').fill('Invoice')
  await contactDialog.getByLabel('Contact address').fill('jordan.invoice@example.test')
  await contactDialog.getByLabel('Invoice routing').selectOption('recipient')
  await contactDialog.getByRole('button', { name: 'Add contact' }).click()
  await expect(contactDialog).toBeHidden()

  const contactRow = page
    .locator('[data-client-contacts] tbody tr[data-row]')
    .filter({ hasText: 'Jordan Invoice' })
  await expect(contactRow).toContainText('Invoice recipient')
  await contactRow.getByRole('button', { name: 'Edit' }).click()
  await contactDialog.getByLabel('Invoice routing').selectOption('cc')
  await contactDialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(contactRow).toContainText('Invoice CC')

  const persisted = await page.evaluate(async (clientId) => {
    const [clientResponse, contactsResponse, projectsResponse] = await Promise.all([
      fetch(`/api/v1/clients/${clientId}`),
      fetch(`/api/v1/contacts?client_id=${clientId}&per_page=200`),
      fetch(`/api/v1/projects?client_id=${clientId}&per_page=200`),
    ])
    return {
      client: await clientResponse.json(),
      contacts: await contactsResponse.json(),
      projects: await projectsResponse.json(),
    }
  }, childId)
  expect(persisted.client.data).toMatchObject({
    id: childId,
    name: 'Browser Worked-For Studio',
    parent_client_id: expect.any(Number),
    bill_to_client_id: expect.any(Number),
  })
  expect(persisted.client.data.parent_client_id).toBe(
    persisted.client.data.bill_to_client_id,
  )
  expect(persisted.contacts.data).toEqual([
    expect.objectContaining({
      client_id: childId,
      email: 'jordan.invoice@example.test',
      invoice_recipient_status: 'cc',
    }),
  ])
  expect(persisted.projects.data).toEqual([
    expect.objectContaining({ client_id: childId, code: 'CLIENT' }),
  ])

  await contactRow.locator('.data-table-overflow > summary').click()
  await contactRow.getByRole('button', { name: 'Delete' }).click()
  const contactDelete = page.locator('[data-contact-delete-dialog]')
  await expect(contactDelete).toContainText('cannot be undone')
  await contactDelete.getByRole('button', { name: 'Delete contact' }).click()
  await expect(contactDelete).toBeHidden()
  await expect(page.locator('[data-client-contacts]')).toContainText(
    'No contacts have been added',
  )

  await page.getByRole('button', { name: 'Archive', exact: true }).first().click()
  const clientArchive = page.locator('[data-client-archive-dialog]')
  await clientArchive.getByRole('button', { name: 'Archive client' }).click()
  await expect(clientArchive).toBeHidden()
  await expect(page.locator('[data-client-detail-active]')).toHaveText('Archived')

  const archived = await page.evaluate(async (clientId) => {
    const [clientResponse, contactsResponse] = await Promise.all([
      fetch(`/api/v1/clients/${clientId}`),
      fetch(`/api/v1/contacts?client_id=${clientId}&per_page=200`),
    ])
    return {
      client: (await clientResponse.json()).data,
      contacts: (await contactsResponse.json()).data,
    }
  }, childId)
  expect(archived.client.is_active).toBe(false)
  expect(archived.contacts).toEqual([])
})

test('[e2e:project-directory] creates selectable work, edits assignments, uploads, and archives through real D1', async ({
  page,
  request,
}) => {
  const prepared = await controlBrowserFixture(request, 'project-directory-cleanup')
  expect(prepared.status()).toBe(204)

  let blockNextAttachmentRefresh = false
  let markAttachmentRefreshStarted = (): void => undefined
  const attachmentRefreshStarted = new Promise<void>((resolve) => {
    markAttachmentRefreshStarted = resolve
  })
  let releaseAttachmentRefresh = (): void => undefined
  const attachmentRefreshRelease = new Promise<void>((resolve) => {
    releaseAttachmentRefresh = resolve
  })
  await page.route('**/api/v1/projects/*/attachments*', async (route) => {
    if (blockNextAttachmentRefresh && route.request().method() === 'GET') {
      blockNextAttachmentRefresh = false
      markAttachmentRefreshStarted()
      await attachmentRefreshRelease
    }
    await route.continue()
  })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/projects')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.locator('[data-project-list]')).toContainText(
    'Browser Acceptance Project',
  )
  await expect(page.locator('[data-project-list]')).not.toContainText(
    'Browser UI Project',
  )
  await expectPhoneControl(page.getByRole('button', { name: 'Add project' }))
  await expectPhoneControl(page.getByRole('button', { name: 'Active', exact: true }))
  await expectNoPageOverflow(page)

  await page.getByRole('button', { name: 'Add project' }).click()
  const projectDialog = page.locator('[data-project-form-dialog]')
  await projectDialog.getByLabel('Client').selectOption({
    label: 'Browser Acceptance Client',
  })
  await projectDialog.getByLabel('Name').fill('Browser UI Project')
  await projectDialog.getByLabel('Code').fill('BPROJ')
  await projectDialog.getByLabel('Bill by').selectOption('tasks')
  await projectDialog.getByLabel('Budget by').selectOption('project')
  await projectDialog.getByLabel('Hours budget').fill('12.5')
  await projectDialog.getByLabel('Hourly rate').fill('175.25')
  await projectDialog.getByLabel('Cost budget', { exact: true }).fill('2345.67')
  await projectDialog.getByLabel('Minimum time-entry note length').fill('3')
  await projectDialog.getByLabel('Administrator notes').fill('Browser delivery detail')
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/projects' &&
      response.request().method() === 'POST',
  )
  await projectDialog.getByRole('button', { name: 'Add project' }).click()
  expect((await created).status()).toBe(201)
  await expect(projectDialog).toBeHidden()

  const row = page.locator('[data-project-list] tbody tr[data-row]').filter({
    hasText: 'Browser UI Project',
  })
  // The client is a band above its run of rows, not a column repeated on each
  // one, so it is asserted on the table rather than inside the row.
  await expect(
    page
      .locator('[data-project-list] .data-table-group')
      .filter({ hasText: 'Browser Acceptance Client' }),
  ).toHaveCount(1)
  // Budget | Spent | Remaining | Costs come from the list-scoped rollup, one
  // request for the page. The columns exist and carry figures rather than the
  // em-dash placeholder a missing rollup would leave.
  const budgetsLoaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/reports/project-budgets' &&
      response.status() === 200,
  )
  await page.reload()
  expect((await budgetsLoaded).ok()).toBe(true)
  for (const column of ['budget', 'spent', 'remaining', 'costs']) {
    await expect(
      page.locator(`[data-project-list] thead th[data-column="${column}"]`),
    ).toHaveCount(1)
  }
  await expect(row.locator('td[data-column="spent"]')).not.toHaveText('—')
  await expectNoPageOverflow(page)

  await row.getByRole('link', { name: '[BPROJ] Browser UI Project' }).click()
  await expect(page.locator('[data-project-facts]')).toContainText(
    'Browser delivery detail',
  )
  await expect(page.locator('[data-project-facts]')).toContainText('$175.25')
  await expectNoPageOverflow(page)

  await page.getByRole('button', { name: 'Assign task' }).click()
  const assignmentDialog = page.locator('[data-task-assignment-dialog]')
  await assignmentDialog.locator('select[name="task_id"]').selectOption({
    label: 'Browser Acceptance Task',
  })
  await assignmentDialog.getByLabel('Hours budget').fill('7.25')
  await assignmentDialog.getByLabel('Task hourly rate').fill('201.01')
  await assignmentDialog.getByLabel('Task fee budget').fill('999.99')
  const assigned = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/task-assignments' &&
      response.request().method() === 'POST',
  )
  await assignmentDialog.getByRole('button', { name: 'Assign task' }).click()
  const assignedResponse = await assigned
  expect(assignedResponse.status()).toBe(201)
  const assignedBody = await assignedResponse.json()
  const taskCard = page.locator('[data-project-task-assignments] li').filter({
    hasText: 'Browser Acceptance Task',
  })
  await expect(taskCard).toContainText('7.25 hours')
  await expect(taskCard).toContainText('$201.01')

  const projectId = Number(new URL(page.url()).pathname.split('/').at(-1))
  expect(Number.isSafeInteger(projectId)).toBe(true)
  const selectable = await page.evaluate(async (expectedProjectId) => {
    const response = await fetch('/api/v1/time-entry-options')
    const body = await response.json()
    return body.data.some(
      (option: { project_id: number; minimum_note_length: number }) =>
        option.project_id === expectedProjectId && option.minimum_note_length === 3,
    )
  }, projectId)
  expect(selectable).toBe(true)

  const upload = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/projects/${projectId}/attachments` &&
      response.request().method() === 'POST',
  )
  await page
    .getByLabel('Attach a file')
    .setInputFiles({ name: 'browser-project.txt', mimeType: 'text/plain', buffer: Buffer.from('browser project') })
  await page.getByRole('button', { name: 'Upload' }).click()
  expect((await upload).status()).toBe(201)
  const attachment = page.getByRole('link', { name: 'browser-project.txt' })
  await expect(attachment).toBeVisible()
  const attachmentHref = await attachment.getAttribute('href')
  expect(attachmentHref).not.toBeNull()
  expect(
    await page.evaluate(async (href) => (await fetch(href)).text(), attachmentHref!),
  ).toBe('browser project')

  await page
    .locator('.project-header-actions')
    .getByRole('button', { name: 'Edit', exact: true })
    .click()
  await projectDialog.getByLabel('Starts on').fill('2026-08-01')
  await projectDialog.getByLabel('Ends on').fill('2026-12-31')
  await projectDialog.getByLabel('Administrator notes').fill('Updated browser detail')
  const updatedProject = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}` &&
      response.request().method() === 'PATCH',
  )
  blockNextAttachmentRefresh = true
  await projectDialog.getByRole('button', { name: 'Save project' }).click()
  expect((await updatedProject).status()).toBe(200)
  await attachmentRefreshStarted
  const editAssignment = taskCard.getByRole('button', { name: 'Edit', exact: true })
  try {
    await expect(editAssignment).toBeDisabled()
  } finally {
    releaseAttachmentRefresh()
  }
  await expect(editAssignment).toBeEnabled()
  await expect(page.locator('[data-project-facts]')).toContainText('Updated browser detail')
  await expect(page.locator('[data-project-facts]')).toContainText('2026-12-31')

  await editAssignment.click()
  await assignmentDialog.getByLabel('Hours budget').fill('8.5')
  const updatedAssignment = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/task-assignments/${assignedBody.data.id}` &&
      response.request().method() === 'PATCH',
  )
  await assignmentDialog.getByRole('button', { name: 'Save assignment' }).click()
  expect((await updatedAssignment).status()).toBe(200)
  await expect(taskCard).toContainText('8.5 hours')

  await taskCard.getByRole('button', { name: 'Archive' }).click()
  const assignmentArchive = page.locator('[data-task-assignment-archive-dialog]')
  await assignmentArchive.getByRole('button', { name: 'Archive assignment' }).click()
  await expect(taskCard).toContainText('Archived')

  await page.locator('[data-project-header-actions], .project-header-actions').getByRole('button', {
    name: 'Archive',
    exact: true,
  }).click()
  const projectArchive = page.locator('[data-project-archive-dialog]')
  await projectArchive.getByRole('button', { name: 'Archive project' }).click()
  await expect(page).toHaveURL(/\/projects$/u)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  const archivedRow = page.locator('[data-project-list] tbody tr[data-row]').filter({
    has: page.locator(`a[href="/projects/${projectId}"]`),
  })
  await expect(archivedRow).toContainText('Archived')
})

test('[e2e:task-admin] creates, edits, applies a default to a new project, and archives through real D1', async ({
  context,
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  const archiveRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname.startsWith('/api/v1/tasks/')
    ) {
      archiveRequests.push(request.url())
    }
  })
  await page.goto('/tasks')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.locator('[data-task-list]')).toContainText(
    'Browser Acceptance Task',
  )
  await expectPhoneControl(page.getByRole('button', { name: 'Add task' }))
  await expectPhoneControl(page.getByRole('button', { name: 'Active', exact: true }))
  await expectNoPageOverflow(page)

  await page.getByRole('button', { name: 'Add task' }).click()
  const formDialog = page.locator('[data-task-form-dialog]')
  await formDialog.getByLabel('Name').fill('Browser Default Task')
  await formDialog.getByLabel('Default hourly rate').fill('123.45')
  await formDialog.getByLabel('Automatically add to new projects').check()
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/tasks' &&
      response.request().method() === 'POST',
  )
  await formDialog.getByRole('button', { name: 'Add task' }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const createdTask = (await createdResponse.json()).data as { id: number }
  await expect(formDialog).toBeHidden()

  let row = page.locator('[data-task-list] tbody tr[data-row]').filter({
    hasText: 'Browser Default Task',
  })
  await expect(row).toContainText('$123.45/hour')
  await expect(row).toContainText('Added')
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await formDialog.getByLabel('Name').fill('Browser Default Task Updated')
  await formDialog.getByLabel('Default hourly rate').fill('150.05')
  await formDialog.getByLabel('Billable by default').uncheck()
  const updated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/tasks/${createdTask.id}` &&
      response.request().method() === 'PATCH',
  )
  await formDialog.getByRole('button', { name: 'Save task' }).click()
  expect((await updated).status()).toBe(200)
  row = page.locator('[data-task-list] tbody tr[data-row]').filter({
    hasText: 'Browser Default Task Updated',
  })
  await expect(row).toContainText('$150.05/hour')
  // Billable reads as a column value now rather than a sentence on the card.
  await expect(row.locator('td[data-column="billable"]')).toHaveText('No')

  const projectAssignment = await page.evaluate(async (taskId) => {
    const projectResponse = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 1,
        name: `Task admin default project ${taskId}`,
        code: `TASK-${taskId}`,
        billing_method: 'time_materials',
        bill_by: 'tasks',
      }),
    })
    const project = (await projectResponse.json()).data as { id: number }
    const assignmentsResponse = await fetch(
      `/api/v1/task-assignments?project_id=${project.id}&task_id=${taskId}&per_page=200`,
    )
    const assignments = (await assignmentsResponse.json()).data
    const cleanupResponse = await fetch(`/api/v1/projects/${project.id}`, {
      method: 'DELETE',
    })
    return {
      projectStatus: projectResponse.status,
      assignmentStatus: assignmentsResponse.status,
      cleanupStatus: cleanupResponse.status,
      assignments,
    }
  }, createdTask.id)
  expect(projectAssignment).toEqual({
    projectStatus: 201,
    assignmentStatus: 200,
    cleanupStatus: 204,
    assignments: [
      expect.objectContaining({
        task_id: createdTask.id,
        billable: false,
        hourly_rate_cents: 15_005,
        is_active: true,
      }),
    ],
  })

  await row.locator('.data-table-overflow > summary').click()
  await row.getByRole('button', { name: 'Archive' }).click()
  const archiveDialog = page.locator('[data-task-archive-dialog]')
  await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(archiveDialog).toBeHidden()
  expect(archiveRequests).toEqual([])

  await row.locator('.data-table-overflow > summary').click()
  await row.getByRole('button', { name: 'Archive' }).click()
  await archiveDialog.getByRole('button', { name: 'Close' }).click()
  await expect(archiveDialog).toBeHidden()
  expect(archiveRequests).toEqual([])

  await row.locator('.data-table-overflow > summary').click()
  await row.getByRole('button', { name: 'Archive' }).click()
  const archived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/tasks/${createdTask.id}` &&
      response.request().method() === 'DELETE',
  )
  await archiveDialog.getByRole('button', { name: 'Archive task' }).click()
  expect((await archived).status()).toBe(204)
  await expect(archiveDialog).toBeHidden()
  await expect(row).toHaveCount(0)
  expect(archiveRequests).toHaveLength(1)

  await page.getByRole('button', { name: 'All', exact: true }).click()
  const archivedRow = page.locator('[data-task-list] tbody tr[data-row]').filter({
    hasText: 'Browser Default Task Updated',
  })
  await expect(archivedRow).toContainText('Archived')
  await expect(archivedRow).toContainText('Edit or reactivate')
  await expectNoPageOverflow(page)

  const cleaned = await context.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'task-admin-cleanup' },
    headers: {
      'x-ezacto-browser-fixture-control': 'start-end-round-trip',
    },
  })
  expect(cleaned.status()).toBe(204)
})

test('[e2e:reports-ui] runs uninvoiced, client rollup, and project budget reports through real D1', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto(
    '/reports?report=uninvoiced&from=2026-08-01&to=2026-08-30',
  )
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const reports = page.locator('[data-reports-page]')
  await expect(reports).toBeVisible()
  await expect(page).toHaveTitle('ezacto — Reports')
  await expect(reports.getByRole('heading', { name: 'Uninvoiced work' })).toBeVisible()
  await expect(reports.locator('.report-currency-card')).toContainText('USD')
  const uninvoicedTotal = await page.evaluate(async () => {
    const response = await fetch(
      '/api/v1/reports/uninvoiced?from=2026-08-01&to=2026-08-30',
    )
    return (await response.json()).data.totals.find(
      (total: { currency: string }) => total.currency === 'USD',
    ).total_cents as number
  })
  await expect(reports.locator('.report-currency-card strong')).toHaveText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      uninvoicedTotal / 100,
    ),
  )
  for (const control of [
    reports.getByLabel('Report', { exact: true }),
    reports.getByLabel('From'),
    reports.getByLabel('To'),
    reports.getByLabel('Client (optional)'),
    reports.getByLabel('Project (optional)'),
    reports.getByRole('button', { name: 'Run report' }),
  ]) {
    await expectPhoneControl(control)
  }
  await expectNoPageOverflow(page)

  await reports.getByLabel('Report', { exact: true }).selectOption('client-rollup')
  await reports.getByLabel('Root client').selectOption({
    label: 'Browser Acceptance Client',
  })
  const runReport = reports.getByRole('button', { name: 'Run report' })
  await expect(runReport).toBeEnabled()
  await runReport.click()
  await expect(page).toHaveURL(
    /\/reports\?report=client-rollup&from=2026-08-01&to=2026-08-30&client_id=1$/u,
  )
  await expect(reports.getByRole('heading', { name: 'Client rollup' })).toBeVisible()
  // Scoped to the results, not the page: the filter form carries its own
  // "Root client" label and the selected client's name, so asserting either
  // against the whole page passes whether or not a report rendered at all.
  const rollup = reports.locator('[data-report-results]')
  // The rollup names the client and is the way into it, rather than an id.
  await expect(
    rollup.getByRole('link', { name: 'Browser Acceptance Client' }).first(),
  ).toHaveAttribute('href', '/clients/1')
  await expect(rollup).toContainText('Direct activity')
  await expect(rollup).toContainText('Including descendants')
  await expectNoPageOverflow(page)

  await reports.getByLabel('Report', { exact: true }).selectOption('project-budget')
  await reports.getByLabel('Project').selectOption({
    label: '[BROWSER] Browser Acceptance Project',
  })
  await reports.getByRole('button', { name: 'Run report' }).click()
  await expect(page).toHaveURL(
    /\/reports\?report=project-budget&from=2026-08-01&to=2026-08-30&project_id=1$/u,
  )
  await expect(reports.getByRole('heading', { name: 'Project budget' })).toBeVisible()
  await expect(
    reports.getByRole('link', { name: '[BROWSER] Browser Acceptance Project' }).first(),
  ).toHaveAttribute('href', '/projects/1')
  await expect(reports).toContainText('Budget4 h')
  const budgetSpent = await page.evaluate(async () => {
    const response = await fetch(
      '/api/v1/reports/project-budget/1?from=2026-08-01&to=2026-08-30',
    )
    return (await response.json()).data.grains[0].spent_seconds as number
  })
  await expect(reports).toContainText(
    `Spent${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(budgetSpent / 3_600)} h`,
  )
  await expectNoPageOverflow(page)
})

test('[e2e:expense-categories] [e2e:expense-receipt] manages category availability, history, and receipts through real D1 and R2', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/expense-categories')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const workspace = page.locator('[data-expense-categories-page]')
  await expect(workspace).toBeVisible()
  await expect(page).toHaveTitle('ezacto — Expense categories')
  const createCategory = page.locator('[data-expense-category-create-form]')
  await createCategory.getByLabel('Name', { exact: true }).fill('Browser UI Mileage')
  await createCategory.getByLabel('Entry method').selectOption('unit')
  await createCategory.getByLabel('Unit name').fill('km')
  await createCategory.getByLabel('Unit price (cents)').fill('42')
  const categoryCreated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/expense-categories' &&
      response.request().method() === 'POST',
  )
  await createCategory.getByRole('button', { name: 'Create category' }).click()
  const categoryResponse = await categoryCreated
  expect(categoryResponse.status()).toBe(201)
  const categoryId = Number((await categoryResponse.json()).data.id)
  expect(Number.isSafeInteger(categoryId)).toBe(true)
  const categoryRow = page.locator(
    `[data-expense-category-list] tbody tr[data-row-key="${categoryId}"]`,
  )
  await expect(categoryRow).toContainText('42 cents per km')
  await expectNoPageOverflow(page)

  await page.getByRole('link', { name: 'Back to expenses' }).click()
  const createExpense = page.locator('[data-expense-create-form]')
  await createExpense
    .getByLabel('Project')
    .selectOption({ label: '[BROWSER] Browser Acceptance Project' })
  await createExpense.getByLabel('Category').selectOption({ label: 'Browser UI Mileage' })
  await createExpense.getByLabel('Date').fill('2026-07-15')
  await createExpense.getByLabel('Units (km)').fill('3')
  await createExpense.getByLabel('Notes').fill('Historical category retention')
  const expenseCreated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/expenses' &&
      response.request().method() === 'POST',
  )
  await createExpense.getByRole('button', { name: 'Add expense' }).click()
  const expenseResponse = await expenseCreated
  expect(expenseResponse.status()).toBe(201)
  const expenseId = Number((await expenseResponse.json()).data.id)
  expect(Number.isSafeInteger(expenseId)).toBe(true)

  await page.goto('/expense-categories')
  await expect(categoryRow).toBeVisible()
  await categoryRow.locator('.data-table-overflow > summary').click()
  await categoryRow.getByRole('button', { name: 'Archive' }).click()
  const archiveDialog = page.locator('[data-expense-category-archive-dialog]')
  await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(archiveDialog).toBeHidden()
  await expect(categoryRow).toContainText('Active')

  await categoryRow.locator('.data-table-overflow > summary').click()
  await categoryRow.getByRole('button', { name: 'Archive' }).click()
  const archived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/expense-categories/${categoryId}` &&
      response.request().method() === 'PATCH',
  )
  await archiveDialog.getByRole('button', { name: 'Archive category' }).click()
  const archivedResponse = await archived
  expect(archivedResponse.status()).toBe(200)
  expect(archivedResponse.request().postDataJSON()).toEqual({ is_active: false })
  await expect(categoryRow).toBeHidden()
  await workspace.getByRole('button', { name: 'All', exact: true }).click()
  await expect(categoryRow).toContainText('Archived')

  await page.goto('/expenses')
  await expect(
    page.locator('[data-expense-create-category] option', { hasText: 'Browser UI Mileage' }),
  ).toHaveCount(0)
  await page.goto(`/expenses/${expenseId}`)
  const historicalCategory = page.locator(
    '[data-expense-edit-category] option:checked',
  )
  await expect(historicalCategory).toHaveText('Browser UI Mileage')
  await expect(page.locator('[data-expense-detail-total]')).toContainText('$1.26')
  await expect(page.locator('[data-expense-edit-form] [name="notes"]')).toHaveValue(
    'Historical category retention',
  )
  await expectNoPageOverflow(page)
  await test.step('preserves the expense receipt workflow', async () =>
    exerciseExpenseReceipt(page),
  )
})

const exerciseExpenseReceipt = async (page: Page): Promise<void> => {
  await page.goto('/expenses')

  const create = page.locator('[data-expense-create-form]')
  await expect(create).toBeVisible()
  await create.getByLabel('Project').selectOption({ label: '[BROWSER] Browser Acceptance Project' })
  await create.getByLabel('Category').selectOption({ label: 'Travel' })
  await create.getByLabel('Date').fill('2026-08-25')
  await create.getByLabel('Amount').fill('18.75')
  await create.getByLabel('Notes').fill('Airport shuttle receipt\nCustomer kickoff')
  await create.getByLabel('Billable').check()
  await create.getByLabel('Reimbursable').check()
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/expenses' &&
      response.request().method() === 'POST',
  )
  await create.getByRole('button', { name: 'Add expense' }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const createdBody = await createdResponse.json()
  const expenseId = Number(createdBody.data.id)
  expect(Number.isSafeInteger(expenseId)).toBe(true)

  const filters = page.locator('[data-expense-filter-form]')
  await filters.locator('input[name="from"]').fill('2026-08-25')
  await filters.locator('input[name="to"]').fill('2026-08-25')
  await filters.locator('select[name="client_id"]').selectOption({ label: 'Browser Acceptance Client' })
  await filters.locator('select[name="project_id"]').selectOption({ label: '[BROWSER] Browser Acceptance Project' })
  await filters.locator('select[name="expense_category_id"]').selectOption({ label: 'Travel' })
  await filters.locator('select[name="approval_status"]').selectOption('unsubmitted')
  await filters.locator('select[name="reimbursement_status"]').selectOption('none')
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/v1/expenses' &&
      response.request().method() === 'GET' &&
      url.searchParams.get('client_id') === '1' &&
      url.searchParams.get('expense_category_id') === '1'
    )
  })
  await filters.getByRole('button', { name: 'Apply filters' }).click()
  expect((await filtered).status()).toBe(200)
  await expect(page).toHaveURL(/\/expenses\?.*approval_status=unsubmitted/u)
  const row = page.locator(`[data-expense-list] tbody tr[data-row-key="${expenseId}"]`)
  await expect(row).toBeVisible()
  await expect(row).toContainText('Airport shuttle receipt')
  await expect(row).toContainText('$18.75')
  await expect(row).toContainText('Reimbursement: None')
  await expect(page.locator('[data-expense-list] .data-table-group')).toContainText(
    'Week of Aug 24, 2026',
  )
  await expectNoPageOverflow(page)

  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/expenses/${expenseId}$`, 'u'))
  const edit = page.locator('[data-expense-edit-form]')
  await expect(edit.getByLabel('Notes')).toHaveValue(/Customer kickoff/u)
  await expect(page.locator('[data-expense-detail-approval-fact]')).toHaveText('Unsubmitted')
  await edit.getByLabel('Notes').fill('Airport shuttle receipt\nReviewed detail')
  const updated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/expenses/${expenseId}` &&
      response.request().method() === 'PATCH',
  )
  await edit.getByRole('button', { name: 'Save expense' }).click()
  expect((await updated).status()).toBe(200)
  await expect(page.locator('[data-expense-edit-result]')).toHaveText('Expense saved.')

  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/expenses/${expenseId}/attachments` &&
      response.request().method() === 'POST',
  )
  await page
    .getByLabel('Attach a receipt')
    .setInputFiles({
      name: 'airport-shuttle.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('real R2 receipt bytes'),
    })
  await page.getByRole('button', { name: 'Upload receipt' }).click()
  expect((await uploaded).status()).toBe(201)
  const receiptLink = page.getByRole('link', { name: 'airport-shuttle.txt' })
  await expect(receiptLink).toBeVisible()
  const href = await receiptLink.getAttribute('href')
  expect(href).not.toBeNull()
  expect(await page.evaluate(async (path) => (await fetch(path)).text(), href!)).toBe(
    'real R2 receipt bytes',
  )

  await page.goto(
    '/expenses?from=2026-08-25&to=2026-08-25&client_id=1&project_id=1&expense_category_id=1&approval_status=unsubmitted&reimbursement_status=none',
  )
  await expect(
    page.locator(`[data-expense-list] tbody tr[data-row-key="${expenseId}"]`),
  ).toContainText('Reviewed detail')
}

test('[e2e:invoice-cycle] generates a real draft through the authenticated wizard', async ({
  page,
  request,
}) => {
  const seeded = await controlBrowserFixture(request, 'invoice-generation-seed')
  expect(seeded.status()).toBe(204)

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/invoices/new')

  await expect(page).toHaveTitle('ezacto — Sign in')
  await expect(page.locator('[data-invoice-generation-page]')).toBeHidden()
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const wizard = page.locator('[data-invoice-generation-page]')
  await expect(wizard).toBeVisible()
  await expect(page).toHaveTitle('ezacto — Generate invoice')
  await expect(wizard.getByRole('heading', { name: 'Generate an invoice' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(wizard.getByLabel('Client')).toHaveValue('1')
  await expect(wizard.getByLabel('From')).toHaveValue('2026-08-01')
  await expect(wizard.getByLabel('To')).toHaveValue('2026-08-30')
  const primaryProject = wizard.getByRole('checkbox', {
    name: 'Browser Acceptance Project',
    exact: true,
  })
  const secondaryProject = wizard.getByRole('checkbox', {
    name: 'Browser Secondary Project',
    exact: true,
  })
  await expect(primaryProject).toHaveCount(1)
  await expect(primaryProject).toHaveValue('1')
  await expect(secondaryProject).toHaveCount(1)
  await expect(secondaryProject).toHaveValue('2')
  await expectPhoneControl(
    primaryProject.locator('..'),
  )
  for (const projectChoice of await wizard.locator('input[name="project"]').all()) {
    await projectChoice.setChecked((await projectChoice.inputValue()) === '1')
  }
  await wizard.getByLabel('Expenses').selectOption('')
  for (const control of [
    wizard.getByLabel('Client'),
    wizard.getByLabel('From'),
    wizard.getByLabel('To'),
    wizard.getByLabel('Time entries'),
    wizard.getByLabel('Expenses'),
    wizard.getByRole('button', { name: 'Generate draft invoice' }),
  ]) {
    await expectPhoneControl(control)
  }
  await expectNoPageOverflow(page)

  const generated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/invoice-generations' &&
      response.request().method() === 'POST',
  )
  await wizard.getByRole('button', { name: 'Generate draft invoice' }).click()
  const generatedResponse = await generated
  expect(generatedResponse.status()).toBe(201)
  expect(generatedResponse.request().postDataJSON()).toMatchObject({
    client_id: 1,
    project_ids: [1],
  })
  const generatedPayload = (await generatedResponse.json()) as {
    data: { id: number; due_date: string }
  }

  await expect(page.locator('[data-invoice-generation-result]')).toHaveText(
    'Draft invoice generated successfully.',
  )
  const success = page.locator('[data-invoice-generation-success]')
  await expect(success).toBeVisible()
  await expect(success.locator('[data-generated-invoice-number]')).toHaveText(/^\d+$/u)
  await expect(success.locator('[data-generated-invoice-total]')).toContainText('$75.00')
  await expect(success.locator('[data-generated-invoice-total]')).toContainText('1 line')
  await expect(success).toContainText('The draft is saved and ready to review.')

  const generatedNumber = await success.locator('[data-generated-invoice-number]').innerText()
  await success.getByRole('link', { name: 'Open draft invoice' }).click()
  await expect(page).toHaveURL(/\/invoices\/\d+$/u)
  const detail = page.locator('[data-invoice-document]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-invoice-detail-number]')).toHaveText(generatedNumber)
  await expect(detail.locator('[data-invoice-detail-lines]')).toContainText(
    'Browser Acceptance Project',
  )
  await expect(detail.locator('[data-invoice-detail-total]')).toHaveText('$75.00')

  const invoiceId = generatedPayload.data.id
  const attachmentSection = page.locator('[data-invoice-attachment-form]')
  await expect(attachmentSection).toBeVisible()
  const attachUpload = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/invoices/${invoiceId}/attachments` &&
      response.request().method() === 'POST',
  )
  await page
    .getByLabel('Choose file')
    .setInputFiles({
      name: 'browser-invoice.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('invoice attachment content'),
    })
  await page.getByRole('button', { name: 'Upload' }).click()
  expect((await attachUpload).status()).toBe(201)
  const invoiceAttachment = page.getByRole('link', { name: 'browser-invoice.txt' })
  await expect(invoiceAttachment).toBeVisible()
  const invoiceAttachmentHref = await invoiceAttachment.getAttribute('href')
  expect(invoiceAttachmentHref).not.toBeNull()
  expect(
    await page.evaluate(async (href) => (await fetch(href)).text(), invoiceAttachmentHref!),
  ).toBe('invoice attachment content')

  const attachUpload2 = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/invoices/${invoiceId}/attachments` &&
      response.request().method() === 'POST',
  )
  await page
    .getByLabel('Choose file')
    .setInputFiles({
      name: 'browser-invoice-2.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('second attachment content'),
    })
  await page.getByRole('button', { name: 'Upload' }).click()
  expect((await attachUpload2).status()).toBe(201)
  await expect(page.locator('[data-invoice-attachment-status]')).toContainText('2 files attached')

  await detail.getByRole('button', { name: 'Mark sent', exact: true }).click()
  const composer = page.locator('[data-invoice-composer-dialog]')
  await expect(composer).toBeVisible()
  await expect(composer).toContainText('%invoice_number%')
  await expect(composer).toContainText('%invoice_amount%')
  await composer.getByLabel('Recipients').fill('Accounts Payable <ap@example.test>')
  await composer.getByLabel('Subject').fill('Invoice %invoice_number%')
  await composer
    .locator('[data-invoice-composer-body]')
    .fill('Invoice #%invoice_id% totals %invoice_amount% and is due %invoice_due_date%.')
  await composer.getByLabel('Record a planned reminder date').check()
  await composer.locator('[data-invoice-composer-reminder-date]').fill('2099-09-30')
  for (const control of [
    composer.getByLabel('Recipients'),
    composer.getByLabel('Subject'),
    composer.locator('[data-invoice-composer-body]'),
    composer.getByRole('button', { name: 'Mark sent', exact: true }),
  ]) {
    await expectPhoneControl(control)
  }
  await expectNoPageOverflow(page)
  const sent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.match(/^\/api\/v1\/invoices\/\d+\/transitions$/u) !==
        null && response.request().method() === 'POST',
  )
  await composer.getByRole('button', { name: 'Mark sent', exact: true }).click()
  const sentResponse = await sent
  expect(sentResponse.status()).toBe(201)
  expect(sentResponse.request().postDataJSON()).toMatchObject({
    command: 'send',
    recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
    subject: `Invoice ${generatedNumber}`,
    body: `Invoice #${generatedPayload.data.id} totals $75.00 and is due ${generatedPayload.data.due_date}.`,
    attach_pdf: false,
    send_me_a_copy: false,
    thank_you: false,
    reminder: true,
    send_reminder_on: '2099-09-30',
  })
  await expect(composer).toBeHidden()
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Open')
  await expect(detail.locator('[data-invoice-reminder-line]')).toContainText(
    'Sep 30, 2099',
  )
  await expect(detail.locator('[data-invoice-detail-messages]')).toContainText(
    `Invoice #${generatedPayload.data.id} totals $75.00`,
  )

  await page.getByRole('link', { name: 'Back to invoices' }).click()
  await expect(page).toHaveURL(/\/invoices$/u)
  const generatedRow = page.locator(
    `[data-invoice-list] tbody tr[data-row-key="${generatedPayload.data.id}"]`,
  )
  await expect(generatedRow).toBeVisible()
  await expect(generatedRow).toContainText('$75.00')
})

test('[e2e:invoice-lines] adds, edits, and deletes exact lines through the real worker and D1', async ({
  context,
  page,
}) => {
  const seeded = await context.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'invoice-line-seed' },
    headers: {
      'x-ezacto-browser-fixture-control': 'start-end-round-trip',
    },
  })
  expect(seeded.status()).toBe(204)

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/invoices/new')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.locator('[data-sign-in-form]').getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  const draft = await page.evaluate(async () => {
    const response = await fetch('/api/v1/invoice-generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-invoice-lines-generate',
      },
      body: JSON.stringify({
        client_id: 1,
        from: '2026-08-14',
        to: '2026-08-14',
        project_ids: [1],
        time_summary_type: 'project',
        expense_summary_type: null,
      }),
    })
    if (!response.ok) throw new Error(`invoice generation failed: ${response.status}`)
    const body = (await response.json()) as {
      data: { id: number; version: number; amount_cents: number; currency: string }
    }
    const financials = await fetch(`/api/v1/invoices/${body.data.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-invoice-lines-financials',
      },
      body: JSON.stringify({
        expected_version: body.data.version,
        tax_rate_ppm: 100_000,
        tax2_rate_ppm: null,
        discount_rate_ppm: 0,
      }),
    })
    if (!financials.ok) throw new Error(`invoice financial edit failed: ${financials.status}`)
    const financialBody = (await financials.json()) as {
      data: { invoice: { id: number; version: number; amount_cents: number; currency: string } }
    }
    const sent = await fetch(`/api/v1/invoices/${body.data.id}/transitions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-invoice-lines-open',
      },
      body: JSON.stringify({
        command: 'send',
        expected_version: financialBody.data.invoice.version,
      }),
    })
    if (!sent.ok) throw new Error(`invoice transition failed: ${sent.status}`)
    const sentBody = (await sent.json()) as {
      data: { invoice: { id: number; version: number; amount_cents: number; currency: string } }
    }
    const paid = await fetch(`/api/v1/invoices/${body.data.id}/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-invoice-lines-payment',
      },
      body: JSON.stringify({
        expected_version: sentBody.data.invoice.version,
        amount_cents: sentBody.data.invoice.amount_cents,
        currency: sentBody.data.invoice.currency,
        paid_date: '2026-08-30',
        notes: 'Payment-state reconciliation fixture',
      }),
    })
    if (!paid.ok) throw new Error(`invoice payment failed: ${paid.status}`)
    const paidBody = (await paid.json()) as {
      data: {
        invoice: {
          id: number
          version: number
          amount_cents: number
          due_amount_cents: number
          state: string
        }
      }
    }
    return paidBody.data.invoice
  })
  expect(draft.amount_cents).toBe(7_500)
  expect(draft.due_amount_cents).toBe(0)
  expect(draft.state).toBe('paid')
  await page.goto(`/invoices/${draft.id}`)

  const detail = page.locator('[data-invoice-document]')
  const add = detail.getByRole('button', { name: 'Add line', exact: true })
  const editor = page.locator('[data-invoice-line-dialog]')
  await expect(detail).toBeVisible()
  await expectPhoneControl(add)
  await add.click()
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toBeHidden()
  await expect(detail.locator('[data-invoice-line-id]')).toHaveCount(1)
  await add.click()
  await editor.getByRole('button', { name: 'Close invoice line dialog' }).click()
  await expect(editor).toBeHidden()
  await expect(detail.locator('[data-invoice-line-id]')).toHaveCount(1)

  const commandIds: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/invoices/${draft.id}/line-items`
    ) {
      commandIds.push(request.headers()['idempotency-key'] ?? '')
    }
  })
  await page.route(
    `**/api/v1/invoices/${draft.id}/line-items`,
    async (route) => {
      const committed = await route.fetch()
      expect(committed.status()).toBe(201)
      await route.abort('failed')
    },
    { times: 1 },
  )

  await add.click()
  await editor.getByLabel('Item type').fill('Consulting')
  await editor.getByLabel('Description').fill('Exact tenth-hour adjustment')
  await editor.getByLabel('Quantity').fill('0.1')
  await editor.getByLabel('Rate (USD)').fill('1.05')
  await editor.getByLabel('Apply tax 1').check()
  await expect(editor.locator('[data-invoice-line-preview]')).toHaveText('$0.11')
  for (const control of [
    editor.getByLabel('Item type'),
    editor.getByLabel('Description'),
    editor.getByLabel('Quantity'),
    editor.getByLabel('Rate (USD)'),
    editor.getByRole('button', { name: 'Add line', exact: true }),
  ]) {
    await expectPhoneControl(control)
  }
  await expectNoPageOverflow(page)

  await editor.getByRole('button', { name: 'Add line', exact: true }).click()
  await expect(editor.locator('[data-invoice-line-result]')).not.toHaveText('')
  await expect(editor).toBeVisible()
  const retried = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/invoices/${draft.id}/line-items` &&
      response.request().method() === 'POST',
  )
  await editor.getByRole('button', { name: 'Add line', exact: true }).click()
  expect((await retried).status()).toBe(201)
  await expect(editor).toBeHidden()
  expect(commandIds).toHaveLength(2)
  expect(commandIds[0]).not.toBe('')
  expect(commandIds[0]).toBe(commandIds[1])

  const createdRow = detail.locator('[data-invoice-line-id]', { hasText: 'Consulting' })
  await expect(createdRow).toHaveCount(1)
  await expect(createdRow).toContainText('Exact tenth-hour adjustment')
  await expect(createdRow).toContainText('$0.11')
  await expect(detail.locator('[data-invoice-detail-total]')).toHaveText('$75.12')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$0.12')
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Open')
  await expectNoPageOverflow(page)

  const persistedCreated = await page.evaluate(async (invoiceId) => {
    const response = await fetch(`/api/v1/invoices/${invoiceId}`)
    return (await response.json()) as {
      data: {
        version: number
        amount_cents: number
        due_amount_cents: number
        tax_amount_cents: number
        line_items: Array<{
          id: number
          kind: string
          quantity: number
          unit_price_cents: number
          amount_cents: number
          taxed: boolean
          updated_at: string
        }>
      }
    }
  }, draft.id)
  expect(persistedCreated.data.amount_cents).toBe(7_512)
  expect(persistedCreated.data.due_amount_cents).toBe(12)
  expect(persistedCreated.data.tax_amount_cents).toBe(1)
  const createdLine = persistedCreated.data.line_items.find((line) => line.kind === 'Consulting')!
  expect(createdLine).toMatchObject({
    quantity: 0.1,
    unit_price_cents: 105,
    amount_cents: 11,
    taxed: true,
  })

  await createdRow.getByRole('button', { name: 'Edit' }).click()
  await editor.getByLabel('Description').fill('Updated fractional adjustment')
  await editor.getByLabel('Quantity').fill('1.5')
  await editor.getByLabel('Rate (USD)').fill('2.05')
  await expect(editor.locator('[data-invoice-line-preview]')).toHaveText('$3.08')
  const updated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/invoices/${draft.id}/line-items/${createdLine.id}` &&
      response.request().method() === 'PATCH',
  )
  await editor.getByRole('button', { name: 'Save line', exact: true }).click()
  const updatedResponse = await updated
  expect(updatedResponse.status()).toBe(200)
  expect(updatedResponse.request().postDataJSON()).toMatchObject({
    expected_version: persistedCreated.data.version,
    expected_updated_at: createdLine.updated_at,
    kind: 'Consulting',
    quantity: 1.5,
    unit_price_cents: 205,
  })
  await expect(editor).toBeHidden()
  await expect(detail.locator('[data-invoice-detail-total]')).toHaveText('$78.39')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$3.39')

  const updatedRow = detail.locator('[data-invoice-line-id]', { hasText: 'Consulting' })
  await updatedRow.getByRole('button', { name: 'Delete' }).click()
  const confirmation = page.locator('[data-invoice-line-delete-dialog]')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
  await expect(updatedRow).toHaveCount(1)
  await updatedRow.getByRole('button', { name: 'Delete' }).click()
  await confirmation.getByRole('button', { name: 'Close delete line dialog' }).click()
  await expect(confirmation).toBeHidden()
  await expect(updatedRow).toHaveCount(1)
  await updatedRow.getByRole('button', { name: 'Delete' }).click()
  const deleted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/invoices/${draft.id}/line-items/${createdLine.id}` &&
      response.request().method() === 'DELETE',
  )
  await confirmation.getByRole('button', { name: 'Delete line', exact: true }).click()
  expect((await deleted).status()).toBe(200)
  await expect(confirmation).toBeHidden()
  await expect(detail.locator('[data-invoice-line-id]')).toHaveCount(1)
  await expect(detail.locator('[data-invoice-detail-total]')).toHaveText('$75.00')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$0.00')
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Paid')

  const persistedDeleted = await page.evaluate(async (invoiceId) => {
    const response = await fetch(`/api/v1/invoices/${invoiceId}`)
    return (await response.json()) as {
      data: { amount_cents: number; due_amount_cents: number; line_items: Array<{ id: number }> }
    }
  }, draft.id)
  expect(persistedDeleted.data.amount_cents).toBe(7_500)
  expect(persistedDeleted.data.due_amount_cents).toBe(0)
  expect(persistedDeleted.data.line_items.some((line) => line.id === createdLine.id)).toBe(false)
})

test('[e2e:invoice-cycle] records a final payment and restores the open balance on delete', async ({
  context,
  page,
}) => {
  const seeded = await context.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'invoice-payment-seed' },
    headers: {
      'x-ezacto-browser-fixture-control': 'start-end-round-trip',
    },
  })
  expect(seeded.status()).toBe(204)

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/invoices/new')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  const openedInvoice = await page.evaluate(async () => {
    const generated = await fetch('/api/v1/invoice-generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-payment-cycle-generate',
      },
      body: JSON.stringify({
        client_id: 1,
        from: '2026-08-15',
        to: '2026-08-15',
        project_ids: [1],
        time_summary_type: 'project',
        expense_summary_type: null,
      }),
    })
    if (!generated.ok) throw new Error(`invoice generation failed: ${generated.status}`)
    const generatedBody = (await generated.json()) as {
      data: { id: number; version: number; amount_cents: number }
    }
    const sent = await fetch(`/api/v1/invoices/${generatedBody.data.id}/transitions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'browser-payment-cycle-open',
      },
      body: JSON.stringify({
        command: 'send',
        expected_version: generatedBody.data.version,
      }),
    })
    if (!sent.ok) throw new Error(`invoice transition failed: ${sent.status}`)
    const sentBody = (await sent.json()) as {
      data: { invoice: { id: number; version: number; amount_cents: number } }
    }
    return sentBody.data.invoice
  })
  expect(openedInvoice.amount_cents).toBe(7_500)
  await page.goto(`/invoices/${openedInvoice.id}`)

  const detail = page.locator('[data-invoice-document]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Open')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$75.00')
  const record = detail.getByRole('button', { name: 'Record payment' })
  await expectPhoneControl(record)
  await record.click()

  const paymentDialog = page.locator('[data-invoice-payment-dialog]')
  await expect(paymentDialog).toBeVisible()
  await expect(paymentDialog.getByLabel('Amount')).toHaveValue('75.00')
  await expect(paymentDialog.getByLabel('Currency')).toHaveValue('USD')
  await expect(paymentDialog.getByLabel('Payment timing')).toHaveValue('date')
  await paymentDialog.getByLabel('Paid date').fill('2026-08-30')
  await paymentDialog.getByLabel('Notes').fill('Final payment from browser acceptance')
  await expect(paymentDialog).toContainText('No email or thank-you message will be sent.')
  for (const control of [
    paymentDialog.getByLabel('Amount'),
    paymentDialog.getByLabel('Currency'),
    paymentDialog.getByLabel('Payment timing'),
    paymentDialog.getByLabel('Paid date'),
    paymentDialog.getByLabel('Notes'),
    paymentDialog.getByRole('button', { name: 'Record payment' }),
  ]) {
    await expectPhoneControl(control)
  }
  await expectNoPageOverflow(page)

  const recorded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/invoices/${openedInvoice.id}/payments` &&
      response.request().method() === 'POST',
  )
  await paymentDialog.getByRole('button', { name: 'Record payment' }).click()
  const recordedResponse = await recorded
  expect(recordedResponse.status()).toBe(201)
  expect(recordedResponse.request().postDataJSON()).toEqual({
    expected_version: openedInvoice.version,
    amount_cents: 7_500,
    currency: 'USD',
    paid_date: '2026-08-30',
    notes: 'Final payment from browser acceptance',
  })
  await expect(paymentDialog).toBeHidden()
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Paid')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$0.00')
  const paymentRow = detail.locator('[data-invoice-payment-id]')
  await expect(paymentRow).toHaveCount(1)
  await expect(paymentRow).toContainText('$75.00')
  await expect(paymentRow).toContainText('Method: Manual')
  await expect(paymentRow).toContainText('Final payment from browser acceptance')
  await expect(record).toBeDisabled()

  const deleteRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname.startsWith(
        `/api/v1/invoices/${openedInvoice.id}/payments/`,
      )
    ) {
      deleteRequests.push(request.url())
    }
  })
  await paymentRow.getByRole('button', { name: 'Delete' }).click()
  const confirmation = page.locator('[data-invoice-payment-delete-dialog]')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
  expect(deleteRequests).toEqual([])

  await paymentRow.getByRole('button', { name: 'Delete' }).click()
  await confirmation.getByRole('button', { name: 'Close delete payment dialog' }).click()
  await expect(confirmation).toBeHidden()
  expect(deleteRequests).toEqual([])

  await paymentRow.getByRole('button', { name: 'Delete' }).click()
  const deleted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(
        `/api/v1/invoices/${openedInvoice.id}/payments/`,
      ) &&
      response.request().method() === 'DELETE',
  )
  await confirmation
    .getByRole('button', { name: 'Delete payment', exact: true })
    .click()
  expect((await deleted).status()).toBe(200)
  await expect(confirmation).toBeHidden()
  await expect(detail.locator('[data-invoice-detail-state]')).toHaveText('Open')
  await expect(detail.locator('[data-invoice-detail-due]')).toHaveText('$75.00')
  await expect(detail.locator('[data-invoice-detail-payments]')).toContainText(
    'No payments recorded.',
  )
})

test('[e2e:timesheet-approval] [e2e:lock-policy] rejects, approves, reopens, policy-locks, and unlocks a real D1 timesheet', async ({
  context,
  page,
}) => {
  const seeded = await context.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'approval-seed' },
    headers: {
      'x-ezacto-browser-fixture-control': 'start-end-round-trip',
    },
  })
  expect(seeded.status()).toBe(204)

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/?week=2026-08-17')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Monday, Aug 17')
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Tuesday, Aug 18')
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Wednesday, Aug 19')

  const status = page.locator('[data-timesheet-status]')
  await expect(status).toBeVisible()
  await expect(page.locator('[data-timesheet-status-label]')).toHaveText('Not submitted')
  const submitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/timesheet-submissions' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Submit week' }).click()
  expect((await submitted).status()).toBe(201)
  await expect(page.locator('[data-timesheet-status-label]')).toHaveText('Submitted for approval')
  await expect(page.locator('[data-day-rows] input[data-cell-key]')).toBeEnabled()

  await page.goto('/approvals')
  await expect(page).toHaveTitle('ezacto — Approvals')
  const card = page.locator('[data-approval-queue] [data-submission-id]')
  await expect(card).toContainText('Browser Owner')
  await expect(card).toContainText('1.00')
  await expect(card).toContainText('Browser Acceptance Project / Browser Acceptance Task')
  await expect(card).toContainText('Wed, Aug 19')
  await expect(card).toContainText('Ready for review')
  await expect(card).toContainText('1 expense')
  await expect(card).toContainText('Browser Acceptance Project / Travel')
  await expect(card).toContainText('$12.50')
  await expect(card).toContainText('Receipt ready for review')
  await card.getByRole('button', { name: 'Reject' }).click()

  const rejection = page.locator('[data-rejection-dialog]')
  await expect(rejection).toBeVisible()
  await rejection.getByRole('button', { name: 'Reject timesheet' }).click()
  await expect(page.locator('[data-rejection-result]')).toHaveText(
    'Enter a reason before rejecting this timesheet.',
  )
  await rejection.getByLabel('What needs to change?').fill('Clarify the delivery detail.')
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/reject') &&
      response.request().method() === 'POST',
  )
  await rejection.getByRole('button', { name: 'Reject timesheet' }).click()
  expect((await rejected).ok()).toBe(true)
  await expect(rejection).toBeHidden()

  await page.goto('/?week=2026-08-17')
  await expect(page.locator('[data-timesheet-status-label]')).toHaveText('Changes requested')
  await expect(page.locator('[data-timesheet-rejection-reason]')).toHaveText(
    'Needs changes: Clarify the delivery detail.',
  )
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Tuesday, Aug 18')
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Wednesday, Aug 19')

  const entryRow = page.locator('[data-day-rows] .day-row').filter({
    has: page.locator('[data-entry-note="901"]'),
  })
  await entryRow.locator('.cell-note').click()
  const editor = page.locator('[data-entry-dialog]')
  await editor.getByLabel('Note').fill('Corrected delivery detail')
  const corrected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/time-entries/901' &&
      response.request().method() === 'PATCH',
  )
  await editor.getByRole('button', { name: 'Save entry' }).click()
  expect((await corrected).ok()).toBe(true)
  await expect(editor).toBeHidden()
  await expect(page.locator('[data-day-label]')).toContainText('Wednesday, Aug 19')
  await expect(page.locator('[data-entry-note="901"]')).toHaveText('Corrected delivery detail')
  const rejectedExpense = await page.evaluate(async () => {
    const response = await fetch('/api/v1/expenses/901')
    return { status: response.status, body: await response.json() }
  })
  expect(rejectedExpense.status).toBe(200)
  expect(rejectedExpense.body).toMatchObject({
    data: { approval_status: 'unsubmitted', is_locked: false },
  })

  const resubmitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/timesheet-submissions' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Resubmit week' }).click()
  expect((await resubmitted).ok()).toBe(true)
  await expect(page.locator('[data-timesheet-rejection-reason]')).toBeHidden()

  await page.goto('/approvals')
  const resubmittedCard = page.locator('[data-approval-queue] [data-submission-id]')
  await expect(resubmittedCard).toContainText('Browser Owner')
  const approved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/approve') &&
      response.request().method() === 'POST',
  )
  await resubmittedCard.getByRole('button', { name: 'Approve' }).click()
  expect((await approved).ok()).toBe(true)
  await expect(page.locator('[data-approval-queue]')).toContainText(
    'No timesheets are waiting for review.',
  )

  await page.goto('/?week=2026-08-17')
  await expect(page.locator('[data-timesheet-status-label]')).toHaveText('Approved')
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Tuesday, Aug 18')
  await page.getByRole('button', { name: 'Next day' }).click()
  const lockedCell = page.locator('[data-day-rows] input[data-cell-key]')
  await expect(lockedCell).toBeDisabled()
  await expect(page.locator('[data-day-rows] [data-locked-reason]')).toBeVisible()
  await expect(page.locator('[data-entry-note="901"]')).toHaveText('Corrected delivery detail')
  const approvedExpense = await page.evaluate(async () => {
    const response = await fetch('/api/v1/expenses/901')
    return { status: response.status, body: await response.json() }
  })
  expect(approvedExpense.status).toBe(200)
  expect(approvedExpense.body).toMatchObject({
    data: {
      approval_status: 'approved',
      is_locked: true,
      locked_reason_code: 'approved',
      notes: 'Receipt ready for review',
    },
  })

  await page.goto('/approvals')
  const approvedCard = page
    .locator('[data-approval-history] [data-approved-submission-id]')
    .filter({ hasText: 'Browser Owner' })
  await expect(approvedCard).toContainText('Sun, Aug 16 – Sat, Aug 22')
  await approvedCard.getByRole('button', { name: 'Reopen' }).click()

  const withdrawal = page.locator('[data-withdrawal-dialog]')
  await expect(withdrawal).toBeVisible()
  await withdrawal.getByRole('button', { name: 'Reopen timesheet' }).click()
  await expect(page.locator('[data-withdrawal-result]')).toHaveText(
    'Enter a reason before reopening this timesheet.',
  )
  await withdrawal
    .getByLabel('Why is this period being reopened?')
    .fill('Correct work before the monthly close.')
  const reopened = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/withdraw') &&
      response.request().method() === 'POST',
  )
  await withdrawal.getByRole('button', { name: 'Reopen timesheet' }).click()
  const reopenedResponse = await reopened
  expect(reopenedResponse.ok()).toBe(true)
  expect(await reopenedResponse.json()).toMatchObject({
    data: {
      status: 'unsubmitted',
      rejection_reason: 'Correct work before the monthly close.',
    },
  })
  await expect(withdrawal).toBeHidden()
  await expect(page.locator('[data-approval-history]')).toContainText(
    'No approved timesheets are available to reopen.',
  )
  const reopenedResources = await page.evaluate(async () => {
    const [entry, expense] = await Promise.all([
      fetch('/api/v1/time-entries/901'),
      fetch('/api/v1/expenses/901'),
    ])
    return {
      entry: { status: entry.status, body: await entry.json() },
      expense: { status: expense.status, body: await expense.json() },
    }
  })
  expect(reopenedResources).toMatchObject({
    entry: {
      status: 200,
      body: { data: { approval_status: 'unsubmitted', is_locked: false } },
    },
    expense: {
      status: 200,
      body: { data: { approval_status: 'unsubmitted', is_locked: false } },
    },
  })

  const policyPanel = page.locator('[data-lock-policy-panel]')
  await expect(policyPanel).toBeVisible()
  await policyPanel.locator('[data-lock-policy-auto]').uncheck()
  await policyPanel.locator('[data-lock-policy-day]').selectOption('friday')
  await policyPanel.locator('[data-lock-policy-time]').fill('16:45')
  await policyPanel.locator('[data-lock-policy-timezone]').fill('America/Costa_Rica')
  const policySaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/timesheet-lock-policy' &&
      response.request().method() === 'PATCH',
  )
  await policyPanel.getByRole('button', { name: 'Save policy' }).click()
  const policyResponse = await policySaved
  expect(policyResponse.ok()).toBe(true)
  expect(policyResponse.request().postDataJSON()).toEqual({
    auto_lock: false,
    timesheet_deadline: { day: 'friday', time: '16:45' },
    timezone: 'America/Costa_Rica',
  })
  expect(await policyResponse.json()).toMatchObject({
    data: {
      auto_lock: false,
      timesheet_deadline: { day: 'friday', time: '16:45' },
      timezone: 'America/Costa_Rica',
    },
  })
  await expect(page.locator('[data-lock-policy-result]')).toHaveText(
    'Automatic locking disabled. Existing lock records remain in effect.',
  )

  await policyPanel.locator('[data-manual-lock-through]').fill('2026-08-19')
  await policyPanel
    .locator('[data-manual-lock-reason]')
    .fill('Monthly close verification')
  const manualLocked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/timesheet-locks' &&
      response.request().method() === 'POST',
  )
  await policyPanel.getByRole('button', { name: 'Create lock' }).click()
  const manualLockResponse = await manualLocked
  expect(manualLockResponse.status()).toBe(201)
  const manualLockBody = (await manualLockResponse.json()) as {
    data: { id: number }
  }
  expect(manualLockBody).toMatchObject({
    data: {
      kind: 'manual',
      period_start: null,
      period_end: '2026-08-19',
      reason: 'Monthly close verification',
      active: true,
    },
  })
  const manualLockCard = page.locator(
    `[data-timesheet-lock-list] [data-lock-id="${manualLockBody.data.id}"]`,
  )
  await expect(manualLockCard).toContainText('Manual cutoff')
  await expect(manualLockCard).toContainText('Monthly close verification')

  await page.goto('/?week=2026-08-17')
  await expect(page.locator('[data-day-label]')).toContainText('Monday, Aug 17')
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-day-label]')).toContainText('Wednesday, Aug 19')
  const policyLockedRow = page.locator('[data-day-rows] .day-row').filter({
    has: page.locator('[data-entry-note="901"]'),
  })
  const policyLockedCell = policyLockedRow.locator('[data-cell-state="locked"]')
  await expect(policyLockedCell).toBeVisible()
  await expect(policyLockedCell.locator('input')).toBeDisabled()
  await expect(policyLockedCell.locator('input')).toHaveAttribute('title', 'Locked by policy')
  await expect(policyLockedCell.locator('[data-locked-reason]')).toHaveText('Locked by policy')
  await expect(policyLockedCell.locator('.cell-note')).toBeDisabled()

  const refusedEdit = await page.evaluate(async () => {
    const response = await fetch('/api/v1/time-entries/901', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: 7200 }),
    })
    return { status: response.status, body: await response.json() }
  })
  expect(refusedEdit).toMatchObject({
    status: 422,
    body: {
      error: {
        code: 'tracked_mutation_locked',
        fields: [{ code: 'policy_locked' }],
      },
    },
  })
  const unchanged = await page.evaluate(async () => {
    const response = await fetch('/api/v1/time-entries/901')
    return response.json()
  })
  expect(unchanged).toMatchObject({ data: { seconds: 3600, is_locked: true } })

  await page.goto('/approvals')
  const activeLockCard = page.locator(
    `[data-timesheet-lock-list] [data-lock-id="${manualLockBody.data.id}"]`,
  )
  await activeLockCard
    .locator(`[data-lock-unlock-reason="${manualLockBody.data.id}"]`)
    .fill('Correction window opened')
  const unlocked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/timesheet-locks/${manualLockBody.data.id}/unlock` &&
      response.request().method() === 'POST',
  )
  await activeLockCard.getByRole('button', { name: 'Unlock' }).click()
  const unlockResponse = await unlocked
  expect(unlockResponse.ok()).toBe(true)
  expect(await unlockResponse.json()).toMatchObject({
    data: {
      id: manualLockBody.data.id,
      active: false,
      unlock_reason: 'Correction window opened',
    },
  })
  await expect(page.locator('[data-lock-policy-result]')).toHaveText(
    'Tracked work unlocked. The reason was added to the audit trail.',
  )
  await expect(activeLockCard).toHaveCount(0)

  await page.goto('/?week=2026-08-17')
  await expect(page.locator('[data-day-label]')).toContainText('Monday, Aug 17')
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Next day' }).click()
  const unlockedRow = page.locator('[data-day-rows] .day-row').filter({
    has: page.locator('[data-entry-note="901"]'),
  })
  const unlockedInput = unlockedRow.locator('input[data-cell-key]')
  await expect(unlockedInput).toBeEnabled()
  const edited = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/time-entries/901' &&
      response.request().method() === 'PATCH',
  )
  await unlockedInput.fill('1.25')
  await unlockedInput.press('Enter')
  expect((await edited).ok()).toBe(true)
  await expect(unlockedInput).toHaveValue('1.25')
  const editedEntry = await page.evaluate(async () => {
    const response = await fetch('/api/v1/time-entries/901')
    return response.json()
  })
  expect(editedEntry).toMatchObject({
    data: { seconds: 4500, approval_status: 'unsubmitted', is_locked: false },
  })
})

test('[e2e:timesheet-approval] submits and approves an expense-only week', async ({
  context,
  page,
}) => {
  const seeded = await context.request.post('/__ezacto_browser_fixture__/start-end', {
    data: { action: 'approval-expense-only-seed' },
    headers: {
      'x-ezacto-browser-fixture-control': 'start-end-round-trip',
    },
  })
  expect(seeded.status()).toBe(204)

  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/?week=2026-08-09')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password').fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('[data-timesheet-status]')).toBeVisible()
  await expect(page.locator('[data-timesheet-status-label]')).toHaveText('Not submitted')
  const periodTime = await page.evaluate(async () => {
    const response = await fetch('/api/v1/time-entries?from=2026-08-09&to=2026-08-15')
    return { status: response.status, body: await response.json() }
  })
  expect(periodTime.status).toBe(200)
  expect(periodTime.body).toMatchObject({ data: [] })
  await expect(page.getByRole('button', { name: 'Submit week' })).toBeEnabled()

  const submitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/timesheet-submissions' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Submit week' }).click()
  const submittedResponse = await submitted
  expect(submittedResponse.status()).toBe(201)
  expect(await submittedResponse.json()).toMatchObject({
    data: { entry_count: 0, expense_count: 1 },
  })
  await page.goto('/approvals')
  const card = page.locator('[data-approval-queue] [data-submission-id]')
  await expect(card).toContainText('1 expense')
  await expect(card).toContainText('Browser Acceptance Project / Travel')
  await expect(card).toContainText('Wed, Aug 12')
  await expect(card).toContainText('$8.75')
  await expect(card).toContainText('Expense-only receipt')
  const approved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/approve') &&
      response.request().method() === 'POST',
  )
  await card.getByRole('button', { name: 'Approve' }).click()
  expect((await approved).ok()).toBe(true)
  const expense = await page.evaluate(async () => {
    const response = await fetch('/api/v1/expenses/902')
    return { status: response.status, body: await response.json() }
  })
  expect(expense.status).toBe(200)
  expect(expense.body).toMatchObject({
    data: { approval_status: 'approved', is_locked: true, locked_reason_code: 'approved' },
  })
})
