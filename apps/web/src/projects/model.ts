import type { Attachment, GeneralResource, Whoami } from '@conflict-hq/ezacto-client'
import { canManageCommercialTerms } from '@ezacto/core'

export type ProjectDirectoryPage<T = GeneralResource> = {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

/** One project-level budget row, as GET /reports/project-budgets returns it. */
export interface ProjectBudgetSummary {
  project_id: number
  unit: 'seconds' | 'cents' | null
  budget_seconds?: number | null
  spent_seconds?: number
  remaining_seconds?: number | null
  budget_cents?: number | null
  spent_cents?: number
  remaining_cents?: number | null
  cost_cents?: number
  unpriced_entry_count?: number
  /**
   * Resolved server-side from the project, or its client. The list used to work
   * this out itself and fell back to USD when the client was not in the payload,
   * which renders another currency's money as dollars and says nothing.
   */
  currency?: string
}

export interface ProjectDirectoryApi {
  // Optional: a build without the rollup shows the list without money columns
  // rather than one call per project, which is what kept them off it.
  listProjectBudgetSummaries?(
    range: { from: string; to: string },
    signal?: AbortSignal,
  ): Promise<readonly ProjectBudgetSummary[]>
  listDirectoryProjects(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  listProjectClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  getDirectoryProject(id: number, signal?: AbortSignal): Promise<GeneralResource>
  createDirectoryProject(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateDirectoryProject(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  archiveDirectoryProject(id: number, signal?: AbortSignal): Promise<void>
  listDirectoryTasks(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  listProjectTaskAssignments(
    projectId: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  createProjectTaskAssignment(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateProjectTaskAssignment(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  archiveProjectTaskAssignment(id: number, signal?: AbortSignal): Promise<void>
  listDirectoryUsers(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  listProjectUserAssignments(
    projectId: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ProjectDirectoryPage>
  createProjectUserAssignment(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateProjectUserAssignment(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  archiveProjectUserAssignment(id: number, signal?: AbortSignal): Promise<void>
  listDirectoryProjectAttachments(
    projectId: number,
    signal?: AbortSignal,
  ): Promise<readonly Attachment[]>
  uploadDirectoryProjectAttachment(
    projectId: number,
    commandId: string,
    body: FormData,
    signal?: AbortSignal,
  ): Promise<Attachment>
}

export interface ProjectCapabilities {
  readonly canWrite: boolean
  readonly canManageCommercialTerms: boolean
  readonly canViewBillableMoney: boolean
  readonly canViewCostBudget: boolean
  readonly canViewNotes: boolean
}

export const projectCapabilities = (
  identity: Pick<Whoami, 'profile' | 'manager_grants'>,
): ProjectCapabilities => {
  const canWrite =
    identity.profile === 'project_manager' ||
    identity.profile === 'executive_manager' ||
    identity.profile === 'administrator'
  return {
    canWrite,
    canManageCommercialTerms: canManageCommercialTerms({ profile: identity.profile, managerGrants: identity.manager_grants }),
    canViewBillableMoney:
      identity.profile === 'executive_manager' ||
      identity.profile === 'administrator' ||
      (identity.profile === 'project_manager' &&
        identity.manager_grants.includes('billable_rates_manager')),
    canViewCostBudget:
      identity.profile === 'executive_manager' || identity.profile === 'administrator',
    canViewNotes: identity.profile === 'administrator',
  }
}

export const projectIdFromPathname = (pathname: string): number | null => {
  const match = /^\/projects\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const projectText = (
  resource: Readonly<GeneralResource>,
  field: string,
): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export const projectNumber = (
  resource: Readonly<GeneralResource>,
  field: string,
): number | null => {
  const value = resource[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const projectBoolean = (
  resource: Readonly<GeneralResource>,
  field: string,
): boolean => resource[field] === true

export const projectIsActive = (resource: Readonly<GeneralResource>): boolean =>
  resource['is_active'] !== false

export const projectDisplayName = (resource: Readonly<GeneralResource>): string => {
  const name = projectText(resource, 'name') ?? `Project #${resource.id}`
  const code = projectText(resource, 'code')
  return code === null ? name : `[${code}] ${name}`
}

export const projectClientLabel = (
  project: Readonly<GeneralResource>,
  clients: readonly GeneralResource[],
): string => {
  const clientId = projectNumber(project, 'client_id')
  if (clientId === null) return 'Unknown client'
  const client = clients.find((candidate) => candidate.id === clientId)
  return projectText(client ?? ({} as GeneralResource), 'name') ?? `Client #${clientId}`
}

export const projectCurrency = (
  project: Readonly<GeneralResource>,
  clients: readonly GeneralResource[],
): string => {
  const override = projectText(project, 'billing_currency')
  if (override !== null) return override
  const clientId = projectNumber(project, 'client_id')
  const client = clients.find((candidate) => candidate.id === clientId)
  return projectText(client ?? ({} as GeneralResource), 'currency') ?? 'USD'
}

export const taskLabel = (
  taskId: number,
  tasks: readonly GeneralResource[],
): string => {
  const task = tasks.find((candidate) => candidate.id === taskId)
  return task === undefined
    ? `Task #${taskId}`
    : projectText(task, 'name') ?? `Task #${taskId}`
}

export const personLabel = (
  userId: number,
  people: readonly GeneralResource[],
): string => {
  const person = people.find((candidate) => candidate.id === userId)
  if (person === undefined) return `Person #${userId}`
  const first = projectText(person, 'first_name')
  const last = projectText(person, 'last_name')
  const name = [first, last].filter((part) => part !== null).join(' ')
  return name === '' ? projectText(person, 'email') ?? `Person #${userId}` : name
}

/**
 * What a staffed person is actually billed at.
 *
 * `use_default_rates` is the switch and `hourly_rate_cents` is only consulted
 * when it is off, so reading the rate column alone misreports every row that
 * leaves the switch on -- which in the migrated data is most of them. The two
 * are reported together here so the screen cannot show a number the system
 * would not charge.
 */
export const assignmentRateLabel = (
  assignment: Readonly<GeneralResource>,
  currency: string,
): string => {
  if (assignment['use_default_rates'] !== false) return "The person's default rate"
  const cents = projectNumber(assignment, 'hourly_rate_cents')
  return cents === null ? 'Project rate not set' : projectMoney(cents, currency)
}

export const projectMoney = (cents: number | null, currency: string): string => {
  if (cents === null) return 'None'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
  }
}

export const projectHours = (seconds: number | null): string =>
  seconds === null
    ? 'None'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(seconds / 3_600)} hours`

export const projectEnumLabel = (value: string | null): string =>
  value === null
    ? 'None'
    : value
        .split('_')
        .map((part) => part[0]!.toLocaleUpperCase('en-US') + part.slice(1))
        .join(' ')
