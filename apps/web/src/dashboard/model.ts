import type {
  Invoice,
  TeamPerson,
  TimeEntry,
  TimesheetSubmission,
  UninvoicedReport,
} from '@conflict-hq/ezacto-client'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'
import type { ApprovalQueueFilters, ApprovalQueuePage } from '../shell/model.js'

/**
 * Everything the home screen reads is already served to another screen. The
 * dashboard adds no endpoint: it asks the four questions the week grid, the
 * approvals queue, the uninvoiced report and the invoice list already answer.
 * Every method is optional because a build without one leaves that card out
 * rather than showing an empty frame.
 */
export interface DashboardApi {
  /** The week boundary the Time screen uses. The dashboard must agree with it. */
  getTimeEntrySettings(signal?: AbortSignal): Promise<TimeEntrySettings>
  listTimeEntries(
    query: { readonly from?: string; readonly to?: string; readonly is_running?: boolean },
    signal?: AbortSignal,
  ): Promise<readonly TimeEntry[]>
  listTimesheetSubmissions?(
    periodStart: string,
    periodEnd: string,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  listPendingTimesheetSubmissions?(
    filters?: ApprovalQueueFilters,
    signal?: AbortSignal,
  ): Promise<ApprovalQueuePage>
  getUninvoicedReport?(
    filter: {
      readonly from: string
      readonly to: string
      readonly client_id?: number
      readonly project_id?: number
    },
    signal?: AbortSignal,
  ): Promise<UninvoicedReport>
  listInvoices?(
    cursor?: string,
    signal?: AbortSignal,
    perPage?: number,
  ): Promise<{
    readonly data: readonly Invoice[]
    readonly page: { readonly next_cursor: string | null }
  }>
  getTeamPerson?(id: number, signal?: AbortSignal): Promise<TeamPerson>
}

export type DashboardCardKey = 'week' | 'approvals' | 'uninvoiced' | 'owed'

export interface DashboardCard {
  readonly key: DashboardCardKey
  readonly title: string
  readonly href: string
  readonly linkLabel: string
  /**
   * The element already on the page whose visibility decides whether this
   * figure is this person's to see -- the nav item the profile and module gates
   * hide, not a second copy of the rule they apply. The command palette gates
   * its destinations the same way and for the same reason: a second copy of a
   * permission rule is free to drift from the first, silently, and the drift
   * here would hand a member the company's uninvoiced total.
   *
   * A card whose gate is shut is never inserted. Not disabled: a control that
   * refuses without saying why is worse than one that was never offered.
   */
  readonly gate?: string
}

const primaryNav = (href: string): string => `.primary-nav a[href="${href}"]`

export const dashboardCards: readonly DashboardCard[] = [
  {
    key: 'week',
    title: 'Your week',
    href: '/',
    linkLabel: 'Open the week',
  },
  {
    key: 'approvals',
    title: 'Waiting on you',
    href: '/approvals',
    linkLabel: 'Review timesheets',
    gate: primaryNav('/approvals'),
  },
  {
    key: 'uninvoiced',
    title: 'Uninvoiced work',
    href: '/reports?report=uninvoiced',
    linkLabel: 'Open the report',
    gate: '.primary-nav [data-money-nav]',
  },
  {
    key: 'owed',
    title: 'Owed to you',
    href: '/invoices',
    linkLabel: 'Open invoices',
    gate: '.primary-nav [data-money-nav]',
  },
]

/** How far back "uninvoiced" looks. The card links to this same window. */
export const uninvoicedWindowDays = 90

export const shiftCalendarDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(value.valueOf())) throw new Error(`invalid date: ${date}`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export const uninvoicedWindow = (
  today: string,
): { readonly from: string; readonly to: string } => ({
  from: shiftCalendarDate(today, -uninvoicedWindowDays),
  to: today,
})

export const uninvoicedReportHref = (window: {
  readonly from: string
  readonly to: string
}): string => `/reports?report=uninvoiced&from=${window.from}&to=${window.to}`

export const trackedSeconds = (entries: readonly TimeEntry[]): number =>
  entries.reduce((total, entry) => total + entry.seconds, 0)

export interface CurrencyMoney {
  readonly currency: string
  readonly cents: number
}

/**
 * The uninvoiced report keeps each currency separate, and withholds the money
 * fields from a profile that may not read them. A total the server declined to
 * send is absent from this list rather than rendered as zero: zero is a fact
 * about the business, and "we did not tell you" is not.
 */
export const uninvoicedTotals = (report: UninvoicedReport): readonly CurrencyMoney[] =>
  report.totals
    .flatMap((total) =>
      total.total_cents === undefined
        ? []
        : [{ currency: total.currency, cents: total.total_cents }],
    )
    .sort((left, right) => right.cents - left.cents)

export interface InvoiceObligation {
  readonly currency: string
  readonly dueCents: number
  readonly overdueCents: number
  readonly openCount: number
  readonly overdueCount: number
}

/**
 * What is owed, per currency, out of the states the invoice list already
 * carries. Only an open invoice is owed: a draft has not been sent, and paid
 * and closed ones are settled however they got that way.
 */
export const invoiceObligations = (
  invoices: readonly Invoice[],
  today: string,
): readonly InvoiceObligation[] => {
  const byCurrency = new Map<
    string,
    { dueCents: number; overdueCents: number; openCount: number; overdueCount: number }
  >()
  for (const invoice of invoices) {
    if (invoice.state !== 'open' || invoice.due_amount_cents <= 0) continue
    const bucket = byCurrency.get(invoice.currency) ?? {
      dueCents: 0,
      overdueCents: 0,
      openCount: 0,
      overdueCount: 0,
    }
    bucket.dueCents += invoice.due_amount_cents
    bucket.openCount += 1
    if (invoice.due_date < today) {
      bucket.overdueCents += invoice.due_amount_cents
      bucket.overdueCount += 1
    }
    byCurrency.set(invoice.currency, bucket)
  }
  return [...byCurrency]
    .map(([currency, bucket]) => ({ currency, ...bucket }))
    .sort((left, right) => right.dueCents - left.dueCents)
}

export interface WeekStanding {
  readonly state: 'unsubmitted' | 'rejected' | 'submitted' | 'approved'
  readonly needsAction: boolean
  readonly message: string
}

/**
 * The one line the week card owes an answer to: is anything expected of you.
 */
export const weekStanding = (
  submission: TimesheetSubmission | null,
  seconds: number,
): WeekStanding => {
  const status = submission?.status ?? 'unsubmitted'
  if (status === 'approved') {
    return { state: 'approved', needsAction: false, message: 'Approved.' }
  }
  if (status === 'submitted') {
    return { state: 'submitted', needsAction: false, message: 'Submitted, awaiting approval.' }
  }
  const reason = submission?.rejection_reason?.trim() ?? ''
  if (reason !== '') {
    return { state: 'rejected', needsAction: true, message: `Changes requested: ${reason}` }
  }
  return seconds === 0
    ? { state: 'unsubmitted', needsAction: true, message: 'Nothing logged yet this week.' }
    : { state: 'unsubmitted', needsAction: true, message: 'This week is not submitted.' }
}

/**
 * The approvals queue answers a page at a time, so an exact count past the
 * first page would be a guess. "20+" is the honest shape of a number this
 * screen needs only in order to say whether anything is waiting.
 */
export const queueCount = (page: ApprovalQueuePage): string =>
  page.nextCursor === null
    ? String(page.submissions.length)
    : `${page.submissions.length}+`

export const dashboardCount = (
  count: number,
  singular: string,
  plural = `${singular}s`,
): string => `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
