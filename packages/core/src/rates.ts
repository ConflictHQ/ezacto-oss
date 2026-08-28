export const billingMethods = [
  'non_billable',
  'time_materials',
  'fixed_fee',
] as const
export const billByValues = ['project', 'tasks', 'people', 'none'] as const
export const budgetByValues = [
  'project',
  'project_cost',
  'task',
  'task_fees',
  'person',
  'none',
] as const

export type BillingMethod = (typeof billingMethods)[number]
export type BillBy = (typeof billByValues)[number]
export type BudgetBy = (typeof budgetByValues)[number]

export interface DatedRate {
  amountCents: number
  startDate: string | null
  endDate: string | null
}

export interface RateResolutionInput {
  spentDate: string
  project: {
    id: number
    billingMethod: BillingMethod
    billBy: BillBy
    hourlyRateCents: number | null
    budgetBy: BudgetBy
    budgetSeconds: number | null
    costBudgetCents: number | null
  }
  taskAssignment: {
    id: number
    hourlyRateCents: number | null
    budgetSeconds: number | null
    budgetCents: number | null
  }
  userAssignment: {
    id: number
    useDefaultRates: boolean
    hourlyRateCents: number | null
    budgetSeconds: number | null
  }
  userBillableRates: readonly DatedRate[]
  userCostRates: readonly DatedRate[]
}

export type BudgetGrain =
  | {
      budgetBy: 'project'
      source: 'project'
      sourceId: number
      unit: 'seconds'
      amount: number | null
    }
  | {
      budgetBy: 'project_cost'
      source: 'project'
      sourceId: number
      unit: 'cents'
      amount: number | null
    }
  | {
      budgetBy: 'task'
      source: 'task_assignment'
      sourceId: number
      unit: 'seconds'
      amount: number | null
    }
  | {
      budgetBy: 'task_fees'
      source: 'task_assignment'
      sourceId: number
      unit: 'cents'
      amount: number | null
    }
  | {
      budgetBy: 'person'
      source: 'user_assignment'
      sourceId: number
      unit: 'seconds'
      amount: number | null
    }

export interface RateResolution {
  billableRateCents: number | null
  costRateCents: number | null
  budget: BudgetGrain | null
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/

const assertDate = (value: string, field: string): void => {
  const match = datePattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical date`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`${field} must be a real calendar date`)
  }
}

const assertNullableAmount = (value: number | null, field: string): void => {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${field} must be null or a non-negative safe integer`)
  }
}

const effectiveRate = (
  spentDate: string,
  rates: readonly DatedRate[],
  kind: 'billable' | 'cost',
): number | null => {
  const effective: DatedRate[] = []
  for (const rate of rates) {
    assertNullableAmount(rate.amountCents, `${kind} rate`)
    if (rate.startDate !== null)
      assertDate(rate.startDate, `${kind} rate start date`)
    if (rate.endDate !== null) assertDate(rate.endDate, `${kind} rate end date`)
    if (
      rate.startDate !== null &&
      rate.endDate !== null &&
      rate.startDate > rate.endDate
    ) {
      throw new RangeError(`${kind} rate range is inverted`)
    }
    if (
      (rate.startDate === null || rate.startDate <= spentDate) &&
      (rate.endDate === null || rate.endDate >= spentDate)
    ) {
      effective.push(rate)
    }
  }
  if (effective.length > 1)
    throw new Error(`multiple ${kind} rates are effective at spent date`)
  return effective[0]?.amountCents ?? null
}

const resolveBudget = (input: RateResolutionInput): BudgetGrain | null => {
  const { project, taskAssignment, userAssignment } = input
  switch (project.budgetBy) {
    case 'project':
      return {
        budgetBy: 'project',
        source: 'project',
        sourceId: project.id,
        unit: 'seconds',
        amount: project.budgetSeconds,
      }
    case 'project_cost':
      return {
        budgetBy: 'project_cost',
        source: 'project',
        sourceId: project.id,
        unit: 'cents',
        amount: project.costBudgetCents,
      }
    case 'task':
      return {
        budgetBy: 'task',
        source: 'task_assignment',
        sourceId: taskAssignment.id,
        unit: 'seconds',
        amount: taskAssignment.budgetSeconds,
      }
    case 'task_fees':
      return {
        budgetBy: 'task_fees',
        source: 'task_assignment',
        sourceId: taskAssignment.id,
        unit: 'cents',
        amount: taskAssignment.budgetCents,
      }
    case 'person':
      return {
        budgetBy: 'person',
        source: 'user_assignment',
        sourceId: userAssignment.id,
        unit: 'seconds',
        amount: userAssignment.budgetSeconds,
      }
    case 'none':
      return null
  }
}

/**
 * The canonical rate resolver from domain model section 4. It is deliberately
 * pure: callers supply rate history and the entry's spent date, never a clock.
 */
export const resolveRates = (input: RateResolutionInput): RateResolution => {
  assertDate(input.spentDate, 'spent date')
  assertNullableAmount(input.project.hourlyRateCents, 'project hourly rate')
  assertNullableAmount(input.project.budgetSeconds, 'project budget')
  assertNullableAmount(input.project.costBudgetCents, 'project cost budget')
  assertNullableAmount(input.taskAssignment.hourlyRateCents, 'task hourly rate')
  assertNullableAmount(input.taskAssignment.budgetSeconds, 'task time budget')
  assertNullableAmount(input.taskAssignment.budgetCents, 'task fee budget')
  assertNullableAmount(
    input.userAssignment.hourlyRateCents,
    'person hourly rate',
  )
  assertNullableAmount(input.userAssignment.budgetSeconds, 'person budget')

  const datedBillableRate = effectiveRate(
    input.spentDate,
    input.userBillableRates,
    'billable',
  )
  const costRateCents = effectiveRate(
    input.spentDate,
    input.userCostRates,
    'cost',
  )
  let billableRateCents: number | null
  if (input.project.billingMethod === 'non_billable') {
    billableRateCents = null
  } else {
    switch (input.project.billBy) {
      case 'project':
        billableRateCents = input.project.hourlyRateCents
        break
      case 'tasks':
        billableRateCents = input.taskAssignment.hourlyRateCents
        break
      case 'people':
        billableRateCents = input.userAssignment.useDefaultRates
          ? datedBillableRate
          : input.userAssignment.hourlyRateCents
        break
      case 'none':
        billableRateCents = null
        break
    }
  }

  return { billableRateCents, costRateCents, budget: resolveBudget(input) }
}
