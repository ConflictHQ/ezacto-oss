import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
test('native calendar consent, sync and disconnect preserve provider cleanup and session privacy', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.EZACTO_BROWSER_CALENDAR_FIXTURE !== '1',
    'Owned calendar provider fixture only',
  )
  const origin = `http://localhost:${process.env.EZACTO_BROWSER_PORT}`
  let providerRedirects = 0
  let requesterStored = false
  let requesterSent = false
  page.on('request', async (request) => {
    if (new URL(request.url()).pathname.endsWith('/calendar-connections/google/callback'))
      requesterSent = /(?:^|;\s*)__Host-ezacto_calendar_google=/.test(
        (await request.allHeaders())['cookie'] ?? '',
      )
  })
  await page.route('https://accounts.google.com/**', async (route) => {
    requesterStored = (await page.context().cookies()).some(
      (c) => c.name === '__Host-ezacto_calendar_google',
    )
    const url = new URL(route.request().url())
    expect(url.searchParams.get('scope')).toContain('calendar.readonly')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    expect(callback.origin).toBe(origin)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    callback.searchParams.set('code', 'owned-calendar-code')
    providerRedirects++
    await route.fulfill({ status: 302, headers: { location: callback.href }, body: '' })
  })
  await page.goto('/settings/user#calendars')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const section = page.locator('[data-calendar-connections]')
  const google = section.locator('[data-calendar-provider=google]')
  await expect(google.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await google.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.waitForURL(/settings\/user\?calendar=/)
  const diagnostic = await (
    await request.post(`${origin}/__ezacto_browser_fixture__/start-end`, {
      headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
      data: { action: 'calendar-oauth-receipt' },
    })
  ).json()
  await writeFile(
    testInfo.outputPath('stage-counts.json'),
    JSON.stringify({ ...diagnostic, requesterStored, requesterSent }),
  )
  await testInfo.attach('calendar-stage-counts', {
    body: JSON.stringify({
      ...diagnostic,
      cookie_names: (await page.context().cookies()).map((c) => c.name),
    }),
    contentType: 'application/json',
  })
  expect(new URL(page.url()).searchParams.get('calendar')).toBe('connected')
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Calendar consent completed',
  )
  expect(providerRedirects).toBe(1)
  await expect(google.getByRole('button', { name: 'Sync calendar', exact: true })).toBeVisible()
  await google.getByRole('button', { name: 'Sync calendar', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Calendar check finished',
  )
  const receipt = await (
    await request.post(`${origin}/__ezacto_browser_fixture__/start-end`, {
      headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
      data: { action: 'calendar-oauth-receipt' },
    })
  ).json()
  expect(receipt.calls.token).toBeGreaterThan(0)
  expect(receipt.calls.events).toBeGreaterThan(0)
  expect(receipt.proposals).toEqual([{ status: 'proposed', starts_at: receipt.eventStart }])
  expect(receipt.entries).toEqual([{ count: 0 }])
  await page.screenshot({ path: testInfo.outputPath('calendar-connected.png') })
  await google.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Disconnected here',
  )
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(section).toBeHidden()
  await expect(section.locator('[data-calendar-connections-list]')).toBeEmpty()
})

test('Microsoft disconnect requires explicit permission-removal confirmation before reconnecting', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.EZACTO_BROWSER_CALENDAR_FIXTURE !== '1',
    'Owned calendar provider fixture only',
  )
  const origin = `http://localhost:${process.env.EZACTO_BROWSER_PORT}`
  let redirects = 0
  await page.route('https://login.microsoftonline.com/**', async (route) => {
    const url = new URL(route.request().url())
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('scope')).toBe(
      'https://graph.microsoft.com/Calendars.Read offline_access',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    expect(callback.origin).toBe(origin)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    callback.searchParams.set('code', 'owned-microsoft-code')
    redirects++
    await route.fulfill({ status: 302, headers: { location: callback.href }, body: '' })
  })
  await page.goto('/settings/user#calendars')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const section = page.locator('[data-calendar-connections]')
  const microsoft = section.locator('[data-calendar-provider=microsoft]')
  await microsoft.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(microsoft.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await microsoft.getByRole('button', { name: 'Sync calendar', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText('Calendar check finished')
  await microsoft.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Disconnected here',
  )
  await expect(microsoft.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
  await expect(
    microsoft.getByRole('link', { name: 'Personal account permissions' }),
  ).toHaveAttribute('href', 'https://account.live.com/consent/Manage')
  await expect(microsoft.getByRole('button', { name: 'Record permission removal' })).toBeDisabled()
  await microsoft
    .getByRole('checkbox', { name: 'I removed this app’s calendar permission in Microsoft.' })
    .check()
  await page.screenshot({ path: testInfo.outputPath('microsoft-removal-review.png') })
  await microsoft.getByRole('button', { name: 'Record permission removal' }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Your permission-removal confirmation was recorded',
  )
  await expect(microsoft.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await microsoft.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(microsoft.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  expect(redirects).toBe(2)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(section).toBeHidden()
})
