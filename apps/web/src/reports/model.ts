import type {
  ClientRollupReport,
  GeneralResource,
  ProjectBudgetReport,
  UninvoicedReport,
  Whoami,
} from '@ezacto/client'

export type ReportKind = 'uninvoiced' | 'client-rollup' | 'project-budget'

export interface ReportCatalogPage {
  readonly data: readonly GeneralResource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ReportWorkspaceApi {
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
}

export interface ReportFilters {
  readonly kind: ReportKind
  readonly from: string
  readonly to: string
  readonly clientId: number | null
  readonly projectId: number | null
}

const reportKinds = new Set<ReportKind>([
  'uninvoiced',
  'client-rollup',
  'project-budget',
])

export const isReportKind = (value: string): value is ReportKind =>
  reportKinds.has(value as ReportKind)

export const canReadFinancialReports = (profile: Whoami['profile']): boolean =>
  profile === 'accounting' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

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
        : 'project-budget'
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
    (filters.kind === 'uninvoiced' || filters.kind === 'project-budget') &&
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
