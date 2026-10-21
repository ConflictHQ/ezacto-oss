import { expect, test } from '@playwright/test'
const at = '2026-08-31T12:00:00.000Z'
test('[e2e:invoice-hours #924] warns as billed hours change without treating a fee quantity as hours', async ({
  page,
}) => {
  const item = (
    id: number,
    position: number,
    quantity: number,
    price: number,
  ) => ({
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
    not_compared: [
      { line_id: 22, position: 1, description: 'Fixed fee', quantity: 12 },
    ],
    lines: [
      {
        line_id: 21,
        project_id: 1,
        entry_ids: [1],
        linked_seconds: 7200,
        billed_seconds: 7200,
        difference_seconds: 0,
        status: 'matched',
      },
    ],
    entries: [
      {
        entry_id: 1,
        user_id: 1,
        user_name: 'Fixture person',
        spent_date: '2026-08-01',
        project_id: 1,
        project_name: 'Fixture project',
        seconds: 7200,
      },
    ],
  }
  let writes = 0
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/api\/v1\/invoices/u.test(request.url())
    )
      writes++
  })
  await page.route('**/api/v1/invoices?*', (route) =>
    route.fulfill({ json: { data: [invoice], page: { next_cursor: null } } }),
  )
  await page.route('**/api/v1/invoices/7', (route) =>
    route.fulfill({ json: { data: invoice } }),
  )
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
  await expect(warning).toContainText(
    'Review linked time before previewing or sending',
  )
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
})
