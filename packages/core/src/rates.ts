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

/** One line of a card version: a task's rate, or the card default when taskId is null. */
export interface RateCardLine {
  taskId: number | null
  amountCents: number
}

/** One append-only version of a card. A null start date means "all prior". */
export interface RateCardVersion {
  startDate: string | null
  lines: readonly RateCardLine[]
}

export interface RateCard {
  clientId: number
  versions: readonly RateCardVersion[]
}

/**
 * The client rate cards that can price an entry (issue 34). `cards` lists the
 * cards of the project's client and its ancestors, nearest first; a client with
 * no card is simply absent. Inheritance follows the parent chain only, never
 * the bill-to relation.
 */
export interface RateCardContext {
  taskId: number
  cards: readonly RateCard[]
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
  /** Absent or empty: no card applies and the result is exactly the card-less one. */
  rateCards?: RateCardContext
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

/** The version in force on a date: the latest start on or before it. */
const effectiveVersion = (
  spentDate: string,
  card: RateCard,
): RateCardVersion | null => {
  let effective: RateCardVersion | null = null
  const seen = new Set<string>()
  for (const version of card.versions) {
    if (version.startDate !== null)
      assertDate(version.startDate, 'rate card version start date')
    const key = version.startDate ?? ''
    if (seen.has(key))
      throw new Error('rate card has two versions with the same start date')
    seen.add(key)
    for (const line of version.lines) {
      if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 0)
        throw new RangeError('rate card line must be a non-negative safe integer')
    }
    if (version.startDate !== null && version.startDate > spentDate) continue
    if (
      effective === null ||
      (version.startDate !== null &&
        (effective.startDate === null || version.startDate > effective.startDate))
    ) {
      effective = version
    }
  }
  return effective
}

/** The card line that priced an entry, and which card and version supplied it. */
export interface RateCardPick {
  clientId: number
  /** Position in `cards`; with nearest-first input, 0 is the project's own client. */
  position: number
  versionStartDate: string | null
  /** The line's task, or null when the card default priced it. */
  taskId: number | null
  amountCents: number
}

/**
 * The nearest card that prices this task. A card with no version in force, an
 * empty version (how a card is retired), or no line for the task and no default
 * line is skipped and the next ancestor is tried; it never prices at zero.
 */
export const pickRateCardLine = (
  spentDate: string,
  context: RateCardContext,
): RateCardPick | null => {
  assertDate(spentDate, 'spent date')
  for (const [position, card] of context.cards.entries()) {
    const version = effectiveVersion(spentDate, card)
    if (version === null) continue
    const taskLines = version.lines.filter((line) => line.taskId === context.taskId)
    const defaults = version.lines.filter((line) => line.taskId === null)
    if (taskLines.length > 1 || defaults.length > 1)
      throw new Error('rate card version has duplicate lines')
    const line = taskLines[0] ?? defaults[0]
    if (line !== undefined) {
      return {
        clientId: card.clientId,
        position,
        versionStartDate: version.startDate,
        taskId: line.taskId,
        amountCents: line.amountCents,
      }
    }
  }
  return null
}

const cardRate = (
  spentDate: string,
  context: RateCardContext | undefined,
): number | null =>
  context === undefined
    ? null
    : (pickRateCardLine(spentDate, context)?.amountCents ?? null)

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
          ? (cardRate(input.spentDate, input.rateCards) ?? datedBillableRate)
          : input.userAssignment.hourlyRateCents
        break
      case 'none':
        billableRateCents = null
        break
    }
  }

  return { billableRateCents, costRateCents, budget: resolveBudget(input) }
}
