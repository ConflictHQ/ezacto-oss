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
  await page.route('https://accounts.google.com/**', async (route) => {
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
  await expect(section.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await section.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Calendar consent completed',
  )
  expect(providerRedirects).toBe(1)
  await expect(section.getByRole('button', { name: 'Sync calendar', exact: true })).toBeVisible()
  await section.getByRole('button', { name: 'Sync calendar', exact: true }).click()
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
  expect(receipt.proposals).toEqual([{ status: 'proposed' }])
  expect(receipt.entries).toEqual([{ count: 0 }])
  await page.screenshot({ path: testInfo.outputPath('calendar-connected.png') })
  await section.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(section.locator('[data-calendar-connections-status]')).toContainText(
    'Disconnected here',
  )
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(section).toBeHidden()
  await expect(section.locator('[data-calendar-connections-list]')).toBeEmpty()
})
