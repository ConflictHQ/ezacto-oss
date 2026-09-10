import type {
  GeneralResource,
  Invoice,
  Retainer,
  RetainerLedgerEntry,
} from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  retainerAmount,
  retainerAmountFromForm,
  retainerCommitment,
  retainerCommitmentLabel,
  retainerCreateInput,
  retainerCurrency,
  retainerInvoiceLabel,
  retainerLedgerBalanceEffect,
  retainerLedgerHistory,
  retainerLedgerNotes,
  retainerLedgerRequestAmount,
  retainerLedgerSummary,
  retainerLinkedInvoices,
  retainerLockedRateValueCents,
  retainerPolicyPatch,
  retainerProjectedBalance,
  retainerProjectLabel,
  retainerRemainingShare,
  retainerScopeConflict,
  retainerSelectionFromUrl,
  retainerStatusFilterFromUrl,
  retainerWorkspaceUrl,
  retainerWouldOverdraw,
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

/**
 * The write path's arithmetic, tested against the rules the server actually
 * applies rather than against this module's own restatement of them:
 *
 * - `sign = kind is drawdown or expiry ? -1 : +1`, applied by the API to a
 *   magnitude before the row is written (`money-resources.ts`, `append`).
 * - `retainer_ledger_balance_guard` aborts when `on_exhaustion <> 'overflow'
 *   AND balance + amount < 0` — so `warn` refuses exactly as `block` does.
 * - `amount_cents`/`seconds` have a minimum of 1 on every kind but `reset` and
 *   `adjustment`, which take a signed non-zero value.
 */
