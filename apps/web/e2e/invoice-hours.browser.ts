import { expect, test } from '@playwright/test'
const at = '2026-08-31T12:00:00.000Z'
test('[e2e:invoice-hours #924] warns, saves a quantity and explicitly releases matching time with a safe retry', async ({
  page,
}) => {
  const item = (id: number, position: number, quantity: number, price: number) => ({
    id,
    invoice_id: 7,
    position,
    kind: 'Service',
    description: id === 21 ? 'Tracked work' : 'Fixed fee',
    quantity,
    unit_price_cents: price,
    amount_cents: quantity * price,
    taxed: false,
    taxed2: false,
    project_id: 1,
    created_at: at,
    updated_at: at,
  })
  const invoice = {
    id: 7,
    client_id: 4,
    created_by_user_id: 1,
    number: 'INV-924',
    subject: 'August services',
    purchase_order: null,
    notes: null,
    currency: 'USD',
    issue_date: '2026-08-01',
    due_date: '2026-08-31',
    payment_terms: 'net_30',
    state: 'draft',
    version: 0,
    close_reason: null,
    close_write_off_cents: 0,
    sent_at: null,
    paid_at: null,
    paid_date: null,
    closed_at: null,
    period_start: null,
    period_end: null,
    project_id: null,
    retainer_id: null,
    recurring_invoice_id: null,
    estimate_id: null,
    reminder_policy: null,
    tax_rate_ppm: null,
    tax2_rate_ppm: null,
    discount_rate_ppm: null,
    amount_cents: 15000,
    due_amount_cents: 15000,
    tax_amount_cents: 0,
    tax2_amount_cents: 0,
    discount_amount_cents: 0,
    written_off_cents: 0,
    payment_options: [],
    reference_token: null,
    created_at: at,
    updated_at: at,
    line_items: [item(21, 0, 2, 1500), item(22, 1, 12, 1000)],
  }
  const review = {
    invoice_id: 7,
    invoice_version: 0,
    hours_version: 'a'.repeat(64),
    invoice_state: 'draft',
    linked_seconds: 7200,
    billed_seconds: 7200,
    difference_seconds: 0,
    status: 'matched',
    tolerance_seconds: 36,
    total_tolerance_seconds: 36,
    comparison_complete: true,
    has_mismatch: false,
    not_compared_entry_ids: [],
    projects: [],
    not_compared: [{ line_id: 22, position: 1, description: 'Fixed fee', quantity: 12 }],
    lines: [
      {
        line_id: 21,
        project_id: 1,
        entry_ids: [1, 2, 3],
        linked_seconds: 7200,
        billed_seconds: 7200,
        difference_seconds: 0,
        status: 'matched',
      },
    ],
    entries: [
      {
        entry_id: 1,
        user_id: 2,
        user_name: 'Person A',
        spent_date: '2026-08-01',
        project_id: 1,
        project_name: 'Fixture project',
        seconds: 3600,
        eligible_for_release: true,
      },
      {
        entry_id: 2,
        user_id: 2,
        user_name: 'Person A',
        spent_date: '2026-08-02',
        project_id: 1,
        project_name: 'Fixture project',
        seconds: 1800,
        eligible_for_release: true,
      },
      {
        entry_id: 3,
        user_id: 3,
        user_name: 'Person B',
        spent_date: '2026-08-03',
        project_id: 1,
        project_name: 'Fixture project',
        seconds: 1800,
        eligible_for_release: true,
      },
    ],
  }
  let writes = 0,
    releaseRequests = 0,
    actualReleases = 0
  let accepted: Record<string, unknown> | undefined
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/v1\/invoices/u.test(request.url())) writes++
  })
  await page.route('**/api/v1/invoices/7/line-items/21', (route) => {
    const body = route.request().postDataJSON()
    expect(body.expected_version).toBe(0)
    expect(body.quantity).toBe(1.5)
    invoice.line_items[0]!.quantity = 1.5
    invoice.line_items[0]!.amount_cents = 2250
    invoice.version = 1
    invoice.amount_cents = invoice.due_amount_cents = 14250
    review.invoice_version = 1
    review.hours_version = 'b'.repeat(64)
    review.billed_seconds = 5400
    review.difference_seconds = -1800
    review.status = 'billed_below_linked'
    review.has_mismatch = true
    review.lines[0]!.billed_seconds = 5400
    review.lines[0]!.difference_seconds = -1800
    review.lines[0]!.status = 'billed_below_linked'
    return route.fulfill({ json: { data: { invoice, event_ids: ['edit'] } } })
  })
  await page.route('**/api/v1/invoices/7/hours-reconciliation/release', (route) => {
    releaseRequests++
    const body = route.request().postDataJSON()
    if (!accepted) {
      accepted = body
      actualReleases++
      expect(body).toMatchObject({
        line_id: 21,
        expected_version: 1,
        hours_version: 'b'.repeat(64),
        entry_ids: [2],
        confirmed: true,
      })
      review.entries = review.entries.filter((entry) => entry.entry_id !== 2)
      review.linked_seconds = 5400
      review.difference_seconds = 0
      review.status = 'matched'
      review.has_mismatch = false
      review.hours_version = 'c'.repeat(64)
      review.lines[0]!.entry_ids = [1, 3]
      review.lines[0]!.linked_seconds = 5400
      review.lines[0]!.difference_seconds = 0
      review.lines[0]!.status = 'matched'
      return route.abort('failed')
    }
    expect(body).toEqual(accepted)
    return route.fulfill({
      json: {
        data: {
          command_id: body.command_id,
          invoice_id: 7,
          line_id: 21,
          expected_version: 1,
          hours_version: 'b'.repeat(64),
          released_entry_ids: [2],
          released_seconds: 1800,
          recorded_at: at,
          replayed: true,
        },
      },
    })
  })
  await page.route('**/api/v1/invoices?*', (route) =>
    route.fulfill({ json: { data: [invoice], page: { next_cursor: null } } }),
  )
  await page.route('**/api/v1/invoices/7', (route) => route.fulfill({ json: { data: invoice } }))
  await page.route('**/api/v1/invoices/7/hours-reconciliation', (route) =>
    route.fulfill({ json: { data: review } }),
  )
  await page.route('**/api/v1/clients/4', (route) =>
    route.fulfill({
      json: {
        data: { id: 4, name: 'Fixture client', created_at: at, updated_at: at },
      },
    }),
  )
  await page.route('**/api/v1/projects?*', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 1,
            client_id: 4,
            name: 'Fixture project',
            created_at: at,
            updated_at: at,
          },
        ],
        page: { next_cursor: null },
      },
    }),
  )
  await page.goto('/invoices/INV-924/edit')
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const form = page.locator('[data-invoice-edit-form]'),
    warning = page.locator('[data-invoice-edit-hours-warning]'),
    row = page.locator('[data-invoice-edit-line]').first()
  await expect(form).toBeVisible()
  await expect(warning).toBeHidden()
  await row.locator('[data-invoice-edit-line-field="quantity"]').fill('1.5')
  await expect(row.locator('[data-invoice-edit-linked-hours]')).toHaveText(
    /Linked: 2.00 h · billed: 1.50 h/u,
  )
  await expect(warning).toContainText('Review linked time before previewing or sending')
  await page
    .locator('[data-invoice-edit-line]')
    .nth(1)
    .locator('[data-invoice-edit-line-field="quantity"]')
    .fill('16')
  await expect(warning).toContainText('compared lines bill: 1.50 h')
  await row.locator('[data-invoice-edit-line-field="quantity"]').fill('2')
  await expect(warning).toBeHidden()
  await row.getByRole('button', { name: 'Remove line', exact: true }).click()
  await expect(warning).toContainText('Removed lines still have time linked')
  await row.getByRole('button', { name: 'Keep this line', exact: true }).click()
  await expect(warning).toBeHidden()
  expect(writes).toBe(0)
  await page
    .locator('[data-invoice-edit-line]')
    .nth(1)
    .locator('[data-invoice-edit-line-field="quantity"]')
    .fill('12')
  await row.locator('[data-invoice-edit-line-field="quantity"]').fill('1.5')
  await row
    .getByRole('button', { name: 'Save changes and review linked time', exact: true })
    .click()
  await expect(page.locator('[data-invoice-edit-result]')).toContainText(
    'Invoice saved. Choose linked time',
  )
  expect(page.url()).toContain('/invoices/INV-924/edit')
  const release = row.locator('[data-invoice-time-release]')
  await release.getByLabel('Person for time release').selectOption('2')
  const boxes = release.getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await boxes.nth(0).check()
  await expect(
    release.getByRole('button', { name: 'Confirm release of selected time', exact: true }),
  ).toBeDisabled()
  await boxes.nth(0).uncheck()
  await boxes.nth(1).check()
  await release
    .getByRole('button', { name: 'Confirm release of selected time', exact: true })
    .click()
  const retry = release.getByRole('button', { name: 'Retry same release', exact: true })
  await expect(retry).toBeEnabled()
  await expect(release.getByLabel('Person for time release')).toBeDisabled()
  await retry.click()
  await expect(row.locator('[data-invoice-time-release]')).toHaveCount(0)
  await expect(warning).toBeHidden()
  expect(releaseRequests).toBe(2)
  expect(actualReleases).toBe(1)
  expect(writes).toBe(3)
})
