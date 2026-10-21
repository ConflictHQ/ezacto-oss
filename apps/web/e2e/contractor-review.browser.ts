import { expect, test } from '@playwright/test'
import { summarizeStaffPayments, type ContractorReview } from '@ezacto/core'
const email = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!, password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
test('[e2e:contractor-review] reviews current and projected balances, preserves currencies and navigates to explicit confirmation', async ({ page }) => {
  const ledger = { month: '2026-09', as_of: '2026-10-01', provider_settings: { default_provider: 'wise', version: 0, events: [] }, rows: [{ ...summarizeStaffPayments({ user_id: 2, name: 'Review Fixture', active: true, wise_ready: true }, '2026-09', [], '2026-10-01'), is_contractor: true, currency: 'USD', amount_cents: 10000, paid_cents: 4000, balance_cents: 6000 }] }
  const balance = { currency: 'USD', recorded_earnings_cents: 10000, proposed_earnings_cents: 10000, paid_cents: 4000, reserved_cents: 0, available_to_pay_cents: 6000, available_credit_cents: 2000, proposed_credit_cents: 2000, remaining_after_credit_cents: 4000, invoices: [], advances: [], allocations: [], allocation_proposals: [], credit_proposals: [{ advance_item_id: 'advance', amount_cents: 2000, scope: 'month' as const }], items: [], proposal_blocked: false, flags: ['missing_received_invoice'] }
  const review: ContractorReview = { month: '2026-09', completed: true, version: 'fixture', credit_period: { from: '2026-09-01', to: '2026-10-01' }, people: [{ user_id: 2, name: 'Review Fixture', active: true, ledger_version: 1, settled_through: null, ledger_events: [], phase: 'review', latest_review: null, earnings: null, entries: [], currencies: [balance, { ...balance, currency: 'EUR', available_to_pay_cents: null, remaining_after_credit_cents: null, proposed_credit_cents: 0, proposal_blocked: true, flags: ['currency_mismatch'] }] }] }
  let moneyWrites = 0
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/v1\/(staff-payments|payment-runs|payment-allocations|advance-credits|staff-invoices)/u.test(request.url())) moneyWrites++ })
  await page.route('**/api/v1/staff-payments?*', route => route.fulfill({ json: { data: ledger } }))
  await page.route('**/api/v1/payment-runs/report?*', route => route.fulfill({ json: { data: { from: '2026-09', to: '2026-09', ledgers: [ledger], runs: [] } } }))
  let reads = 0
  await page.route('**/api/v1/staff-payments/contractor-review?*', route => { reads++; expect(new URL(route.request().url()).searchParams.get('month')).toBe('2026-09'); return route.fulfill({ json: { data: review } }) })
  await page.goto('/payments?month=2026-09')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('tab', { name: 'Reconcile', exact: true }).click()
  const panel = page.locator('[data-contractor-review]')
  await panel.getByRole('button', { name: 'Load reconciliation for work month' }).click()
  const table = panel.getByRole('table')
  await expect(table.locator('tbody tr')).toHaveCount(2)
  const usd = table.locator('tbody tr').filter({ has: page.getByRole('cell', { name: 'USD', exact: true }) })
  await expect(usd.getByRole('cell', { name: 'USD 60.00', exact: true })).toBeVisible()
  await expect(usd.getByRole('cell', { name: 'USD 40.00', exact: true })).toHaveCount(2)
  const eur = table.locator('tbody tr').filter({ has: page.getByRole('cell', { name: 'EUR', exact: true }) })
  await expect(eur.getByRole('cell', { name: 'Needs review', exact: true })).toHaveCount(2)
  await panel.getByText('Review Fixture · USD · Review evidence', { exact: true }).click()
  await expect(panel.getByText(/After proposed credit:.*projection/u).first()).toBeVisible()
  await panel.getByRole('button', { name: 'Review advance credit', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: 'Advances', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(reads).toBe(1); expect(moneyWrites).toBe(0)
})
