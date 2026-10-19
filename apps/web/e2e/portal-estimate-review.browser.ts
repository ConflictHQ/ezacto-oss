import { expect, test, type Page } from '@playwright/test'

/**
 * The customer estimate page (issue 1010). A contact's emailed link cannot be
 * issued yet -- the portal request leg has no mailer -- so the page is opened
 * the way a contact with a session would, and the portal routes it calls are
 * answered here. What is checked is the page itself: that it can be read and
 * answered from the keyboard and announces what happened, and that an expired
 * estimate cannot be answered from it.
 */

const version = 'a'.repeat(64)

const quote = {
  id: 7,
  number: 'EST-7',
  subject: 'Site rebuild',
  currency: 'USD',
  state: 'sent',
  issue_date: '2026-10-01',
  amount_cents: 108_000,
  sent_at: '2026-10-02T09:00:00.000Z',
  accepted_at: null,
  declined_at: null,
  purchase_order: null,
  notes: 'Valid for the scope listed.',
  tax_rate_ppm: 80_000,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  tax_amount_cents: 8_000,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  line_items: [
    {
      position: 1,
      kind: 'Service',
      description: 'Design',
      quantity: 10,
      unit_price_cents: 10_000,
      amount_cents: 100_000,
      taxed: true,
      taxed2: false,
    },
  ],
  version,
  expires_on: '2026-10-20',
  expired: false,
  answerable: true,
  response: null,
}

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
