import type { GeneralResource, Whoami } from '@ezacto/client'

export type TaskAdminFilter = 'active' | 'all'

export type TaskAdminPage = {
  readonly data: readonly GeneralResource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface TaskAdminApi {
  listAdminTasks(
    filter: TaskAdminFilter,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<TaskAdminPage>
  createAdminTask(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateAdminTask(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  archiveAdminTask(id: number, signal?: AbortSignal): Promise<void>
}

export interface TaskAdminCapabilities {
  readonly canRead: boolean
  readonly canWrite: boolean
  readonly canViewRate: boolean
}

const tokenHasScope = (
  identity: Readonly<Whoami>,
  scope: 'projects:read' | 'projects:write',
): boolean =>
  identity.authentication.kind === 'session' ||
  identity.authentication.scopes.includes(scope)

export const taskAdminCapabilities = (
  identity: Readonly<Whoami>,
): TaskAdminCapabilities => {
  const canRead = tokenHasScope(identity, 'projects:read')
  const profileCanWrite =
    identity.profile === 'project_manager' ||
    identity.profile === 'executive_manager' ||
    identity.profile === 'administrator'
  const canViewRate =
    identity.profile === 'accounting' ||
    identity.profile === 'executive_manager' ||
    identity.profile === 'administrator' ||
    (identity.profile === 'project_manager' &&
      identity.manager_grants.includes('billable_rates_manager'))
  return {
    canRead,
    canWrite: canRead && profileCanWrite && tokenHasScope(identity, 'projects:write'),
    canViewRate,
  }
}

export const taskName = (task: Readonly<GeneralResource>): string => {
  const name = task['name']
  return typeof name === 'string' && name.trim() !== ''
    ? name.trim()
    : `Task #${task.id}`
}

export const taskIsActive = (task: Readonly<GeneralResource>): boolean =>
  task['is_active'] !== false

export const taskBoolean = (
  task: Readonly<GeneralResource>,
  field: 'billable_by_default' | 'is_default',
): boolean => task[field] === true

export const taskRateCents = (
  task: Readonly<GeneralResource>,
): number | null => {
  const value = task['default_hourly_rate_cents']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

export const formatTaskRate = (cents: number | null): string =>
  cents === null
    ? 'No default rate'
    : `${new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(cents / 100)}/hour`

export const parseTaskRateCents = (raw: string): number | null => {
  const value = raw.trim()
  if (value === '') return null
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u.test(value)) {
    throw new Error('Default hourly rate must be a non-negative amount with no more than two decimals.')
  }
  const [whole, fraction = ''] = value.split('.')
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')))
  if (!Number.isSafeInteger(cents)) throw new Error('Default hourly rate is too large.')
  return cents
}

export const taskRateInputValue = (cents: number | null): string =>
  cents === null ? '' : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
