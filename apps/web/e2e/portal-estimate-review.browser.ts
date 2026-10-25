import { expect, test, type Page } from '@playwright/test'

/** Customer quote accessibility plus a real D1-backed queued-mail/sign-in/
 * response flow. The browser harness captures delivery locally; no external
 * provider sends mail during these tests. */

import { quote, version } from './fixtures/portal-estimate.js'

const answered = {
  ...quote,
  state: 'accepted',
  accepted_at: '2026-10-18T14:03:00.000Z',
  answerable: false,
  response: {
    decision: 'accept',
    at: '2026-10-18T14:03:00.000Z',
    by: 'Jordan Rivera',
    version,
    current: true,
  },
}

const answerRequests = (page: Page): string[] => {
  const posted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/portal/estimates/7/response')) {
      posted.push(request.postData() ?? '')
    }
  })
  return posted
}

test('[e2e:estimate-review] is readable, keyboard-operable and announces the recorded answer', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  const posted = answerRequests(page)
  await page.route('**/portal/estimates/7', (route) => route.fulfill({ json: { data: quote } }))
  await page.route('**/portal/estimates/7/response', (route) =>
    route.fulfill({ json: { data: answered, replayed: false } }),
  )
  await page.goto('/portal/estimate-review?estimate=7')

  // Structure a screen reader navigates by.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Estimate EST-7')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await expect(page.getByRole('table', { name: 'Lines on estimate EST-7' })).toBeVisible()
  await expect(page.locator('[data-portal-status]')).toHaveAttribute('role', 'status')
  await expect(page.locator('[data-portal-status]')).toHaveAttribute('aria-live', 'polite')

  // The quote, its expiry and the total.
  await expect(page.locator('[data-portal-facts]')).toContainText(
    '2026-10-20 (open until the end of that day)',
  )
  await expect(page.locator('[data-portal-totals]')).toContainText('$1,080.00')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)

  // Choose, then confirm, from the keyboard alone.
  const accept = page.getByRole('button', { name: 'Accept this estimate' })
  await accept.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('group')).toBeVisible()
  await expect(page.locator('[data-portal-confirm-text]')).toBeFocused()
  await expect(page.locator('[data-portal-confirm-text]')).toContainText(
    'Nothing is charged and no invoice is raised',
  )
  expect(posted).toHaveLength(0)
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-portal-confirm-yes]')).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.locator('[data-portal-status]')).toHaveText('Your acceptance was recorded.')
  await expect(page.locator('[data-portal-answer-line]')).toContainText(
    'Jordan Rivera accepted this estimate',
  )
  await expect(accept).toBeHidden()
  expect(posted).toEqual([JSON.stringify({ decision: 'accept', version })])
})

test('[e2e:estimate-review] offers no answer once the estimate has expired', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  const posted = answerRequests(page)
  const expired = { ...quote, expired: true, answerable: false }
  await page.route('**/portal/estimates/7', (route) => route.fulfill({ json: { data: expired } }))
  await page.goto('/portal/estimate-review?estimate=7')

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Estimate EST-7')
  await expect(page.locator('[data-portal-facts]')).toContainText('2026-10-20 (expired)')
  await expect(page.locator('[data-portal-answer-line]')).toContainText('expired on 2026-10-20')
  await expect(page.getByRole('button', { name: 'Accept this estimate' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Decline this estimate' })).toBeHidden()
  expect(posted).toHaveLength(0)
})

test('[e2e:estimate-review] says an answer refused as expired was not recorded', async ({
  page,
}) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  let reads = 0
  await page.route('**/portal/estimates/7', (route) => {
    reads += 1
    return route.fulfill({
      json: { data: reads === 1 ? quote : { ...quote, expired: true, answerable: false } },
    })
  })
  await page.route('**/portal/estimates/7/response', (route) =>
    route.fulfill({
      status: 410,
      json: { error: { code: 'estimate_expired', message: 'expired' } },
    }),
  )
  await page.goto('/portal/estimate-review?estimate=7')
  await page.getByRole('button', { name: 'Decline this estimate' }).click()
  await page.locator('[data-portal-confirm-yes]').click()

  await expect(page.locator('[data-portal-status]')).toContainText('has expired')
  await expect(page.locator('[data-portal-status]')).toContainText('not recorded')
  await expect(page.getByRole('button', { name: 'Decline this estimate' })).toBeHidden()
})


test('[e2e:estimate-review #1010] requests a real queued link, signs in and records one versioned answer', async ({
  page,
  request,
  context,
}) => {
  const headers = { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' }
  expect(
    (
      await request.post('/__ezacto_browser_fixture__/start-end', {
        headers,
        data: { action: 'portal-estimate-seed' },
      })
    ).status(),
  ).toBe(204)
  try {
    const urls: string[] = []
    page.on('request', (incoming) => urls.push(incoming.url()))
    await page.goto('/portal/estimate-review')
    await expect(
      page.getByRole('heading', { name: 'Sign in to review your estimates', exact: true }),
    ).toBeVisible()
    await page.getByLabel('Email address', { exact: true }).fill('estimate-contact@example.test')
    await page.getByRole('button', { name: 'Send me a sign-in link', exact: true }).click()
    await expect(page.locator('[data-portal-status]')).toContainText(
      'If this address belongs to a client contact',
    )
    const captured = await (
      await request.get('/__ezacto_browser_fixture__/portal-mail', { headers })
    ).json()
    const jobs = captured.jobs.filter(
      (job: { message: { template: string; to: { email: string }[] } }) =>
        job.message.template === 'portal_magic_link_signin:v1' &&
        job.message.to[0]?.email === 'estimate-contact@example.test',
    )
    expect(jobs).toHaveLength(1)
    const link = new URL(
      jobs[0].message.text.split('\n').find((line: string) => line.startsWith('http')),
    )
    const token = new URLSearchParams(link.hash.slice(1)).get('token')!
    expect(link.search).toBe('')
    await page.goto(link.href)
    await expect(page.getByRole('link', { name: 'EST-MAILED-1010', exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    const cookies = await context.cookies()
    expect(cookies.find((cookie) => cookie.name === '__Host-ezacto_portal')).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    })
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/portal/estimates/120001',
    )
    await page.getByRole('link', { name: 'EST-MAILED-1010', exact: true }).click()
    const quote = await (await read).json()
    await expect(
      page.getByRole('table', { name: 'Lines on estimate EST-MAILED-1010', exact: true }),
    ).toContainText('Reviewable scope')
    await page.getByRole('button', { name: 'Accept this estimate', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-portal-status]')).toHaveText('Your acceptance was recorded.')
    await expect(page.locator('[data-portal-answer-line]')).toContainText(
      'Jordan Reviewer accepted',
    )
    const replay = await page.evaluate(async (version) => {
      const response = await fetch('/portal/estimates/120001/response', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accept', version }),
      })
      return { status: response.status, body: await response.json() }
    }, quote.data.version)
    expect(replay.status).toBe(200)
    expect(replay.body.replayed).toBe(true)
    const recorded = await (
      await request.post('/__ezacto_browser_fixture__/start-end', {
        headers,
        data: { action: 'portal-estimate-result' },
      })
    ).json()
    expect(recorded.rows).toEqual([
      expect.objectContaining({
        contact_id: 120001,
        content_hash: quote.data.version,
        event_type: 'accept',
      }),
    ])
    expect(urls.every((url) => !url.includes(token) && !url.includes('estimate-contact'))).toBe(
      true,
    )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  } finally {
    await request.post('/__ezacto_browser_fixture__/start-end', {
      headers,
      data: { action: 'portal-estimate-cleanup' },
    })
  }
})
