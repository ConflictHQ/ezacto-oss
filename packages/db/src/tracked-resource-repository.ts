import {
  TrackedResourceAssignmentError,
  TrackedResourceConflictError,
  TrackedResourceInputError,
  TrackedMutationLockedError,
  TrackedResourceNotFoundError,
  type ApprovalStatus,
  type TrackedState,
  type TeamViewer,
  assertTimeRoundingPolicy,
  canManageTeammateTime,
  dateInTimeZone,
  effectiveTimeRounding,
  effectiveTimeZone,
  roundTimeSeconds,
  timeInTimeZone,
  type EffectiveTimeRounding,
  type TimeRoundingMinutes,
  type TimeRoundingMode,
  type TimeRoundingPolicy,
} from '@ezacto/core'
import {
  computeExpenseTotalCents,
  createExpense,
  type Expense,
  type ReimbursementStatus,
} from './expenses.js'
import {
  createStoppedTimeEntry,
  elapsedWallClockSeconds,
  restartTimeEntry,
  startTimeEntry,
  stopTimeEntry,
  timeRoundingForProject,
  type TimeBoundary,
  type TimeEntry,
} from './time-entries.js'
import {
  assertStoredTimeEntryNoteRequirement,
  currentTimeEntryNotePolicyAllows,
  resolveStoredTimeEntryNoteRequirement,
} from './time-entry-note-requirements.js'
import { resolveEntryRates } from './rate-resolver.js'
import { timeEntryOnBehalfEvent, type TimeEntryChange } from './time-entry-audit.js'
import {
  applyTimeRoundingRecalculation,
  previewTimeRoundingRecalculation,
  type LockedDates,
  type TimeRoundingRecalculationPreview,
  type TimeRoundingRecalculationResult,
  type TimeRoundingRecalculationScope,
} from './time-rounding-recalculation.js'
import {
  clients,
  expenseCategories,
  expenses,
  organizations,
  projects,
  taskAssignments,
  tasks,
  timeEntries,
  timesheetSubmissions,
  userAssignments,
  users,
} from './schema.js'
import {
  executeAtomicTrackedMutation,
  getTrackedState,
  TrackedEntityNotFoundError,
  type CompiledQuery,
} from './tracked-state.js'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

export interface ResourceWindow {
  afterId: number | null
  throughId: number
  take: number
}

export interface ResourceSource<Row extends { id: number }> {
  highWatermark(): Promise<number | null>
  list(window: ResourceWindow): Promise<readonly Row[]>
}

const inputProblem = (field: string, code: string, message: string) =>
  new TrackedResourceInputError(field, code, message)

const assignmentProblem = () => new TrackedResourceAssignmentError()
const concurrentProblem = (resource: 'time entry' | 'expense') =>
  new TrackedResourceConflictError(resource)
const notFound = (resource: 'time entry' | 'expense') => new TrackedResourceNotFoundError(resource)

/**
 * The audit of a write, or nothing: only a change made to somebody else's time
 * is recorded (#917), and it rides in the write's own transaction.
 */
const onBehalfAudit = (
  actor: TimeEntryActor,
  ownerUserId: number,
  change: TimeEntryChange,
  occurredAt: string,
): readonly CompiledQuery[] =>
  ownerUserId === actor.userId
    ? []
    : [timeEntryOnBehalfEvent({ ...change, actorUserId: actor.userId, ownerUserId, occurredAt })]

const timerForSomebodyElse = () =>
  inputProblem(
    'user_id',
    'timer_owned',
    'a timer can only be started by the person it tracks; log stopped time for somebody else',
  )

const approvalPeriodWriteErrorPattern =
  /(?:approved (?:or pending )?timesheet period|(?:time entry|expense) does not match its timesheet submission)/

const isApprovalPeriodWriteError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  let depth = 0
  while (current instanceof Error && !seen.has(current) && depth < 8) {
    if (approvalPeriodWriteErrorPattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
    depth += 1
  }
  return false
}

const policyLockWriteErrorPattern = new RegExp(
  '^(?:D1_ERROR: )?(?:time entry date is locked by timesheet policy|' +
    'expense date is locked by timesheet policy)' +
    '(?:: SQLITE_CONSTRAINT(?: \\(extended: SQLITE_CONSTRAINT_TRIGGER\\))?)?$',
)

const isPolicyLockWriteError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  let depth = 0
  while (current instanceof Error && !seen.has(current) && depth < 8) {
    if (policyLockWriteErrorPattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
    depth += 1
  }
  return false
}

/**
 * The approval status a row actually carries, as a filter condition.
 *
 * Two columns hold the answer. `approval_status` is what this instance
 * decided; `source_approval_status` is what the row carried in the system it
 * was imported from, kept because an instance whose approval module is off
 * resets the native column to `unsubmitted` for every row and would otherwise
 * lose the imported answer entirely. Where the native column says
 * `unsubmitted` and an imported answer exists, the imported one is the true
 * one -- the same rule the expense screen shows.
 */
const effectiveApprovalStatus = (
  table: { approvalStatus: SQLiteColumn; sourceApprovalStatus: SQLiteColumn },
  wanted: ApprovalStatus,
): SQL =>
  wanted === 'unsubmitted'
    ? sql`${table.approvalStatus} = ${wanted}
        AND coalesce(${table.sourceApprovalStatus}, 'unsubmitted') = 'unsubmitted'`
    : sql`(${table.approvalStatus} = ${wanted}
        OR (${table.approvalStatus} = 'unsubmitted'
          AND ${table.sourceApprovalStatus} = ${wanted}))`

const throwIfPolicyLockWriteError = (error: unknown): void => {
  if (isPolicyLockWriteError(error)) {
    throw new TrackedMutationLockedError('policy_locked')
  }
}

const translateTrackedNotFound = (error: unknown, resource: 'time entry' | 'expense'): never => {
  throwIfPolicyLockWriteError(error)
  if (error instanceof TrackedEntityNotFoundError) throw notFound(resource)
  throw error
}

export type TrackedResourceDatabase = Parameters<typeof getTrackedState>[0]

export type PolicySubject =
  | { entityType: 'time_entry'; entityId: number }
  | { entityType: 'expense'; entityId: number }
  | { entityType: 'running_time_entry_replacement'; userId: number }
  | { entityType: 'tracked_date'; spentDate: string }

export interface TrackedPolicyResolver {
  isLocked(subject: Readonly<PolicySubject>): Promise<boolean>
  lockedDates?(spentDates: readonly string[]): Promise<ReadonlyMap<string, boolean>>
}

export interface TrackedResourceClock {
  now(): TimeBoundary
}

/**
 * Who is acting on a time entry. The profile is part of it because an
 * administrator may reach anybody's time (#917); everybody else reaches only
 * their own, and a bare user id could not say which of the two this is.
 */
export type TimeEntryActor = Readonly<Pick<TeamViewer, 'userId' | 'profile'>>

export interface TimeEntryRecord extends TimeEntry {
  state: TrackedState
  noteMinimumLength: number
}

export interface ExpenseRecord extends Expense {
  state: TrackedState
}

