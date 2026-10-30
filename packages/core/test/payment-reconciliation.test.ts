import { expect, it } from 'vitest'
import { reconcileEarnings, proposeEarnings } from '../src/payment-reconciliation.js'
import type { ReconciliationPerson } from '../src/payment-reconciliation.js'
import type { PaymentActualEntry } from '../src/payment-actuals.js'

const entry = (id: number, patch: Partial<PaymentActualEntry> = {}): PaymentActualEntry => ({
  entry_id: id,
  project_id: 1,
  project_name: 'Project',
  spent_date: '2026-08-03',
  rounded_seconds: 3600,
  cost_rate_cents: 5000,
  selected_seconds: 3600,
  ...patch,
})
const person = (
  entries: PaymentActualEntry[],
  confirmed: ReconciliationPerson['confirmed'] = null,
): ReconciliationPerson => ({ user_id: 2, name: 'Contractor Two', entries, confirmed })

it('proposes new earnings from rounded seconds at the captured cost rate', () => {
  const result = proposeEarnings(person([entry(1), entry(2, { rounded_seconds: 1800 })]))
  expect(result).toMatchObject({
    proposed_cents: 7500,
    confirmed_cents: null,
    status: 'new',
    exceptions: [],
  })
})
it('flags entries with no rate and leaves them out of the amount', () => {
  const result = proposeEarnings(
    person([
      entry(1),
      entry(2, { cost_rate_cents: null }),
      entry(3, { cost_rate_cents: null, rounded_seconds: 0 }),
    ]),
  )
  expect(result.proposed_cents).toBe(5000)
  expect(result.status).toBe('attention')
  expect(result.exceptions).toEqual([{ code: 'missing_rate', entry_ids: [2] }])
})
it('converges on a rerun when the confirmed review matches the source', () => {
  const entries = [entry(1)]
  expect(proposeEarnings(person(entries, { amount_cents: 5000, entries })).status).toBe(
    'converged',
  )
})
it('reports a partial review as differing, not as a source change', () => {
  const result = proposeEarnings(
    person([entry(1)], { amount_cents: 2500, entries: [entry(1, { selected_seconds: 1800 })] }),
  )
  expect(result).toMatchObject({ status: 'differs', confirmed_cents: 2500, exceptions: [] })
})
it('flags edited, removed and added entries as a changed source', () => {
  const result = proposeEarnings(
    person([entry(1, { rounded_seconds: 7200 }), entry(3), entry(9)], {
      amount_cents: 15000,
      entries: [entry(1), entry(2), entry(3)],
    }),
  )
  expect(result.status).toBe('attention')
  expect(result.exceptions).toEqual([{ code: 'changed_source', entry_ids: [1, 2, 9] }])
  const rate = proposeEarnings(
    person([entry(1, { cost_rate_cents: 6000 })], { amount_cents: 5000, entries: [entry(1)] }),
  )
  expect(rate.exceptions[0]?.code).toBe('changed_source')
})
it('wraps people with the month and currency', () => {
  expect(reconcileEarnings('2026-08', 'USD', true, [person([entry(1)])])).toMatchObject({
    month: '2026-08',
    currency: 'USD',
    completed: true,
    people: [{ user_id: 2 }],
  })
})
