import { canViewMoneyField } from '@ezacto/core'
import type {
  ActivityLog,
  ClientRollupReport,
  ContractorCostReport,
  DetailedExpenseReport,
  DetailedTimeReport,
  DetailedTimeRow,
  GeneralResource,
  MyHoursReport,
  ProfitabilityReport,
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
  | 'contractor-cost'
  | 'detailed-time'
  | 'activity-log'
  | 'profitability'
  | 'detailed-expense'

/**
 * The Time report's four sub-tabs. They are folds of one response, so the tab
 * is presentation state and not a request parameter -- switching tabs must not
 * re-ask the server for a month it already answered for. It still lives in the
 * address because a link to "September by teammate" has to survive being sent
 * to somebody.
 */
export type TimeReportTab = 'clients' | 'projects' | 'tasks' | 'teammates'

export type DetailedTimeHours = DetailedTimeReport['hours']

/** The Group by control. Date is the default because the table bands by it. */
export type DetailedTimeGrouping = 'date' | 'client' | 'project' | 'task' | 'person'

/**
 * The three controls that sit above the detailed table rather than in the
 * filter card, kept out of `ReportFilters` because only one kind has them and a
 * shared shape carrying four unused fields on every other report is how a
 * filter ends up half-applied. They travel in the address all the same: a
 * report you send somebody has to arrive grouped the way you were reading it.
 */
export interface DetailedTimeOptions {
  readonly hours: DetailedTimeHours
  readonly grouping: DetailedTimeGrouping
  readonly activeProjectsOnly: boolean
}

/**
 * The activity log is a feed, not a table of figures: it answers "what
 * happened" over a range rather than "how much". It carries no money at all,
 * which is why it needs no money gate of its own -- the route asks for
 * `reports:read` and the financial-profile check the strip already applies is
 * the whole of it.
 */
export interface ActivityLogEntry {
  readonly event_id: string
  readonly event_type: string
  readonly occurred_at: string
  readonly aggregate: ActivityLog['aggregate']
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * `invoice.payment.recorded` reads as "Invoice payment recorded".
 *
 * Built from the wire value rather than a hand-kept map, because the events are
 * emitted by the outbox and a map here would silently print a raw dotted string
 * the first time somebody adds one -- which is the moment the log is most worth
 * reading.
 */
export const activityEventLabel = (eventType: string): string => {
  const words = eventType.split('.').join(' ').split('_').join(' ').trim()
  if (words === '') return 'Event'
  return words[0]!.toLocaleUpperCase('en-US') + words.slice(1)
}

/** `invoice` + `1314` -> `Invoice #1314`, the way the rest of the app says it. */
export const activitySubjectLabel = (
  aggregate: Readonly<ActivityLog['aggregate']>,
): string => {
  const kind = String(aggregate.type ?? '').trim()
  const id = aggregate.id
  const name = kind === '' ? 'Record' : kind[0]!.toLocaleUpperCase('en-US') + kind.slice(1)
  return id === undefined || id === null ? name : `${name} #${String(id)}`
}

/**
 * The change against the window before, as a fraction of that window.
 *
 * Null where it cannot be stated: either side missing, or a previous window of
 * zero. Growth from nothing is not a percentage -- it is a first month, and
 * printing "infinite" or "100%" for it would be inventing a denominator.
 */
export const profitabilityDelta = (
  current: number | null,
  previous: number | null,
): number | null => {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / Math.abs(previous)
}

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
  getProfitabilityReport?(
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<ProfitabilityReport>
  getDetailedExpenseReport?(
    filter: {
      readonly from: string
      readonly to: string
      readonly client_id?: number
      readonly project_id?: number
    },
    signal?: AbortSignal,
  ): Promise<DetailedExpenseReport>
  getDetailedTimeReport(
    filter: {
      readonly from: string
      readonly to: string
      readonly client_id?: number
      readonly project_id?: number
      readonly hours?: DetailedTimeHours
      readonly active_projects_only?: boolean
    },
    signal?: AbortSignal,
  ): Promise<DetailedTimeReport>
  getActivityLog?(
    range: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<readonly ActivityLogEntry[]>
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
  'contractor-cost',
  'detailed-time',
  'activity-log',
  'profitability',
  'detailed-expense',
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

const detailedTimeHours: ReadonlySet<string> = new Set<DetailedTimeHours>([
  'all',
  'billable',
  'non_billable',
  'uninvoiced',
])

const detailedTimeGroupings: ReadonlySet<string> = new Set<DetailedTimeGrouping>([
  'date',
  'client',
  'project',
  'task',
  'person',
])

/**
 * Read separately from the filters because an unreadable value here is a
 * display preference, not a filter: a stray `group=colour` should fall back to
 * the default grouping and draw the report, where a stray `from=yesterday`
 * has to stop and say so.
 */
export const detailedTimeOptionsFromUrl = (url: URL): DetailedTimeOptions => {
  const hours = url.searchParams.get('hours')
  const grouping = url.searchParams.get('group')
  return {
    hours: hours !== null && detailedTimeHours.has(hours) ? (hours as DetailedTimeHours) : 'all',
    grouping:
      grouping !== null && detailedTimeGroupings.has(grouping)
        ? (grouping as DetailedTimeGrouping)
        : 'date',
    activeProjectsOnly: url.searchParams.get('active_only') === 'true',
  }
}

export const reportFiltersUrl = (
  filters: Readonly<ReportFilters>,
  options?: Readonly<DetailedTimeOptions>,
): string => {
  const params = new URLSearchParams({
    report: filters.kind,
    from: filters.from,
    to: filters.to,
  })
  if (
    (filters.kind === 'uninvoiced' ||
      filters.kind === 'client-rollup' ||
      filters.kind === 'detailed-time') &&
    filters.clientId !== null
  ) {
    params.set('client_id', String(filters.clientId))
  }
  if (
    (filters.kind === 'uninvoiced' ||
      filters.kind === 'project-budget' ||
      filters.kind === 'my-hours' ||
      filters.kind === 'detailed-time') &&
    filters.projectId !== null
  ) {
    params.set('project_id', String(filters.projectId))
  }
  if (filters.kind === 'detailed-time' && options !== undefined) {
    params.set('hours', options.hours)
    params.set('group', options.grouping)
    params.set('active_only', String(options.activeProjectsOnly))
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

export const detailedTimeProjectLabel = (row: Readonly<DetailedTimeRow>): string =>
  row.project_code.trim() === ''
    ? row.project_name
    : `[${row.project_code.trim()}] ${row.project_name}`

export interface DetailedTimeBand {
  readonly key: string
  readonly label: string
  readonly seconds: number
  readonly rows: readonly DetailedTimeRow[]
}

const bandKey = (
  row: Readonly<DetailedTimeRow>,
  grouping: DetailedTimeGrouping,
): { key: string; label: string } => {
  switch (grouping) {
    case 'client':
      return { key: `client:${row.client_id}`, label: row.client_name }
    case 'project':
      return { key: `project:${row.project_id}`, label: detailedTimeProjectLabel(row) }
    case 'task':
      return { key: `task:${row.task_id}`, label: row.task_name }
    case 'person':
      return { key: `person:${row.user_id}`, label: row.user_name }
    default:
      return { key: `date:${row.spent_date}`, label: row.spent_date }
  }
}

/**
 * Group by changes the table's shape, not its data: the rows are the ones the
 * one request already returned, re-folded here. Issuing a query per grouping
 * would make five ways of asking the same question, and four of them could
 * disagree with the summary above the table.
 *
 * Bands are ordered by their own label, and rows inside a band keep the
 * report's reading order -- date, then client, project, task, person -- so
 * changing the grouping moves the bands and never reshuffles what is in them.
 */
export const groupDetailedTimeRows = (
  rows: readonly DetailedTimeRow[],
  grouping: DetailedTimeGrouping,
): readonly DetailedTimeBand[] => {
  const bands = new Map<string, { label: string; seconds: number; rows: DetailedTimeRow[] }>()
  for (const row of rows) {
    const identity = bandKey(row, grouping)
    const band = bands.get(identity.key) ?? { label: identity.label, seconds: 0, rows: [] }
    band.seconds += row.seconds
    band.rows.push(row)
    bands.set(identity.key, band)
  }
  return [...bands]
    .map(([key, band]) => ({ key, label: band.label, seconds: band.seconds, rows: band.rows }))
    .sort((left, right) =>
      // Dates sort as dates because they are canonical; every other label is a
      // name, and localeCompare is what the pickers beside them already use.
      grouping === 'date'
        ? left.label.localeCompare(right.label)
        : left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
    )
}

/** Decimal hours, the unit every Harvest export and every invoice line uses. */
export const decimalHours = (seconds: number): string => (seconds / 3_600).toFixed(2)

/**
 * A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so a
 * project someone named `=cmd|...` becomes an instruction the moment the export
 * is opened. Quoting alone does not stop it; the apostrophe does, and survives
 * as a visible character rather than silently changing the value.
 */
/**
 * A plain decimal, positive or negative, and nothing else: no exponent, no
 * thousands separator, no currency symbol. Deliberately narrow, because the only
 * job here is to recognise a cell the formula guard must leave alone.
 */
const looksNumeric = (value: string): boolean => /^-?\d+(?:\.\d+)?$/u.test(value)

/**
 * The guard exists because a cell opening with `=`, `+`, `-`, `@` or a control
 * character is executed as a formula by Excel and Sheets, and a leading
 * apostrophe forces it to text instead.
 *
 * It must not fire on a number. Negative time entries are supported and real --
 * 0002_projects_time carries the correction that overstated a contractor's month
 * -- so `-0.50` reaching the guard came back as `'-0.50`, which Excel reads as
 * text. Those rows then drop silently out of a SUM of the Hours column, and a
 * period that nets negative gets a text Total. That is a column not adding up to
 * the total beneath it, which is the defect this report was written to avoid,
 * relocated into the export where it is harder to notice.
 *
 * Numbers are exempted rather than the guard being applied per column: a column
 * list has to be kept in step with the header every time one is added, and the
 * failure is silent when it is not.
 */
const csvCell = (value: string): string => {
  const guarded = !looksNumeric(value) && /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${guarded.replaceAll('"', '""')}"`
}

/**
 * The export is built from the rows already on screen -- never from a second
 * request -- so a reader who was served no `billable_amount_cents` cannot get
 * one by pressing Export. The money columns appear only when the fetched rows
 * carry the field, which is the same test the table renders by.
 */
export const detailedTimeCsv = (
  report: Readonly<DetailedTimeReport>,
  grouping: DetailedTimeGrouping,
): string => {
  const money = report.rows.some((row) => row.billable_amount_cents !== undefined)
  const header = ['Date', 'Client', 'Project', 'Task', 'Roles', 'Person', 'Hours']
  if (money) header.push('Currency', 'Billable amount')
  const lines = [header.map(csvCell).join(',')]
  for (const band of groupDetailedTimeRows(report.rows, grouping)) {
    for (const row of band.rows) {
      const cells = [
        row.spent_date,
        row.client_name,
        detailedTimeProjectLabel(row),
        row.task_name,
        row.roles.join('; '),
        row.user_name,
        decimalHours(row.seconds),
      ]
      if (money) {
        cells.push(
          row.currency,
          row.billable_amount_cents === null || row.billable_amount_cents === undefined
            ? ''
            : (row.billable_amount_cents / 100).toFixed(2),
        )
      }
      lines.push(cells.map(csvCell).join(','))
    }
  }
  const totals = ['Total', '', '', '', '', '', decimalHours(report.seconds)]
  if (money) totals.push('', '')
  lines.push(totals.map(csvCell).join(','))
  return `${lines.join('\r\n')}\r\n`
}

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