export interface TimeEntryFilters {
  /**
   * Whose entries: the actor's own unless named. Naming somebody else matches
   * nothing unless the actor may manage teammates' time.
   */
  userId?: number
  clientId?: number
  projectId?: number
  taskId?: number
  spentDate?: string
  from?: string
  to?: string
  approvalStatus?: ApprovalStatus
  invoiceId?: number
  isBilled?: boolean
  isRunning?: boolean
  billable?: boolean
  budgeted?: boolean
  externalReferenceId?: string
  updatedSince?: string
}

export interface ExpenseFilters {
  clientId?: number
  projectId?: number
  expenseCategoryId?: number
  spentDate?: string
  from?: string
  to?: string
  approvalStatus?: ApprovalStatus
  invoiceId?: number
  isBilled?: boolean
  billable?: boolean
  reimbursable?: boolean
  reimbursementStatus?: ReimbursementStatus
  updatedSince?: string
}

export interface OrganizationTimeEntryNoteSettings {
  required: boolean
  minimumLength: number
}

export interface OrganizationTimeEntrySettings {
  mode: 'duration' | 'start_end'
  timeFormat: 'decimal' | 'hours_minutes'
  clock: '12h' | '24h'
  weekStartDay: 'saturday' | 'sunday' | 'monday'
  /** The organization's rounding rule; a project may have its own (issue 949). */
  timeRounding: TimeRoundingPolicy
}

/** One half or both; the other keeps what is stored. */
export interface UpdateOrganizationTimeRounding {
  mode?: TimeRoundingMode
  minutes?: TimeRoundingMinutes
}

/** A project/task pair a person may log against, and what logging there means. */
export interface TimeEntryOptionRecord {
  projectId: number
  taskId: number
  noteMinimumLength: number
  /** How time on this pair is rounded, and whose rule that is (issue 949). */
  timeRounding: EffectiveTimeRounding
}

export interface UpdateOrganizationTimeEntryNoteSettings {
  required?: boolean
  minimumLength?: number
}

export interface CreateTimeEntryRequest {
  /**
   * Whose time this is: the actor's own unless named. Only an administrator
   * names somebody else, and only for stopped time -- a timer belongs to the
   * person it is running for.
   */
  userId?: number
  projectId: number
  taskId: number
  spentDate?: string
  seconds?: number
  startedTime?: string
  endedTime?: string
  notes?: string | null
  budgeted?: boolean
  externalRef?: Record<string, unknown> | null
  calendarEventRef?: Record<string, unknown> | null
}

export interface UpdateTimeEntryRequest {
  projectId?: number
  taskId?: number
  spentDate?: string
  seconds?: number
  startedTime?: string
  endedTime?: string
  notes?: string | null
  budgeted?: boolean
  externalRef?: Record<string, unknown> | null
  calendarEventRef?: Record<string, unknown> | null
}

export interface CreateExpenseRequest {
  projectId: number
  expenseCategoryId: number
  spentDate: string
  notes?: string | null
  units?: number
  totalCostCents?: number
  billable?: boolean
  reimbursable?: boolean
}

export interface UpdateExpenseRequest {
  projectId?: number
  expenseCategoryId?: number
  spentDate?: string
  notes?: string | null
  units?: number
  totalCostCents?: number
  billable?: boolean
  reimbursable?: boolean
}

interface AssignmentResolution {
  userAssignmentId: number
  taskAssignmentId: number
  billable: boolean
}

interface ApprovalMembership {
  approvalStatus: ApprovalStatus
  timesheetSubmissionId: number | null
}

type TimeSettings = Pick<
  typeof organizations.$inferSelect,
  | 'timeEntryMode'
  | 'timeFormat'
  | 'clock'
  | 'weekStartDay'
  | 'timeRoundingMode'
  | 'timeRoundingMinutes'
  // Issue 651: a running timer is filed against the organization's today, not
  // UTC's.
  | 'timezone'
>

const moneyUpperBound = 9_000_000_000_000

const organizationTimeRounding = (
  settings: Pick<typeof organizations.$inferSelect, 'timeRoundingMode' | 'timeRoundingMinutes'>,
): TimeRoundingPolicy =>
  assertTimeRoundingPolicy({ mode: settings.timeRoundingMode, minutes: settings.timeRoundingMinutes })

/** A project's own rule, or null where it takes the organization's. */
const projectTimeRounding = (
  project: Pick<typeof projects.$inferSelect, 'timeRoundingMode' | 'timeRoundingMinutes'>,
): TimeRoundingPolicy | null =>
  project.timeRoundingMode === null
    ? null
    : assertTimeRoundingPolicy({
        mode: project.timeRoundingMode,
        minutes: project.timeRoundingMinutes,
      })

const mapReturnedTimeEntry = (row: Record<string, unknown>): TimeEntry =>
  Object.fromEntries(
    Object.entries(getTableColumns(timeEntries)).map(([property, column]) => {
      const value = row[column.name]
      return [property, value === null ? null : column.mapFromDriverValue(value)]
    }),
  ) as TimeEntry

const mapReturnedExpense = (row: Record<string, unknown>): Expense =>
  Object.fromEntries(
    Object.entries(getTableColumns(expenses)).map(([property, column]) => {
      const value = row[column.name]
      return [property, value === null ? null : column.mapFromDriverValue(value)]
    }),
  ) as Expense

const isRunning = (entry: TimeEntry): boolean =>
  entry.timerStartedAt !== null || (entry.startedTime !== null && entry.endedTime === null)


/**
 * The same instant, with the date and wall-clock time the organization sees.
 *
 * `instant` is untouched -- it is the moment, and the moment is not local to
 * anybody. Only the calendar fields move.
 */
const localBoundary = (
  boundary: TimeBoundary,
  timezone: string | null,
): TimeBoundary => {
  const zone = timezone ?? 'UTC'
  if (zone === 'UTC') return boundary
  try {
    return {
      instant: boundary.instant,
      date: dateInTimeZone(boundary.instant, zone),
      time: timeInTimeZone(boundary.instant, zone),
    }
  } catch {
    // An unusable zone is a settings problem, not a reason to refuse a timer.
    // Falling back to UTC restores exactly the behaviour that existed before
    // this, which is wrong but no more wrong than it already was.
    return boundary
  }
}

export class DrizzleTrackedResourceRepository {
  readonly #database: TrackedResourceDatabase
  readonly #policy: TrackedPolicyResolver

  constructor(database: TrackedResourceDatabase, policy: TrackedPolicyResolver) {
    this.#database = database
    this.#policy = policy
  }

