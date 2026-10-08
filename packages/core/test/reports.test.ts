import { describe, expect, it } from 'vitest'
import {
  hoursToTheHundredth,
  trackedAmountCents,
  uninvoicedGenerationPreview,
} from '../src/reports.js'
import { journalDecimalHours } from '../src/journal-document.js'

describe('report generation arithmetic', () => {
  it('[unit] prices stored rounded seconds with integer half-up cents', () => {
    expect(trackedAmountCents(1_800, 12_345)).toBe(6_173)
    expect(trackedAmountCents(3_599, 1)).toBe(1)
    expect(trackedAmountCents(1_799, 1)).toBe(0)
  })

  it('[money] gives an invoice line its hours to the hundredth, half away from zero', () => {
    // Issue 923: 133944 s is 37.20666... hours, billed as 37.21.
    expect(hoursToTheHundredth(133_944)).toBe(37.21)
    expect(hoursToTheHundredth(4_471)).toBe(1.24)
    expect(hoursToTheHundredth(3_600)).toBe(1)
    expect(hoursToTheHundredth(0)).toBe(0)
    // 18 s is exactly half a hundredth and rounds up. So does 522 s, exactly
    // 0.145 hours, where scaling the float by 100 lands a hair under the half
    // and would print 0.14.
    expect(hoursToTheHundredth(17)).toBe(0)
    expect(hoursToTheHundredth(18)).toBe(0.01)
    expect(hoursToTheHundredth(522)).toBe(0.15)
    expect(hoursToTheHundredth(-522)).toBe(-0.15)
    expect(Object.is(hoursToTheHundredth(-17), 0)).toBe(true)
    expect(() => hoursToTheHundredth(0.5)).toThrow('seconds')
  })

  it('[money] prints the hours the work journal shows as the line bills them', () => {
    for (const seconds of [133_944, 4_471, 522, 1_000, -4_471]) {
      expect(journalDecimalHours(seconds)).toBe(hoursToTheHundredth(seconds).toFixed(2))
    }
    expect(journalDecimalHours(133_944)).toBe('37.21')
    expect(journalDecimalHours(522)).toBe('0.15')
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
