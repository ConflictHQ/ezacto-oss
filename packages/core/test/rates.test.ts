import { describe, expect, it } from 'vitest'
import {
  billByValues,
  budgetByValues,
  resolveRates,
  type BillBy,
  type BudgetBy,
  type RateResolutionInput,
} from '../src/rates.js'

const input = (
  changes: {
    billBy?: BillBy
    budgetBy?: BudgetBy
    useDefaultRates?: boolean
    datedBillable?: number | null
    datedCost?: number | null
    spentDate?: string
  } = {},
): RateResolutionInput => ({
  spentDate: changes.spentDate ?? '2026-06-15',
  project: {
    id: 11,
    billingMethod: 'time_materials',
    billBy: changes.billBy ?? 'project',
    hourlyRateCents: 10_000,
    budgetBy: changes.budgetBy ?? 'none',
    budgetSeconds: 100,
    costBudgetCents: 200,
  },
  taskAssignment: {
    id: 22,
    hourlyRateCents: 20_000,
    budgetSeconds: 300,
    budgetCents: 400,
  },
  userAssignment: {
    id: 33,
    useDefaultRates: changes.useDefaultRates ?? true,
    hourlyRateCents: 30_000,
    budgetSeconds: 500,
  },
  userBillableRates:
    changes.datedBillable === null
      ? []
      : [
          {
            amountCents: changes.datedBillable ?? 40_000,
            startDate: null,
            endDate: null,
          },
        ],
  userCostRates:
    changes.datedCost === null
      ? []
      : [
          {
            amountCents: changes.datedCost ?? 50_000,
            startDate: null,
            endDate: null,
          },
        ],
})

describe('rate resolver', () => {
  const datedCases = [
    ['missing', null],
    ['explicit zero', 0],
    ['positive', 40_000],
  ] as const

  for (const billBy of billByValues) {
    for (const useDefaultRates of [false, true]) {
      for (const [datedCase, datedBillable] of datedCases) {
        it(`[unit] resolves bill_by=${billBy}, use_default_rates=${useDefaultRates}, dated=${datedCase}`, () => {
          const result = resolveRates(
            input({ billBy, useDefaultRates, datedBillable }),
          )
          const expected =
            billBy === 'project'
              ? 10_000
              : billBy === 'tasks'
                ? 20_000
                : billBy === 'people'
                  ? useDefaultRates
                    ? datedBillable
                    : 30_000
                  : null
          expect(result.billableRateCents).toBe(expected)
        })
      }
    }
  }

  it.each([
    [null, 50_000, null, 50_000],
    [40_000, null, 40_000, null],
    [null, null, null, null],
    [0, 0, 0, 0],
  ] as const)(
    '[unit] keeps billable=%s and cost=%s independently nullable without zero substitution',
    (datedBillable, datedCost, expectedBillable, expectedCost) => {
      const result = resolveRates(
        input({
          billBy: 'people',
          useDefaultRates: true,
          datedBillable,
          datedCost,
        }),
      )
      expect([result.billableRateCents, result.costRateCents]).toEqual([
        expectedBillable,
        expectedCost,
      ])
    },
  )

  it('[unit] uses spent_date across a mid-period change and has no today input', () => {
    const histories: Pick<
      RateResolutionInput,
      'userBillableRates' | 'userCostRates'
    > = {
      userBillableRates: [
        { amountCents: 11_000, startDate: null, endDate: '2026-06-30' },
        { amountCents: 22_000, startDate: '2026-07-01', endDate: null },
      ],
      userCostRates: [
        { amountCents: 3_000, startDate: null, endDate: '2026-06-30' },
        { amountCents: 4_000, startDate: '2026-07-01', endDate: null },
      ],
    }
    const before = resolveRates({
      ...input({
        billBy: 'people',
        useDefaultRates: true,
        spentDate: '2026-06-30',
      }),
      ...histories,
    })
    const after = resolveRates({
      ...input({
        billBy: 'people',
        useDefaultRates: true,
        spentDate: '2026-07-01',
      }),
      ...histories,
    })
    expect([before.billableRateCents, before.costRateCents]).toEqual([
      11_000, 3_000,
    ])
    expect([after.billableRateCents, after.costRateCents]).toEqual([
      22_000, 4_000,
    ])
  })

  const budgetExpectations: Record<BudgetBy, unknown> = {
    project: {
      budgetBy: 'project',
      source: 'project',
      sourceId: 11,
      unit: 'seconds',
      amount: 100,
    },
    project_cost: {
      budgetBy: 'project_cost',
      source: 'project',
      sourceId: 11,
      unit: 'cents',
      amount: 200,
    },
    task: {
      budgetBy: 'task',
      source: 'task_assignment',
      sourceId: 22,
      unit: 'seconds',
      amount: 300,
    },
    task_fees: {
      budgetBy: 'task_fees',
      source: 'task_assignment',
      sourceId: 22,
      unit: 'cents',
      amount: 400,
    },
    person: {
      budgetBy: 'person',
      source: 'user_assignment',
      sourceId: 33,
      unit: 'seconds',
      amount: 500,
    },
    none: null,
  }

  it.each(budgetByValues)(
    '[unit] resolves budget_by=%s to its live grain',
    (budgetBy) => {
      expect(resolveRates(input({ budgetBy })).budget).toEqual(
        budgetExpectations[budgetBy],
      )
    },
  )

  it.each(billByValues)(
    '[unit] returns no billable rate for non-billable projects regardless of bill_by=%s',
    (billBy) => {
      const candidate = input({ billBy })
      candidate.project.billingMethod = 'non_billable'
      expect(resolveRates(candidate).billableRateCents).toBeNull()
    },
  )

  it('[unit] applies the selected rate to fixed-fee projects because only non-billable disables billing', () => {
    const candidate = input({ billBy: 'tasks' })
    candidate.project.billingMethod = 'fixed_fee'
    expect(resolveRates(candidate).billableRateCents).toBe(20_000)
  })

  it.each([
    ['project', 'project'],
    ['tasks', 'task'],
    ['people', 'person'],
  ] as const)(
    '[unit] preserves missing and explicit-zero %s source rates without substitution',
    (billBy, source) => {
      const missing = input({ billBy, useDefaultRates: false })
      const zero = input({ billBy, useDefaultRates: false })
      if (source === 'project') {
        missing.project.hourlyRateCents = null
        zero.project.hourlyRateCents = 0
      } else if (source === 'task') {
        missing.taskAssignment.hourlyRateCents = null
        zero.taskAssignment.hourlyRateCents = 0
      } else {
        missing.userAssignment.hourlyRateCents = null
        zero.userAssignment.hourlyRateCents = 0
      }
      expect(resolveRates(missing).billableRateCents).toBeNull()
      expect(resolveRates(zero).billableRateCents).toBe(0)
    },
  )

  it('[unit] preserves a configured budget grain whose amount is missing', () => {
    const candidate = input({ budgetBy: 'task_fees' })
    candidate.taskAssignment.budgetCents = null
    expect(resolveRates(candidate).budget).toEqual({
      budgetBy: 'task_fees',
      source: 'task_assignment',
      sourceId: 22,
      unit: 'cents',
      amount: null,
    })
  })

  it('[unit] rejects overlapping rate history instead of guessing', () => {
    const candidate = input({ billBy: 'people' })
    candidate.userBillableRates = [
      { amountCents: 1, startDate: null, endDate: null },
      { amountCents: 2, startDate: '2026-01-01', endDate: null },
    ]
    expect(() => resolveRates(candidate)).toThrow(/multiple billable rates/)
  })
})