  async #timeSettings(): Promise<TimeSettings> {
    const [settings] = await this.#database
      .select()
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1)
    if (!settings) throw new Error('organization must exist before serving tracked resources')
    return settings
  }

  // The local day a timer is filed under belongs to the person tracking it. We
  // prefer that user's own timezone; a user who has never set one (the 'UTC'
  // column default) defers to the organization timezone, which in turn defaults
  // to 'UTC'. This keeps prior behaviour for anyone without a personal zone
  // while letting a user in another zone file on their own day.
  async #effectiveTimezone(userId: number, settings: TimeSettings): Promise<string> {
    const [user] = await this.#database
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    // The rule itself -- a personal zone wins only if a calendar can use it,
    // and the organisation's is the floor -- lives in core, where the time
    // reminders (issue 935) read it too.
    return effectiveTimeZone(user?.timezone ?? null, settings.timezone)
  }

  /**
   * The boundary on the wall clock of the person whose entry it is: their own
   * zone, then the organization's, as `#effectiveTimezone` decides the day a
   * timer is filed on. The instant is untouched.
   */
  async #ownerBoundary(userId: number, boundary: TimeBoundary): Promise<TimeBoundary> {
    return localBoundary(boundary, await this.#effectiveTimezone(userId, await this.#timeSettings()))
  }

  async timeEntrySettings(): Promise<OrganizationTimeEntrySettings> {
    const settings = await this.#timeSettings()
    return {
      mode: settings.timeEntryMode,
      timeFormat: settings.timeFormat,
      clock: settings.clock,
      weekStartDay: settings.weekStartDay,
      timeRounding: organizationTimeRounding(settings),
    }
  }

  /**
   * Sets the organization's rule (issue 949). Nothing already saved changes:
   * the new rule rounds time saved from now on, and open time is re-rounded
   * only by the recalculation below, after a preview.
   */
  async updateTimeRoundingSettings(
    input: Readonly<UpdateOrganizationTimeRounding>,
    updatedAt: string,
  ): Promise<TimeRoundingPolicy> {
    const current = organizationTimeRounding(await this.#timeSettings())
    const next = assertTimeRoundingPolicy({
      mode: input.mode ?? current.mode,
      minutes: input.minutes ?? current.minutes,
    })
    const [organization] = await this.#database
      .update(organizations)
      .set({ timeRoundingMode: next.mode, timeRoundingMinutes: next.minutes, updatedAt })
      .where(eq(organizations.id, 1))
      .returning()
    if (!organization) throw new Error('organization must exist before serving tracked resources')
    return organizationTimeRounding(organization)
  }

  /** What re-rounding open time under today's rules would change (issue 949). */
  async previewTimeRoundingRecalculation(
    scope: Readonly<TimeRoundingRecalculationScope>,
  ): Promise<TimeRoundingRecalculationPreview> {
    return previewTimeRoundingRecalculation(this.#database, scope, this.#lockedDates())
  }

  /** Applies exactly the preview the fingerprint names, or answers `stale`. */
  async applyTimeRoundingRecalculation(
    scope: Readonly<TimeRoundingRecalculationScope>,
    fingerprint: string,
    updatedAt: string,
  ): Promise<TimeRoundingRecalculationResult> {
    return applyTimeRoundingRecalculation(
      this.#database,
      scope,
      fingerprint,
      updatedAt,
      this.#lockedDates(),
    )
  }

  /**
   * The lock policy's answer for many dates at once where it offers one, else
   * one date at a time: the same question `isLocked` answers for a single edit.
   */
  #lockedDates(): LockedDates {
    const policy = this.#policy
    if (policy.lockedDates !== undefined) return (dates) => policy.lockedDates!(dates)
    return async (dates) =>
      new Map(
        await Promise.all(
          dates.map(
            async (spentDate) =>
              [spentDate, await policy.isLocked({ entityType: 'tracked_date', spentDate })] as const,
          ),
        ),
      )
  }

  async timeEntryNoteSettings(): Promise<OrganizationTimeEntryNoteSettings> {
    const [organization] = await this.#database
      .select()
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1)
    if (!organization) throw new Error('organization must exist before serving tracked resources')
    return {
      required: organization.timeEntryNotesRequired,
      minimumLength: organization.timeEntryNotesMinimumLength,
    }
  }

  async updateTimeEntryNoteSettings(
    input: Readonly<UpdateOrganizationTimeEntryNoteSettings>,
    updatedAt: string,
  ): Promise<OrganizationTimeEntryNoteSettings> {
    const [organization] = await this.#database
      .update(organizations)
      .set({
        ...(input.required !== undefined ? { timeEntryNotesRequired: input.required } : {}),
        ...(input.minimumLength !== undefined
          ? { timeEntryNotesMinimumLength: input.minimumLength }
          : {}),
        updatedAt,
      })
      .where(eq(organizations.id, 1))
      .returning()
    if (!organization) throw new Error('organization must exist before serving tracked resources')
    return {
      required: organization.timeEntryNotesRequired,
      minimumLength: organization.timeEntryNotesMinimumLength,
    }
  }

  async #resolveTimeAssignment(
    userId: number,
    projectId: number,
    taskId: number,
  ): Promise<AssignmentResolution> {
    const [userAssignment] = await this.#database
      .select()
      .from(userAssignments)
      .innerJoin(projects, eq(projects.id, userAssignments.projectId))
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(
        and(
          eq(userAssignments.userId, userId),
          eq(userAssignments.projectId, projectId),
          eq(userAssignments.isActive, true),
          eq(projects.isActive, true),
          eq(clients.isActive, true),
        ),
      )
      .limit(1)
    const [taskAssignment] = await this.#database
      .select()
      .from(taskAssignments)
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .where(
        and(
          eq(taskAssignments.projectId, projectId),
          eq(taskAssignments.taskId, taskId),
          eq(taskAssignments.isActive, true),
          eq(tasks.isActive, true),
        ),
      )
      .limit(1)
    if (!userAssignment || !taskAssignment) throw assignmentProblem()
    return {
      userAssignmentId: userAssignment.user_assignments.id,
      taskAssignmentId: taskAssignment.task_assignments.id,
      billable: taskAssignment.task_assignments.billable,
    }
  }

  async #requireProjectAssignment(userId: number, projectId: number): Promise<void> {
    const [assignment] = await this.#database
      .select()
      .from(userAssignments)
      .innerJoin(projects, eq(projects.id, userAssignments.projectId))
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(
        and(
          eq(userAssignments.userId, userId),
          eq(userAssignments.projectId, projectId),
          eq(userAssignments.isActive, true),
          eq(projects.isActive, true),
          eq(clients.isActive, true),
        ),
      )
      .limit(1)
    if (!assignment) throw assignmentProblem()
  }

  /**
   * Which time entries the actor reaches (#917): an administrator anybody's,
   * everybody else their own. Every time-entry read and write goes through
   * this, so no path can widen it on its own.
   */
  #timeEntryAccess(actor: TimeEntryActor): SQL {
    return canManageTeammateTime(actor.profile) ? sql`1` : eq(timeEntries.userId, actor.userId)
  }

  async #accessibleTimeEntry(actor: TimeEntryActor, id: number): Promise<TimeEntry> {
    const [entry] = await this.#database
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.id, id), this.#timeEntryAccess(actor)))
      .limit(1)
    if (!entry) throw notFound('time entry')
    return entry
  }

  async #ownedExpense(userId: number, id: number): Promise<Expense> {
    const [expense] = await this.#database
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
      .limit(1)
    if (!expense) throw notFound('expense')
    return expense
  }

  async #approvalMembership(
    userId: number,
    spentDate: string,
    running: boolean,
  ): Promise<ApprovalMembership> {
    const [submission] = await this.#database
      .select()
      .from(timesheetSubmissions)
      .where(
        and(
          eq(timesheetSubmissions.userId, userId),
          lte(timesheetSubmissions.periodStart, spentDate),
          gte(timesheetSubmissions.periodEnd, spentDate),
        ),
      )
      .limit(1)
    if (submission?.status === 'approved') {
      throw inputProblem(
        'spent_date',
        'approved_period',
        'The selected timesheet period is approved and locked.',
      )
    }
    if (submission?.status === 'submitted') {
      if (running) {
        throw inputProblem(
          'time_entry',
          'submitted_period_running',
          'A running timer cannot be started inside a submitted timesheet period.',
        )
      }
      return { approvalStatus: 'submitted', timesheetSubmissionId: submission.id }
    }
    return { approvalStatus: 'unsubmitted', timesheetSubmissionId: null }
  }

  async #translateApprovalPeriodWriteError(
    error: unknown,
    userId: number,
    spentDate: string,
    running: boolean,
    resource: 'time entry' | 'expense' = 'time entry',
  ): Promise<never> {
    throwIfPolicyLockWriteError(error)
    if (!isApprovalPeriodWriteError(error)) throw error
    await this.#approvalMembership(userId, spentDate, running)
    throw concurrentProblem(resource)
  }

  async #assertPolicyDateUnlocked(spentDate: string): Promise<void> {
    if (await this.#policy.isLocked({ entityType: 'tracked_date', spentDate })) {
      throw new TrackedMutationLockedError('policy_locked')
    }
  }

  async #timeRecord(entry: TimeEntry, preparedPolicyLocked?: boolean): Promise<TimeEntryRecord> {
    const policyLocked = preparedPolicyLocked ?? await this.#policy.isLocked({
      entityType: 'time_entry', entityId: entry.id,
    })
    try {
      const [state, noteRequirement] = await Promise.all([
        getTrackedState(this.#database, {
          entityType: 'time_entry',
          entityId: entry.id,
          policyLocked,
        }),
        resolveStoredTimeEntryNoteRequirement(this.#database, entry.userId, entry.projectId),
      ])
      return { ...entry, state, noteMinimumLength: noteRequirement?.minimumLength ?? 0 }
    } catch (error) {
      return translateTrackedNotFound(error, 'time entry')
    }
  }

  async #expenseRecord(expense: Expense, preparedPolicyLocked?: boolean): Promise<ExpenseRecord> {
    const policyLocked = preparedPolicyLocked ?? await this.#policy.isLocked({
      entityType: 'expense', entityId: expense.id,
    })
    try {
      const state = await getTrackedState(this.#database, {
        entityType: 'expense',
        entityId: expense.id,
        policyLocked,
      })
      return { ...expense, state }
    } catch (error) {
      return translateTrackedNotFound(error, 'expense')
    }
  }

  #timeConditions(actor: TimeEntryActor, filters: Readonly<TimeEntryFilters>): SQL[] {
    const conditions: SQL[] = [
      eq(timeEntries.userId, filters.userId ?? actor.userId),
      this.#timeEntryAccess(actor),
    ]
    if (filters.clientId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${projects} filter_project
        WHERE filter_project.id = ${timeEntries.projectId}
          AND filter_project.client_id = ${filters.clientId}
      )`)
    }
    if (filters.projectId !== undefined)
      conditions.push(eq(timeEntries.projectId, filters.projectId))
    if (filters.taskId !== undefined) conditions.push(eq(timeEntries.taskId, filters.taskId))
    if (filters.spentDate !== undefined)
      conditions.push(eq(timeEntries.spentDate, filters.spentDate))
    if (filters.from !== undefined) conditions.push(gte(timeEntries.spentDate, filters.from))
    if (filters.to !== undefined) conditions.push(lte(timeEntries.spentDate, filters.to))
    if (filters.approvalStatus !== undefined) {
      // Filter on the effective status, which is what the screen shows. An
      // instance with the approval module off holds `unsubmitted` in the
      // native column for every imported row, so matching only that column
      // makes `approval_status=approved` answer "none" over a book where
      // fourteen thousand rows were approved before this instance existed.
      // Where the native column is unsubmitted the imported answer stands in.
      conditions.push(effectiveApprovalStatus(timeEntries, filters.approvalStatus))
    }
    if (filters.invoiceId !== undefined)
      conditions.push(eq(timeEntries.invoiceId, filters.invoiceId))
    if (filters.isBilled !== undefined) {
      conditions.push(
        filters.isBilled ? isNotNull(timeEntries.invoiceId) : isNull(timeEntries.invoiceId),
      )
    }
    if (filters.isRunning !== undefined) {
      const running = or(
        isNotNull(timeEntries.timerStartedAt),
        and(isNotNull(timeEntries.startedTime), isNull(timeEntries.endedTime)),
      )!
      conditions.push(filters.isRunning ? running : not(running))
    }
    if (filters.billable !== undefined) conditions.push(eq(timeEntries.billable, filters.billable))
    if (filters.budgeted !== undefined) conditions.push(eq(timeEntries.budgeted, filters.budgeted))
    if (filters.externalReferenceId !== undefined) {
      conditions.push(
        sql`CAST(json_extract(${timeEntries.externalRef}, '$.id') AS TEXT) = ${filters.externalReferenceId}`,
      )
    }
    if (filters.updatedSince !== undefined) {
      conditions.push(
        sql`julianday(${timeEntries.updatedAt}) >= julianday(${filters.updatedSince})`,
      )
    }
    return conditions
  }

  #expenseConditions(userId: number, filters: Readonly<ExpenseFilters>): SQL[] {
    const conditions: SQL[] = [eq(expenses.userId, userId)]
    if (filters.clientId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${projects} filter_project
        WHERE filter_project.id = ${expenses.projectId}
          AND filter_project.client_id = ${filters.clientId}
      )`)
    }
    if (filters.projectId !== undefined) conditions.push(eq(expenses.projectId, filters.projectId))
    if (filters.expenseCategoryId !== undefined) {
      conditions.push(eq(expenses.expenseCategoryId, filters.expenseCategoryId))
    }
    if (filters.spentDate !== undefined) conditions.push(eq(expenses.spentDate, filters.spentDate))
    if (filters.from !== undefined) conditions.push(gte(expenses.spentDate, filters.from))
    if (filters.to !== undefined) conditions.push(lte(expenses.spentDate, filters.to))
    if (filters.approvalStatus !== undefined) {
      conditions.push(effectiveApprovalStatus(expenses, filters.approvalStatus))
    }
    if (filters.invoiceId !== undefined) conditions.push(eq(expenses.invoiceId, filters.invoiceId))
    if (filters.isBilled !== undefined) {
      conditions.push(filters.isBilled ? isNotNull(expenses.invoiceId) : isNull(expenses.invoiceId))
    }
    if (filters.billable !== undefined) conditions.push(eq(expenses.billable, filters.billable))
    if (filters.reimbursable !== undefined) {
      conditions.push(eq(expenses.reimbursable, filters.reimbursable))
    }
    if (filters.reimbursementStatus !== undefined) {
      conditions.push(eq(expenses.reimbursementStatus, filters.reimbursementStatus))
    }
    if (filters.updatedSince !== undefined) {
      conditions.push(sql`julianday(${expenses.updatedAt}) >= julianday(${filters.updatedSince})`)
    }
    return conditions
  }

  async timeEntryOptions(userId: number): Promise<readonly TimeEntryOptionRecord[]> {
    const organization = organizationTimeRounding(await this.#timeSettings())
    const rows = await this.#database
      .select()
      .from(userAssignments)
      .innerJoin(projects, eq(projects.id, userAssignments.projectId))
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .innerJoin(taskAssignments, eq(taskAssignments.projectId, projects.id))
      .innerJoin(tasks, eq(tasks.id, taskAssignments.taskId))
      .where(
        and(
          eq(userAssignments.userId, userId),
          eq(userAssignments.isActive, true),
          eq(projects.isActive, true),
          eq(clients.isActive, true),
          eq(taskAssignments.isActive, true),
          eq(tasks.isActive, true),
        ),
      )
      .orderBy(asc(userAssignments.projectId), asc(taskAssignments.taskId))
    return Promise.all(
      rows.map(async (row) => ({
        projectId: row.user_assignments.projectId,
        taskId: row.task_assignments.taskId,
        noteMinimumLength:
          (
            await resolveStoredTimeEntryNoteRequirement(
              this.#database,
              userId,
              row.user_assignments.projectId,
            )
          )?.minimumLength ?? 0,
        timeRounding: effectiveTimeRounding(organization, projectTimeRounding(row.projects)),
      })),
    )
  }

  timeEntries(
    actor: TimeEntryActor,
    filters: Readonly<TimeEntryFilters>,
  ): ResourceSource<TimeEntryRecord> {
    const conditions = this.#timeConditions(actor, filters)
    return {
      highWatermark: async () => {
        const [row] = await this.#database
          .select()
          .from(timeEntries)
          .where(and(...conditions))
          .orderBy(desc(timeEntries.id))
          .limit(1)
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await this.#database
          .select()
          .from(timeEntries)
          .where(
            and(
              ...conditions,
              lte(timeEntries.id, throughId),
              ...(afterId === null ? [] : [gt(timeEntries.id, afterId)]),
            ),
          )
          .orderBy(asc(timeEntries.id))
          .limit(take)
        const byDate = await this.#policy.lockedDates?.(rows.map(({ spentDate }) => spentDate))
        return Promise.all(rows.map((row) => this.#timeRecord(row, byDate?.get(row.spentDate))))
      },
    }
  }

  // Submission review is based on explicit teammates, not project co-membership.
  // Keep the predicate in every read query so a revoked assignment cannot be
  // reused by an already-created cursor source.
  #expenseReadAccess(viewer: Readonly<TeamViewer>, ownerId: SQL | SQLiteColumn): SQL {
    if (viewer.profile === 'administrator' || viewer.profile === 'executive_manager') return sql`1`
    if (viewer.profile !== 'project_manager') return sql`${ownerId} = ${viewer.userId}`
    return sql`(${ownerId} = ${viewer.userId} OR EXISTS (
      SELECT 1 FROM teammate_assignments reviewer
      WHERE reviewer.manager_id = ${viewer.userId} AND reviewer.user_id = ${ownerId}
    ))`
  }

  async canReadExpenseUser(viewer: Readonly<TeamViewer>, userId: number): Promise<boolean> {
    const [row] = await this.#database.select().from(users)
      .where(and(eq(users.id, userId), this.#expenseReadAccess(viewer, users.id))).limit(1)
    return row !== undefined
  }

  expenses(
    userId: number,
    filters: Readonly<ExpenseFilters>,
    viewer: Readonly<TeamViewer>,
  ): ResourceSource<ExpenseRecord> {
    const conditions = [
      ...this.#expenseConditions(userId, filters),
      this.#expenseReadAccess(viewer, expenses.userId),
    ]
    return {
      highWatermark: async () => {
        const [row] = await this.#database
          .select()
          .from(expenses)
          .where(and(...conditions))
          .orderBy(desc(expenses.id))
          .limit(1)
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await this.#database
          .select()
          .from(expenses)
          .where(
            and(
              ...conditions,
              lte(expenses.id, throughId),
              ...(afterId === null ? [] : [gt(expenses.id, afterId)]),
            ),
          )
          .orderBy(asc(expenses.id))
          .limit(take)
        const byDate = await this.#policy.lockedDates?.(rows.map(({ spentDate }) => spentDate))
        return Promise.all(rows.map((row) => this.#expenseRecord(row, byDate?.get(row.spentDate))))
      },
    }
  }

  async getTimeEntry(actor: TimeEntryActor, id: number): Promise<TimeEntryRecord> {
    return this.#timeRecord(await this.#accessibleTimeEntry(actor, id))
  }

  async getExpense(
    viewer: Readonly<TeamViewer>,
    id: number,
  ): Promise<ExpenseRecord> {
    const [expense] = await this.#database.select().from(expenses)
      .where(and(eq(expenses.id, id), this.#expenseReadAccess(viewer, expenses.userId))).limit(1)
    if (expense === undefined) throw notFound('expense')
    return this.#expenseRecord(expense)
  }

  async createTimeEntry(
    actor: TimeEntryActor,
    input: Readonly<CreateTimeEntryRequest>,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    // Everything below is the owner's: their assignments, their timesheet,
    // their rates. Only the audit names the actor.
    const userId = input.userId ?? actor.userId
    const onBehalf = userId !== actor.userId
    if (onBehalf && !canManageTeammateTime(actor.profile)) {
      throw inputProblem('user_id', 'forbidden', 'only an administrator may log time for another person')
    }
    const settings = await this.#timeSettings()
    // The clock is UTC, because an instant is. The *date* a running timer is
    // filed under is the operator's, not UTC's: west of UTC those differ every
    // evening, so a 23:14 Saturday session lands on Sunday and a Sunday-evening
    // session lands in next week's timesheet entirely (issue 651).
    //
    // The refusals below are about the current local date. Nothing applied a
    // timezone until issue 651; the day now follows the user's zone, falling
    // back to the organization's.
    const zone = await this.#effectiveTimezone(userId, settings)
    const local = localBoundary(boundary, zone)
    const assignment = await this.#resolveTimeAssignment(userId, input.projectId, input.taskId)
    const base = {
      userId,
      projectId: input.projectId,
      taskId: input.taskId,
      userAssignmentId: assignment.userAssignmentId,
      taskAssignmentId: assignment.taskAssignmentId,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.budgeted !== undefined ? { budgeted: input.budgeted } : {}),
      ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
      ...(input.calendarEventRef !== undefined ? { calendarEventRef: input.calendarEventRef } : {}),
    }
    // Times make a start/end entry in either mode (issue 943): the calendar
    // records an interval even where everything else records a duration. The
    // organization's mode decides only what a request without times means.
    const carriesTimes = input.startedTime !== undefined || input.endedTime !== undefined
    let created: TimeEntry
    if (settings.timeEntryMode === 'duration' && !carriesTimes) {
      if (input.seconds === undefined) {
        if (onBehalf) throw timerForSomebodyElse()
        if (input.spentDate !== undefined && input.spentDate !== local.date) {
          throw inputProblem(
            'spent_date',
            'timer_owned',
            'a running timer must use the current organization-local date',
          )
        }
        await this.#assertPolicyDateUnlocked(local.date)
        const runningEntryPolicyLocked = await this.#policy.isLocked({
          entityType: 'running_time_entry_replacement',
          userId,
        })
        const approval = await this.#approvalMembership(userId, local.date, true)
        try {
          created = await startTimeEntry(
            this.#database,
            { ...base, ...approval },
            local,
            runningEntryPolicyLocked,
          )
        } catch (error) {
          return this.#translateApprovalPeriodWriteError(error, userId, local.date, true)
        }
      } else {
        if (input.spentDate === undefined) {
          throw inputProblem('spent_date', 'required', 'spent_date is required for a stopped entry')
        }
        await this.#assertPolicyDateUnlocked(input.spentDate)
        const approval = await this.#approvalMembership(userId, input.spentDate, false)
        try {
          created = await createStoppedTimeEntry(
            this.#database,
            {
              ...base,
              ...approval,
              spentDate: input.spentDate,
              seconds: input.seconds,
              createdAt: boundary.instant,
              updatedAt: boundary.instant,
            },
            onBehalfAudit(actor, userId, { action: 'create' }, boundary.instant),
          )
        } catch (error) {
          return this.#translateApprovalPeriodWriteError(error, userId, input.spentDate, false)
        }
      }
    } else {
      if (input.seconds !== undefined) {
        throw inputProblem(
          'seconds',
          'mode_mismatch',
          'start/end entries derive seconds from times',
        )
      }
      if (input.endedTime === undefined) {
        // A running entry keeps the organization's shape (invariant 2), so a
        // duration organization's timer is a duration timer. The trigger that
        // stops a person's previous timer cannot measure between the two
        // shapes: one is a UTC instant, the other a local wall-clock time.
        if (settings.timeEntryMode === 'duration') {
          throw inputProblem(
            'started_time',
            'mode_mismatch',
            'a timer in a duration organization runs without times; send ended_time as well to log a stopped start/end entry',
          )
        }
        if (onBehalf) throw timerForSomebodyElse()
        if (input.spentDate !== undefined && input.spentDate !== local.date) {
          throw inputProblem(
            'spent_date',
            'timer_owned',
            'a running timer must use the current organization-local date',
          )
        }
        if (input.startedTime !== undefined && input.startedTime !== local.time) {
          throw inputProblem(
            'started_time',
            'timer_owned',
            'a running timer must use the current organization-local start time',
          )
        }
        await this.#assertPolicyDateUnlocked(local.date)
        const runningEntryPolicyLocked = await this.#policy.isLocked({
          entityType: 'running_time_entry_replacement',
          userId,
        })
        const approval = await this.#approvalMembership(userId, local.date, true)
        try {
          created = await startTimeEntry(
            this.#database,
            { ...base, ...approval },
            local,
            runningEntryPolicyLocked,
          )
        } catch (error) {
          return this.#translateApprovalPeriodWriteError(error, userId, local.date, true)
        }
      } else {
        if (input.spentDate === undefined || input.startedTime === undefined) {
          throw inputProblem(
            'started_time',
            'required',
            'spent_date and started_time are required with ended_time',
          )
        }
        await this.#assertPolicyDateUnlocked(input.spentDate)
        const approval = await this.#approvalMembership(userId, input.spentDate, false)
        try {
          created = await createStoppedTimeEntry(
            this.#database,
            {
              ...base,
              ...approval,
              spentDate: input.spentDate,
              startedTime: input.startedTime,
              endedTime: input.endedTime,
              createdAt: boundary.instant,
              updatedAt: boundary.instant,
            },
            onBehalfAudit(actor, userId, { action: 'create' }, boundary.instant),
          )
        } catch (error) {
          return this.#translateApprovalPeriodWriteError(error, userId, input.spentDate, false)
        }
      }
    }
    return this.#timeRecord(created)
  }

  async updateTimeEntry(
    actor: TimeEntryActor,
    id: number,
    input: Readonly<UpdateTimeEntryRequest>,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#accessibleTimeEntry(actor, id)
    // The owner's rules, not the actor's: an administrator correcting somebody
    // else's time is held to that person's assignments, timesheet and note
    // requirement, and the entry stays theirs (#917).
    const userId = entry.userId
    const timingOrAssignmentChange =
      input.projectId !== undefined ||
      input.taskId !== undefined ||
      input.spentDate !== undefined ||
      input.seconds !== undefined ||
      input.startedTime !== undefined ||
      input.endedTime !== undefined
    if (isRunning(entry) && timingOrAssignmentChange) {
      throw inputProblem(
        'time_entry',
        'timer_running',
        'stop the timer before changing assignment or timing fields',
      )
    }

    const projectId = input.projectId ?? entry.projectId
    const taskId = input.taskId ?? entry.taskId
    const spentDate = input.spentDate ?? entry.spentDate
    if (spentDate !== entry.spentDate) await this.#assertPolicyDateUnlocked(spentDate)
    const approval: ApprovalMembership =
      entry.approvalStatus === 'approved' || spentDate === entry.spentDate
        ? {
            approvalStatus: entry.approvalStatus,
            timesheetSubmissionId: entry.timesheetSubmissionId,
          }
        : await this.#approvalMembership(userId, spentDate, false)
    const assignmentChanged = projectId !== entry.projectId || taskId !== entry.taskId
    const dateChanged = spentDate !== entry.spentDate
    const assignment = assignmentChanged
      ? await this.#resolveTimeAssignment(userId, projectId, taskId)
      : {
          userAssignmentId: entry.userAssignmentId,
          taskAssignmentId: entry.taskAssignmentId,
          billable: entry.billable,
        }
    const notes = input.notes !== undefined ? input.notes : entry.notes
    await assertStoredTimeEntryNoteRequirement(this.#database, userId, projectId, notes)

    let seconds = entry.seconds
    let secondsWithoutTimer = entry.secondsWithoutTimer
    let roundedSeconds = entry.roundedSeconds
    let startedTime = entry.startedTime
    let endedTime = entry.endedTime
    const timingChanged =
      dateChanged ||
      input.seconds !== undefined ||
      input.startedTime !== undefined ||
      input.endedTime !== undefined
    const entryMode = entry.startedTime === null ? 'duration' : 'start_end'
    if (entryMode === 'duration') {
      if (input.startedTime !== undefined || input.endedTime !== undefined) {
        throw inputProblem(
          'started_time',
          'mode_mismatch',
          'duration entries do not accept start/end times',
        )
      }
      if (input.seconds !== undefined) seconds = input.seconds
    } else {
      if (input.seconds !== undefined) {
        throw inputProblem(
          'seconds',
          'mode_mismatch',
          'start/end entries derive seconds from times',
        )
      }
      startedTime = input.startedTime ?? entry.startedTime
      endedTime = input.endedTime ?? entry.endedTime
      if (timingChanged) {
        if (startedTime === null || endedTime === null) {
          throw inputProblem(
            'ended_time',
            'required',
            'a stopped start/end entry requires both times',
          )
        }
        seconds = elapsedWallClockSeconds(0, spentDate, startedTime, spentDate, endedTime, true)
      }
    }
    if (timingChanged) secondsWithoutTimer = seconds
    // Rounded under the rule of the project it ends up on (issue 949): a new
    // duration, and a move to a project that rounds differently, both re-round.
    // A negative duration is an imported correction and keeps its source's
    // figure, whichever project it is filed under.
    if ((timingChanged || projectId !== entry.projectId) && seconds >= 0) {
      roundedSeconds = roundTimeSeconds(
        seconds,
        await timeRoundingForProject(this.#database, projectId),
      )
    }

    const rates =
      assignmentChanged || dateChanged
        ? await resolveEntryRates(this.#database, {
            userId,
            projectId,
            taskId,
            userAssignmentId: assignment.userAssignmentId,
            taskAssignmentId: assignment.taskAssignmentId,
            spentDate,
          })
        : {
            billableRateCents: entry.billableRateCents,
            costRateCents: entry.costRateCents,
          }
    const policyLocked = await this.#policy.isLocked({ entityType: 'time_entry', entityId: id })
    let updated: Record<string, unknown>
    try {
      updated = await executeAtomicTrackedMutation(
        this.#database,
        { entityType: 'time_entry', entityId: id, policyLocked },
        (mutationPredicate) =>
          this.#database
            .update(timeEntries)
            .set({
              projectId,
              taskId,
              userAssignmentId: assignment.userAssignmentId,
              taskAssignmentId: assignment.taskAssignmentId,
              spentDate,
              seconds,
              secondsWithoutTimer,
              roundedSeconds,
              startedTime,
              endedTime,
              billable: assignment.billable,
              billableRateCents: rates.billableRateCents,
              costRateCents: rates.costRateCents,
              approvalStatus: approval.approvalStatus,
              timesheetSubmissionId: approval.timesheetSubmissionId,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.budgeted !== undefined ? { budgeted: input.budgeted } : {}),
              ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
              ...(input.calendarEventRef !== undefined
                ? { calendarEventRef: input.calendarEventRef }
                : {}),
              updatedAt: boundary.instant,
            })
            .where(
              and(
                eq(timeEntries.userId, userId),
                eq(timeEntries.updatedAt, entry.updatedAt),
                mutationPredicate,
                currentTimeEntryNotePolicyAllows(userId, projectId, notes),
              ),
            )
            .returning(),
        () => concurrentProblem('time entry'),
        onBehalfAudit(actor, userId, { action: 'update', before: entry }, boundary.instant),
      )
    } catch (error) {
      throwIfPolicyLockWriteError(error)
      await assertStoredTimeEntryNoteRequirement(this.#database, userId, projectId, notes)
      if (isApprovalPeriodWriteError(error)) {
        return this.#translateApprovalPeriodWriteError(error, userId, spentDate, false)
      }
      return translateTrackedNotFound(error, 'time entry')
    }
    return this.#timeRecord(mapReturnedTimeEntry(updated))
  }

  async deleteTimeEntry(
    actor: TimeEntryActor,
    id: number,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#accessibleTimeEntry(actor, id)
    const noteRequirement = await resolveStoredTimeEntryNoteRequirement(
      this.#database,
      entry.userId,
      entry.projectId,
    )
    const policyLocked = await this.#policy.isLocked({ entityType: 'time_entry', entityId: id })
    let deleted: Record<string, unknown>
    try {
      deleted = await executeAtomicTrackedMutation(
        this.#database,
        { entityType: 'time_entry', entityId: id, policyLocked },
        (mutationPredicate) =>
          this.#database
            .delete(timeEntries)
            .where(
              and(
                eq(timeEntries.userId, entry.userId),
                eq(timeEntries.updatedAt, entry.updatedAt),
                mutationPredicate,
              ),
            )
            .returning(),
        () => concurrentProblem('time entry'),
        onBehalfAudit(actor, entry.userId, { action: 'delete', before: entry }, boundary.instant),
      )
    } catch (error) {
      return translateTrackedNotFound(error, 'time entry')
    }
    const row = mapReturnedTimeEntry(deleted)
    return {
      ...row,
      state: {
        approvalStatus: row.approvalStatus,
        invoiceId: row.invoiceId,
        isBilled: row.invoiceId !== null,
        isLocked: false,
        lockedReasonCode: null,
        lockedReason: null,
      },
      noteMinimumLength: noteRequirement?.minimumLength ?? 0,
    }
  }

  async stopTimeEntry(
    actor: TimeEntryActor,
    id: number,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#accessibleTimeEntry(actor, id)
    if (!isRunning(entry)) {
      throw inputProblem('time_entry', 'not_running', 'time entry is not running')
    }
    const policyLocked = await this.#policy.isLocked({ entityType: 'time_entry', entityId: id })
    // A start/end timer started on its owner's wall clock, so it stops on it
    // too (issue 945): measured against the UTC clock, a 09:00 timer stopped
    // at 10:00 in a zone six hours west ran seven hours and ended at 16:00. The
    // owner's zone, not the actor's, for the same reason the day is theirs.
    const local = await this.#ownerBoundary(entry.userId, boundary)
    try {
      return this.#timeRecord(
        await stopTimeEntry(
          this.#database,
          id,
          local,
          policyLocked,
          onBehalfAudit(actor, entry.userId, { action: 'stop', before: entry }, boundary.instant),
        ),
      )
    } catch (error) {
      return translateTrackedNotFound(error, 'time entry')
    }
  }

  async restartTimeEntry(
    actor: TimeEntryActor,
    id: number,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#accessibleTimeEntry(actor, id)
    // Restarting is starting a timer, and a timer is its owner's to start: an
    // administrator may stop somebody's timer but not set one running (#917).
    if (entry.userId !== actor.userId) {
      throw inputProblem(
        'time_entry',
        'timer_owned',
        'a timer can only be restarted by the person it tracks',
      )
    }
    const userId = entry.userId
    if (isRunning(entry)) {
      throw inputProblem('time_entry', 'already_running', 'time entry is already running')
    }
    if (entry.approvalStatus === 'submitted') {
      throw inputProblem(
        'time_entry',
        'submitted_period_running',
        'A running timer cannot be started inside a submitted timesheet period.',
      )
    }
    if (entry.approvalStatus === 'unsubmitted') {
      await this.#approvalMembership(userId, entry.spentDate, true)
    }
    const [policyLocked, runningEntryPolicyLocked] = await Promise.all([
      this.#policy.isLocked({ entityType: 'time_entry', entityId: id }),
      this.#policy.isLocked({ entityType: 'running_time_entry_replacement', userId }),
    ])
    // A start/end restart starts on the local date and time, as a new timer
    // does (issue 945).
    const local = await this.#ownerBoundary(userId, boundary)
    try {
      return this.#timeRecord(
        await restartTimeEntry(
          this.#database,
          id,
          local,
          policyLocked,
          runningEntryPolicyLocked,
        ),
      )
    } catch (error) {
      throwIfPolicyLockWriteError(error)
      if (isApprovalPeriodWriteError(error)) {
        return this.#translateApprovalPeriodWriteError(error, userId, entry.spentDate, true)
      }
      return translateTrackedNotFound(error, 'time entry')
    }
  }

  async createExpense(
    userId: number,
    input: Readonly<CreateExpenseRequest>,
    boundary: TimeBoundary,
  ): Promise<ExpenseRecord> {
    await this.#assertPolicyDateUnlocked(input.spentDate)
    await this.#approvalMembership(userId, input.spentDate, false)
    await this.#requireProjectAssignment(userId, input.projectId)
    const [category] = await this.#database
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.expenseCategoryId))
      .limit(1)
    if (!category || !category.isActive) {
      throw inputProblem(
        'expense_category_id',
        'inactive',
        'expense category must exist and be active',
      )
    }
    try {
      computeExpenseTotalCents(category.unitPriceCents, input)
    } catch (error) {
      throw inputProblem(
        category.unitPriceCents === null ? 'total_cost_cents' : 'units',
        'category_pricing_mismatch',
        error instanceof Error ? error.message : 'expense pricing does not match the category',
      )
    }
    let created: Expense
    try {
      created = await createExpense(this.#database, {
        userId,
        projectId: input.projectId,
        expenseCategoryId: input.expenseCategoryId,
        spentDate: input.spentDate,
        createdAt: boundary.instant,
        updatedAt: boundary.instant,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.units !== undefined ? { units: input.units } : {}),
        ...(input.totalCostCents !== undefined ? { totalCostCents: input.totalCostCents } : {}),
        ...(input.billable !== undefined ? { billable: input.billable } : {}),
        ...(input.reimbursable !== undefined ? { reimbursable: input.reimbursable } : {}),
      })
    } catch (error) {
      throwIfPolicyLockWriteError(error)
      if (isApprovalPeriodWriteError(error)) {
        return this.#translateApprovalPeriodWriteError(
          error,
          userId,
          input.spentDate,
          false,
          'expense',
        )
      }
      if (
        error instanceof Error &&
        /expense category|computed totalCostCents|expense creation did not/.test(error.message)
      ) {
        throw concurrentProblem('expense')
      }
      throw error
    }
    return this.#expenseRecord(created)
  }

  async updateExpense(
    userId: number,
    id: number,
    input: Readonly<UpdateExpenseRequest>,
    boundary: TimeBoundary,
  ): Promise<ExpenseRecord> {
    const expense = await this.#ownedExpense(userId, id)
    const projectId = input.projectId ?? expense.projectId
    const spentDate = input.spentDate ?? expense.spentDate
    if (spentDate !== expense.spentDate) await this.#assertPolicyDateUnlocked(spentDate)
    const approval: ApprovalMembership =
      expense.approvalStatus === 'approved' || spentDate === expense.spentDate
        ? {
            approvalStatus: expense.approvalStatus,
            timesheetSubmissionId: expense.timesheetSubmissionId,
          }
        : await this.#approvalMembership(userId, spentDate, false)
    if (projectId !== expense.projectId) await this.#requireProjectAssignment(userId, projectId)
    const expenseCategoryId = input.expenseCategoryId ?? expense.expenseCategoryId
    const categoryChanged = expenseCategoryId !== expense.expenseCategoryId
    const pricingTouched =
      categoryChanged || input.units !== undefined || input.totalCostCents !== undefined
    let units = expense.units
    let totalCostCents = expense.totalCostCents
    let pricePredicate: SQL | undefined
    if (pricingTouched) {
      if (input.units !== undefined && input.totalCostCents !== undefined) {
        throw inputProblem(
          'units',
          'mutually_exclusive',
          'send units or total_cost_cents, not both',
        )
      }
      if (input.units === undefined && input.totalCostCents === undefined) {
        throw inputProblem(
          'expense_category_id',
          'pricing_required',
          'changing expense_category_id requires units or total_cost_cents',
        )
      }
      const [category] = await this.#database
        .select()
        .from(expenseCategories)
        .where(eq(expenseCategories.id, expenseCategoryId))
        .limit(1)
      if (!category || !category.isActive) {
        throw inputProblem(
          'expense_category_id',
          'inactive',
          'expense category must exist and be active',
        )
      }
      let computed: ReturnType<typeof computeExpenseTotalCents>
      try {
        computed = computeExpenseTotalCents(category.unitPriceCents, {
          ...(input.units !== undefined ? { units: input.units } : {}),
          ...(input.totalCostCents !== undefined ? { totalCostCents: input.totalCostCents } : {}),
        })
      } catch (error) {
        throw inputProblem(
          category.unitPriceCents === null ? 'total_cost_cents' : 'units',
          'category_pricing_mismatch',
          error instanceof Error ? error.message : 'expense pricing does not match the category',
        )
      }
      units = computed.units
      totalCostCents = computed.totalCostCents
      pricePredicate = sql`EXISTS (
        SELECT 1 FROM ${expenseCategories} category
        WHERE category.id = ${expenseCategoryId}
          AND category.is_active = 1
          AND category.unit_price_cents IS ${category.unitPriceCents}
      )`
    }
    if (pricingTouched && (totalCostCents < 0 || totalCostCents > moneyUpperBound)) {
      throw inputProblem('total_cost_cents', 'out_of_range', 'total_cost_cents is out of range')
    }
    const policyLocked = await this.#policy.isLocked({ entityType: 'expense', entityId: id })
    let updated: Record<string, unknown>
    try {
      updated = await executeAtomicTrackedMutation(
        this.#database,
        { entityType: 'expense', entityId: id, policyLocked },
        (mutationPredicate) =>
          this.#database
            .update(expenses)
            .set({
              projectId,
              expenseCategoryId,
              units,
              totalCostCents,
              spentDate,
              approvalStatus: approval.approvalStatus,
              timesheetSubmissionId: approval.timesheetSubmissionId,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.billable !== undefined ? { billable: input.billable } : {}),
              ...(input.reimbursable !== undefined ? { reimbursable: input.reimbursable } : {}),
              updatedAt: boundary.instant,
            })
            .where(
              and(
                eq(expenses.userId, userId),
                eq(expenses.updatedAt, expense.updatedAt),
                ...(pricePredicate === undefined ? [] : [pricePredicate]),
                mutationPredicate,
              ),
            )
            .returning(),
        () => concurrentProblem('expense'),
      )
    } catch (error) {
      if (isApprovalPeriodWriteError(error)) {
        return this.#translateApprovalPeriodWriteError(
          error,
          userId,
          spentDate,
          false,
          'expense',
        )
      }
      return translateTrackedNotFound(error, 'expense')
    }
    return this.#expenseRecord(mapReturnedExpense(updated))
  }

  async deleteExpense(userId: number, id: number): Promise<ExpenseRecord> {
    const expense = await this.#ownedExpense(userId, id)
    const policyLocked = await this.#policy.isLocked({ entityType: 'expense', entityId: id })
    let deleted: Record<string, unknown>
    try {
      deleted = await executeAtomicTrackedMutation(
        this.#database,
        { entityType: 'expense', entityId: id, policyLocked },
        (mutationPredicate) =>
          this.#database
            .delete(expenses)
            .where(
              and(
                eq(expenses.userId, userId),
                eq(expenses.updatedAt, expense.updatedAt),
                mutationPredicate,
              ),
            )
            .returning(),
        () => concurrentProblem('expense'),
      )
    } catch (error) {
      return translateTrackedNotFound(error, 'expense')
    }
    const row = mapReturnedExpense(deleted)
    return {
      ...row,
      state: {
        approvalStatus: row.approvalStatus,
        invoiceId: row.invoiceId,
        isBilled: row.invoiceId !== null,
        isLocked: false,
        lockedReasonCode: null,
        lockedReason: null,
      },
    }
  }
}
