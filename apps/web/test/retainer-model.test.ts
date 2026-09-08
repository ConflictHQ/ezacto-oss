import type { GeneralResource, Retainer, RetainerLedgerEntry } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  retainerAmount,
  retainerCommitment,
  retainerCommitmentLabel,
  retainerCurrency,
  retainerLedgerHistory,
  retainerLedgerNotes,
  retainerLedgerSummary,
  retainerLockedRateValueCents,
  retainerProjectLabel,
  retainerRemainingShare,
  retainerScopeConflict,
  retainerSelectionFromUrl,
  retainerStatusFilterFromUrl,
  retainerWorkspaceUrl,
} from '../src/retainers/model.js'

const timestamp = '2026-09-02T12:00:00.000Z'

const money = (overrides: Partial<Retainer> = {}): Retainer => ({
  id: 1,
  client_id: 4,
  project_id: null,
  state: 'ongoing',
  denomination: 'money',
  amount_cents: 500_000,
  seconds: null,
  locked_rate_cents: null,
  rate_locked_at: null,
  period: null,
  rollover: null,
  expires_at: null,
  on_exhaustion: 'block',
  balance: 320_000,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const hours = (overrides: Partial<Retainer> = {}): Retainer =>
  money({
    id: 2,
    denomination: 'hours',
    amount_cents: null,
    seconds: 144_000,
    balance: 72_000,
    ...overrides,
  })

/**
 * What `ensureHarvestRetainerStub` actually inserts: a money retainer with a
 * zero agreed amount, the invoice's client, no project and no policy, whose
 * balance only appears later as one worksheet `adjustment`.
 */
const harvestStub = (overrides: Partial<Retainer> = {}): Retainer =>
  money({ id: 9, amount_cents: 0, balance: 0, ...overrides })

const entry = (
  overrides: Partial<RetainerLedgerEntry> & Pick<RetainerLedgerEntry, 'id' | 'kind' | 'amount'>,
): RetainerLedgerEntry => ({
  retainer_id: 1,
  unit: 'cents',
  invoice_id: null,
  occurred_on: '2026-01-01',
  notes: null,
  created_at: timestamp,
  ...overrides,
})

const client = (fields: Record<string, unknown>): GeneralResource => ({
  id: 4,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})

describe('Retainer model', () => {
  it('[unit] reads the status filter and the open detail out of one URL', () => {
    const url = (path: string): URL => new URL(path, 'https://time.example.test')
    expect(retainerStatusFilterFromUrl(url('/invoices/retainers'))).toBe('ongoing')
    expect(retainerStatusFilterFromUrl(url('/invoices/retainers?status=all'))).toBe('all')
    expect(retainerSelectionFromUrl(url('/invoices/retainers?retainer=12'))).toBe(12)
    // An id that is not an id opens the list rather than a detail for NaN.
    expect(retainerSelectionFromUrl(url('/invoices/retainers?retainer=0'))).toBeNull()
    expect(retainerSelectionFromUrl(url('/invoices/retainers?retainer=x'))).toBeNull()
    expect(retainerWorkspaceUrl('ongoing')).toBe('/invoices/retainers')
    expect(retainerWorkspaceUrl('all', 12)).toBe('/invoices/retainers?status=all&retainer=12')
  })

  it('[unit] [inv-10] totals the ledger the way the balance view does', () => {
    const entries = [
      entry({ id: 'a', kind: 'deposit', amount: 500_000, invoice_id: 7 }),
      entry({ id: 'b', kind: 'drawdown', amount: -120_000, invoice_id: 8 }),
      entry({ id: 'c', kind: 'expiry', amount: -30_000 }),
      entry({ id: 'd', kind: 'adjustment', amount: -30_000, notes: 'Credit note' }),
    ]
    const summary = retainerLedgerSummary(entries)
    expect(summary).toEqual({
      movements: 4,
      deposited: 500_000,
      drawnDown: 120_000,
      expired: 30_000,
      adjusted: -30_000,
      balance: 320_000,
    })
    // Invariant 10: the balance is the sum of the entries and nothing else.
    expect(summary.balance).toBe(entries.reduce((sum, item) => sum + item.amount, 0))
    // And the running balance ends where the retainer says it is, which is what
    // makes the history readable as an account.
    const history = retainerLedgerHistory(entries)
    expect(history.map((movement) => movement.balance)).toEqual([
      500_000, 380_000, 350_000, 320_000,
    ])
    expect(history.at(-1)!.balance).toBe(money().balance)
  })

  it('[unit] never derives drawn down from the agreed amount', () => {
    // A deposit of 200,000 against an agreed 500,000: the drawdown is 40,000,
    // not the 340,000 that `commitment - balance` would claim.
    const entries = [
      entry({ id: 'a', kind: 'deposit', amount: 200_000, invoice_id: 7 }),
      entry({ id: 'b', kind: 'drawdown', amount: -40_000, invoice_id: 8 }),
    ]
    const summary = retainerLedgerSummary(entries)
    expect(summary.drawnDown).toBe(40_000)
    expect(summary.balance).toBe(160_000)
    expect(retainerCommitment(money()) !== null && retainerCommitment(money())! - summary.balance)
      .not.toBe(summary.drawnDown)
  })

  it('[unit] states a Harvest stub as unrecorded rather than as zero on retainer', () => {
    const stub = harvestStub()
    expect(retainerCommitment(stub)).toBeNull()
    expect(retainerCommitmentLabel(stub, 'USD')).toBe('Not recorded')
    // No commitment means no share to be a percentage of, rather than a
    // division by zero rendered as Infinity or NaN.
    expect(retainerRemainingShare(stub)).toBeNull()
    const notes = retainerLedgerNotes(stub, retainerLedgerSummary([]))
    expect(notes.join(' ')).toContain('No movements recorded yet')
    expect(notes.join(' ')).toContain('No agreed amount is recorded')
  })

  it('[unit] names an opening balance that arrived without a deposit', () => {
    const opening = entry({
      id: 'ret_open',
      kind: 'adjustment',
      amount: 450_000,
      notes: 'Harvest opening balance',
    })
    const stub = harvestStub({ balance: 450_000 })
    const summary = retainerLedgerSummary([opening])
    expect(summary.deposited).toBe(0)
    expect(summary.balance).toBe(stub.balance)
    expect(retainerLedgerNotes(stub, summary).join(' ')).toContain('No deposit has been posted')
  })

  it('[unit] says an overdrawn retainer is overdrawn, in sign and in words', () => {
    const overdrawn = money({ on_exhaustion: 'overflow', balance: -25_000 })
    expect(retainerRemainingShare(overdrawn)).toBeLessThan(0)
    expect(retainerAmount(overdrawn.balance, 'cents', 'USD')).toBe('-$250.00')
    expect(retainerLedgerNotes(overdrawn, retainerLedgerSummary([])).join(' ')).toContain(
      'overdrawn',
    )
  })

  it('[unit] values an hours balance only at a locked rate', () => {
    const unlocked = hours()
    expect(retainerLockedRateValueCents(unlocked, unlocked.balance)).toBeNull()
    const locked = hours({ locked_rate_cents: 15_000, rate_locked_at: timestamp })
    // 20 hours at $150.00/hour.
    expect(retainerLockedRateValueCents(locked, locked.balance)).toBe(300_000)
    // A money retainer has no rate to lock, so it claims no second number.
    expect(retainerLockedRateValueCents(money(), money().balance)).toBeNull()
    expect(retainerAmount(locked.balance, 'seconds', 'USD')).toBe('20 hours')
  })

  it('[unit] takes its currency from the client, and falls back rather than throwing', () => {
    expect(retainerCurrency(money(), [client({ currency: 'EUR' })])).toBe('EUR')
    expect(retainerCurrency(money(), [])).toBe('USD')
    expect(retainerAmount(500_000, 'cents', 'EUR')).toContain('5,000.00')
    // An unusable currency code must not take the screen down with it.
    expect(retainerAmount(500_000, 'cents', 'not-a-currency')).toBe('$5,000.00')
  })

  it('[unit] flags a project scoped to a different client than the retainer', () => {
    const project = (clientId: number): GeneralResource => ({
      id: 3,
      client_id: clientId,
      name: 'Rollout',
      created_at: timestamp,
      updated_at: timestamp,
    })
    const scoped = money({ project_id: 3 })
    expect(retainerScopeConflict(scoped, [project(4)])).toBe(false)
    expect(retainerScopeConflict(scoped, [project(11)])).toBe(true)
    // An unknown project cannot be judged, so it is not accused.
    expect(retainerScopeConflict(scoped, [])).toBe(false)
    expect(retainerProjectLabel(money(), [])).toBe('All projects')
    expect(retainerProjectLabel(scoped, [project(4)])).toBe('Rollout')
  })
})
