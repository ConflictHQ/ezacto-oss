import { describe, expect, it } from 'vitest'
import { trackedAmountCents, uninvoicedGenerationPreview } from '../src/reports.js'

describe('report generation arithmetic', () => {
  it('[unit] prices stored rounded seconds with integer half-up cents', () => {
    expect(trackedAmountCents(1_800, 12_345)).toBe(6_173)
    expect(trackedAmountCents(3_599, 1)).toBe(1)
    expect(trackedAmountCents(1_799, 1)).toBe(0)
  })

  it('[unit] prices a correction entry as the exact negative of what it offsets', () => {
    // #279: Harvest offsets an over-logged entry with a negative one. Pricing
    // the magnitude and carrying the sign is what makes the pair cancel — a
    // half-up round applied to the negative directly would leave a cent behind.
    expect(trackedAmountCents(-3_600, 6_000)).toBe(-6_000)
    expect(trackedAmountCents(-1_800, 12_345)).toBe(-6_173)
    expect(trackedAmountCents(-1_800, 12_345)).toBe(-trackedAmountCents(1_800, 12_345))
    expect(trackedAmountCents(-1_799, 1)).toBe(0)
    expect(() => trackedAmountCents(3_600, -1)).toThrow('hourly rate cents')
  })

  it('[unit] nets a correction out of the uninvoiced generation preview', () => {
    expect(
      uninvoicedGenerationPreview({
        timeEntries: [
          { id: 1, currency: 'USD', roundedSeconds: 3_600, billableRateCents: 17_500 },
          { id: 2, currency: 'USD', roundedSeconds: -900, billableRateCents: 17_500 },
        ],
        expenses: [],
      }),
    ).toEqual([
      {
        currency: 'USD',
        roundedSeconds: 2_700,
        timeEntryCount: 2,
        unpricedTimeEntryCount: 0,
        expenseCount: 0,
        timeCents: 13_125,
        expenseCents: 0,
        totalCents: 13_125,
      },
    ])
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
