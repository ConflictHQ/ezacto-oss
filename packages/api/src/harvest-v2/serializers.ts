import type { GeneralResourceRecord } from '@ezacto/core'
import type { ExpenseRecord, TimeEntryRecord } from '../resources/tracked-repository.js'

/**
 * Canonical record -> Harvest v2 object. Every compat quirk (decimal hours and
 * dollars, collapsed second-resolution timestamps, Harvest's bill_by casing,
 * the is_billable / is_fixed_fee split, access_roles) lives here and only here;
 * storage stays canonical (docs/domain-model.md section 7). Key order is the
 * order of Harvest's documented objects, so a rendered object byte-compares.
 */

type Field = GeneralResourceRecord[string]

const text = (record: GeneralResourceRecord, field: string): string | null => {
  const value: Field | undefined = record[field]
  return typeof value === 'string' ? value : null
}

const requiredText = (record: GeneralResourceRecord, field: string): string => {
  const value = text(record, field)
  if (value === null) throw new Error(`Harvest shim: ${field} is missing on record ${record.id}`)
  return value
}

const flag = (record: GeneralResourceRecord, field: string): boolean => record[field] === true

const number = (record: GeneralResourceRecord, field: string): number | null => {
  const value: Field | undefined = record[field]
  return typeof value === 'number' ? value : null
}

const twoPlaces = (value: number): number => Math.round(value * 100) / 100

/** Integer cents to Harvest's decimal money. */
export const harvestMoney = (cents: number | null): number | null =>
  cents === null ? null : twoPlaces(cents / 100)

/** Integer seconds to Harvest's decimal hours. */
export const harvestHours = (seconds: number | null): number | null =>
  seconds === null ? null : twoPlaces(seconds / 3600)

/** Canonical instants carry milliseconds; Harvest's stop at the second. */
export const harvestInstant = (instant: string): string => instant.replace(/\.\d+Z$/, 'Z')

export interface HarvestClient {
  id: number
  name: string
  is_active: boolean
  address: string | null
  currency: string
  created_at: string
  updated_at: string
}

/**
 * statement_key is not rendered: the repository strips the secret from every
 * record (docs/domain-model.md 2.6), so the shim cannot expose it yet.
 */
export const serializeHarvestClient = (client: GeneralResourceRecord): HarvestClient => ({
  id: client.id,
  name: requiredText(client, 'name'),
  is_active: flag(client, 'isActive'),
  address: text(client, 'address'),
  currency: requiredText(client, 'currency'),
  created_at: harvestInstant(client.createdAt),
  updated_at: harvestInstant(client.updatedAt),
})

export interface HarvestProject {
  id: number
  name: string
  code: string | null
  is_active: boolean
  is_billable: boolean | null
  is_fixed_fee: boolean | null
  bill_by: 'Project' | 'Tasks' | 'People' | 'none' | null
  hourly_rate: number | null
  budget: number | null
  budget_by: string
  budget_is_monthly: boolean
  notify_when_over_budget: boolean
  over_budget_notification_percentage: number
  show_budget_to_all: boolean
  created_at: string
  updated_at: string
  starts_on: string | null
  ends_on: string | null
  notes: string | null
  cost_budget: number | null
  cost_budget_include_expenses: boolean
  fee: number | null
  client: { id: number; name: string; currency: string }
}

const billBy: Readonly<Record<string, HarvestProject['bill_by']>> = {
  project: 'Project',
  tasks: 'Tasks',
  people: 'People',
  none: 'none',
}

/**
 * A project embeds its client, as Harvest does; the caller supplies the record.
 * The billing method and bill-by are commercial terms the native API withholds
 * from profiles without commercial authority, so when the record does not carry
 * them the three fields they derive render null rather than a guess.
 */
