import type { GeneralResourceRecord } from '@ezacto/core'

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
  is_billable: boolean
  is_fixed_fee: boolean
  bill_by: 'Project' | 'Tasks' | 'People' | 'none'
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

/** A project embeds its client, as Harvest does; the caller supplies the record. */
export const serializeHarvestProject = (
  project: GeneralResourceRecord,
  client: GeneralResourceRecord,
): HarvestProject => {
  const method = requiredText(project, 'billingMethod')
  const by = requiredText(project, 'billBy')
  const mapped = billBy[by]
  if (mapped === undefined) throw new Error(`Harvest shim: unknown bill_by ${by}`)
  return {
    id: project.id,
    name: requiredText(project, 'name'),
    code: text(project, 'code'),
    is_active: flag(project, 'isActive'),
    is_billable: method !== 'non_billable',
    is_fixed_fee: method === 'fixed_fee',
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
