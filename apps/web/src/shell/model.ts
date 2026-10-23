import type { FirstRunApi } from '../first-run/model.js'
import type { EstimateComposerApi } from '../estimates/composer.js'
import type { ScheduledRunApi } from '../scheduled-runs/model.js'
import type { StaffPaymentsApi } from '../staff-payments/browser.js'
import {
  EzactoClient,
  EzactoApiError,
  type Expense,
  type GeneralResource,
  type Invoice,
  type InvoiceGenerationInput,
  type InvoiceTransitionInput,
  type PasswordSignInInput,
  type Session,
  type SignInResult,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryOption,
  type TimeEntryPatch,
  type TimesheetRejectionInput,
  type TimesheetLockPolicy,
  type TimesheetLockPolicyPatch,
  type TimesheetLockWindow,
  type TimesheetBulkApprovalInput,
  type TimesheetManualLockInput,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type TimesheetSubmissionInput,
  type TimesheetUnlockInput,
  type TimesheetWithdrawalInput,
  type Whoami,
  type ApiToken,
  type CreateApiTokenInput,
  type IssuedApiToken,
  type TwoFactorChallengeIssued,
  type TwoFactorEnrolment,
  type TwoFactorStatus,
  type ProfileNotificationInput,
  type TeamNotificationPreference,
} from '@conflict-hq/ezacto-client'
import type { InvoiceState } from '../invoices/model.js'
import type { ActivityExportQuery, ActivityQuery, ActivityRow } from '../activity/browser.js'
import type { CapacityApi, PlanningApi } from '../capacity/model.js'
import type { MyPaymentsApi } from '../my-payments/model.js'
import type { LogPageResult } from '../components/paged-log.js'
import type {
  EmailLogQuery,
  EmailLogRow,
  OutboxQuery,
  OutboxRow,
} from '../deliveries/browser.js'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'
import type { ClientDirectoryApi, ClientInvoiceSending } from '../clients/model.js'
import { personLabel, type ProjectDirectoryApi } from '../projects/model.js'
import { detailedTimeExportPath, type ReportWorkspaceApi } from '../reports/model.js'
import type { ExpenseWorkflowApi } from '../expenses/model.js'
import type { ExpenseCategoryDirectoryApi } from '../expense-categories/model.js'
import type { InvoiceEditorApi, InvoicePaymentApi } from '../invoices/model.js'
import type { RoleAdminApi } from '../roles/model.js'
import type { TaskAdminApi } from '../tasks/model.js'
import type { TeamDirectoryApi } from '../team/model.js'
import type { CompanySettingsApi } from '../module-settings/model.js'
import type { EmailConfigurationApi } from '../email-config/model.js'
import type { RecurringWorkspaceApi } from '../recurring/model.js'
import type { EstimateWorkspaceApi } from '../estimates/model.js'
import type { RetainerWorkspaceApi } from '../retainers/model.js'
import { shellFetch } from './net.js'

