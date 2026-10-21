/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import {
  summarizeStaffPayments,
  type StaffInvoice,
  type AdvanceCreditApplication,
  type PaymentRunReport,
} from '@ezacto/core'
import {
  paymentFinancialSections,
  type PaymentFinancialSources,
} from '../src/staff-payments/report-financials.js'
import { paymentRunCsv, paymentReportTotals } from '../src/staff-payments/runs-model.js'
import { createPaymentRunsController } from '../src/staff-payments/runs-browser.js'
import { renderStaffPayments } from '../src/staff-payments/render.js'
const filters = { person: '', currency: '', status: 'all' }
const invoice = (
  id: number,
  currency: string,
  kind: 'draft' | 'received' | 'void',
  amount: number,
): StaffInvoice => ({
  id,
  user_id: 2,
  month: '2026-09',
  currency,
  reference: `=REF-${id}`,
  matched_cents: kind === 'received' ? amount : 0,
  flags: [],
  line_flags: [[]],
  versions: [0, 1].map((version) => ({
    command_id: `invoice-${id}-${version}`,
    version,
    month: '2026-09',
    currency,
    kind: version === 1 ? kind : 'received',
    lines: [
      {
        description: '=Formula-looking description',
        project_id: 7,
        entry_id: 31,
        seconds: 3600,
        rate_cents: amount,
      },
    ],
    amount_cents: version === 1 ? amount : 999,
    review_id: null,
    document_id: null,
    reason: 'Reviewed',
    actor_id: 1,
    recorded_at: '2026-10-01T00:00:00Z',
    paid_cents_at_recording: 0,
    has_payment_history: false,
  })),
})
const application = (
  id: string,
  month: string,
  amount: number,
  reversed: string | null = null,
): AdvanceCreditApplication => ({
  id,
  advance_item_id: 'deposit',
  user_id: 2,
  currency: 'USD',
  month,
  amount_cents: amount,
  scope: 'entry',
  project_id: 7,
  entry_id: 31,
  reason: 'Explicit application',
  actor_id: 1,
  recorded_at: `${month}-10T12:00:00Z`,
  reversed_at: reversed,
  reversal_reason: reversed ? 'Hours corrected' : null,
})
const sources = (): PaymentFinancialSources => ({
  invoices: [
    {
      month: '2026-09',
      people: [
        {
          user_id: 2,
          name: 'Person Two',
          currency: 'USD',
          earned_cents: 20000,
          paid_cents: 10000,
          invoiced_cents: 12000,
          matched_invoice_cents: 12000,
          uninvoiced_cents: 8000,
          invoices: [
            invoice(1, 'USD', 'received', 12000),
            invoice(2, 'EUR', 'received', 2000),
            invoice(3, 'USD', 'draft', 3000),
            invoice(4, 'USD', 'void', 4000),
          ],
        },
      ],
    },
  ],
  advances: {
    from: '2026-09-01',
    to: '2026-09-30',
    advances: [
      {
        advance_item_id: 'deposit',
        user_id: 2,
        name: 'Person Two',
        currency: 'USD',
        month: '2026-08',
        advance_project_id: null,
        advance_reason: 'Pre-work deposit',
        state: 'paid',
        amount_cents: 20000,
        settled_cents: 20000,
        settled_at: '2026-08-01T00:00:00Z',
        applied_cents: 10000,
        returned_cents: 1000,
        reserved_cents: 0,
        available_cents: 9000,
        opening_cents: 14000,
        period_settled_cents: 0,
        period_applied_cents: 4000,
        period_returned_cents: 1000,
        closing_cents: 9000,
        applications: [
          application('old', '2026-08', 5000),
          application('reversed', '2026-08', 1000, '2026-09-15T00:00:00Z'),
          application('current', '2026-09', 5000),
        ],
        returns: [
          {
            id: 'return',
            advance_item_id: 'deposit',
            amount_cents: 1000,
            reference: 'REFUND',
            reason: 'Unused credit returned',
            actor_id: 1,
            recorded_at: '2026-09-20T00:00:00Z',
          },
        ],
      },
    ],
  },
})
const row = {
  ...summarizeStaffPayments(
    { user_id: 2, name: 'Person Two', active: true, wise_ready: true },
    '2026-09',
    [],
    '2026-10-01',
  ),
  amount_cents: 20000,
  currency: 'USD',
  paid_cents: 10000,
  balance_cents: 10000,
  reserved_cents: 2000,
  available_cents: 8000,
}
const report: PaymentRunReport = {
  from: '2026-09',
  to: '2026-09',
  runs: [],
  ledgers: [
    {
      month: '2026-09',
      as_of: '2026-10-01',
      provider_settings: { default_provider: 'wise', version: 0, events: [] },
      rows: [row],
    },
  ],
}