export const serializeHarvestProject = (
  project: GeneralResourceRecord,
  client: GeneralResourceRecord,
): HarvestProject => {
  const method = text(project, 'billingMethod')
  const by = text(project, 'billBy')
  const mapped = by === null ? null : billBy[by]
  if (mapped === undefined) throw new Error(`Harvest shim: unknown bill_by ${by}`)
  return {
    id: project.id,
    name: requiredText(project, 'name'),
    code: text(project, 'code'),
    is_active: flag(project, 'isActive'),
    is_billable: method === null ? null : method !== 'non_billable',
    is_fixed_fee: method === null ? null : method === 'fixed_fee',
    bill_by: mapped,
    hourly_rate: harvestMoney(number(project, 'hourlyRateCents')),
    budget: harvestHours(number(project, 'budgetSeconds')),
    budget_by: requiredText(project, 'budgetBy'),
    budget_is_monthly: flag(project, 'budgetIsMonthly'),
    notify_when_over_budget: flag(project, 'notifyWhenOverBudget'),
    // Unset means "at 100%" (docs/domain-model.md 2.8); Harvest always renders one.
    over_budget_notification_percentage: number(project, 'overBudgetPct') ?? 100,
    show_budget_to_all: flag(project, 'showBudgetToAll'),
    created_at: harvestInstant(project.createdAt),
    updated_at: harvestInstant(project.updatedAt),
    starts_on: text(project, 'startsOn'),
    ends_on: text(project, 'endsOn'),
    notes: text(project, 'notes'),
    cost_budget: harvestMoney(number(project, 'costBudgetCents')),
    cost_budget_include_expenses: flag(project, 'costBudgetIncludeExpenses'),
    fee: harvestMoney(number(project, 'feeCents')),
    client: {
      id: client.id,
      name: requiredText(client, 'name'),
      currency: requiredText(client, 'currency'),
    },
  }
}

