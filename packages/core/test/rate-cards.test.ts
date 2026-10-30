import { describe, expect, it } from 'vitest'
import {
  billByValues,
  resolveRates,
  type BillBy,
  type RateCard,
  type RateResolutionInput,
} from '../src/rates.js'

const TASK = 7

const input = (
  changes: {
    billBy?: BillBy
    useDefaultRates?: boolean
    datedBillable?: number | null
    cards?: readonly RateCard[]
    spentDate?: string
  } = {},
): RateResolutionInput => ({
  spentDate: changes.spentDate ?? '2026-06-15',
  project: {
    id: 11,
    billingMethod: 'time_materials',
    billBy: changes.billBy ?? 'people',
    hourlyRateCents: 10_000,
    budgetBy: 'none',
    budgetSeconds: null,
    costBudgetCents: null,
  },
  taskAssignment: { id: 22, hourlyRateCents: 20_000, budgetSeconds: null, budgetCents: null },
  userAssignment: {
    id: 33,
    useDefaultRates: changes.useDefaultRates ?? true,
    hourlyRateCents: 30_000,
    budgetSeconds: null,
  },
  userBillableRates:
    changes.datedBillable === null
      ? []
      : [{ amountCents: changes.datedBillable ?? 40_000, startDate: null, endDate: null }],
  userCostRates: [],
  ...(changes.cards === undefined ? {} : { rateCards: { taskId: TASK, cards: changes.cards } }),
})

const card = (clientId: number, ...versions: RateCard['versions'][number][]): RateCard => ({
  clientId,
  versions,
})
const single = (amountCents: number, startDate: string | null = null) => ({
  startDate,
  lines: [{ taskId: null, amountCents }],
})