describe('payment report invoice and credit evidence', () => {
  it('uses only current received versions and retains independent invoice currencies and source links', () => {
    const sections = paymentFinancialSections(sources(), filters, [row])
    expect(sections[0]!.rows.map((r) => [r.Currency, r['Received cents']])).toEqual([
      ['USD', 12000],
      ['EUR', 2000],
      ['USD', 0],
      ['USD', 0],
    ])
    expect(sections[0]!.rows.every((r) => r['Invoice version'] === 1)).toBe(true)
    expect(sections[1]!.rows[0]).toMatchObject({
      'Project ID': 7,
      'Entry ID': 31,
      'Selected seconds': 3600,
      'Amount cents': 12000,
    })
    expect(
      paymentFinancialSections(sources(), { ...filters, currency: 'eur' }, [])[0]!.rows,
    ).toHaveLength(1)
    expect(
      paymentFinancialSections(sources(), { ...filters, person: 'Nobody' }, [row]).every(
        (section) => section.rows.length === 0,
      ),
    ).toBe(true)
    expect(
      paymentFinancialSections(sources(), { ...filters, status: 'paid' }, [])[0]!.rows,
    ).toHaveLength(0)
  })
  it('shows period credit movements, reversals and returns without adding credit to ledger paid twice', () => {
    const sections = paymentFinancialSections(sources(), filters, [row])
    const credit = sections[2]!.rows[0]!
    expect(credit).toMatchObject({
      'Opening credit cents': 14000,
      'Credit applied cents': 4000,
      'Credit returned cents': 1000,
      'Closing credit cents': 9000,
      'Current available credit cents': 9000,
    })
    expect(
      Number(credit['Opening credit cents']) +
        Number(credit['Credit settled cents']) -
        Number(credit['Credit applied cents']) -
        Number(credit['Credit returned cents']),
    ).toBe(credit['Closing credit cents'])
    expect(sections[3]!.rows.map((r) => [r['Application ID'], r['Period movement cents']])).toEqual(
      [
        ['reversed', -1000],
        ['current', 5000],
      ],
    )
    expect(sections[4]!.rows[0]).toMatchObject({
      'Return ID': 'return',
      'Amount cents': 1000,
      'Transfer reference': 'REFUND',
    })
    expect(paymentReportTotals([row]).get('USD')!.paid).toBe(10000n)
    expect(sections[2]!.note).toContain('do not add them to paid again')
  })
  it('exports the filtered evidence with uniform columns and spreadsheet-safe references', () => {
    const csv = paymentRunCsv(report, filters, [], sources())
    expect(csv).toContain('"Contractor invoices","Person Two","2026-09","EUR"')
    expect(csv).toContain('"Credit applied to earnings"')
    expect(csv).toContain('"Returned advance credit"')
    expect(csv).toContain('"-1000"')
    expect(csv).not.toContain('"\'-1000"')
    expect(csv).toContain('"\'=REF-1"')
    expect(csv).toContain('"\'=Formula-looking description"')
    const records = csv
      .trim()
      .split('\r\n')
      .map((line) => line.match(/"(?:[^"]|"")*"/gu))
    expect(records.every((record) => record?.length === records[0]?.length)).toBe(true)
    expect(paymentRunCsv(report, { ...filters, currency: 'EUR' }, [], sources())).not.toContain(
      '"deposit"',
    )
  })
  it('loads sources for the selected range, renders them and clears private facts on abort', async () => {
    history.replaceState({}, '', '/payments/report')
    document.body.innerHTML = renderStaffPayments('staff-payments')
    const source = sources()
    const getStaffInvoiceReport = vi.fn(async () => source.invoices[0]!)
    const getAdvanceCreditReport = vi.fn(async () => source.advances!)
    const controller = createPaymentRunsController(
      { getPaymentRunReport: async () => report, getStaffInvoiceReport, getAdvanceCreditReport },
      async () => {},
    )
    const active = new AbortController()
    await controller.activate(active.signal)
    expect(getStaffInvoiceReport).toHaveBeenCalledWith('2026-09', active.signal)
    expect(getAdvanceCreditReport).toHaveBeenCalledWith('2026-09-01', '2026-09-30', active.signal)
    const host = document.querySelector<HTMLElement>('[data-run-report-financials]')!
    expect(host.textContent).toContain('REF-1')
    expect(host.textContent).toContain('REFUND')
    expect(host.textContent).toContain('Reversed')
    const currency = document.querySelector<HTMLInputElement>(
      '[data-run-report-form] [name="currency"]',
    )!
    currency.value = 'EUR'
    currency.dispatchEvent(new Event('input'))
    expect(host.textContent).toContain('REF-2')
    expect(host.textContent).not.toContain('REF-1')
    expect(host.textContent).not.toContain('deposit')
    active.abort()
    expect(host.textContent).toBe('')
  })
})
