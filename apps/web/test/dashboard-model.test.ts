import type { Invoice, UninvoicedReport } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  dashboardCards,
  invoiceObligations,
  queueCount,
  trackedSeconds,
  uninvoicedReportHref,
  uninvoicedTotals,
  uninvoicedWindow,
  weekStanding,
} from '../src/dashboard/model.js'

const timestamp = '2026-09-01T12:00:00.000Z'

const invoice = (overrides: Partial<Invoice>): Invoice =>
  ({
    id: 1,
    client_id: 1,
    created_by_user_id: 1,
    number: 'INV-1',
    subject: null,
    purchase_order: null,
    notes: null,
    currency: 'USD',
    issue_date: '2026-08-01',
    due_date: '2026-08-31',
    payment_terms: 'net_30',
    state: 'open',
    version: 1,
    close_reason: null,
    close_write_off_cents: 0,
    sent_at: timestamp,
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
    amount_cents: 100_000,
    due_amount_cents: 100_000,
    tax_amount_cents: 0,
    tax2_amount_cents: 0,
    discount_amount_cents: 0,
    written_off_cents: 0,
    payment_options: [],
    reference_token: null,
    created_at: timestamp,
    updated_at: timestamp,
    line_items: [],
    ...overrides,
  }) as Invoice

const uninvoiced = (
  totals: UninvoicedReport['totals'],
): UninvoicedReport => ({
  from: '2026-06-03',
  to: '2026-09-01',
  client_id: null,
  project_id: null,
  totals,
  projects: [],
})

describe('dashboard model', () => {
  it('[unit] counts only open invoices as owed, and separates the ones past due', () => {
    const obligations = invoiceObligations(
      [
        invoice({ id: 1, due_amount_cents: 120_000, due_date: '2026-08-20' }),
        invoice({ id: 2, due_amount_cents: 80_000, due_date: '2026-09-30' }),
        // Neither of these is owed: a draft has not been sent, and a paid
        // invoice is settled. Both carry a due amount, so a sum that reached
        // for the field without reading the state would swallow them.
        invoice({ id: 3, state: 'draft', due_amount_cents: 500_000 }),
        invoice({ id: 4, state: 'paid', due_amount_cents: 900_000 }),
        invoice({ id: 5, state: 'closed', due_amount_cents: 700_000 }),
        invoice({ id: 6, currency: 'EUR', due_amount_cents: 50_000, due_date: '2026-07-01' }),
      ],
      '2026-09-01',
    )

    expect(obligations).toEqual([
      {
        currency: 'USD',
        dueCents: 200_000,
        overdueCents: 120_000,
        openCount: 2,
        overdueCount: 1,
      },
      {
        currency: 'EUR',
        dueCents: 50_000,
        overdueCents: 50_000,
        openCount: 1,
        overdueCount: 1,
      },
    ])
  })

  it('[security] leaves out a currency whose amount the server withheld', () => {
    // The uninvoiced serializer drops time_cents/total_cents for a profile that
    // may not read money. Rendering the missing field as zero would tell a
    // reader the business has nothing uninvoiced, which is a different claim
    // from "you were not told".
    const totals = uninvoicedTotals(
      uninvoiced([
        {
          currency: 'USD',
          rounded_seconds: 3_600,
          time_entry_count: 1,
          unpriced_time_entry_count: 0,
          expense_count: 0,
        },
        {
          currency: 'EUR',
          rounded_seconds: 7_200,
          time_entry_count: 2,
          unpriced_time_entry_count: 0,
          expense_count: 0,
          total_cents: 44_000,
        },
      ]),
    )

    expect(totals).toEqual([{ currency: 'EUR', cents: 44_000 }])
  })

  it('[unit] sorts uninvoiced currencies by amount so the figure is the largest', () => {
    expect(
      uninvoicedTotals(
        uninvoiced([
          { currency: 'GBP', rounded_seconds: 0, time_entry_count: 0, unpriced_time_entry_count: 0, expense_count: 0, total_cents: 1_000 },
          { currency: 'USD', rounded_seconds: 0, time_entry_count: 0, unpriced_time_entry_count: 0, expense_count: 0, total_cents: 9_000 },
        ]),
      ).map((total) => total.currency),
    ).toEqual(['USD', 'GBP'])
  })

  it('[unit] links the uninvoiced card at the window it reports', () => {
    const range = uninvoicedWindow('2026-09-01')
    expect(range).toEqual({ from: '2026-06-03', to: '2026-09-01' })
    expect(uninvoicedReportHref(range)).toBe(
      '/reports?report=uninvoiced&from=2026-06-03&to=2026-09-01',
    )
  })

  it('[unit] says what the week still needs from you', () => {
    expect(weekStanding(null, 0)).toMatchObject({
      needsAction: true,
      message: 'Nothing logged yet this week.',
    })
    expect(weekStanding(null, 3_600)).toMatchObject({
      needsAction: true,
      message: 'This week is not submitted.',
    })
    expect(
      weekStanding(
        { status: 'submitted', rejection_reason: null } as never,
        3_600,
      ),
    ).toMatchObject({ needsAction: false })
    expect(
      weekStanding(
        { status: 'unsubmitted', rejection_reason: 'Missing notes' } as never,
        3_600,
      ),
    ).toMatchObject({ needsAction: true, message: 'Changes requested: Missing notes' })
    expect(
      weekStanding({ status: 'approved', rejection_reason: null } as never, 3_600),
    ).toMatchObject({ needsAction: false, message: 'Approved.' })
  })

  it('[unit] keeps a queue count honest past the first page', () => {
    expect(queueCount({ submissions: [1, 2] as never, nextCursor: null })).toBe('2')
    expect(queueCount({ submissions: [1, 2] as never, nextCursor: 'more' })).toBe('2+')
  })

  it('[unit] totals a week from the entries the timesheet already reads', () => {
    expect(trackedSeconds([{ seconds: 3_600 }, { seconds: 1_800 }] as never)).toBe(5_400)
  })

  it('[security] gives every money card a gate and the week card none', () => {
    // The week is your own time; the other three are the company's. A money
    // card that reached the page without a gate is the defect this asserts
    // against, and it is cheaper to catch here than in the browser.
    const gates = Object.fromEntries(
      dashboardCards.map((card) => [card.key, card.gate ?? null]),
    )
    expect(gates).toEqual({
      week: null,
      approvals: '.primary-nav a[href="/approvals"]',
      uninvoiced: '.primary-nav [data-money-nav]',
      owed: '.primary-nav [data-money-nav]',
    })
  })
})
