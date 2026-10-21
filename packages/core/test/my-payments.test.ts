import { describe, expect, it } from 'vitest'
import { summarizeMyPayments, type StaffPaymentEvent } from '../src/index.js'

const event = (overrides: Partial<StaffPaymentEvent>): StaffPaymentEvent => ({
  id: 'e',
  user_id: 2,
  month: '2026-08',
  expected_version: 0,
  version: 1,
  kind: 'amount',
  amount_cents: 10000,
  currency: 'USD',
  paid_on: null,
  due_on: '2026-09-01',
  reference: 'secret-reference',
  note: 'private note',
  payment_id: null,
  source: 'wise',
  actor_id: 1,
  actor_name: 'Admin One',
  recorded_at: '2026-09-02T00:00:00.000Z',
  request_id: 'request-secret',
  ...overrides,
})

describe('own payment summary (issue 100)', () => {
  it('[unit] exposes only the specified fields, whatever the ledger events carry', () => {
    const summary = summarizeMyPayments(
      '2026-08',
      [
        event({}),
        event({ id: 'p', version: 2, kind: 'payment', amount_cents: 4000, paid_on: '2026-09-10', due_on: null }),
      ],
      7200,
      [{ amount_cents: 1, currency: 'USD', scheduled_on: '2026-10-20', status: 'scheduled', ...{ month: '2026-08', fee: 5 } }],
      '2026-10-19',
    )
    expect(Object.keys(summary).sort()).toEqual(['balance_cents', 'hours_seconds', 'month', 'owed', 'paid_cents', 'payments', 'status', 'upcoming'])
    expect(Object.keys(summary.payments[0]!).sort()).toEqual(['amount_cents', 'currency', 'paid_on'])
    expect(Object.keys(summary.upcoming[0]!).sort()).toEqual(['amount_cents', 'currency', 'scheduled_on', 'status'])
    const text = JSON.stringify(summary)
    for (const hidden of ['secret-reference', 'private note', 'request-secret', 'Admin One', 'wise', '2026-09-01']) expect(text).not.toContain(hidden)
    expect(summary).toMatchObject({ status: 'partial', owed: { amount_cents: 10000 }, paid_cents: 4000, balance_cents: 6000 })
  })

  it('[unit] a voided receipt leaves paid and restores the balance; nothing recorded is pending review', () => {
    const events = [
      event({}),
      event({ id: 'p', version: 2, kind: 'payment', amount_cents: 4000, paid_on: '2026-09-10', due_on: null }),
      event({ id: 'v', version: 3, kind: 'void', amount_cents: null, currency: null, payment_id: 'p', due_on: null }),
    ]
    expect(summarizeMyPayments('2026-08', events, 0, [], '2026-10-19')).toMatchObject({ status: 'pending', paid_cents: 0, balance_cents: 10000, payments: [] })
    expect(summarizeMyPayments('2026-07', [], 3600, [], '2026-10-19')).toMatchObject({ status: 'pending_review', owed: null, balance_cents: null })
  })
})

it('labels an application of existing advance credit separately from a new payment and an upcoming deposit', () => {
  const summary = summarizeMyPayments('2026-08', [event({}), event({ id: 'credit', version: 2, kind: 'payment', source: 'advance_credit', amount_cents: 4000, paid_on: '2026-10-01' })], 7200,
    [{ kind: 'advance', amount_cents: 10000, currency: 'USD', scheduled_on: '2026-10-02', status: 'scheduled' }], '2026-10-01')
  expect(summary.paid_cents).toBe(4000)
  expect(summary.balance_cents).toBe(6000)
  expect(summary.payments).toEqual([{ kind: 'credit_application', amount_cents: 4000, currency: 'USD', paid_on: '2026-10-01' }])
  expect(summary.upcoming[0]).toMatchObject({ kind: 'advance' })
})