export interface HarvestTask {
  id: number
  name: string
  billable_by_default: boolean
  is_default: boolean
  default_hourly_rate: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export const serializeHarvestTask = (task: GeneralResourceRecord): HarvestTask => ({
  id: task.id,
  name: requiredText(task, 'name'),
  billable_by_default: flag(task, 'billableByDefault'),
  is_default: flag(task, 'isDefault'),
  default_hourly_rate: harvestMoney(number(task, 'defaultHourlyRateCents')),
  is_active: flag(task, 'isActive'),
  created_at: harvestInstant(task.createdAt),
  updated_at: harvestInstant(task.updatedAt),
})

export interface HarvestUser {
  id: number
  first_name: string
  last_name: string
  email: string | null
  telephone: string | null
  timezone: string
  has_access_to_all_future_projects: boolean
  is_contractor: boolean
  is_active: boolean
  weekly_capacity: number
  default_hourly_rate: number | null
  cost_rate: number | null
  roles: string[]
  access_roles: string[]
  avatar_url: string | null
  created_at: string
  updated_at: string
}

/** What a user record does not carry: role labels and the two current rates. */
export interface HarvestUserContext {
  roleNames: readonly string[]
  defaultHourlyRateCents: number | null
  costRateCents: number | null
}

/**
 * The native profile and manager grants collapse back to Harvest's base role
 * plus sub-roles. Profiles Harvest has no name for (people_admin, accounting,
 * executive_manager) render as "manager": the closest base role.
 */
const harvestAccessRoles = (user: GeneralResourceRecord): string[] => {
  const profile = requiredText(user, 'profile')
  if (profile === 'administrator') return ['administrator']
  if (profile === 'member') return ['member']
  const grants = user.managerGrants
  return ['manager', ...(Array.isArray(grants) ? grants.map(String) : [])]
}

export const serializeHarvestUser = (
  user: GeneralResourceRecord,
  context: HarvestUserContext,
): HarvestUser => ({
  id: user.id,
  first_name: requiredText(user, 'firstName'),
  last_name: requiredText(user, 'lastName'),
  email: text(user, 'email'),
  telephone: text(user, 'telephone'),
  timezone: requiredText(user, 'timezone'),
  has_access_to_all_future_projects: flag(user, 'hasAccessToAllFutureProjects'),
  is_contractor: flag(user, 'isContractor'),
  is_active: flag(user, 'isActive'),
  weekly_capacity: number(user, 'weeklyCapacity') ?? 0,
  default_hourly_rate: harvestMoney(context.defaultHourlyRateCents),
  cost_rate: harvestMoney(context.costRateCents),
  roles: [...context.roleNames],
  access_roles: harvestAccessRoles(user),
  avatar_url: text(user, 'avatarUrl'),
  created_at: harvestInstant(user.createdAt),
  updated_at: harvestInstant(user.updatedAt),
})

/**
 * A canonical 24h `HH:MM` as the organization's clock shows it. Harvest renders
 * a 12h clock as "8:00am" (no leading zero, lower-case meridiem, midnight as
 * 12:00am, noon as 12:00pm); a 24h clock keeps the canonical form.
 */
export const harvestClockTime = (time: string | null, clock: '12h' | '24h'): string | null => {
  if (time === null) return null
  const parts = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (parts === null)
    throw new Error(`Harvest shim: ${JSON.stringify(time)} is not a canonical HH:MM time`)
  if (clock === '24h') return time
  const hour = Number(parts[1])
  return `${hour % 12 === 0 ? 12 : hour % 12}:${parts[2]}${hour < 12 ? 'am' : 'pm'}`
}

const personName = (user: GeneralResourceRecord): string =>
  `${requiredText(user, 'firstName')} ${requiredText(user, 'lastName')}`.trim()

export interface HarvestUserAssignmentSummary {
  id: number
  is_project_manager: boolean
  is_active: boolean
  budget: number | null
  created_at: string
  updated_at: string
  hourly_rate: number | null
}

export interface HarvestTaskAssignmentSummary {
  id: number
  billable: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  hourly_rate: number | null
  budget: number | null
}

/** The embedded user assignment; the rate is null where the viewer may not read it. */
export const serializeHarvestUserAssignmentSummary = (
  assignment: GeneralResourceRecord,
): HarvestUserAssignmentSummary => ({
  id: assignment.id,
  is_project_manager: flag(assignment, 'isProjectManager'),
  is_active: flag(assignment, 'isActive'),
  budget: harvestHours(number(assignment, 'budgetSeconds')),
  created_at: harvestInstant(assignment.createdAt),
  updated_at: harvestInstant(assignment.updatedAt),
  hourly_rate: harvestMoney(number(assignment, 'hourlyRateCents')),
})

/** The embedded task assignment; the rate is null where the viewer may not read it. */
export const serializeHarvestTaskAssignmentSummary = (
  assignment: GeneralResourceRecord,
): HarvestTaskAssignmentSummary => ({
  id: assignment.id,
  billable: flag(assignment, 'billable'),
  is_active: flag(assignment, 'isActive'),
  created_at: harvestInstant(assignment.createdAt),
  updated_at: harvestInstant(assignment.updatedAt),
  hourly_rate: harvestMoney(number(assignment, 'hourlyRateCents')),
  budget: harvestHours(number(assignment, 'budgetSeconds')),
})

export interface HarvestTimeEntry {
  id: number
  spent_date: string
  hours: number
  hours_without_timer: number
  rounded_hours: number
  notes: string | null
  is_locked: boolean
  locked_reason: string | null
  is_closed: boolean
  approval_status: string
  is_billed: boolean | null
  timer_started_at: string | null
  started_time: string | null
  ended_time: string | null
  is_running: boolean
  billable: boolean
  budgeted: boolean
  billable_rate: number | null
  cost_rate: number | null
  created_at: string
  updated_at: string
  user: { id: number; name: string }
  client: { id: number; name: string; currency: string }
  project: { id: number; name: string; code: string | null }
  task: { id: number; name: string }
  user_assignment: HarvestUserAssignmentSummary
  task_assignment: HarvestTaskAssignmentSummary
  invoice: { id: number; number: string } | null
  external_reference: {
    id: string
    group_id: string | null
    account_id: string | null
    permalink: string | null
  } | null
}

/**
 * What an entry does not carry. The records are the rows it points at, already
 * stripped of what the viewer may not read; the rates, lock reason and invoice
 * are decided by the route the way the native serializer decides them.
 */
export interface HarvestTimeEntryContext {
  clock: '12h' | '24h'
  user: GeneralResourceRecord
  client: GeneralResourceRecord
  project: GeneralResourceRecord
  task: GeneralResourceRecord
  userAssignment: GeneralResourceRecord
  taskAssignment: GeneralResourceRecord
  billableRateCents: number | null
  costRateCents: number | null
  /** Null when the viewer may not read invoices, as the native API omits it. */
  isBilled: boolean | null
  lockedReason: string | null
  invoice: { id: number; number: string } | null
}

const externalReference = (
  reference: Record<string, unknown> | null,
): HarvestTimeEntry['external_reference'] => {
  if (reference === null) return null
  const id = reference.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const optional = (value: unknown): string | null =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : null
  return {
    id: String(id),
    group_id: optional(reference.group_id),
    account_id: optional(reference.account_id),
    permalink: optional(reference.permalink),
  }
}

/**
 * Both entry modes render through here: a duration-mode entry carries hours and
 * maybe a timer start and no clock times; a start/end entry carries clock times,
 * shown in the organization's clock. `hours` is the stored seconds whatever the
 * mode, so a running start/end entry reports what was stored, not a figure up
 * to now.
 */
export const serializeHarvestTimeEntry = (
  entry: Readonly<TimeEntryRecord>,
  context: HarvestTimeEntryContext,
): HarvestTimeEntry => ({
  id: entry.id,
  spent_date: entry.spentDate,
  hours: harvestHours(entry.seconds) ?? 0,
  hours_without_timer: harvestHours(entry.secondsWithoutTimer) ?? 0,
  rounded_hours: harvestHours(entry.roundedSeconds) ?? 0,
  notes: entry.notes,
  is_locked: entry.state.isLocked,
  locked_reason: context.lockedReason,
  // Harvest's deprecated is_closed is the approved state; both are rendered.
  is_closed: entry.state.approvalStatus === 'approved',
  approval_status: entry.state.approvalStatus,
  is_billed: context.isBilled,
  timer_started_at: entry.timerStartedAt === null ? null : harvestInstant(entry.timerStartedAt),
  started_time: harvestClockTime(entry.startedTime, context.clock),
  ended_time: harvestClockTime(entry.endedTime, context.clock),
  is_running:
    entry.timerStartedAt !== null || (entry.startedTime !== null && entry.endedTime === null),
  billable: entry.billable,
  budgeted: entry.budgeted,
  billable_rate: harvestMoney(context.billableRateCents),
  cost_rate: harvestMoney(context.costRateCents),
  created_at: harvestInstant(entry.createdAt),
  updated_at: harvestInstant(entry.updatedAt),
  user: { id: context.user.id, name: personName(context.user) },
  client: {
    id: context.client.id,
    name: requiredText(context.client, 'name'),
    currency: requiredText(context.client, 'currency'),
  },
  project: {
    id: context.project.id,
    name: requiredText(context.project, 'name'),
    code: text(context.project, 'code'),
  },
  task: { id: context.task.id, name: requiredText(context.task, 'name') },
  user_assignment: serializeHarvestUserAssignmentSummary(context.userAssignment),
  task_assignment: serializeHarvestTaskAssignmentSummary(context.taskAssignment),
  invoice: context.invoice,
  external_reference: externalReference(entry.externalRef),
})

export interface HarvestProjectAssignment extends HarvestUserAssignmentSummary {
  use_default_rates: boolean
  project: { id: number; name: string; code: string | null }
  client: { id: number; name: string; currency: string }
  task_assignments: Array<HarvestTaskAssignmentSummary & { task: { id: number; name: string } }>
}

/** A person's assignment to a project with the project's task assignments embedded. */
export const serializeHarvestProjectAssignment = (
  assignment: GeneralResourceRecord,
  project: GeneralResourceRecord,
  client: GeneralResourceRecord,
  taskAssignments: ReadonlyArray<{ assignment: GeneralResourceRecord; task: GeneralResourceRecord }>,
): HarvestProjectAssignment => {
  const summary = serializeHarvestUserAssignmentSummary(assignment)
  return {
    id: summary.id,
    is_project_manager: summary.is_project_manager,
    is_active: summary.is_active,
    use_default_rates: flag(assignment, 'useDefaultRates'),
    budget: summary.budget,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    hourly_rate: summary.hourly_rate,
    project: {
      id: project.id,
      name: requiredText(project, 'name'),
      code: text(project, 'code'),
    },
    client: {
      id: client.id,
      name: requiredText(client, 'name'),
      currency: requiredText(client, 'currency'),
    },
    task_assignments: taskAssignments.map(({ assignment: taskAssignment, task }) => ({
      ...serializeHarvestTaskAssignmentSummary(taskAssignment),
      task: { id: task.id, name: requiredText(task, 'name') },
    })),
  }
}

export interface HarvestExpense {
  id: number
  notes: string | null
  total_cost: number
  units: number | null
  is_closed: boolean
  approval_status: string
  is_locked: boolean
  is_billed: boolean | null
  locked_reason: string | null
  spent_date: string
  created_at: string
  updated_at: string
  billable: boolean
  user: { id: number; name: string }
  user_assignment: HarvestUserAssignmentSummary | null
  project: { id: number; name: string; code: string | null }
  expense_category: { id: number; name: string; unit_name: string | null; unit_price: number | null }
  client: { id: number; name: string; currency: string }
  invoice: { id: number; number: string } | null
}

/**
 * The rows an expense points at, already stripped of what the viewer may not
 * read; the lock reason and invoice are decided by the route the way the native
 * serializer decides them. The user assignment is null when the person was never
 * assigned to the project (an imported expense can outlive that), and the
 * receipt is not rendered: receipts are attachments here, not a column.
 */
export interface HarvestExpenseContext {
  user: GeneralResourceRecord
  userAssignment: GeneralResourceRecord | null
  project: GeneralResourceRecord
  client: GeneralResourceRecord
  expenseCategory: GeneralResourceRecord
  /** Null when the viewer may not read invoices, as the native API omits it. */
  isBilled: boolean | null
  lockedReason: string | null
  invoice: { id: number; number: string } | null
}

export const serializeHarvestExpense = (
  expense: Readonly<ExpenseRecord>,
  context: HarvestExpenseContext,
): HarvestExpense => ({
  id: expense.id,
  notes: expense.notes,
  total_cost: harvestMoney(expense.totalCostCents) ?? 0,
  units: expense.units,
  // Harvest's deprecated is_closed is the approved state; both are rendered.
  is_closed: expense.state.approvalStatus === 'approved',
  approval_status: expense.state.approvalStatus,
  is_locked: expense.state.isLocked,
  is_billed: context.isBilled,
  locked_reason: context.lockedReason,
  spent_date: expense.spentDate,
  created_at: harvestInstant(expense.createdAt),
  updated_at: harvestInstant(expense.updatedAt),
  billable: expense.billable,
  user: { id: context.user.id, name: personName(context.user) },
  user_assignment:
    context.userAssignment === null
      ? null
      : serializeHarvestUserAssignmentSummary(context.userAssignment),
  project: {
    id: context.project.id,
    name: requiredText(context.project, 'name'),
    code: text(context.project, 'code'),
  },
  expense_category: {
    id: context.expenseCategory.id,
    name: requiredText(context.expenseCategory, 'name'),
    unit_name: text(context.expenseCategory, 'unitName'),
    unit_price: harvestMoney(number(context.expenseCategory, 'unitPriceCents')),
  },
  client: {
    id: context.client.id,
    name: requiredText(context.client, 'name'),
    currency: requiredText(context.client, 'currency'),
  },
  invoice: context.invoice,
})