describe('client rate cards in the rate resolver', () => {
  it('[unit] no card gives the card-less result for every bill_by and use_default_rates', () => {
    for (const billBy of billByValues) {
      for (const useDefaultRates of [false, true]) {
        const base = resolveRates(input({ billBy, useDefaultRates }))
        expect(resolveRates(input({ billBy, useDefaultRates, cards: [] }))).toEqual(base)
        expect(
          resolveRates(
            input({ billBy, useDefaultRates, cards: [card(1, { startDate: null, lines: [] })] }),
          ),
        ).toEqual(base)
      }
    }
  })

  it('[unit] a card prices only the bill_by=people leg with default rates', () => {
    const cards = [card(1, single(99_000))]
    for (const billBy of ['project', 'tasks', 'none'] as const) {
      expect(resolveRates(input({ billBy, cards })).billableRateCents).toEqual(
        resolveRates(input({ billBy })).billableRateCents,
      )
    }
    expect(resolveRates(input({ cards, useDefaultRates: false })).billableRateCents).toBe(30_000)
    expect(resolveRates(input({ cards })).billableRateCents).toBe(99_000)
  })

  it('[unit] a non-billable project stays unpriced whatever the card says', () => {
    const candidate = input({ cards: [card(1, single(99_000))] })
    candidate.project.billingMethod = 'non_billable'
    expect(resolveRates(candidate).billableRateCents).toBeNull()
  })

  it('[unit] the nearest card wins: a node override beats an inherited card', () => {
    const cards = [card(3, single(5_000)), card(2, single(6_000)), card(1, single(7_000))]
    expect(resolveRates(input({ cards })).billableRateCents).toBe(5_000)
    expect(resolveRates(input({ cards: cards.slice(1) })).billableRateCents).toBe(6_000)
  })

  it('[unit] precedence table: assignment override > node card > inherited card > person default', () => {
    const own = card(3, single(5_000))
    const inherited = card(1, single(7_000))
    const cases: Array<[boolean, readonly RateCard[], number | null, number | null]> = [
      [false, [own, inherited], 40_000, 30_000],
      [true, [own, inherited], 40_000, 5_000],
      [true, [inherited], 40_000, 7_000],
      [true, [], 40_000, 40_000],
      [true, [], null, null],
    ]
    for (const [useDefaultRates, cards, datedBillable, expected] of cases) {
      expect(
        resolveRates(input({ useDefaultRates, cards, datedBillable })).billableRateCents,
      ).toBe(expected)
    }
  })

  it('[unit] a task line beats the card default, and the default covers other tasks', () => {
    const lines = [
      { taskId: TASK, amountCents: 12_000 },
      { taskId: null, amountCents: 8_000 },
      { taskId: 99, amountCents: 1_000 },
    ]
    expect(
      resolveRates(input({ cards: [card(1, { startDate: null, lines })] })).billableRateCents,
    ).toBe(12_000)
    const otherOnly = [
      { taskId: 99, amountCents: 1_000 },
      { taskId: null, amountCents: 8_000 },
    ]
    expect(
      resolveRates(input({ cards: [card(1, { startDate: null, lines: otherOnly })] }))
        .billableRateCents,
    ).toBe(8_000)
  })

  it('[unit] a card with no line for the task and no default is skipped, not zero', () => {
    const noMatch = card(2, { startDate: null, lines: [{ taskId: 99, amountCents: 1_000 }] })
    expect(
      resolveRates(input({ cards: [noMatch, card(1, single(7_000))] })).billableRateCents,
    ).toBe(7_000)
    expect(resolveRates(input({ cards: [noMatch] })).billableRateCents).toBe(40_000)
    expect(
      resolveRates(input({ cards: [noMatch], datedBillable: null })).billableRateCents,
    ).toBeNull()
  })

  it('[unit] uses the version effective at spent_date, and none effective is skipped', () => {
    const versioned = card(2, single(5_000, '2026-01-01'), single(6_000, '2026-07-01'))
    const at = (spentDate: string) =>
      resolveRates(input({ cards: [versioned, card(1, single(7_000))], spentDate }))
        .billableRateCents
    expect(at('2025-12-31')).toBe(7_000)
    expect(at('2026-01-01')).toBe(5_000)
    expect(at('2026-06-30')).toBe(5_000)
    expect(at('2026-07-01')).toBe(6_000)
    // versions may arrive in any order
    const reversed = card(2, single(6_000, '2026-07-01'), single(5_000, '2026-01-01'))
    expect(
      resolveRates(input({ cards: [reversed], spentDate: '2026-06-30' })).billableRateCents,
    ).toBe(5_000)
    // a null start is "all prior" and loses to any dated version in force
    const openStart = card(2, single(4_000), single(6_000, '2026-07-01'))
    expect(
      resolveRates(input({ cards: [openStart], spentDate: '2026-06-30' })).billableRateCents,
    ).toBe(4_000)
    expect(
      resolveRates(input({ cards: [openStart], spentDate: '2026-07-02' })).billableRateCents,
    ).toBe(6_000)
  })

  it('[unit] an empty latest version retires the card and the ancestor prices instead', () => {
    const retired = card(2, single(5_000, '2026-01-01'), { startDate: '2026-06-01', lines: [] })
    const cards = [retired, card(1, single(7_000))]
    expect(resolveRates(input({ cards, spentDate: '2026-05-31' })).billableRateCents).toBe(5_000)
    expect(resolveRates(input({ cards, spentDate: '2026-06-01' })).billableRateCents).toBe(7_000)
  })

  it('[unit] an explicit zero line is a price, not a gap', () => {
    expect(resolveRates(input({ cards: [card(1, single(0))] })).billableRateCents).toBe(0)
  })

  it('[unit] rejects malformed cards instead of guessing', () => {
    expect(() => resolveRates(input({ cards: [card(1, single(1), single(2))] }))).toThrow(
      /same start/,
    )
    expect(() => resolveRates(input({ cards: [card(1, single(-1))] }))).toThrow(RangeError)
    expect(() => resolveRates(input({ cards: [card(1, single(1.5))] }))).toThrow(RangeError)
    expect(() => resolveRates(input({ cards: [card(1, single(1, '2026-02-30'))] }))).toThrow(
      RangeError,
    )
    const duplicated = { startDate: null, lines: [...single(1).lines, ...single(2).lines] }
    expect(() => resolveRates(input({ cards: [card(1, duplicated)] }))).toThrow(/duplicate/)
  })
})
