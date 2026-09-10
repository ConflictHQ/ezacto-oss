import { canViewMoneyField } from '@ezacto/core'
import type {
  ClientRollupReport,
  ContractorCostReport,
  GeneralResource,
  MyHoursReport,
  ProjectBudgetReport,
  UninvoicedReport,
  Whoami,
} from '@ezacto/client'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'

export type ReportKind =
  | 'my-hours'
  | 'uninvoiced'
  | 'client-rollup'
  | 'project-budget'
  | 'contractor-cost'

export interface ReportCatalogPage {
  readonly data: readonly GeneralResource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ReportWorkspaceApi {
  /**
   * Only `week_start_day` is wanted, and only so the period control can tell a
   * whole week from an arbitrary seven days. Optional because a build without
   * it should still report: the control then falls back to Monday and calls a
   * Saturday-to-Friday range custom, which is a wrong label on a working
   * report rather than a screen that refuses to load.
   */
  getTimeEntrySettings?(signal?: AbortSignal): Promise<TimeEntrySettings>
  listReportClients(cursor?: string, signal?: AbortSignal): Promise<ReportCatalogPage>
  listReportProjects(cursor?: string, signal?: AbortSignal): Promise<ReportCatalogPage>
  getUninvoicedReport(
    filter: {
      readonly from: string
      readonly to: string
      readonly client_id?: number
      readonly project_id?: number
    },
    signal?: AbortSignal,
  ): Promise<UninvoicedReport>
  getClientRollupReport(
    clientId: number,
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<ClientRollupReport>
  getProjectBudgetReport(
    projectId: number,
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<ProjectBudgetReport>
  /**
   * No user takes part in this signature. Whose hours come back is the session's
   * business, not the caller's, and a parameter here would be the first place a
   * request could be edited to ask for somebody else's.
   */
  getMyHoursReport(
    filter: {
      readonly from: string
      readonly to: string
      readonly project_id?: number
    },
    signal?: AbortSignal,
  ): Promise<MyHoursReport>
  /**
   * A range and nothing else. The endpoint takes no person and no project: it
   * answers for everybody who tracked time, which is what a payroll hand-off
   * needs, and a person parameter here would suggest the report can be narrowed
   * to one when the route would ignore it.
   */
  getContractorCostReport(
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<ContractorCostReport>
}

export interface ReportFilters {
  readonly kind: ReportKind
  readonly from: string
  readonly to: string
  readonly clientId: number | null
  readonly projectId: number | null
}

const reportKinds = new Set<ReportKind>([
  'my-hours',
  'uninvoiced',
  'client-rollup',
  'project-budget',
  'contractor-cost',
])

export const isReportKind = (value: string): value is ReportKind =>
  reportKinds.has(value as ReportKind)

export const canReadFinancialReports = (profile: Whoami['profile']): boolean =>
  profile === 'accounting' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

/**
 * Stricter than `canReadFinancialReports`, and deliberately not the same set:
 * every figure in the contractor cost report is a cost, and cost authority is
 * the administrator's alone, so accounting and an executive manager read the
 * other financial kinds but not this one.
 *
 * Asked of `canViewMoneyField` rather than restated as a third profile list
 * here, because the route refuses on exactly that call. A local copy would be
 * one edit away from a tab that opens a report the API then 403s.
 */
export const canReadCostReports = (
  identity: Pick<Whoami, 'profile' | 'manager_grants'>,
): boolean =>
  canViewMoneyField(
    { profile: identity.profile, managerGrants: identity.manager_grants },
    'cost_rate',
  )

export const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

const positiveId = (value: string | null): number | null => {
  if (value === null) return null
  if (!/^[1-9][0-9]*$/u.test(value)) return -1
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : -1
}

export const reportFiltersFromUrl = (
  url: URL,
  today: string,
  financialAccess = true,
): ReportFilters => {
  if (!isCalendarDate(today)) throw new TypeError('today must be a calendar date')
  const rawKind = url.searchParams.get('report')
  const kind =
    rawKind !== null && reportKinds.has(rawKind as ReportKind)
      ? (rawKind as ReportKind)
      : financialAccess
        ? 'uninvoiced'
        : 'my-hours'
  const monthStart = `${today.slice(0, 8)}01`
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  return {
    kind,
    from: from ?? monthStart,
    to: to ?? today,
    clientId: positiveId(url.searchParams.get('client_id')),
    projectId: positiveId(url.searchParams.get('project_id')),
  }
}

export const reportFiltersUrl = (filters: Readonly<ReportFilters>): string => {
  const params = new URLSearchParams({
    report: filters.kind,
    from: filters.from,
    to: filters.to,
  })
  if (
    (filters.kind === 'uninvoiced' || filters.kind === 'client-rollup') &&
    filters.clientId !== null
  ) {
    params.set('client_id', String(filters.clientId))
  }
  if (
    (filters.kind === 'uninvoiced' ||
      filters.kind === 'project-budget' ||
      filters.kind === 'my-hours') &&
    filters.projectId !== null
  ) {
    params.set('project_id', String(filters.projectId))
  }
  return `/reports?${params.toString()}`
}

export const validateReportFilters = (filters: Readonly<ReportFilters>): string | null => {
  if (!isCalendarDate(filters.from) || !isCalendarDate(filters.to)) {
    return 'Choose a valid From and To date.'
  }
  if (filters.from > filters.to) return 'To must be on or after From.'
  if (filters.clientId !== null && filters.clientId < 1) return 'Choose a valid client.'
  if (filters.projectId !== null && filters.projectId < 1) return 'Choose a valid project.'
  if (filters.kind === 'client-rollup' && filters.clientId === null) {
    return 'Choose a root client.'
  }
  if (filters.kind === 'project-budget' && filters.projectId === null) {
    return 'Choose a project.'
  }
  return null
}

export const reportResourceLabel = (resource: Readonly<GeneralResource>): string => {
  const name = resource['name']
  const code = resource['code']
  const displayName =
    typeof name === 'string' && name.trim() !== '' ? name.trim() : `#${resource.id}`
  return typeof code === 'string' && code.trim() !== ''
    ? `[${code.trim()}] ${displayName}`
    : displayName
}

export const formatReportMoney = (
  cents: number | null | undefined,
  currency: string,
): string => {
  if (cents === null || cents === undefined) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${currency} ${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100)}`
  }
}

export const formatReportHours = (seconds: number | null | undefined): string =>
  seconds === null || seconds === undefined
    ? '—'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(seconds / 3_600)} h`

/** The project-budget endpoint identifies cents but does not identify their currency. */
export const formatReportCents = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? '—'
    : `${new Intl.NumberFormat('en-US').format(cents)} cents`
