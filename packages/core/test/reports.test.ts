import { describe, expect, it } from 'vitest'
import { trackedAmountCents, uninvoicedGenerationPreview } from '../src/reports.js'

describe('report generation arithmetic', () => {
  it('[unit] prices stored rounded seconds with integer half-up cents', () => {
    expect(trackedAmountCents(1_800, 12_345)).toBe(6_173)
    expect(trackedAmountCents(3_599, 1)).toBe(1)
    expect(trackedAmountCents(1_799, 1)).toBe(0)
  })

  it('[unit] builds deterministic per-currency generation totals without pricing null rates', () => {
    expect(
      uninvoicedGenerationPreview({
        timeEntries: [
          {
            id: 1,
            currency: 'usd',
            roundedSeconds: 1_800,
            billableRateCents: 12_345,
          },
          {
            id: 2,
            currency: 'USD',
            roundedSeconds: 900,
            billableRateCents: null,
          },
        ],
        expenses: [{ id: 1, currency: 'USD', totalCostCents: 827 }],
      }),
    ).toEqual([
      {
        currency: 'USD',
        roundedSeconds: 2_700,
        timeEntryCount: 2,
        unpricedTimeEntryCount: 1,
        expenseCount: 1,
        timeCents: 6_173,
        expenseCents: 827,
        totalCents: 7_000,
      },
    ])
  })
})
