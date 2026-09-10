import {
  EzactoClient,
  EzactoApiError,
  type AuthPrincipal,
  type Expense,
  type GeneralResource,
  type Invoice,
  type InvoiceGenerationInput,
  type InvoiceTransitionInput,
  type PasswordSignInInput,
  type Session,
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
} from '@ezacto/client'
import type { InvoiceState } from '../invoices/model.js'
import type { ActivityRow } from '../activity/browser.js'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'
import type { ClientDirectoryApi } from '../clients/model.js'
import type { ProjectDirectoryApi } from '../projects/model.js'
import type { ReportWorkspaceApi } from '../reports/model.js'
import type { ExpenseWorkflowApi } from '../expenses/model.js'
import type { ExpenseCategoryDirectoryApi } from '../expense-categories/model.js'
import type { InvoicePaymentApi } from '../invoices/model.js'
import type { TaskAdminApi } from '../tasks/model.js'
import type { TeamDirectoryApi } from '../team/model.js'
import type { CompanySettingsApi } from '../module-settings/model.js'
import type { EmailConfigurationApi } from '../email-config/model.js'
import type { RecurringWorkspaceApi } from '../recurring/model.js'
import type { RetainerWorkspaceApi } from '../retainers/model.js'

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

export interface ShellApi
  extends Partial<ClientDirectoryApi>,
    Partial<ProjectDirectoryApi>,
    Partial<ReportWorkspaceApi>,
    Partial<ExpenseWorkflowApi>,
    Partial<ExpenseCategoryDirectoryApi>,
    Partial<EmailConfigurationApi>,
    Partial<RecurringWorkspaceApi>,
    Partial<RetainerWorkspaceApi>,
    Partial<InvoicePaymentApi>,
    Partial<TaskAdminApi>,
    Partial<TeamDirectoryApi>,
    Partial<CompanySettingsApi> {
  whoami(signal?: AbortSignal): Promise<Whoami>
  signIn(credentials: PasswordSignInInput, signal?: AbortSignal): Promise<AuthPrincipal>
  logoutCurrentSession(signal?: AbortSignal): Promise<Session>
  listProjects(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  listClients?(cursor?: string, signal?: AbortSignal): Promise<CursorPage<GeneralResource>>
  /** The page size a caller may raise when it is walking, not browsing. */
  listActivityLog?(
    query: { readonly from?: string; readonly to?: string; readonly event_type?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly ActivityRow[] }>
  listInvoices?(
    cursor?: string,
    signal?: AbortSignal,
    perPage?: number,
    states?: readonly InvoiceState[],
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
  listTimeEntryOptions(signal?: AbortSignal): Promise<readonly TimeEntryOption[]>
  getTimeEntrySettings(signal?: AbortSignal): Promise<TimeEntrySettings>
  listTimeEntries(query: {
    readonly from?: string
    readonly to?: string
    readonly is_running?: boolean
  }, signal?: AbortSignal): Promise<readonly TimeEntry[]>
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

export const paletteDestinations: readonly PaletteDestination[] = [
  {
    label: 'Home',
    href: '/dashboard',
    group: 'Track',
    keywords: 'dashboard overview where things stand',
    gate: primaryNav('/dashboard'),
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
  { label: 'Tasks', href: '/tasks', group: 'Organize', gate: primaryNav('/tasks') },
  {
    label: 'Clients',
    href: '/clients',
    group: 'Organize',
    keywords: 'contacts',
    gate: primaryNav('/clients'),
  },
  { label: 'Team', href: '/team', group: 'Organize', keywords: 'people', gate: primaryNav('/team') },
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
    label: 'Activity log',
    href: '/settings/activity',
    group: 'Review',
    keywords: 'audit history who changed',
    // The same gate as Company settings: the log names who did what, and the
    // palette must not offer a destination that answers 403.
    gate: '[data-settings-activity-tab]',
  },
  {
    label: 'Invoices',
    href: '/invoices',
    group: 'Bill',
    keywords: 'money billing',
    gate: primaryNav('/invoices'),
  },
  {
    label: 'Generate invoice',
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
 * Mirrors `SELF_WITHDRAWAL_REASON` in `packages/db/src/timesheet-approvals.ts`,
 * which is where the value is written. `apps/web` depends only on the generated
 * client, so the literal is stated twice; a test in that package pins the same
 * string so the pair cannot drift apart quietly.
 */
export const SELF_WITHDRAWAL_REASON = 'Taken back by the owner before review.'

/**
 * Whether an unsubmitted week was sent back by its own owner rather than by a
 * reviewer. Both write the same three columns, because the table requires every
 * unsubmitted row to say who returned it and why.
 *
 * Identity alone is not enough, and a browser test is what proved it: an
 * administrator rejecting their *own* week is also a row whose reviewer is its
 * owner, and reading that as a self-withdrawal hid a real rejection. The reason
 * is what actually separates the two. A reviewer who types this exact sentence
 * as their rejection reason would be misread, which costs a label and nothing
 * else.
 *
 * Worth a named function rather than an inline comparison: getting it wrong
 * shows someone "Changes requested" for a correction they made themselves.
 */
export const isSelfWithdrawn = (
  submission: Pick<
    TimesheetSubmission,
    'status' | 'user_id' | 'reviewed_by_user_id' | 'rejection_reason'
  > | null,
): boolean =>
  submission !== null &&
  submission.status === 'unsubmitted' &&
  submission.reviewed_by_user_id !== null &&
  submission.reviewed_by_user_id === submission.user_id &&
  submission.rejection_reason === SELF_WITHDRAWAL_REASON

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

export const loadShellSnapshot = async (
  api: ShellApi,
  now = new Date(),
  signal?: AbortSignal,
): Promise<ShellSnapshot> => {
  const timeEntrySettings = await api.getTimeEntrySettings(signal)
  const range = weekRange(localDate(now), timeEntrySettings.week_start_day)
  const expenseRequest = api.listExpenses?.(range, signal).catch((error: unknown) => {
    if (error instanceof EzactoApiError && error.status === 404) return []
    throw error
  }) ?? Promise.resolve([])
  const [resources, entries, running, expenses, timeEntryOptions] = await Promise.all([
    loadCatalogResources(api, signal),
    api.listTimeEntries(range, signal),
    api.listTimeEntries({ is_running: true }, signal),
    expenseRequest,
    api.listTimeEntryOptions(signal),
  ])
  const displayedEntries = displayEntries(entries, resources)
  const displayedRunning = displayEntries(running, resources)
  if (displayedRunning.length > 1)
    throw new Error('more than one timer is running')
  return {
    entries: displayedEntries,
    expenses,
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

const withSignal = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal }

export const createShellApi = (client: EzactoClient): ShellApi => ({
  whoami: async (signal) => {
    return (await client.getWhoami(withSignal(signal))).data
  },
  signIn: async (credentials, signal) => {
    return (await client.signIn({ body: credentials, ...withSignal(signal) })).data
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
  getEmailHealth: async (signal) =>
    (await client.getEmailHealth(withSignal(signal))).data,
  getBackupStatus: async (signal) =>
    (await client.getBackupStatus(withSignal(signal))).data,
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
  getUninvoicedReport: async (filter, signal) =>
    (
      await client.getUninvoicedReport({
        query: filter,
        ...withSignal(signal),
      })
    ).data,
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
  listActivityLog: (query, signal) =>
    client.listActivityLog({ query: { per_page: 200, ...query }, ...withSignal(signal) }),
  listInvoices: (cursor, signal, perPage, states) =>
    client.listInvoices({
      query: {
        per_page: perPage ?? 50,
        ...(cursor === undefined ? {} : { cursor }),
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
  generateRecurringInvoice: async (id, idempotencyKey, signal) =>
    (
      await client.generateRecurringInvoice({
        id,
        'Idempotency-Key': idempotencyKey,
        ...withSignal(signal),
      })
    ).data,
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
  getInvoice: async (id, signal) =>
    (await client.getInvoice({ id, ...withSignal(signal) })).data,
  listInvoiceMessages: async (id, signal) =>
    (await client.listInvoiceMessages({ id, ...withSignal(signal) })).data,
  listInvoicePayments: async (id, signal) =>
    (await client.listInvoicePayments({ id, ...withSignal(signal) })).data,
  listInvoiceAttachments: async (id, signal) =>
    (await client.listInvoiceAttachments({ invoiceId: id, ...withSignal(signal) })).data,
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
  listTimeEntryOptions: async (signal) =>
    (await client.listTimeEntryOptions(withSignal(signal))).data,
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
})

export const createSameOriginShellApi = (): ShellApi =>
  createShellApi(
    new EzactoClient({
      baseUrl: globalThis.location.origin,
      fetch: (input, init) =>
        globalThis.fetch(input, { ...init, credentials: 'same-origin' }),
    }),
  )
