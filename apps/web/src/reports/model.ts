import type {
  ClientRollupReport,
  GeneralResource,
  MyHoursReport,
  ProjectBudgetReport,
  TimeReport,
  UninvoicedReport,
  Whoami,
} from '@ezacto/client'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'

export type ReportKind =
  | 'my-hours'
  | 'time'
  | 'uninvoiced'
  | 'client-rollup'
  | 'project-budget'

/**
 * The Time report's four sub-tabs. They are folds of one response, so the tab
 * is presentation state and not a request parameter -- switching tabs must not
 * re-ask the server for a month it already answered for. It still lives in the
 * address because a link to "September by teammate" has to survive being sent
 * to somebody.
 */
export type TimeReportTab = 'clients' | 'projects' | 'tasks' | 'teammates'

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
   * No grouping parameter: the response carries all four foldings, because
   * they are one dataset and asking four times invites four answers.
   */
  getTimeReport(
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<TimeReport>
}

export interface ReportFilters {
  readonly kind: ReportKind
  readonly from: string
  readonly to: string
  readonly clientId: number | null
  readonly projectId: number | null
  readonly tab: TimeReportTab
}

const reportKinds = new Set<ReportKind>([
  'my-hours',
  'time',
  'uninvoiced',
  'client-rollup',
  'project-budget',
])

const timeReportTabs = new Set<TimeReportTab>([
  'clients',
  'projects',
  'tasks',
  'teammates',
])

export const isTimeReportTab = (value: string): value is TimeReportTab =>
  timeReportTabs.has(value as TimeReportTab)

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
        : 'my-hours'
  const monthStart = `${today.slice(0, 8)}01`
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const rawTab = url.searchParams.get('tab')
  return {
    kind,
    from: from ?? monthStart,
    to: to ?? today,
    clientId: positiveId(url.searchParams.get('client_id')),
    projectId: positiveId(url.searchParams.get('project_id')),
    // Clients, as in the report being matched. An unreadable tab falls back
    // rather than failing validation: the tab decides which fold of an answer
    // already in hand is drawn, so a bad one is worth no more than a wrong
    // starting tab.
    tab: rawTab !== null && isTimeReportTab(rawTab) ? rawTab : 'clients',
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
  // Only the Time report has sub-tabs, so only it carries one. A `tab` left on
  // every other kind's address would be a parameter that does nothing, and the
  // first person to change it would reasonably expect something to happen.
  if (filters.kind === 'time') params.set('tab', filters.tab)
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

/**
 * Billable share of a row's hours, as Harvest prints it beside the figure.
 * Null where nothing was tracked: "0%" of no hours reads as a person who was
 * busy on nothing billable, which is a different claim from an empty row.
 */
export const billablePercent = (
  billableSeconds: number,
  roundedSeconds: number,
): number | null =>
  roundedSeconds === 0 ? null : Math.round((billableSeconds * 100) / roundedSeconds)
