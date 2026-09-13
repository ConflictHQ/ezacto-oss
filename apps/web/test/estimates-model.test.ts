import { describe, expect, it } from 'vitest'
import {
  estimateCanConvert,
  estimateConversionMessage,
  estimateConversionOutcome,
  estimateDueDate,
  estimateMoney,
  estimateStateLabel,
} from '../src/estimates/model.js'

/**
 * Issue 485. Seven API paths and nine client methods served since the API
 * shipped, and no screen called any of them.
 */

describe('which estimates can become invoices', () => {
  it('[money] only an accepted one', async () => {
    // A draft was quoted to nobody, a sent one was not agreed, and a declined
    // one was refused. Raising an invoice from any of those bills somebody for
    // work they never agreed to pay for.
    expect(estimateCanConvert({ state: 'accepted' })).toBe(true)
    for (const state of ['draft', 'sent', 'declined']) {
      expect(estimateCanConvert({ state } as never), state).toBe(false)
    }
  })
})

describe('what the screen says happened', () => {
  it('[unit] names every state it can be in', () => {
    expect(
      ['draft', 'sent', 'accepted', 'declined'].map(estimateStateLabel),
    ).toEqual(['Draft', 'Sent', 'Accepted', 'Declined'])
    // An unknown state prints itself rather than an empty cell.
    expect(estimateStateLabel('withdrawn')).toBe('withdrawn')
  })

  it('[money] keeps a refusal apart from a failure', () => {
    // "Not accepted yet" and "already an invoice" are both refusals and neither
    // is a fault. Collapsing them into one error is what makes an operator
    // think a screen is broken when it is telling them something true.
    const refusal = (code: string) =>
      estimateConversionOutcome({ body: { error: { code } } })
    expect(refusal('estimate_not_accepted')).toEqual({ kind: 'not_accepted' })
    expect(refusal('estimate_already_converted')).toEqual({ kind: 'already_converted' })
    expect(estimateConversionMessage({ kind: 'not_accepted' })).toMatch(/only an accepted/iu)
    expect(estimateConversionMessage({ kind: 'already_converted' })).toMatch(/already/iu)
  })

  it('[money] names a taken invoice number, which is the one a person can fix', () => {
    expect(
      estimateConversionOutcome({ body: { error: { code: 'invoice_number_taken' } } }),
    ).toMatchObject({ kind: 'failed', message: /already used/u })
  })

  it('[unit] falls back to the API message, then to the error', () => {
    expect(
      estimateConversionOutcome({ body: { error: { message: 'Client is archived.' } } }),
    ).toEqual({ kind: 'failed', message: 'Client is archived.' })
    expect(estimateConversionOutcome(new Error('offline'))).toEqual({
      kind: 'failed',
      message: 'offline',
    })
  })

  it('[unit] says so when the deployment cannot convert at all', () => {
    expect(estimateConversionMessage({ kind: 'unavailable' })).toMatch(/cannot convert/iu)
  })
})

describe('filling the conversion form in', () => {
  it('[unit] derives the due date from the terms', () => {
    // So nobody does date arithmetic to raise an invoice.
    expect(estimateDueDate('2026-09-12', 'net_30')).toBe('2026-10-12')
    expect(estimateDueDate('2026-09-12', 'net_15')).toBe('2026-09-27')
    expect(estimateDueDate('2026-09-12', 'upon_receipt')).toBe('2026-09-12')
  })

  it('[unit] crosses a month and a year end', () => {
    expect(estimateDueDate('2026-12-20', 'net_30')).toBe('2027-01-19')
  })

  it('[unit] leaves an unreadable date alone rather than inventing one', () => {
    expect(estimateDueDate('not-a-date', 'net_30')).toBe('not-a-date')
  })
})

describe('showing an amount', () => {
  it('[money] formats in the estimate currency', () => {
    expect(estimateMoney(172_5625, 'USD')).toBe('$17,256.25')
  })

  it('[money] falls back rather than going blank on a currency Intl rejects', () => {
    // A screen should not disappear because a currency is unusual.
    expect(estimateMoney(100_00, 'NOTACODE')).toBe('$100.00')
  })
})