interface CursorPage<T> {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ApprovalQueueFilters {
  readonly userId?: number
  readonly clientId?: number
  readonly projectId?: number
}

export interface ApprovalQueuePage {
  readonly submissions: readonly TimesheetSubmission[]
  readonly nextCursor: string | null
}

/** Whether the hours report goes with an invoice, at which detail, in which files. */
export interface InvoiceJournalChoice {
  readonly level: 'detailed' | 'summary' | false
  readonly formats: readonly ('pdf' | 'csv' | 'xlsx')[]
}

export interface ShellApi
  extends StaffPaymentsApi,
    Partial<ClientDirectoryApi>,
    Partial<ProjectDirectoryApi>,
    Partial<ReportWorkspaceApi>,
    Partial<ExpenseWorkflowApi>,
    Partial<ExpenseCategoryDirectoryApi>,
    Partial<EmailConfigurationApi>,
    Partial<RecurringWorkspaceApi>,
    Partial<EstimateWorkspaceApi>,
    Partial<EstimateComposerApi>,
    Partial<RetainerWorkspaceApi>,
    Partial<InvoicePaymentApi>,
    Partial<InvoiceEditorApi>,
    Partial<RoleAdminApi>,
    Partial<TaskAdminApi>,
    Partial<TeamDirectoryApi>,
    Partial<CompanySettingsApi>,
    Partial<FirstRunApi> {
  whoami(signal?: AbortSignal): Promise<Whoami>
  /**
   * Your own reminder preferences (issue 935), under Settings. Optional like
   * the other settings reads: a shell built against an API without the route
   * leaves the section hidden rather than offering a form that cannot save.
   */
  getProfileNotifications?(signal?: AbortSignal): Promise<TeamNotificationPreference>
  updateProfileNotifications?(
    input: ProfileNotificationInput,
    signal?: AbortSignal,
  ): Promise<TeamNotificationPreference>
  /**
   * Issue 731: an enrolled user is not signed in yet. The challenge answer
   * carries no principal, so the caller has to read the status rather than
   * assume the session landed.
   */
  signIn(
    credentials: PasswordSignInInput,
    signal?: AbortSignal,
  ): Promise<SignInResult>
  completeTwoFactorChallenge?(
    input: { readonly code: string; readonly challenge?: string },
    signal?: AbortSignal,
  ): Promise<void>
  requestPasswordReset?(email: string, signal?: AbortSignal): Promise<void>
  resetPassword?(input: { token: string; password: string }, signal?: AbortSignal): Promise<void>
  logoutCurrentSession(signal?: AbortSignal): Promise<Session>
  listProjects(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  listClients?(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  /** Whether the Activity log module is on, so the surface is not offered when it is off. */
  getActivityLogEnabled?(signal?: AbortSignal): Promise<boolean>
  /** Planned hours against capacity and tracked time, person by week (issue 1007). */
  getCapacity?(
    range: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): ReturnType<CapacityApi['getCapacity']>
  /** Allocation and time off entry on the capacity screen, for an administrator (issue 1007). */
  planning?: PlanningApi
  /** The signed-in person's own payment summary (issue 100). */
  getMyPayments?(month: string, signal?: AbortSignal): ReturnType<MyPaymentsApi['getMyPayments']>
  scheduledRuns?: ScheduledRunApi
  getMyStaffInvoices?: MyPaymentsApi['getMyStaffInvoices']
  /** The page size a caller may raise when it is walking, not browsing. */
  listActivityLog?(
    query: ActivityQuery,
    signal?: AbortSignal,
  ): Promise<{
    readonly data: readonly ActivityRow[]
    readonly page?: { readonly next_cursor: string | null }
  }>
  /** The filtered view as a CSV file (issue 8). Absent where the build cannot export. */
  exportActivityLog?(
    query: ActivityExportQuery,
    signal?: AbortSignal,
  ): Promise<{ readonly blob: Blob; readonly filename: string; readonly truncated: boolean }>
  /** Finished years the live activity log still holds (issue 8). */
  listRollableActivityYears?(
    signal?: AbortSignal,
  ): Promise<readonly { readonly year: number; readonly entries: number }[]>
  /** Rolls one finished year of the activity log into its archive. Administrators only. */
  rollActivityYear?(year: number, signal?: AbortSignal): Promise<void>
  /**
   * The tokens you have issued, and issuing another (issue 485).
   *
   * Yours alone: the routes scope every one of these to the acting user, so
   * this is a personal-settings surface rather than an administrative one.
   */
  /**
   * Two-step sign-in, for the person it protects (issue 485).
   *
   * An instance can require a second factor and nothing in the app could set
   * one up, which left enrolment to a terminal.
   */
  getTwoFactorStatus?(signal?: AbortSignal): Promise<TwoFactorStatus>
  beginTwoFactorEnrolment?(signal?: AbortSignal): Promise<TwoFactorEnrolment>
  confirmTwoFactorEnrolment?(code: string, signal?: AbortSignal): Promise<TwoFactorStatus>
  disableTwoFactor?(code: string, signal?: AbortSignal): Promise<TwoFactorStatus>
  /** Issue 770: the emailed second factor. Turning it off needs no code; it is session-only. */
  enableTwoFactorEmail?(signal?: AbortSignal): Promise<TwoFactorStatus>
  disableTwoFactorEmail?(signal?: AbortSignal): Promise<TwoFactorStatus>
  /**
   * Mails a code for an open challenge. The earlier challenge dies with this
   * call, so the answer carries the token to use from now on.
   */
  sendTwoFactorEmailCode?(
    input: { readonly challenge?: string },
    signal?: AbortSignal,
  ): Promise<TwoFactorChallengeIssued>
  listApiTokens?(signal?: AbortSignal): Promise<readonly ApiToken[]>
  createApiToken?(
    input: CreateApiTokenInput,
    signal?: AbortSignal,
  ): Promise<IssuedApiToken>
  revokeApiToken?(tokenId: number, signal?: AbortSignal): Promise<void>
  /** What was sent, and what became of it (issue 485). */
  listEmailLog?(
    query: EmailLogQuery,
    signal?: AbortSignal,
  ): Promise<LogPageResult<EmailLogRow>>
  listOutboxDeliveries?(
    query: OutboxQuery,
    signal?: AbortSignal,
  ): Promise<LogPageResult<OutboxRow>>
  retryOutboxDelivery?(
    subscriberId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  listInvoices?(
    cursor?: string,
    signal?: AbortSignal,
    perPage?: number,
    states?: readonly InvoiceState[],
    sort?: string,
  ): Promise<CursorPage<Invoice>>
  listTasks(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  /**
   * Records matching a typed query, for the palette. Optional because a build
   * without it simply offers no record hits; the palette's commands are
   * unaffected.
   */
  searchEntities?(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PaletteEntity[]>
  /** `userId` names a teammate, which only an administrator may do (issue 917). */
  listTimeEntryOptions(
    signal?: AbortSignal,
    userId?: number,
  ): Promise<readonly TimeEntryOption[]>
  getTimeEntrySettings(signal?: AbortSignal): Promise<TimeEntrySettings>
  listTimeEntries(query: {
    readonly from?: string
    readonly to?: string
    readonly is_running?: boolean
    /** A teammate's entries, which only an administrator may ask for (issue 917). */
    readonly user_id?: number
  }, signal?: AbortSignal): Promise<readonly TimeEntry[]>
  /**
   * One entry by id, for the editor a report row opens (issue 917). Optional because
   * the week never needs it: it already holds every entry it draws.
   */
  getTimeEntry?(id: number, signal?: AbortSignal): Promise<TimeEntry>
  listExpenses?(query: {
    readonly from?: string
    readonly to?: string
  }, signal?: AbortSignal): Promise<readonly Expense[]>
  createTimeEntry(input: TimeEntryInput, signal?: AbortSignal): Promise<TimeEntry>
  updateTimeEntry(id: number, patch: TimeEntryPatch, signal?: AbortSignal): Promise<TimeEntry>
  deleteTimeEntry(id: number, signal?: AbortSignal): Promise<void>
  stopTimeEntry(id: number, signal?: AbortSignal): Promise<TimeEntry>
  restartTimeEntry?(id: number, signal?: AbortSignal): Promise<TimeEntry>
  listTimesheetSubmissions?(
    periodStart: string,
    periodEnd: string,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  submitTimesheet?(
    input: TimesheetSubmissionInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  listPendingTimesheetSubmissions?(
    filters?: ApprovalQueueFilters,
    signal?: AbortSignal,
  ): Promise<ApprovalQueuePage>
  listApprovedTimesheetSubmissions?(
    periodStart: string,
    filters?: ApprovalQueueFilters,
    signal?: AbortSignal,
  ): Promise<ApprovalQueuePage>
  getTimesheetSubmission?(id: number, signal?: AbortSignal): Promise<TimesheetSubmissionDetail>
  approveTimesheetSubmission?(id: number, signal?: AbortSignal): Promise<TimesheetSubmission>
  bulkApproveTimesheetSubmissions?(
    commandId: string,
    input: TimesheetBulkApprovalInput,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  rejectTimesheetSubmission?(
    id: number,
    input: TimesheetRejectionInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  withdrawTimesheetSubmission?(
    id: number,
    input: TimesheetWithdrawalInput,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  /** Taking back your own week before anyone has reviewed it. No reason asked. */
  unsubmitTimesheetSubmission?(
    id: number,
    signal?: AbortSignal,
  ): Promise<TimesheetSubmission>
  /** The signed-in user's own timezone, for the self-service control (issue 757). */
  getProfile?(signal?: AbortSignal): Promise<{
    user_id: number
    timezone: string
    first_name?: string
    last_name?: string
    email?: string | null
  }>
  updateProfile?(
    timezone: string,
    signal?: AbortSignal,
  ): Promise<{ user_id: number; timezone: string }>
  getTimesheetLockPolicy?(signal?: AbortSignal): Promise<TimesheetLockPolicy>
  updateTimesheetLockPolicy?(
    input: TimesheetLockPolicyPatch,
    signal?: AbortSignal,
  ): Promise<TimesheetLockPolicy>
  listTimesheetLocks?(signal?: AbortSignal): Promise<readonly TimesheetLockWindow[]>
  createTimesheetManualLock?(
    commandId: string,
    input: TimesheetManualLockInput,
    signal?: AbortSignal,
  ): Promise<TimesheetLockWindow>
  unlockTimesheetLock?(
    id: number,
    input: TimesheetUnlockInput,
    signal?: AbortSignal,
  ): Promise<TimesheetLockWindow>
  generateInvoice?(
    commandId: string,
    input: InvoiceGenerationInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  /** The hours report (work journal, issue 647) rendered when an invoice is emailed. */
  getOrganizationInvoiceJournal?(signal?: AbortSignal): Promise<InvoiceJournalChoice>
  setInvoiceJournal?(
    invoiceId: number,
    choice: InvoiceJournalChoice,
    signal?: AbortSignal,
  ): Promise<void>
  transitionInvoice?(
    id: number,
    commandId: string,
    input: InvoiceTransitionInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
}

export interface QuickAddCommand {
  readonly seconds: number
  readonly project: string
  readonly task: string
  readonly notes?: string
}

export const maximumTimeEntryNoteLength = 10_000
export const pendingTimesheetQueueLimit = 50
export const pendingTimesheetDetailConcurrency = 4

export const hydratePendingTimesheetDetails = async (
  summaries: readonly TimesheetSubmission[],
  getSubmission: (id: number, signal?: AbortSignal) => Promise<TimesheetSubmissionDetail>,
  signal?: AbortSignal,
): Promise<readonly TimesheetSubmissionDetail[]> => {
  const bounded = summaries.slice(0, pendingTimesheetQueueLimit)
  const details: Array<TimesheetSubmissionDetail | undefined> = new Array(bounded.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < bounded.length) {
      const index = next++
      details[index] = await getSubmission(bounded[index]!.id, signal)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(pendingTimesheetDetailConcurrency, bounded.length) },
      worker,
    ),
  )
  return details.filter(
    (detail): detail is TimesheetSubmissionDetail => detail?.status === 'submitted',
  )
}

/**
 * Whose week an administrator can open on Time (issue 917): everyone active except
 * themselves, named the way the project screens name people, in name order.
 */
export const timePersonChoices = (
  people: readonly GeneralResource[],
  selfId: number,
): readonly { readonly id: number; readonly name: string }[] =>
  people
    .filter((person) => person.id !== selfId && person['is_active'] !== false)
    .map((person) => ({ id: person.id, name: personLabel(person.id, people) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en-US'))

export const timeEntryNoteLength = (notes: string | null | undefined): number =>
  notes === null || notes === undefined ? 0 : Array.from(notes.trim()).length

export class TimeEntryNoteValidationError extends Error {
  readonly minimumLength: number

  constructor(minimumLength: number) {
    super(
      `A note of at least ${minimumLength} ${minimumLength === 1 ? 'character is' : 'characters are'} required for that project and task.`,
    )
    this.name = 'TimeEntryNoteValidationError'
    this.minimumLength = minimumLength
  }
}

export interface DisplayTimeEntry extends TimeEntry {
  readonly project_label: string
  readonly task_label: string
}

export interface ShellSnapshot {
  readonly entries: readonly DisplayTimeEntry[]
  readonly expenses: readonly Expense[]
  /**
   * Whether the Expenses module answered. False when an administrator has
   * switched it off (issue 815): the week loads without expenses, and the
   * shell hides the Expenses link rather than offering a page that refuses.
   * Module state itself is an administrator's to read, so this is the one
   * signal every profile gets.
   */
  readonly expensesAvailable: boolean
  readonly running: DisplayTimeEntry | null
  readonly timeEntrySettings: TimeEntrySettings
  readonly catalog: {
    readonly projects: readonly GeneralResource[]
    readonly tasks: readonly GeneralResource[]
    readonly timeEntryOptions: readonly TimeEntryOption[]
  }
}

const resourceText = (
  resource: GeneralResource,
  field: string,
): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const resourceLabel = (resource: GeneralResource): string =>
  resourceText(resource, 'name') ??
  resourceText(resource, 'code') ??
  `#${resource.id}`

const resourceAliases = (resource: GeneralResource): readonly string[] =>
  [
    resourceText(resource, 'name'),
    resourceText(resource, 'code'),
    String(resource.id),
  ].filter((value): value is string => value !== null)

const normalized = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')

/**
 * Whether this profile browses the firm's directories -- Projects, Tasks and
 * Clients. Not a shorthand for "is not a member": a member is refused because
 * those three screens are the firm's own record of what it sells and who it
 * sells to, while the member's record of what they did reaches them through
 * their timesheet, their expenses, their reports and their dashboard
 * (issue 491).
 *
 * The nav is the smaller half of that rule. The API narrows what the same three
 * collections RETURN to a member -- the projects they are assigned to, those
 * projects' clients, and the tasks assigned to those projects -- so a member who
 * types /clients is answered with their own work rather than the book, and the
 * screens that read those collections to render, Expenses above all, keep the
 * catalog they need.
 */
export const canBrowseDirectories = (profile: Whoami['profile']): boolean =>
  profile !== 'member'

/**
 * Every place ⌘K can take you, grouped by what you came to do rather than by
 * which table the page reads: Track is where the day goes in, Organize is the
 * shape of the work, Bill is the money out, Review is the checking. Settings
 * sits under Organize because setting the account up is that kind of errand.
 */
export type PaletteGroup = 'Track' | 'Organize' | 'Bill' | 'Review'

export interface PaletteDestination {
  readonly label: string
  readonly href: string
  readonly group: PaletteGroup
  /** Words that should find this destination but do not belong in its name. */
  readonly keywords?: string
  /**
   * The element already on the page whose visibility decides whether this
   * destination is this person's to reach -- the nav link the profile and
   * module gates hide, not a second copy of the rule they apply. A second copy
   * is free to drift from the one the nav uses, and the drift is silent: it
   * hands a member a link the product spent three guards hiding.
   */
  readonly gate?: string
}

const primaryNav = (href: string): string => `.primary-nav a[href="${href}"]`

/**
 * Folded out of the strip by issue 461 and gated from the Menu instead.
 *
 * The palette offers a destination when the nav element behind it is present
 * and showing, and `paletteOffers` fails closed on a missing element. So a
 * section that leaves the strip has to keep a gated element somewhere, or it
 * leaves the palette with it.
 */
const foldedNav = (href: string): string => `.secondary-nav a[href="${href}"]`

export const paletteDestinations: readonly PaletteDestination[] = [
  {
    label: 'Home',
    href: '/dashboard',
    group: 'Track',
    keywords: 'dashboard overview where things stand',
    gate: foldedNav('/dashboard'),
  },
  {
    label: 'Time',
    href: '/',
    group: 'Track',
    keywords: 'week day timesheet hours',
    gate: primaryNav('/'),
  },
  {
    label: 'Expenses',
    href: '/expenses',
    group: 'Track',
    keywords: 'receipts',
    gate: primaryNav('/expenses'),
  },
  { label: 'Projects', href: '/projects', group: 'Organize', gate: primaryNav('/projects') },
  { label: 'Tasks', href: '/tasks', group: 'Organize', gate: foldedNav('/tasks') },
  {
    label: 'Clients',
    href: '/clients',
    group: 'Organize',
    keywords: 'contacts',
    gate: primaryNav('/clients'),
  },
  { label: 'Team', href: '/team', group: 'Organize', keywords: 'people', gate: foldedNav('/team') },
  // Reached from Expenses and gated with it: the categories page is that
  // section's own administration rather than a destination of its own.
  {
    label: 'Expense categories',
    href: '/expense-categories',
    group: 'Organize',
    gate: primaryNav('/expenses'),
  },
  {
    label: 'Your settings',
    href: '/settings/user',
    group: 'Organize',
    keywords: 'account you profile',
  },
  {
    label: 'Company settings',
    href: '/settings/company',
    group: 'Organize',
    keywords: 'modules organization',
    gate: '[data-settings-company-tab]',
  },
  {
    label: 'Email templates',
    href: '/settings/templates',
    group: 'Organize',
    keywords: 'email template reminder thank you password reset verification sender',
    gate: '[data-settings-templates-tab]',
  },
  {
    label: 'Roles',
    href: '/settings/roles',
    group: 'Organize',
    keywords: 'role title people team manage',
    gate: '[data-settings-roles-tab]',
  },
  {
    label: 'Activity log',
    href: '/settings/activity',
    group: 'Review',
    keywords: 'audit history who changed',
    // The same gate as Company settings: the log names who did what, and the
    // palette must not offer a destination that answers 403.
    gate: '[data-settings-activity-tab]',
  },
  {
    label: 'Deliveries',
    href: '/settings/deliveries',
    group: 'Review',
    keywords: 'email sent outbox delivery failed retry bounce',
    // The same gate as the activity log, and for the same reason: the table
    // names every recipient this instance has written to.
    gate: '[data-settings-deliveries-tab]',
  },
  {
    label: 'Invoices',
    href: '/invoices',
    group: 'Bill',
    keywords: 'money billing',
    gate: primaryNav('/invoices'),
  },
  {
    label: 'New invoice',
    href: '/invoices/new',
    group: 'Bill',
    keywords: 'new draft',
    gate: primaryNav('/invoices'),
  },
  {
    label: 'Approvals',
    href: '/approvals',
    group: 'Review',
    keywords: 'timesheets submitted',
    gate: primaryNav('/approvals'),
  },
  { label: 'Reports', href: '/reports', group: 'Review', gate: primaryNav('/reports') },
]

/**
 * Whether an unsubmitted week was sent back by its own owner rather than by a
 * reviewer.
 *
 * The row says so directly: a rejection names a reviewer and a reason, and a
 * withdrawal names neither, because nobody reviewed it. That became expressible
 * in migration 0047, which gave the table a fourth CHECK branch for it.
 *
 * Before that, every unsubmitted row had to carry a reviewer and a reason, so a
 * withdrawal wrote the owner as their own reviewer and a fixed sentence as the
 * reason -- and this function had to match that sentence, restated here because
 * `apps/web` depends only on the generated client. Identity alone was not
 * enough, as a browser test proved: an administrator rejecting their *own* week
 * is also a row whose reviewer is its owner, and reading that as a withdrawal
 * hid a real rejection. A reviewer who typed the sentence verbatim was misread
 * the other way. Neither can happen now -- a rejection always has a reviewer.
 *
 * Worth a named function rather than an inline comparison: getting it wrong
 * shows someone "Changes requested" for a correction they made themselves.
 */
export const isSelfWithdrawn = (
  submission: Pick<TimesheetSubmission, 'status' | 'reviewed_by_user_id'> | null,
): boolean =>
  submission !== null &&
  submission.status === 'unsubmitted' &&
  submission.reviewed_by_user_id === null

const paletteGroups: readonly PaletteGroup[] = ['Track', 'Organize', 'Bill', 'Review']

/**
 * What an entity hit looks like once the search has resolved it. The palette
 * renders a destination and a record identically -- both are somewhere to go --
 * so the section holds the narrower shape both satisfy.
 */
export interface PaletteResult {
  readonly label: string
  readonly href: string
}

export type PaletteEntityKind = 'client' | 'project' | 'task'

export interface PaletteEntity extends PaletteResult {
  readonly kind: PaletteEntityKind
}

/**
 * Records get their own headings rather than joining Track/Organize/Bill/Review.
 * Those four name what you are trying to do; a client is not a thing you are
 * trying to do, and filing one under Organize would make the groups mean two
 * things at once.
 */
const entityHeadings: readonly { kind: PaletteEntityKind; heading: string }[] = [
  { kind: 'client', heading: 'Clients' },
  { kind: 'project', heading: 'Projects' },
  { kind: 'task', heading: 'Tasks' },
]

export type PaletteHeading = PaletteGroup | 'Clients' | 'Projects' | 'Tasks'

export interface PaletteSection {
  readonly group: PaletteHeading
  readonly destinations: readonly PaletteResult[]
}

const paletteHaystack = (destination: PaletteDestination): string =>
  normalized(`${destination.label} ${destination.keywords ?? ''}`)

/**
 * The results under the input, in group order. `offered` is the caller's read of
 * each destination's gate; a destination it rejects is absent rather than
 * disabled, because the point of the gate is that the page is never advertised.
 */
export const palettePlan = (
  query: string,
  offered: (destination: PaletteDestination) => boolean,
  entities: readonly PaletteEntity[] = [],
): readonly PaletteSection[] => {
  // Normalizing both sides drops the spaces, so "expense cat" still finds
  // Expense categories.
  const needle = normalized(query)
  const matched = paletteDestinations.filter(
    (destination) =>
      offered(destination) &&
      (needle === '' || paletteHaystack(destination).includes(needle)),
  )
  const commands: PaletteSection[] = paletteGroups
    .map((group) => ({
      group: group as PaletteHeading,
      destinations: matched.filter(
        (destination) => destination.group === group,
      ) as readonly PaletteResult[],
    }))
    .filter((section) => section.destinations.length > 0)
  // Records come after the commands: an empty query offers none, and a typed
  // one is more often reaching for a screen than for a row.
  const records: PaletteSection[] =
    needle === ''
      ? []
      : entityHeadings
          .map(({ kind, heading }) => ({
            group: heading as PaletteHeading,
            destinations: entities.filter(
              (entity) => entity.kind === kind,
            ) as readonly PaletteResult[],
          }))
          .filter((section) => section.destinations.length > 0)
  return [...commands, ...records]
}

// `go <name>` predates the palette and still works. Its map is the palette's own
// catalog, so a route added to one can never be the one missing from the other.
const collect = async (
  load: (cursor?: string) => Promise<CursorPage<GeneralResource>>,
  signal?: AbortSignal,
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await load(cursor)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

const loadCatalogResources = async (
  api: ShellApi,
  signal?: AbortSignal,
): Promise<{ projects: GeneralResource[]; tasks: GeneralResource[] }> => {
  const [projects, tasks] = await Promise.all([
    collect((cursor) => api.listProjects(cursor, signal), signal),
    collect((cursor) => api.listTasks(cursor, signal), signal),
  ])
  return { projects, tasks }
}

const assertNoteIsAllowed = (
  notes: string | null | undefined,
  minimumLength: number,
): void => {
  if (
    notes !== null &&
    notes !== undefined &&
    notes.length > maximumTimeEntryNoteLength
  ) {
    throw new Error(
      `Notes cannot exceed ${maximumTimeEntryNoteLength.toLocaleString('en-US')} characters.`,
    )
  }
  const length = timeEntryNoteLength(notes)
  if (length < minimumLength) {
    throw new TimeEntryNoteValidationError(minimumLength)
  }
}

const resolveAvailableEntrySelection = async (
  api: ShellApi,
  projectValue: string,
  taskValue: string,
  signal?: AbortSignal,
): Promise<{
  project: GeneralResource
  task: GeneralResource
  minimumNoteLength: number
}> => {
  const [resources, options] = await Promise.all([
    loadCatalogResources(api, signal),
    api.listTimeEntryOptions(signal),
  ])
  const project = resolveResource('project', projectValue, resources.projects)
  const task = resolveResource('task', taskValue, resources.tasks)
  const selected = options.find(
    (option) =>
      option.project_id === project.id && option.task_id === task.id,
  )
  if (selected === undefined) {
    throw new Error('That project and task combination is not available.')
  }
  return {
    project,
    task,
    minimumNoteLength: selected.minimum_note_length,
  }
}

const resolveResource = (
  kind: 'project' | 'task',
  value: string,
  resources: readonly GeneralResource[],
): GeneralResource => {
  const wanted = normalized(value)
  const matches = resources.filter((resource) =>
    resourceAliases(resource).some((alias) => normalized(alias) === wanted),
  )
  if (matches.length === 0) throw new Error(`${kind} not found: ${value}`)
  if (matches.length > 1) throw new Error(`${kind} is ambiguous: ${value}`)
  return matches[0]!
}

export const parseDurationSeconds = (value: string): number => {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/iu.exec(value)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error('duration must look like 2h, 90m, or 1h30m')
  }
  const seconds = Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error('duration must resolve to whole positive seconds')
  }
  return seconds
}

export const parseQuickAdd = (value: string): QuickAddCommand => {
  const tokens = /^log\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/iu.exec(
    value.trim(),
  )
  if (tokens === null) {
    throw new Error('use: log 2h project task [note]')
  }
  const notes = tokens[4]?.trim()
  return {
    seconds: parseDurationSeconds(tokens[1]!),
    project: tokens[2]!,
    task: tokens[3]!,
    ...(notes === undefined || notes === '' ? {} : { notes }),
  }
}

/**
 * What the command bar should say while a `log` line is being typed (issue 556).
 *
 * The results panel only searches *go* destinations, so a `log` line can never
 * match one and the panel read "No destination matches that." for as long as
 * you typed -- directly under a hint advertising the log form. The natural read
 * is that the command is wrong, so the operator abandons a command that in fact
 * works.
 *
 * Returns null for anything that is not a log line, so the destination search
 * keeps the panel for every other query.
 */
export const quickAddPreview = (value: string): string | null => {
  const trimmed = value.trim()
  if (!/^log(\s|$)/iu.test(trimmed)) return null
  try {
    const command = parseQuickAdd(trimmed)
    const hours = command.seconds / 3_600
    const duration = `${new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2,
    }).format(hours)}h`
    // Named parts rather than an echo of the input: the point is to show the
    // command was understood, which means showing what it was understood AS.
    const parts = [duration, command.project, command.task]
    return `Log ${parts.join(' \u00b7 ')}${command.notes === undefined ? '' : ` \u00b7 ${command.notes}`}`
  } catch {
    // Recognisably a log line, not yet a complete one. Still not a failed
    // destination search, so it must not say so.
    return 'Keep typing: log 2h project task'
  }
}

export const navigationDestination = (
  value: string,
  offered: (destination: PaletteDestination) => boolean,
): string | null => {
  const match = /^go\s+(.+)$/iu.exec(value.trim())
  if (match === null) return null
  // The typed `go` grammar and the results list are the same dialog reaching
  // the same table, so they answer to the same gate. Without it the list
  // correctly withholds Approvals from a member while `go approvals` in that
  // very input still takes them there. `offered` is required rather than
  // defaulted: a gate a caller can forget is one that will be forgotten.
  const wanted = normalized(match[1]!)
  const destination = paletteDestinations.find(
    (candidate) => normalized(candidate.label) === wanted && offered(candidate),
  )
  return destination?.href ?? null
}

export const localDate = (now = new Date()): string => {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The date a running timer will be filed on, as far as the browser can tell.
 *
 * The server files a timer on the operator's own timezone, then the
 * organization's (issue 651) -- never the browser's clock, which a laptop away
 * from home disagrees with every evening. `zones` are those candidates in
 * that order; the first one `Intl` accepts wins, because the server skips a
 * zone it cannot use in exactly the same way (imported people carry Harvest
 * display names such as "Central America"). With none usable the browser's
 * own day is the best guess left. `en-CA` formats as YYYY-MM-DD, the shape
 * the grid keys its cells by.
 */
export const filingDate = (zones: readonly string[], now = new Date()): string => {
  for (const timeZone of zones) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now)
    } catch {
      // Not a zone this engine knows; the next candidate is what the server
      // would use too.
    }
  }
  return localDate(now)
}

/**
 * The filing day and the minute of it, read in the same zone `filingDate`
 * would choose: where the calendar measures a running entry to and draws its
 * line for now (issue 943). A clock read in another zone would put that line
 * on the right day at the wrong hour.
 */
export const filingClock = (
  zones: readonly string[],
  now = new Date(),
): { readonly date: string; readonly minutes: number } => {
  for (const timeZone of zones) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now)
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? ''
      return {
        date: `${part('year')}-${part('month')}-${part('day')}`,
        minutes: (Number(part('hour')) % 24) * 60 + Number(part('minute')),
      }
    } catch {
      // Not a zone this engine knows; the next candidate is what the server
      // would use too.
    }
  }
  return { date: localDate(now), minutes: now.getHours() * 60 + now.getMinutes() }
}

export const weekRange = (
  within: string,
  weekStartDay: 'saturday' | 'sunday' | 'monday' = 'monday',
): { from: string; to: string } => {
  const date = new Date(`${within}T00:00:00.000Z`)
  const startIndex = weekStartDay === 'sunday' ? 0 : weekStartDay === 'monday' ? 1 : 6
  const daysSinceStart = (date.getUTCDay() - startIndex + 7) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceStart)
  const from = date.toISOString().slice(0, 10)
  date.setUTCDate(date.getUTCDate() + 6)
  return { from, to: date.toISOString().slice(0, 10) }
}

export const runningElapsedSeconds = (
  entry: TimeEntry,
  now = new Date(),
): number => {
  if (
    !entry.is_running ||
    entry.timer_started_at === null ||
    entry.timer_started_at === undefined
  ) {
    return entry.seconds
  }
  const started = new Date(entry.timer_started_at).valueOf()
  return (
    entry.seconds + Math.max(0, Math.floor((now.valueOf() - started) / 1_000))
  )
}

const labels = (resources: readonly GeneralResource[]): Map<number, string> =>
  new Map(resources.map((resource) => [resource.id, resourceLabel(resource)]))

const displayEntries = (
  entries: readonly TimeEntry[],
  resources: {
    projects: readonly GeneralResource[]
    tasks: readonly GeneralResource[]
  },
): DisplayTimeEntry[] => {
  const projects = labels(resources.projects)
  const tasks = labels(resources.tasks)
  return entries.map((entry) => ({
    ...entry,
    project_label: projects.get(entry.project_id) ?? `#${entry.project_id}`,
    task_label: tasks.get(entry.task_id) ?? `#${entry.task_id}`,
  }))
}

const isModuleDisabled = (error: EzactoApiError): boolean => {
  const body = error.body as { error?: { code?: unknown } } | null
  return typeof body === 'object' && body !== null && body.error?.code === 'module_disabled'
}

/**
 * `userId` loads a teammate's week for an administrator (issue 917): that person's
 * entries and the project/task pairs they may log against. The running timer
 * and the expenses stay the signed-in person's -- the header timer is theirs,
 * and the week only reads expenses to offer submitting it, which is the
 * owner's to do and is not offered on somebody else's week.
 */
export const loadShellSnapshot = async (
  api: ShellApi,
  now = new Date(),
  signal?: AbortSignal,
  userId?: number,
): Promise<ShellSnapshot> => {
  const timeEntrySettings = await api.getTimeEntrySettings(signal)
  const range = weekRange(localDate(now), timeEntrySettings.week_start_day)
  // Expenses are a module, and a module an administrator switched off answers
  // 403 `module_disabled` -- a decision, not a failure. Only the 404 of a build
  // without the routes was tolerated here, so turning the module off in
  // Settings took the whole week with it ("your week could not load").
  // Only an explicit refusal hides the module: a build without the adapter,
  // or a route that 404s, says nothing about what the administrator chose.
  let expensesAvailable = true
  const expenseRequest = api.listExpenses?.(range, signal).catch((error: unknown) => {
    if (error instanceof EzactoApiError && error.status === 404) return []
    if (error instanceof EzactoApiError && error.status === 403 && isModuleDisabled(error)) {
      expensesAvailable = false
      return []
    }
    throw error
  }) ?? Promise.resolve([])
  const [resources, entries, running, expenses, timeEntryOptions] = await Promise.all([
    loadCatalogResources(api, signal),
    api.listTimeEntries(userId === undefined ? range : { ...range, user_id: userId }, signal),
    api.listTimeEntries({ is_running: true }, signal),
    expenseRequest,
    userId === undefined
      ? api.listTimeEntryOptions(signal)
      : api.listTimeEntryOptions(signal, userId),
  ])
  const displayedEntries = displayEntries(entries, resources)
  const displayedRunning = displayEntries(running, resources)
  if (displayedRunning.length > 1)
    throw new Error('more than one timer is running')
  return {
    entries: displayedEntries,
    expenses,
    expensesAvailable,
    running: displayedRunning[0] ?? null,
    timeEntrySettings,
    catalog: { ...resources, timeEntryOptions },
  }
}

export const prepareQuickAdd = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<{ input: TimeEntryInput; minimumNoteLength: number }> => {
  const command = parseQuickAdd(value)
  const selection = await resolveAvailableEntrySelection(
    api,
    command.project,
    command.task,
    signal,
  )
  return {
    input: {
      project_id: selection.project.id,
      task_id: selection.task.id,
      spent_date: localDate(now),
      seconds: command.seconds,
      ...(command.notes === undefined ? {} : { notes: command.notes }),
    },
    minimumNoteLength: selection.minimumNoteLength,
  }
}

export const quickAddInput = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<TimeEntryInput> => {
  const draft = await prepareQuickAdd(api, value, now, signal)
  assertNoteIsAllowed(draft.input.notes, draft.minimumNoteLength)
  return draft.input
}

export const quickAdd = async (
  api: ShellApi,
  value: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<TimeEntry> => {
  const input = await quickAddInput(api, value, now, signal)
  return signal === undefined ? api.createTimeEntry(input) : api.createTimeEntry(input, signal)
}

export const startTimer = async (
  api: ShellApi,
  projectValue: string,
  taskValue: string,
  signal?: AbortSignal,
  notes?: string,
): Promise<TimeEntry> => {
  const selection = await resolveAvailableEntrySelection(
    api,
    projectValue,
    taskValue,
    signal,
  )
  assertNoteIsAllowed(notes, selection.minimumNoteLength)
  const input: TimeEntryInput = {
    project_id: selection.project.id,
    task_id: selection.task.id,
    ...(notes === undefined || notes.trim() === '' ? {} : { notes }),
  }
  return signal === undefined
    ? api.createTimeEntry(input)
    : api.createTimeEntry(input, signal)
}

const collectPlanned = async <Row>(
  load: (cursor?: string) => Promise<CursorPage<Row>>,
  signal?: AbortSignal,
): Promise<Row[]> => {
  const rows: Row[] = []
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await load(cursor)
    rows.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return rows
}

const withSignal = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal }

/**
 * An hours-report level as the client page reads it. The contract types a
 * level as "detailed", "summary" or any boolean, which is wider than what the
 * route sends: false is the only boolean, and it means no hours report.
 */
const journalLevel = (value: 'detailed' | 'summary' | boolean): 'detailed' | 'summary' | false =>
  value === 'detailed' || value === 'summary' ? value : false

const clientInvoiceSending = (
  data: Awaited<ReturnType<EzactoClient['getClientInvoiceSending']>>['data'],
): ClientInvoiceSending => ({
  ...data,
  // Null is the client following the organization, and stays null.
  attach_journal: data.attach_journal === null ? null : journalLevel(data.attach_journal),
  organization: {
    ...data.organization,
    attach_journal: journalLevel(data.organization.attach_journal),
  },
})

export const createShellApi = (client: EzactoClient): ShellApi => ({
  getPaymentRunReport: async (from,to,signal) => (await client.getPaymentRunReport({query:{from,to},...withSignal(signal)})).data,
  previewPaymentRun: async (body,signal) => (await client.previewPaymentRun({body,...withSignal(signal)})).data,
  approvePaymentRun: async (id,body,signal) => (await client.approvePaymentRun({id,body,...withSignal(signal)})).data,
  cancelPaymentRun: async (id,signal) => (await client.cancelPaymentRun({id,...withSignal(signal)})).data,
  reconcilePaymentRunItem: async (id,itemId,signal) => (await client.reconcilePaymentRunItem({id,itemId,...withSignal(signal)})).data,
  configureStaffPaymentProvider: (body, signal) =>
    client.configureStaffPaymentProvider({ body, ...withSignal(signal) }),
  acceptContractorReview: async (body, signal) => (await client.acceptContractorReview({ body, ...withSignal(signal) })).data,
  getContractorAcceptances: async (month, signal) => (await client.getContractorAcceptances({ query: { month }, ...withSignal(signal) })).data,
  getContractorReview: async (month, signal) => (await client.getContractorReview({ query: { month }, ...withSignal(signal) })).data,
  getPaymentActuals: async (month, signal) => (await client.getPaymentActuals({ query: { month }, ...withSignal(signal) })).data,
  confirmPaymentActuals: (body, signal) => client.confirmPaymentActuals({ body, ...withSignal(signal) }),
  getStaffInvoiceReport: async (month, signal) => (await client.getStaffInvoiceReport({ query: { month }, ...withSignal(signal) })).data,
  saveStaffInvoice: async (command, signal) => (await client.saveStaffInvoice({ body: command, ...withSignal(signal) })).data,
  uploadStaffInvoiceDocument: async (invoiceId, month, id, file, signal) => {
    const body = new FormData(); body.set('file', file);
    return (await client.uploadStaffInvoiceDocument({ invoiceId, 'Idempotency-Key': id, query: { month }, body, ...withSignal(signal) })).data;
  },
  getMyStaffInvoices: (month, signal) => client.getMyStaffInvoices({ query: { month }, ...withSignal(signal) }),
  getAdvanceCreditReport: async (from, to, signal) => (await client.getAdvanceCreditReport({ query: { from, to }, ...withSignal(signal) })).data,
  applyAdvanceCredit: async (command, signal) => { await client.applyAdvanceCredit({ body: command, ...withSignal(signal) }) },
  reverseAdvanceCredit: async (command, signal) => { await client.reverseAdvanceCredit({ body: command, ...withSignal(signal) }) },
  returnAdvanceCredit: async (command, signal) => { await client.returnAdvanceCredit({ body: command, ...withSignal(signal) }) },
  getPaymentAllocationReport: async (month, signal) => (await client.getPaymentAllocationReport({ query: { month }, ...withSignal(signal) })).data,
  previewPaymentAllocation: async (body, signal) => (await client.previewPaymentAllocation({ body, ...withSignal(signal) })).data,
  allocatePayment: (body, signal) => client.allocatePayment({ body, ...withSignal(signal) }),
  reversePaymentAllocation: (body, signal) => client.reversePaymentAllocation({ body, ...withSignal(signal) }),
  getStaffPaymentReport: async (month, signal) =>
    (await client.getStaffPaymentReport({ query: { month }, ...withSignal(signal) })).data,
  recordStaffPaymentEvent: (body, signal) =>
    client.recordStaffPaymentEvent({ body, ...withSignal(signal) }),
  whoami: async (signal) => {
    return (await client.getWhoami(withSignal(signal))).data
  },
  signIn: async (credentials, signal) => {
    return (await client.signIn({ body: credentials, ...withSignal(signal) })).data
  },
  completeTwoFactorChallenge: async (input, signal) => {
    await client.completeTwoFactorChallenge({
      body: {
        code: input.code,
        ...(input.challenge === undefined ? {} : { challenge: input.challenge }),
      },
      ...withSignal(signal),
    })
  },
  requestPasswordReset: async (email, signal) => {
    await client.requestPasswordReset({ body: { email }, ...withSignal(signal) })
  },
  resetPassword: async (input, signal) => {
    await client.resetPassword({ body: input, ...withSignal(signal) })
  },
  logoutCurrentSession: async (signal) => {
    const current = (await client.listSessions(withSignal(signal))).data.find(
      (session) => session.current,
    )
    if (current === undefined) {
      throw new Error('The current session could not be found.')
    }
    return (
      await client.revokeSession({
        sessionId: current.id,
        ...withSignal(signal),
      })
    ).data
  },
  getFirstRunStatus: async (userId, signal, includeCompletedSetup = false) => {
    const owner = (await client.getTeamPerson({ id: userId, ...withSignal(signal) })).data
    if (!owner.is_owner) return null
    const entries = await client.listTimeEntries({
      query: { user_id: userId, per_page: 1 },
      ...withSignal(signal),
    })
    if (entries.data.length > 0 && !includeCompletedSetup)
      return {
        hasTimeEntry: true,
        hasClient: false,
        hasProject: false,
        hasTask: false,
        hasProjectTask: false,
        hasOwnAssignment: false,
        projectId: null,
      }
    const [clients, projects, tasks, options] = await Promise.all([
      client.listClients({ query: { is_active: true, per_page: 1 }, ...withSignal(signal) }),
      client.listProjects({ query: { is_active: true, per_page: 1 }, ...withSignal(signal) }),
      collect(
        (cursor) =>
          client.listTasks({
            query: { is_active: true, per_page: 200, ...(cursor ? { cursor } : {}) },
            ...withSignal(signal),
          }),
        signal,
      ),
      client.listTimeEntryOptions(withSignal(signal)),
    ])
    // Prefer an already usable project. Otherwise guide the owner through the
    // first active project, keeping the task and person checks on that project.
    const projectId = options.data[0]?.project_id ?? projects.data[0]?.id ?? null
    const [taskAssignments, ownAssignments] =
      projectId === null
        ? [[], null]
        : await Promise.all([
            collect(
              (cursor) =>
                client.listTaskAssignments({
                  query: {
                    project_id: projectId,
                    is_active: true,
                    per_page: 200,
                    ...(cursor ? { cursor } : {}),
                  },
                  ...withSignal(signal),
                }),
              signal,
            ),
            client.listUserAssignments({
              query: { project_id: projectId, user_id: userId, is_active: true, per_page: 1 },
              ...withSignal(signal),
            }),
          ])
    return {
      hasTimeEntry: entries.data.length > 0,
      hasClient: clients.data.length > 0,
      hasProject: projects.data.length > 0,
      hasTask: tasks.length > 0,
      hasProjectTask: taskAssignments.some((assignment) =>
        tasks.some((task) => task.id === assignment['task_id']),
      ),
      hasOwnAssignment: (ownAssignments?.data.length ?? 0) > 0,
      projectId,
    }
  },
  listProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  /**
   * One `q` per resource rather than everything held in memory: the palette is
   * open on every screen, and a build that loaded every client, project and
   * task to filter three of them would pay for the whole directory on each
   * keystroke. `per_page` is small because nobody reads past the first few.
   */
  searchEntities: async (query, signal) => {
    const limit = 5
    const [clients, projects, tasks] = await Promise.all([
      client.listClients({
        query: { per_page: limit, q: query },
        ...withSignal(signal),
      }),
      client.listProjects({
        query: { per_page: limit, q: query },
        ...withSignal(signal),
      }),
      client.listTasks({
        query: { per_page: limit, q: query },
        ...withSignal(signal),
      }),
    ])
    return [
      ...clients.data.map((record) => ({
        kind: 'client' as const,
        label: String(record.name ?? `Client ${record.id}`),
        href: `/clients/${record.id}`,
      })),
      ...projects.data.map((record) => ({
        kind: 'project' as const,
        label: String(record.name ?? `Project ${record.id}`),
        href: `/projects/${record.id}`,
      })),
      ...tasks.data.map((record) => ({
        kind: 'task' as const,
        label: String(record.name ?? `Task ${record.id}`),
        href: `/tasks`,
      })),
    ]
  },
  listDirectoryClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getClientRateCard: async (id, signal) => (await client.getClientRateCard({id, ...withSignal(signal)})).data,
  createClientRateCard: async (id, name, signal) => (await client.createClientRateCard({id, body: {name}, ...withSignal(signal)})).data,
  createClientRateCardVersion: async (id, input, signal) => (await client.createClientRateCardVersion({id, body: input, ...withSignal(signal)})).data,
  getClientEffectiveRateCard: async (id, taskId, date, signal) => (await client.getClientEffectiveRateCard({id, query: {task_id: taskId, spent_date: date}, ...withSignal(signal)})).data,
  listRateCardTasks: (cursor, signal) => client.listTasks({query: {per_page: 200, is_active: true, ...(cursor === undefined ? {} : {cursor})}, ...withSignal(signal)}),
  getDirectoryClient: async (id, signal) =>
    (await client.getClient({ id, ...withSignal(signal) })).data,
  createDirectoryClient: async (input, signal) =>
    (await client.createClient({ body: input, ...withSignal(signal) })).data,
  updateDirectoryClient: async (id, input, signal) =>
    (await client.updateClient({ id, body: input, ...withSignal(signal) })).data,
  archiveDirectoryClient: async (id, signal) => {
    await client.deleteClient({ id, ...withSignal(signal) })
  },
  listClientContacts: (clientId, cursor, signal) =>
    client.listContacts({
      query: {
        client_id: clientId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createClientContact: async (input, signal) =>
    (await client.createContact({ body: input, ...withSignal(signal) })).data,
  updateClientContact: async (id, input, signal) =>
    (await client.updateContact({ id, body: input, ...withSignal(signal) })).data,
  deleteClientContact: async (id, signal) => {
    await client.deleteContact({ id, ...withSignal(signal) })
  },
  listClientProjects: (clientId, cursor, signal) =>
    client.listProjects({
      query: {
        client_id: clientId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listClientSubtree: async (clientId, signal) =>
    (await client.listClientDescendants({ id: clientId, ...withSignal(signal) })).data,
  // One request for the whole subtree, not one per node: `client_id` is a
  // comma-separated set on both of these for exactly this caller.
  listClientOpenInvoices: (clientIds, cursor, signal) =>
    client.listInvoices({
      query: {
        client_id: clientIds.join(','),
        state: 'open',
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listClientRetainers: (clientIds, cursor, signal) =>
    client.listRetainers({
      query: {
        client_id: clientIds.join(','),
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listProjectBudgetSummaries: async (range, signal) =>
    (
      await client.listProjectBudgetSummaries({
        query: { from: range.from, to: range.to },
        ...withSignal(signal),
      })
    ).data,
  listDirectoryProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listTeamPeople: (filter, cursor, signal) =>
    client.listTeamPeople({
      query: {
        ...filter,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getTimeEntryNoteSettings: async (signal) =>
    (await client.getTimeEntryNoteSettings(withSignal(signal))).data,
  updateTimeEntryNoteSettings: async (patch, signal) =>
    (await client.updateTimeEntryNoteSettings({ body: patch, ...withSignal(signal) })).data,
  updateTimeEntryRoundingSettings: async (patch, signal) =>
    (await client.updateTimeEntryRoundingSettings({ body: patch, ...withSignal(signal) })).data,
  previewTimeRoundingRecalculation: async (scope, signal) =>
    (await client.previewTimeRoundingRecalculation({ query: scope, ...withSignal(signal) })).data,
  applyTimeRoundingRecalculation: async (request, signal) =>
    (await client.applyTimeRoundingRecalculation({ body: request, ...withSignal(signal) })).data,
  getInvoiceReminders: async (signal) =>
    (await client.getOrganizationInvoiceReminders(withSignal(signal))).data.reminder_policy,
  updateInvoiceReminders: async (policy, signal) => {
    const saved = (
      await client.setOrganizationInvoiceReminders({
        body: { reminder_policy: policy },
        ...withSignal(signal),
      })
    ).data
    return { policy: saved.reminder_policy, applied: saved.applied_to_open_invoices ?? 0 }
  },
  getProfileNotifications: async (signal) =>
    (await client.getProfileNotifications(withSignal(signal))).data,
  updateProfileNotifications: async (input, signal) =>
    (await client.updateProfileNotifications({ body: input, ...withSignal(signal) })).data,
  getNotificationSettings: async (signal) =>
    (await client.getNotificationSettings(withSignal(signal))).data,
  updateNotificationSettings: async (patch, signal) =>
    (await client.setNotificationSettings({ body: patch, ...withSignal(signal) })).data,
  getTimesheetAutoApproval: async (signal) =>
    (await client.getTimesheetAutoApproval(withSignal(signal))).data,
  updateTimesheetAutoApproval: async (patch, signal) =>
    (await client.setTimesheetAutoApproval({ body: patch, ...withSignal(signal) })).data,
  webhooks: client,
  listEmailSuppressions: (cursor, signal) => client.listEmailSuppressions({query:{per_page:50,...(cursor===undefined?{}:{cursor})},...withSignal(signal)}),
  liftEmailSuppression: async (id, input, signal) => (await client.liftEmailSuppression({id,body:input,...withSignal(signal)})).data,
  getEmailHealth: async (signal) =>
    (await client.getEmailHealth(withSignal(signal))).data,
  checkOffsiteBackupDestination: async (signal) => (await client.checkOffsiteBackupDestination(withSignal(signal))).data,
  getBackupStatus: async (signal) =>
    (await client.getBackupStatus(withSignal(signal))).data,
  createBackupDownloadLink: async (input, signal) =>
    (await client.createBackupDownloadLink({ body: input, ...withSignal(signal) })).data,
  listBackupRuns: (query, signal) => client.listBackupRuns({ query, ...withSignal(signal) }),
  // Issue 593 shipped the Accounting settings section reading these four and
  // nothing supplying them, so the screen reported "not configured" on every
  // deployment and the connect button never appeared. The suite did not catch
  // it because the settings tests inject their own API; this adapter is the
  // only place the real client is bound to that screen.
  getQuickBooksConnection: async (signal) =>
    (await client.getQuickBooksConnection(withSignal(signal))).data,
  startQuickBooksAuthorization: async (signal) =>
    (await client.startQuickBooksAuthorization(withSignal(signal))).data,
  updateQuickBooksSettings: async (allowOnlinePayment, signal) =>
    (
      await client.updateQuickBooksSettings({
        body: { allow_online_payment: allowOnlinePayment },
        ...withSignal(signal),
      })
    ).data,
  disconnectQuickBooks: (signal) => client.disconnectQuickBooks(withSignal(signal)),
  getQuickBooksReconciliation: async (signal) =>
    (await client.getQuickBooksReconciliation(withSignal(signal))).data,
  // Bound here because this is the only place the real client reaches the
  // client screen. Issue 593 shipped a settings section reading four methods
  // nothing supplied, and the suite stayed green because the tests inject
  // their own API -- so a method added to an interface without a line here is
  // a control that silently does nothing.
  getBillStatus: async (signal) => (await client.getBillStatus(withSignal(signal))).data,
  getBillClientDelivery: async (clientId, signal) =>
    (await client.getBillClientDelivery({ id: clientId, ...withSignal(signal) })).data,
  setBillClientDelivery: async (clientId, deliverViaBill, signal) =>
    (
      await client.setBillClientDelivery({
        id: clientId,
        body: { deliver_via_bill: deliverViaBill },
        ...withSignal(signal),
      })
    ).data,
  // The write is the Send dialog's `setClientInvoiceSending`, bound with the
  // invoice operations; the client page shares it and reads back with this.
  getClientInvoiceSending: async (clientId, signal) =>
    clientInvoiceSending(
      (await client.getClientInvoiceSending({ id: clientId, ...withSignal(signal) })).data,
    ),
  getInstanceTheme: async (signal) =>
    (await client.getInstanceTheme(withSignal(signal))).data,
  setInstanceTheme: async (palette, signal) =>
    (await client.setInstanceTheme({ body: { palette }, ...withSignal(signal) })).data,
  clearInstanceTheme: (signal) => client.clearInstanceTheme(withSignal(signal)),
  listSenderIdentities: async (signal) =>
    (await client.listSenderIdentities(withSignal(signal))).data,
  listSsoDomains: async (signal) =>
    (await client.listSsoProvisioningDomains(withSignal(signal))).data,
  addSsoDomain: async (domain, signal) =>
    (await client.addSsoProvisioningDomain({ body: { domain }, ...withSignal(signal) })).data,
  verifySsoDomain: async (id, signal) =>
    (await client.verifySsoProvisioningDomain({ id, ...withSignal(signal) })).data,
  removeSsoDomain: (id, signal) =>
    client.removeSsoProvisioningDomain({ id, ...withSignal(signal) }),
  getTeamStatus: async (signal) =>
    (await client.getTeamStatus(withSignal(signal))).data,
  getTeamWeekStartDay: async (signal) =>
    (await client.getTimeEntrySettings(withSignal(signal))).data.week_start_day,
  getTeamPerson: async (id, signal) =>
    (await client.getTeamPerson({ id, ...withSignal(signal) })).data,
  getTeamCatalog: async (signal) =>
    (await client.getTeamCatalog(withSignal(signal))).data,
  getTwoFactorStatus: async (signal) => (await client.getTwoFactorStatus(withSignal(signal))).data,
  beginTwoFactorEnrolment: async (signal) =>
    (await client.beginTwoFactorEnrolment(withSignal(signal))).data,
  confirmTwoFactorEnrolment: async (code, signal) =>
    (await client.confirmTwoFactorEnrolment({ body: { code }, ...withSignal(signal) })).data,
  disableTwoFactor: async (code, signal) =>
    (await client.disableTwoFactor({ body: { code }, ...withSignal(signal) })).data,
  enableTwoFactorEmail: async (signal) =>
    (await client.enableTwoFactorEmail(withSignal(signal))).data,
  disableTwoFactorEmail: async (signal) =>
    (await client.disableTwoFactorEmail(withSignal(signal))).data,
  sendTwoFactorEmailCode: async (input, signal) =>
    (
      await client.sendTwoFactorEmailCode({
        body: input.challenge === undefined ? {} : { challenge: input.challenge },
        ...withSignal(signal),
      })
    ).data,
  listApiTokens: async (signal) => (await client.listApiTokens(withSignal(signal))).data,
  createApiToken: async (input, signal) =>
    (await client.createApiToken({ body: input, ...withSignal(signal) })).data,
  revokeApiToken: async (tokenId, signal) => {
    await client.revokeApiToken({ tokenId, ...withSignal(signal) })
  },
  getWiseConnection: async (signal) => {
    const { data } = await client.getWiseConnection(withSignal(signal))
    return {
      configured: data.configured,
      connection:
        data.connection === null
          ? null
          : {
              profileId: data.connection.profile_id,
              profileName: data.connection.profile_name,
              payableRecipients: data.connection.payable_recipients,
              webhooksVerifiable: data.connection.webhooks_verifiable,
            },
    }
  },
  getWisePayoutDestination: async (userId, signal) => {
    const { data } = await client.getWisePayoutDestination({ userId, ...withSignal(signal) })
    return {
      configured: data.configured,
      destination:
        data.destination === null
          ? null
          : {
              kind: data.destination.kind,
              linkedAt: data.destination.linked_at,
              verifiedAt: data.destination.verified_at,
            },
    }
  },
  shareWiseProfile: async (input, signal) => ({
    name: (
      await client.shareWiseProfile({
        body: { user_id: input.userId, identifier: input.identifier, currency: input.currency },
        ...withSignal(signal),
      })
    ).data.contact.name,
  }),
  removeWisePayoutDestination: async (userId, signal) => {
    await client.removeWisePayoutDestination({ userId, ...withSignal(signal) })
  },
  listPayoutProviders: async (args) => {
    return client.listPayoutProviders({ ...withSignal(args?.signal) })
  },
  listPayoutAccounts: async ({ id, signal }) => {
    return client.listPayoutAccounts({ id, ...withSignal(signal) })
  },
  linkPayoutAccount: async ({ id, body, signal }) => {
    await client.linkPayoutAccount({ id, body, ...withSignal(signal) })
  },
  detachPayoutAccount: async ({ id, signal }) => {
    await client.detachPayoutAccount({ id, ...withSignal(signal) })
  },
  setPayoutProviderEnabled: async ({ provider, body, signal }) => {
    await client.setPayoutProviderEnabled({ provider, body, ...withSignal(signal) })
  },
  getPayoutPreference: async ({ id, signal }) => client.getPayoutPreference({ id, ...withSignal(signal) }),
  setPayoutPreference: async ({ id, provider, expectedVersion, signal }) => {
    await client.setPayoutPreference({
      id,
      body: { provider, expected_version: expectedVersion },
      ...withSignal(signal),
    })
  },
  listPayoutPreferences: async (args) => client.listPayoutPreferences({ ...withSignal(args?.signal) }),
  getUserEmailFactor: async (userId, signal) =>
    (await client.getUserTwoFactorEmail({ id: userId, ...withSignal(signal) })).data
      .email_enabled,
  disableUserEmailFactor: async (userId, signal) => {
    await client.disableUserTwoFactorEmail({ id: userId, ...withSignal(signal) })
  },
  createTeamPerson: async (input, signal) =>
    (await client.createUser({ body: input, ...withSignal(signal) })).data,
  updateTeamPerson: async (id, commandId, body, signal) =>
    (
      await client.updateTeamPerson({
        id,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  replaceTeamPersonProjectAssignments: async (id, commandId, body, signal) =>
    (
      await client.replaceTeamPersonProjectAssignments({
        id,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  updateTeamPersonNotifications: async (id, commandId, body, signal) =>
    (
      await client.updateTeamPersonNotifications({
        id,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  appendTeamPersonRate: async (id, commandId, body, signal) =>
    (
      await client.appendTeamPersonRate({
        id,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  removeTeamPersonRate: async (id, rateId, commandId, body, signal) =>
    (
      await client.removeTeamPersonRate({
        id,
        rateId,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  listProjectClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listReportClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listReportProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getMyHoursReport: async (filter, signal) =>
    (
      await client.getMyHoursReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getDetailedTimeReport: async (filter, signal) =>
    (
      await client.getDetailedTimeReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getTimeReport: async (filter, signal) =>
    (
      await client.getTimeReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getInvoicedReport: async (filter, signal) =>
    (
      await client.getInvoicedReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getPaymentsReceivedReport: async (filter, signal) =>
    (
      await client.getPaymentsReceivedReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getReceivablesReport: async (filter, signal) =>
    (
      await client.getReceivablesReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getUninvoicedReport: async (filter, signal) =>
    (
      await client.getUninvoicedReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getContractorCostReport: async (filter, signal) =>
    (
      await client.getContractorCostReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getProfitabilityReport: async (filter, signal) =>
    (
      await client.getProfitabilityReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getDetailedExpenseReport: async (filter, signal) =>
    (
      await client.getDetailedExpenseReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getReportDefinitionRegistry: async (signal) =>
    (await client.getReportDefinitionRegistry(withSignal(signal))).data,
  listSavedReports: async (filter, signal) =>
    (await client.listSavedReports({ query: filter, ...withSignal(signal) })).data,
  createSavedReport: async (input, signal) =>
    (await client.createSavedReport({ body: input, ...withSignal(signal) })).data,
  createReportView: async (input, signal) =>
    (await client.createReportView({ body: input, ...withSignal(signal) })).data,
  getSavedReport: async (reportId, signal) =>
    (await client.getSavedReport({ reportId, ...withSignal(signal) })).data,
  previewReportDefinition: async (input, signal) =>
    (await client.previewReportDefinition({ body: input, ...withSignal(signal) })).data,
  runSavedReport: async (reportId, signal) =>
    (await client.runSavedReport({ reportId, ...withSignal(signal) })).data,
  pinSavedReport: async (reportId, signal) => {
    await client.pinSavedReport({ reportId, ...withSignal(signal) })
  },
  unpinSavedReport: async (reportId, signal) => {
    await client.unpinSavedReport({ reportId, ...withSignal(signal) })
  },
  duplicateSavedReport: async (reportId, signal) =>
    (await client.duplicateSavedReport({ reportId, ...withSignal(signal) })).data,
  updateSavedReport: async (reportId, input, signal) =>
    (await client.updateSavedReport({ reportId, body: input, ...withSignal(signal) })).data,
  deleteSavedReport: async (reportId, signal) => {
    await client.deleteSavedReport({ reportId, ...withSignal(signal) })
  },
  shareSavedReport: async (reportId, userId, signal) => {
    await client.shareSavedReport({ reportId, userId, ...withSignal(signal) })
  },
  unshareSavedReport: async (reportId, userId, signal) => {
    await client.unshareSavedReport({ reportId, userId, ...withSignal(signal) })
  },
  shareSavedReportWithRole: async (reportId, profile, signal) => {
    await client.shareSavedReportWithRole({ reportId, profile, ...withSignal(signal) })
  },
  unshareSavedReportWithRole: async (reportId, profile, signal) => {
    await client.unshareSavedReportWithRole({ reportId, profile, ...withSignal(signal) })
  },
  executeDetailedTimeAction: async (input, signal) =>
    (await client.executeDetailedTimeAction({ body: input, ...withSignal(signal) })).data,
  getClientRollupReport: async (clientId, filter, signal) =>
    (
      await client.getClientRollupReport({
        clientId,
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getProjectBudgetReport: async (projectId, filter, signal) =>
    (
      await client.getProjectBudgetReport({
        projectId,
        query: filter,
        ...withSignal(signal),
      })
    ).data,
  getDirectoryProject: async (id, signal) =>
    (await client.getProject({ id, ...withSignal(signal) })).data,
  createDirectoryProject: async (input, signal) =>
    (await client.createProject({ body: input, ...withSignal(signal) })).data,
  updateDirectoryProject: async (id, input, signal) =>
    (await client.updateProject({ id, body: input, ...withSignal(signal) })).data,
  archiveDirectoryProject: async (id, signal) => {
    await client.deleteProject({ id, ...withSignal(signal) })
  },
  listDirectoryTasks: (cursor, signal) =>
    client.listTasks({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listAdminTasks: (filter, cursor, signal) =>
    client.listTasks({
      query: {
        per_page: 50,
        // Tasks arrive a page at a time, so the archived view has to be asked
        // for rather than filtered out of what is on hand the way the client
        // and project directories do it -- they page themselves to exhaustion,
        // this one stops at fifty. "All" sends nothing, which asks for both.
        ...(filter === 'all' ? {} : { is_active: filter === 'active' }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createAdminTask: async (input, signal) =>
    (await client.createTask({ body: input, ...withSignal(signal) })).data,
  updateAdminTask: async (id, input, signal) =>
    (await client.updateTask({ id, body: input, ...withSignal(signal) })).data,
  archiveAdminTask: async (id, signal) => {
    await client.deleteTask({ id, ...withSignal(signal) })
  },
  listProjectTaskAssignments: (projectId, cursor, signal) =>
    client.listTaskAssignments({
      query: {
        project_id: projectId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createProjectTaskAssignment: async (input, signal) =>
    (await client.createTaskAssignment({ body: input, ...withSignal(signal) })).data,
  updateProjectTaskAssignment: async (id, input, signal) =>
    (await client.updateTaskAssignment({ id, body: input, ...withSignal(signal) })).data,
  archiveProjectTaskAssignment: async (id, signal) => {
    await client.deleteTaskAssignment({ id, ...withSignal(signal) })
  },
  listRoles: (cursor, signal) =>
    client.listRoles({
      query: { per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
      ...withSignal(signal),
    }),
  // Who holds what, so a delete can say how many people it detaches.
  listRoleHolders: (signal) =>
    client.listUsers({ query: { per_page: 200 }, ...withSignal(signal) }),
  createRole: async (input, signal) =>
    (await client.createRole({ body: input, ...withSignal(signal) })).data,
  updateRole: async (id, input, signal) =>
    (await client.updateRole({ id, body: input, ...withSignal(signal) })).data,
  deleteRole: async (id, signal) => {
    await client.deleteRole({ id, ...withSignal(signal) })
  },
  listDirectoryUsers: (cursor, signal) =>
    client.listUsers({
      query: { per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
      ...withSignal(signal),
    }),
  listProjectUserAssignments: (projectId, cursor, signal) =>
    client.listUserAssignments({
      query: {
        project_id: projectId,
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createProjectUserAssignment: async (input, signal) =>
    (await client.createUserAssignment({ body: input, ...withSignal(signal) })).data,
  updateProjectUserAssignment: async (id, input, signal) =>
    (await client.updateUserAssignment({ id, body: input, ...withSignal(signal) })).data,
  archiveProjectUserAssignment: async (id, signal) => {
    await client.deleteUserAssignment({ id, ...withSignal(signal) })
  },
  getActivityLogEnabled: async (signal) =>
    (await client.getActivityLogStatus(withSignal(signal))).data.enabled,
  getActivityLog: async (range, signal) =>
    (
      await client.listActivityLog({
        query: { from: range.from, to: range.to, per_page: 200 },
        ...withSignal(signal),
      })
    ).data,
  listDirectoryProjectAttachments: async (projectId, signal) =>
    (await client.listProjectAttachments({ projectId, ...withSignal(signal) })).data,
  uploadDirectoryProjectAttachment: async (projectId, commandId, body, signal) =>
    (
      await client.createProjectAttachment({
        projectId,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  listWorkflowExpenses: (filters, cursor, signal) =>
    client.listExpenses({
      query: {
        ...filters,
        per_page: 100,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getExpenseWeekStartDay: async (signal) =>
    (await client.getTimeEntrySettings(withSignal(signal))).data.week_start_day,
  getWorkflowExpense: async (id, signal) =>
    (await client.getExpense({ id, ...withSignal(signal) })).data,
  createWorkflowExpense: async (input, signal) =>
    (await client.createExpense({ body: input, ...withSignal(signal) })).data,
  updateWorkflowExpense: async (id, input, signal) =>
    (await client.updateExpense({ id, body: input, ...withSignal(signal) })).data,
  listExpenseCategories: (cursor, signal) =>
    client.listExpenseCategories({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listExpenseProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listExpenseClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listWorkflowExpenseAttachments: async (expenseId, signal) =>
    (await client.listExpenseAttachments({ expenseId, ...withSignal(signal) })).data,
  uploadWorkflowExpenseAttachment: async (expenseId, commandId, body, signal) =>
    (
      await client.createExpenseAttachment({
        expenseId,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  listDirectoryExpenseCategories: (activeOnly, cursor, signal) =>
    client.listExpenseCategories({
      query: {
        per_page: 50,
        ...(activeOnly ? { is_active: true } : {}),
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createDirectoryExpenseCategory: async (input, signal) =>
    (await client.createExpenseCategory({ body: input, ...withSignal(signal) })).data,
  updateDirectoryExpenseCategory: async (id, body, signal) =>
    (await client.updateExpenseCategory({ id, body, ...withSignal(signal) })).data,
  archiveDirectoryExpenseCategory: async (id, signal) =>
    (
      await client.updateExpenseCategory({
        id,
        body: { is_active: false },
        ...withSignal(signal),
      })
    ).data,
  getCapacity: (range, signal) =>
    client.getCapacity({ query: range, ...withSignal(signal) }),
  planning: {
    listProjects: async (signal) =>
      (
        await collect(
          (cursor) =>
            client.listProjects({
              query: {
                per_page: 200,
                is_active: true,
                ...(cursor === undefined ? {} : { cursor }),
              },
              ...withSignal(signal),
            }),
          signal,
        )
      ).map((project) => ({
        id: project.id,
        name: typeof project.name === 'string' ? project.name : `Project ${project.id}`,
      })),
    listAllocations: (range, signal) =>
      collectPlanned(
        (cursor) =>
          client.listAllocations({
            query: { ...range, per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
            ...withSignal(signal),
          }),
        signal,
      ),
    createAllocation: (input, signal) =>
      client.createAllocation({ body: input, ...withSignal(signal) }),
    updateAllocation: (id, patch, signal) =>
      client.updateAllocation({ id, body: patch, ...withSignal(signal) }),
    deleteAllocation: (id, signal) => client.deleteAllocation({ id, ...withSignal(signal) }),
    listTimeOff: (range, signal) =>
      collectPlanned(
        (cursor) =>
          client.listTimeOff({
            query: { ...range, per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
            ...withSignal(signal),
          }),
        signal,
      ),
    createTimeOff: (input, signal) => client.createTimeOff({ body: input, ...withSignal(signal) }),
    updateTimeOff: (id, patch, signal) =>
      client.updateTimeOff({ id, body: patch, ...withSignal(signal) }),
    deleteTimeOff: (id, signal) => client.deleteTimeOff({ id, ...withSignal(signal) }),
  },
  scheduledRuns: {
    consumeReviewLink: async (id,token,signal) => {await client.consumeScheduledReviewLink({id,body:{token},...withSignal(signal)})},
    read: (id, signal) => client.getScheduledRun({ id, ...withSignal(signal) }),
    confirm: (id, signal, acknowledgeReportWarnings) => client.confirmScheduledRun({ id, body: {acknowledge_report_warnings:acknowledgeReportWarnings===true}, ...withSignal(signal) }),
    retry: (id, signal) => client.retryScheduledRun({ id, ...withSignal(signal) }),
    cancel: (id, signal) => client.cancelScheduledRun({ id, ...withSignal(signal) }),
  },
  getMyPayments: (month, signal) =>
    client.getMyPayments({ query: { month }, ...withSignal(signal) }),
  listActivityLog: (query, signal) =>
    client.listActivityLog({ query: { per_page: 200, ...query }, ...withSignal(signal) }),
  listRollableActivityYears: async (signal) =>
    (await client.listRollableActivityYears({ ...withSignal(signal) })).data.rollable,
  rollActivityYear: async (year, signal) => {
    await client.rollActivityYear({ body: { year }, ...withSignal(signal) })
  },
  listEmailLog: (query, signal) => client.listEmailLog({ query, ...withSignal(signal) }),
  listOutboxDeliveries: (query, signal) =>
    client.listOutboxDeliveries({ query, ...withSignal(signal) }),
  retryOutboxDelivery: (subscriberId, eventId, signal) =>
    client.retryOutboxDelivery({ subscriberId, eventId, ...withSignal(signal) }),
  listInvoices: (cursor, signal, perPage, states, sort) =>
    client.listInvoices({
      query: {
        per_page: perPage ?? 50,
        ...(cursor === undefined ? {} : { cursor }),
        ...(sort === undefined ? {} : { sort }),
        // Empty means "every state", which is the absent parameter, not a
        // request for nothing.
        ...(states === undefined || states.length === 0
          ? {}
          : { state: states.join(',') }),
      },
      ...withSignal(signal),
    }),
  // `listSenderIdentities` is already supplied above, for the company-settings
  // email-health panel. One adapter, two screens.
  setDefaultSenderIdentity: async (id, expectedVersion, idempotencyKey, signal) =>
    (
      await client.setDefaultSenderIdentity({
        id,
        'Idempotency-Key': idempotencyKey,
        body: { expected_version: expectedVersion },
        ...withSignal(signal),
      })
    ).data,
  archiveSenderIdentity: async (id, expectedVersion, idempotencyKey, signal) =>
    (
      await client.archiveSenderIdentity({
        id,
        'Idempotency-Key': idempotencyKey,
        body: { expected_version: expectedVersion },
        ...withSignal(signal),
      })
    ).data,
  // The evidence carries its own version, separate from the identity's: a
  // refresh is a claim about what the provider last said, not about the row.
  refreshSenderIdentityEvidence: async (id, expectedEvidenceVersion, idempotencyKey, signal) =>
    (
      await client.refreshSenderIdentityEvidence({
        id,
        'Idempotency-Key': idempotencyKey,
        body: { expected_evidence_version: expectedEvidenceVersion },
        ...withSignal(signal),
      })
    ).data,
  listEmailTemplates: async (signal) =>
    (await client.listEmailTemplates(withSignal(signal))).data,
  listEmailTemplateVersions: async (kind, signal) =>
    (await client.listEmailTemplateVersions({ kind, ...withSignal(signal) })).data,
  listEmailTemplateVariables: async (signal) =>
    (await client.listEmailTemplateVariables(withSignal(signal))).data,
  createEmailTemplateVersion: async (kind, idempotencyKey, body, signal) =>
    (
      await client.createEmailTemplateVersion({
        kind,
        'Idempotency-Key': idempotencyKey,
        body,
        ...withSignal(signal),
      })
    ).data,
  listEstimates: (cursor, signal) =>
    client.listEstimates({
      query: { per_page: 50, ...(cursor === undefined ? {} : { cursor }) },
      ...withSignal(signal),
    }),
  listEstimateTemplates: (signal) => client.listEstimateTemplates({...withSignal(signal)}),
  createEstimateTemplate: async (body, signal) => (await client.createEstimateTemplate({body,...withSignal(signal)})).data,
  updateEstimateTemplate: async (id, body, signal) => (await client.updateEstimateTemplate({id,body,...withSignal(signal)})).data,
  createEstimateDraft: async (body, key, signal) => (await client.createEstimateDraft({body,'Idempotency-Key':key,...withSignal(signal)})).data,
  getEstimate: async (id, signal) =>
    (await client.getEstimate({ id, ...withSignal(signal) })).data,
  listEstimateMessages: async (id, signal) =>
    (await client.listEstimateMessages({ id, ...withSignal(signal) })).data,
  setEstimateExpiry: async (id, body, signal) =>
    (await client.setEstimateExpiry({ id, body, ...withSignal(signal) })).data,
  convertEstimate: async (id, body, idempotencyKey, signal) =>
    (
      await client.convertEstimate({
        id,
        body,
        'Idempotency-Key': idempotencyKey,
        ...withSignal(signal),
      })
    ).data,
  // The client directory the estimates pane names rows from. Unfiltered, for
  // the reason the recurring pane gives: an estimate outlives the archiving of
  // the client it quoted.
  listEstimateClients: (cursor, signal) =>
    client.listClients({
      query: { per_page: 100, ...(cursor === undefined ? {} : { cursor }) },
      ...withSignal(signal),
    }),
  listRecurringInvoices: (cursor, signal) =>
    client.listRecurringInvoices({
      query: {
        per_page: 50,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getRecurringInvoice: async (id, signal) =>
    (await client.getRecurringInvoice({ id, ...withSignal(signal) })).data,
  getBandedMonthReport: async (from, to, signal) =>
    (await client.getBandedMonthReport({ query: { from, to }, ...withSignal(signal) })).data,
  generateRecurringInvoice: async (id, idempotencyKey, signal) =>
    (
      await client.generateRecurringInvoice({
        id,
        'Idempotency-Key': idempotencyKey,
        ...withSignal(signal),
      })
    ).data,
  createRecurringInvoice: async (body, idempotencyKey, signal) =>
    (
      await client.createRecurringInvoice({
        'Idempotency-Key': idempotencyKey,
        body,
        ...withSignal(signal),
      })
    ).data,
  updateRecurringInvoice: async (id, body, signal) =>
    (await client.updateRecurringInvoice({ id, body, ...withSignal(signal) })).data,
  deleteRecurringInvoice: (id, signal) =>
    client.deleteRecurringInvoice({ id, ...withSignal(signal) }),
  listRecurringInvoiceAttachments: async (definitionId, signal) =>
    (
      await client.listRecurringInvoiceAttachments({
        recurringInvoiceId: definitionId,
        ...withSignal(signal),
      })
    ).data,
  uploadRecurringInvoiceAttachment: async (definitionId, commandId, body, signal) =>
    (
      await client.createRecurringInvoiceAttachment({
        recurringInvoiceId: definitionId,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  setRecurringInvoiceAttachmentThrough: async (definitionId, attachmentId, through, signal) =>
    (
      await client.setRecurringInvoiceAttachmentThrough({
        recurringInvoiceId: definitionId,
        attachmentId,
        body: { through },
        ...withSignal(signal),
      })
    ).data,
  removeRecurringInvoiceAttachment: (definitionId, attachmentId, signal) =>
    client.removeRecurringInvoiceAttachment({
      recurringInvoiceId: definitionId,
      attachmentId,
      ...withSignal(signal),
    }),
  // Unfiltered for the same reason the retainer lists below are: a recurring
  // definition outlives the archiving of the client it bills.
  listRecurringClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listRecurringProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listRetainers: (cursor, signal) =>
    client.listRetainers({
      query: {
        per_page: 50,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  getRetainerDetail: async (id, signal) =>
    (await client.getRetainer({ id, ...withSignal(signal) })).data,
  listRetainerLedger: async (id, signal) =>
    (await client.listRetainerLedger({ id, ...withSignal(signal) })).data,
  // Unfiltered, unlike `listClients`/`listProjects` above: a retainer survives
  // the archiving of the client or project it names, and a row that fell back
  // to "Client #14" because the filter dropped the client is a worse answer
  // than a slightly longer list.
  listRetainerClients: (cursor, signal) =>
    client.listClients({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listRetainerProjects: (cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  // No `state` filter, unlike the invoice list screens: a deposit or a drawdown
  // names an invoice already linked to the retainer, and that invoice is very
  // often already paid or closed. Filtering by state here would hide exactly
  // the rows the ledger's own guard is going to demand.
  listRetainerInvoices: (cursor, signal) =>
    client.listInvoices({
      query: {
        per_page: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  createRetainer: async (commandId, input, signal) =>
    (
      await client.createRetainer({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  // The one retainer write with no `Idempotency-Key` parameter to pass: the
  // contract gives PATCH /retainers/:id neither that nor an expected version.
  // The screen compensates by sending only changed fields; see the note on
  // `retainerPolicyPatch`.
  updateRetainer: async (id, input, signal) =>
    (await client.updateRetainer({ id, body: input, ...withSignal(signal) })).data,
  drawDownRetainer: async (id, commandId, input, signal) =>
    (
      await client.drawDownRetainer({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  appendRetainerLedger: async (id, commandId, input, signal) =>
    (
      await client.appendRetainerLedger({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  releaseInvoiceLineTime: async (id, body, signal) => (await client.releaseInvoiceLineTime({ id, body, ...withSignal(signal) })).data,
  getInvoiceHoursReconciliation: async (id, signal) => (await client.getInvoiceHoursReconciliation({ id, ...withSignal(signal) })).data,
  getInvoice: async (id, signal) =>
    (await client.getInvoice({ id, ...withSignal(signal) })).data,
  // Exact and unique, so the page holds that invoice or nothing.
  findInvoiceByNumber: async (number, signal) =>
    (await client.listInvoices({ query: { number }, ...withSignal(signal) })).data[0] ?? null,
  // Unfiltered by is_active: a line keeps the link it has to a project archived
  // since, and the select has to be able to show it.
  listInvoiceClientProjects: (clientId, cursor, signal) =>
    client.listProjects({
      query: {
        per_page: 200,
        client_id: clientId,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listInvoiceMessages: async (id, signal) =>
    (await client.listInvoiceMessages({ id, ...withSignal(signal) })).data,
  listInvoicePayments: async (id, signal) =>
    (await client.listInvoicePayments({ id, ...withSignal(signal) })).data,
  listInvoiceAttachments: async (id, signal) =>
    (await client.listInvoiceAttachments({ invoiceId: id, ...withSignal(signal) })).data,
  getInvoiceQuickBooks: async (id, signal) =>
    (await client.getInvoiceQuickBooks({ id, ...withSignal(signal) })).data,
  syncInvoiceQuickBooks: async (id, signal) =>
    (await client.syncInvoiceQuickBooks({ id, ...withSignal(signal) })).data,
  getInvoiceReminderPreference: async (id, signal) =>
    (await client.getInvoiceReminderPreference({ id, ...withSignal(signal) })).data,
  setInvoiceReminderPreference: async (id, reminders, signal) =>
    (await client.setInvoiceReminderPreference({ id, body: { reminders }, ...withSignal(signal) })).data,
  getInvoiceDocumentPreference: async (id, signal) =>
    (await client.getInvoiceDocumentPreference({ id, ...withSignal(signal) })).data,
  // What the Send dialog opens on, and the client rules it can save back.
  getInvoiceEmailDefaults: async (id, signal) =>
    (await client.getInvoiceEmailDefaults({ id, ...withSignal(signal) })).data,
  setClientInvoiceSending: async (clientId, input, signal) => {
    await client.setClientInvoiceSending({ id: clientId, body: input, ...withSignal(signal) })
  },
  setInvoiceCopyToSelf: async (copy, signal) => {
    await client.updateProfile({ body: { invoice_copy_to_self: copy }, ...withSignal(signal) })
  },
  previewInvoiceEmail: async (id, input, signal) => {
    const preview = await client.previewInvoiceEmail({ id, body: input, ...withSignal(signal) })
    return { email: preview.data, documentHref: preview.links.document }
  },
  sendInvoiceEmailPreview: async (id, input, signal) =>
    (await client.sendInvoiceEmailPreview({ id, body: input, ...withSignal(signal) })).data,
  setInvoiceDocumentPreference: async (id, input, signal) =>
    (await client.setInvoiceDocumentPreference({ id, body: input, ...withSignal(signal) })).data,
  getOrganizationInvoiceDocuments: async (signal) =>
    (await client.getOrganizationInvoiceDocuments({ ...withSignal(signal) })).data,
  setOrganizationInvoiceDocuments: async (input, signal) =>
    (await client.setOrganizationInvoiceDocuments({ body: input, ...withSignal(signal) })).data,
  getOrganizationInvoiceSending: async (signal) =>
    (await client.getOrganizationInvoiceSending({ ...withSignal(signal) })).data,
  setOrganizationInvoiceSending: async (input, signal) =>
    (await client.setOrganizationInvoiceSending({ body: input, ...withSignal(signal) })).data,
  uploadInvoiceAttachment: async (id, commandId, body, signal) =>
    (
      await client.createInvoiceAttachment({
        invoiceId: id,
        'Idempotency-Key': commandId,
        body,
        ...withSignal(signal),
      })
    ).data,
  updateInvoice: async (id, commandId, input, signal) =>
    (
      await client.updateInvoice({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  recordInvoicePayment: async (id, commandId, input, signal) =>
    (
      await client.recordInvoicePayment({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  updateInvoicePayment: async (id, paymentId, commandId, input, signal) =>
    (
      await client.updateInvoicePayment({
        id,
        paymentId,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  deleteInvoicePayment: async (id, paymentId, commandId, input, signal) =>
    (
      await client.deleteInvoicePayment({
        id,
        paymentId,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  createInvoiceLine: async (id, commandId, input, signal) =>
    (
      await client.createInvoiceLine({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  updateInvoiceLine: async (id, lineId, commandId, input, signal) =>
    (
      await client.updateInvoiceLine({
        id,
        lineId,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  deleteInvoiceLine: async (id, lineId, commandId, input, signal) =>
    (
      await client.deleteInvoiceLine({
        id,
        lineId,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  transitionInvoice: async (id, commandId, input, signal) =>
    (
      await client.transitionInvoice({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  deliverInvoiceEmail: async (id, commandId, input, signal) =>
    (
      await client.deliverInvoiceEmail({
        id,
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data.invoice,
  listTasks: (cursor, signal) =>
    client.listTasks({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...withSignal(signal),
    }),
  listTimeEntryOptions: async (signal, userId) =>
    (
      await client.listTimeEntryOptions({
        ...(userId === undefined ? {} : { query: { user_id: userId } }),
        ...withSignal(signal),
      })
    ).data,
  getTimeEntrySettings: async (signal) =>
    (await client.getTimeEntrySettings(withSignal(signal))).data,
  listTimeEntries: async (query, signal) => {
    const entries: TimeEntry[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimeEntries({
        query: {
          ...query,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      entries.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return entries
  },
  listExpenses: async (query, signal) => {
    const expenses: Expense[] = []
    let cursor: string | undefined
    do {
      const page = await client.listExpenses({
        query: {
          ...query,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      expenses.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return expenses
  },
  getTimeEntry: async (id, signal) =>
    (await client.getTimeEntry({ id, ...withSignal(signal) })).data,
  createTimeEntry: async (input, signal) =>
    (await client.createTimeEntry({ body: input, ...withSignal(signal) })).data,
  updateTimeEntry: async (id, patch, signal) =>
    (await client.updateTimeEntry({ id, body: patch, ...withSignal(signal) })).data,
  deleteTimeEntry: async (id, signal) => {
    await client.deleteTimeEntry({ id, ...withSignal(signal) })
  },
  stopTimeEntry: async (id, signal) =>
    (await client.stopTimeEntry({ id, ...withSignal(signal) })).data,
  restartTimeEntry: async (id, signal) =>
    (await client.restartTimeEntry({ id, ...withSignal(signal) })).data,
  listTimesheetSubmissions: async (periodStart, periodEnd, signal) => {
    const submissions: TimesheetSubmission[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimesheetSubmissions({
        query: {
          period_start: periodStart,
          period_end: periodEnd,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      submissions.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return submissions
  },
  submitTimesheet: async (input, signal) =>
    (await client.submitTimesheet({ body: input, ...withSignal(signal) })).data,
  listPendingTimesheetSubmissions: async (filters, signal) => {
    const page = await client.listPendingTimesheetSubmissions({
      query: {
        per_page: pendingTimesheetQueueLimit,
        ...(filters?.userId !== undefined ? { user_id: filters.userId } : {}),
        ...(filters?.clientId !== undefined ? { client_id: filters.clientId } : {}),
        ...(filters?.projectId !== undefined ? { project_id: filters.projectId } : {}),
      },
      ...withSignal(signal),
    })
    return { submissions: page.data, nextCursor: page.page.next_cursor ?? null }
  },
  listApprovedTimesheetSubmissions: async (periodStart, filters, signal) => {
    const page = await client.listApprovedTimesheetSubmissions({
      query: {
        period_start: periodStart,
        per_page: pendingTimesheetQueueLimit,
        ...(filters?.userId !== undefined ? { user_id: filters.userId } : {}),
        ...(filters?.clientId !== undefined ? { client_id: filters.clientId } : {}),
        ...(filters?.projectId !== undefined ? { project_id: filters.projectId } : {}),
      },
      ...withSignal(signal),
    })
    return { submissions: page.data, nextCursor: page.page.next_cursor ?? null }
  },
  getTimesheetSubmission: async (id, signal) =>
    (await client.getTimesheetSubmission({ id, ...withSignal(signal) })).data,
  approveTimesheetSubmission: async (id, signal) =>
    (
      await client.approveTimesheetSubmission({
        id,
        ...withSignal(signal),
      })
    ).data,
  bulkApproveTimesheetSubmissions: async (commandId, input, signal) =>
    (
      await client.bulkApproveTimesheetSubmissions({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  rejectTimesheetSubmission: async (id, input, signal) =>
    (
      await client.rejectTimesheetSubmission({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  unsubmitTimesheetSubmission: async (id, signal) =>
    (await client.unsubmitTimesheetSubmission({ id, ...withSignal(signal) })).data,
  withdrawTimesheetSubmission: async (id, input, signal) =>
    (
      await client.withdrawTimesheetSubmission({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  getProfile: async (signal) => (await client.getProfile(withSignal(signal))).data,
  updateProfile: async (timezone, signal) =>
    (await client.updateProfile({ body: { timezone }, ...withSignal(signal) })).data,
  getTimesheetLockPolicy: async (signal) =>
    (await client.getTimesheetLockPolicy(withSignal(signal))).data,
  updateTimesheetLockPolicy: async (input, signal) =>
    (
      await client.updateTimesheetLockPolicy({
        body: input,
        ...withSignal(signal),
      })
    ).data,
  listTimesheetLocks: async (signal) => {
    const locks: TimesheetLockWindow[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTimesheetLocks({
        query: {
          active: true,
          per_page: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ...withSignal(signal),
      })
      locks.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return locks
  },
  createTimesheetManualLock: async (commandId, input, signal) =>
    (
      await client.createTimesheetManualLock({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  unlockTimesheetLock: async (id, input, signal) =>
    (
      await client.unlockTimesheetLock({
        id,
        body: input,
        ...withSignal(signal),
      })
    ).data,
  generateInvoice: async (commandId, input, signal) =>
    (
      await client.generateInvoice({
        'Idempotency-Key': commandId,
        body: input,
        ...withSignal(signal),
      })
    ).data,

  getInvoiceDefaults: async (signal) =>
    (await client.getInvoiceDefaults({ ...withSignal(signal) })).data,
  updateInvoiceDefaults: async (patch, signal) =>
    (await client.updateInvoiceDefaults({ body: patch, ...withSignal(signal) })).data,
  getOrganizationInvoiceJournal: async (signal) => {
    const data = (await client.getOrganizationInvoiceDocuments({ ...withSignal(signal) })).data
    const level = data.attach_journal
    return {
      level: level === 'detailed' || level === 'summary' ? level : false,
      formats: data.journal_formats,
    }
  },
  setInvoiceJournal: async (invoiceId, choice, signal) => {
    await client.setInvoiceDocumentPreference({
      id: invoiceId,
      body:
        choice.level === false
          ? { attach_journal: false }
          : { attach_journal: choice.level, journal_formats: [...choice.formats] },
      ...withSignal(signal),
    })
  },
})

/**
 * The shell's API, on the page's own origin. Every request goes through
 * `shellFetch`, which retries what it safely can and keys every write (issue
 * 953).
 */
export const createSameOriginShellApi = (): ShellApi => ({
  ...createShellApi(
    new EzactoClient({
      baseUrl: globalThis.location.origin,
      fetch: (input, init) => shellFetch(input, { ...init, credentials: 'same-origin' }),
    }),
  ),
  // A file, not JSON, so it is fetched here rather than through the client.
  downloadInvoiceHoursReport: async (id, format, detail, signal) => {
    const response = await shellFetch(
      `/api/v1/invoices/${encodeURIComponent(String(id))}/hours-report?format=${format}&detail=${detail}`,
      { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) },
    )
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw new EzactoApiError(response.status, body, response.headers.get('x-request-id'))
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename="([^"]+)"/u.exec(disposition)?.[1]
    return { blob: await response.blob(), filename: named ?? `hours-${String(id)}.${format}` }
  },
  // The activity log as a file, for the same reason: the name and whether the
  // file was cut at its row cap are in headers the client drops.
  exportActivityLog: async (query, signal) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) search.set(key, String(value))
    const response = await shellFetch(
      `/api/v1/activity-log/export${search.size === 0 ? '' : `?${search.toString()}`}`,
      { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) },
    )
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw new EzactoApiError(response.status, body, response.headers.get('x-request-id'))
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename="([^"]+)"/u.exec(disposition)?.[1]
    return {
      blob: await response.blob(),
      filename: named ?? 'activity-log.csv',
      truncated: response.headers.get('x-export-truncated') === 'true',
    }
  },
  // The detailed time report as a file, for the same reason: the name the
  // server gives it -- period and client -- is in a header the client drops.
  downloadDetailedTimeReport: async (request, format, audience, signal) => {
    const response = await shellFetch(detailedTimeExportPath(request, format, audience), {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw new EzactoApiError(response.status, body, response.headers.get('x-request-id'))
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename="([^"]+)"/u.exec(disposition)?.[1]
    return {
      blob: await response.blob(),
      filename: named ?? `detailed-time-${request.from}-to-${request.to}.${format}`,
    }
  },
})

/**
 * What the search chip writes before the K (the 2026-10 reskin): the command
 * key on Apple platforms, Ctrl everywhere else. Both chords open the bar on
 * every platform -- the handler takes either modifier -- so this decides only
 * what the chip says, and getting it wrong costs a label, never a shortcut.
 *
 * Read from what the browser says about itself: `userAgentData.platform` where
 * it exists, the older `platform` string, then the user agent. An iPad asking
 * for the desktop site reports itself as a Mac, which is the right answer for
 * a keyboard attached to one.
 */
export interface PlatformHints {
  readonly platform?: string
  readonly userAgent?: string
  readonly userAgentData?: { readonly platform?: string } | undefined
}

export const commandShortcutModifier = (hints: PlatformHints): '⌘' | 'Ctrl ' => {
  const platform = `${hints.userAgentData?.platform ?? ''} ${hints.platform ?? ''}`
  const apple =
    /mac|iphone|ipad|ipod/iu.test(platform) ||
    /mac os x|iphone|ipad|ipod/iu.test(hints.userAgent ?? '')
  return apple ? '⌘' : 'Ctrl '
}