describe('Retainer write path', () => {
  const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
    ({
      id: 77,
      client_id: 4,
      number: 'INV-77',
      currency: 'USD',
      issue_date: '2026-02-01',
      amount_cents: 500_000,
      retainer_id: 1,
      created_at: timestamp,
      updated_at: timestamp,
      ...overrides,
    }) as Invoice

  it('[unit] converts a typed amount to its column exactly, in either unit', () => {
    expect(retainerAmountFromForm('5000', 'cents')).toBe(500_000)
    expect(retainerAmountFromForm('1234.56', 'cents')).toBe(123_456)
    expect(retainerAmountFromForm('0.07', 'cents')).toBe(7)
    expect(retainerAmountFromForm('40', 'seconds')).toBe(144_000)
    expect(retainerAmountFromForm('7.5', 'seconds')).toBe(27_000)
    // The reason the conversion goes through BigInt rather than a scale and a
    // truncate. Both of these land *below* the integer they should be in binary
    // floating point, so truncating loses a second off the hour and a cent off
    // the dollar -- on 345 of the 10,000 two-decimal hour values and 9,174 of
    // the first 200,000 cent ones, not on a curiosity.
    expect(1.13 * 3_600).toBeLessThan(4_068)
    expect(retainerAmountFromForm('1.13', 'seconds')).toBe(4_068)
    expect(0.29 * 100).toBeLessThan(29)
    expect(retainerAmountFromForm('0.29', 'cents')).toBe(29)
    // A hundredth of an hour is 36 whole seconds, so two decimals is exact in
    // both units and neither needs a rounding rule.
    expect(retainerAmountFromForm('0.01', 'seconds')).toBe(36)

    // A sign typed into the amount would be negated by the server's own sign
    // and credit the retainer the operator meant to spend, so it never parses.
    expect(() => retainerAmountFromForm('-1200', 'cents')).toThrow(/two decimals/u)
    expect(() => retainerAmountFromForm('12.345', 'cents')).toThrow(/two decimals/u)
    expect(() => retainerAmountFromForm('', 'cents')).toThrow(/two decimals/u)
    expect(() => retainerAmountFromForm('1e3', 'cents')).toThrow(/two decimals/u)
    expect(() => retainerAmountFromForm('90000000000000', 'cents')).toThrow(/too large/u)
  })

  it('[unit] [money] signs a movement the way the API signs it, and no other way', () => {
    // Unsigned kinds carry a magnitude; the direction control does not apply to
    // them, so asking for a decrease cannot make the request body negative.
    expect(retainerLedgerRequestAmount('deposit', 500_000, 'increase')).toBe(500_000)
    expect(retainerLedgerRequestAmount('deposit', 500_000, 'decrease')).toBe(500_000)
    expect(retainerLedgerRequestAmount('expiry', 60_000, 'decrease')).toBe(60_000)
    // `reset` and `adjustment` are the two kinds whose column takes a sign.
    expect(retainerLedgerRequestAmount('adjustment', 30_000, 'increase')).toBe(30_000)
    expect(retainerLedgerRequestAmount('adjustment', 30_000, 'decrease')).toBe(-30_000)
    expect(retainerLedgerRequestAmount('reset', 30_000, 'decrease')).toBe(-30_000)

    // What the balance does, restating `sign` on this side: a deposit adds a
    // magnitude, a drawdown and an expiry subtract one, a signed kind applies
    // its own sign.
    expect(retainerLedgerBalanceEffect('deposit', 500_000)).toBe(500_000)
    expect(retainerLedgerBalanceEffect('drawdown', 120_000)).toBe(-120_000)
    expect(retainerLedgerBalanceEffect('expiry', 60_000)).toBe(-60_000)
    expect(retainerLedgerBalanceEffect('adjustment', -30_000)).toBe(-30_000)
    expect(retainerLedgerBalanceEffect('reset', 30_000)).toBe(30_000)
  })

  it('[unit] [money] projects the balance one movement ahead, arithmetically', () => {
    const balance = 320_000
    expect(retainerProjectedBalance(balance, 'deposit', 500_000)).toBe(820_000)
    expect(retainerProjectedBalance(balance, 'drawdown', 120_000)).toBe(200_000)
    expect(retainerProjectedBalance(balance, 'expiry', 60_000)).toBe(260_000)
    expect(retainerProjectedBalance(balance, 'adjustment', -30_000)).toBe(290_000)
    expect(retainerProjectedBalance(balance, 'reset', 30_000)).toBe(350_000)

    // The projection has to agree with the ledger it is forecasting: post the
    // same four movements as rows and the sum is the same number.
    const posted = [
      entry({ id: 'p1', kind: 'deposit', amount: 500_000, invoice_id: 7 }),
      entry({ id: 'p2', kind: 'drawdown', amount: -120_000, invoice_id: 8 }),
      entry({ id: 'p3', kind: 'expiry', amount: -60_000 }),
      entry({ id: 'p4', kind: 'adjustment', amount: -30_000, notes: 'Credit note' }),
    ]
    expect(posted).toHaveLength(4)
    let projected = 0
    for (const row of posted) {
      const request =
        row.kind === 'drawdown' || row.kind === 'expiry' ? Math.abs(row.amount) : row.amount
      projected = retainerProjectedBalance(projected, row.kind, request)
    }
    expect(projected).toBe(retainerLedgerSummary(posted).balance)
    expect(projected).toBe(290_000)
  })

  it('[unit] [money] reads the overdraw trigger rather than the exhaustion label', () => {
    // `retainer_ledger_balance_guard` tests `on_exhaustion <> 'overflow'`, so a
    // retainer that only says it warns is refused by the database all the same.
    expect(retainerWouldOverdraw(money({ on_exhaustion: 'block' }), -1)).toBe(true)
    expect(retainerWouldOverdraw(money({ on_exhaustion: 'warn' }), -1)).toBe(true)
    expect(retainerWouldOverdraw(money({ on_exhaustion: 'overflow' }), -1)).toBe(false)
    // Zero is not an overdraw: spending a retainer to the cent is allowed.
    expect(retainerWouldOverdraw(money({ on_exhaustion: 'block' }), 0)).toBe(false)

    const blocked = money({ balance: 320_000, on_exhaustion: 'block' })
    expect(
      retainerWouldOverdraw(
        blocked,
        retainerProjectedBalance(blocked.balance, 'drawdown', 320_000),
      ),
    ).toBe(false)
    expect(
      retainerWouldOverdraw(
        blocked,
        retainerProjectedBalance(blocked.balance, 'drawdown', 320_001),
      ),
    ).toBe(true)
  })

  it('[unit] builds the create body its denomination allows, and locks a rate only at creation', () => {
    const base = {
      clientId: 4,
      projectId: null,
      amount: '5000',
      lockedRate: '',
      period: '  monthly  ',
      rollover: '' as const,
      expiresAt: '',
      onExhaustion: 'block' as const,
    }
    expect(retainerCreateInput({ ...base, denomination: 'money' }, timestamp)).toEqual({
      client_id: 4,
      project_id: null,
      denomination: 'money',
      amount_cents: 500_000,
      period: 'monthly',
      rollover: null,
      expires_at: null,
      on_exhaustion: 'block',
    })
    // An hours retainer sends `seconds` and no `amount_cents`: the API's union
    // has no member carrying both.
    const unlocked = retainerCreateInput(
      { ...base, denomination: 'hours', amount: '40', period: '', rollover: 'cap' },
      timestamp,
    )
    expect(unlocked).toEqual({
      client_id: 4,
      project_id: null,
      denomination: 'hours',
      seconds: 144_000,
      period: null,
      rollover: 'cap',
      expires_at: null,
      on_exhaustion: 'block',
    })
    expect(Object.hasOwn(unlocked, 'locked_rate_cents')).toBe(false)
    expect(
      retainerCreateInput(
        {
          ...base,
          denomination: 'hours',
          amount: '40',
          lockedRate: '150',
          expiresAt: '2026-12-31',
          onExhaustion: 'overflow',
        },
        timestamp,
      ),
    ).toEqual({
      client_id: 4,
      project_id: null,
      denomination: 'hours',
      seconds: 144_000,
      locked_rate_cents: 15_000,
      rate_locked_at: timestamp,
      period: 'monthly',
      rollover: null,
      expires_at: '2026-12-31',
      on_exhaustion: 'overflow',
    })
  })

  it('[unit] patches only what the operator changed, because PATCH carries no version', () => {
    const retainer = money({
      state: 'ongoing',
      period: 'monthly',
      rollover: 'carry',
      expires_at: null,
      on_exhaustion: 'block',
    })
    const unchanged = {
      state: 'ongoing' as const,
      period: 'monthly',
      rollover: 'carry' as const,
      expiresAt: '',
      onExhaustion: 'block' as const,
    }
    // Nothing touched is an empty body, which the API refuses — so the screen
    // has to recognise it rather than send four values nobody changed.
    expect(retainerPolicyPatch(retainer, unchanged)).toEqual({})
    expect(retainerPolicyPatch(retainer, { ...unchanged, state: 'closed' })).toEqual({
      state: 'closed',
    })
    expect(retainerPolicyPatch(retainer, { ...unchanged, period: '' })).toEqual({ period: null })
    expect(retainerPolicyPatch(retainer, { ...unchanged, rollover: '' })).toEqual({
      rollover: null,
    })
    expect(retainerPolicyPatch(retainer, { ...unchanged, expiresAt: '2026-12-31' })).toEqual({
      expires_at: '2026-12-31',
    })
    expect(retainerPolicyPatch(retainer, { ...unchanged, onExhaustion: 'overflow' })).toEqual({
      on_exhaustion: 'overflow',
    })
  })

  it('[unit] offers only the invoices the ledger guard will accept, newest first', () => {
    const retainer = money({ id: 1 })
    const linked = retainerLinkedInvoices(retainer, [
      invoice({ id: 77, number: 'INV-77' }),
      // A different retainer's invoice: `retainer_ledger_invoice_client_guard`
      // joins on `invoice.retainer_id = NEW.retainer_id`, so naming this one is
      // a 409 rather than a movement.
      invoice({ id: 90, number: 'INV-90', retainer_id: 2 }),
      invoice({ id: 81, number: 'INV-81' }),
      invoice({ id: 95, number: 'INV-95', retainer_id: null }),
    ])
    expect(linked).toHaveLength(2)
    expect(linked.map((candidate) => candidate.number)).toEqual(['INV-81', 'INV-77'])
    expect(retainerInvoiceLabel(linked[1]!)).toBe('INV-77 · $5,000.00 · 2026-02-01')
  })
})
