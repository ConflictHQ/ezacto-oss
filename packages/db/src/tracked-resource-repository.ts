import {
  TrackedResourceAssignmentError,
  TrackedResourceConflictError,
  TrackedResourceInputError,
  TrackedResourceNotFoundError,
  type ApprovalStatus,
  type TrackedState,
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
  roundSeconds,
  startTimeEntry,
  stopTimeEntry,
  type TimeBoundary,
  type TimeEntry,
} from './time-entries.js'
import {
  assertStoredTimeEntryNoteRequirement,
  currentTimeEntryNotePolicyAllows,
  resolveStoredTimeEntryNoteRequirement,
} from './time-entry-note-requirements.js'
import { resolveEntryRates } from './rate-resolver.js'
import {
  clients,
  expenseCategories,
  expenses,
  organizations,
  projects,
  taskAssignments,
  tasks,
  timeEntries,
  userAssignments,
} from './schema.js'
import {
  executeAtomicTrackedMutation,
  getTrackedState,
  TrackedEntityNotFoundError,
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

const translateTrackedNotFound = (error: unknown, resource: 'time entry' | 'expense'): never => {
  if (error instanceof TrackedEntityNotFoundError) throw notFound(resource)
  throw error
}

export type TrackedResourceDatabase = Parameters<typeof getTrackedState>[0]

export type PolicySubject =
  | { entityType: 'time_entry' | 'expense'; entityId: number }
  | { entityType: 'running_time_entry_replacement'; userId: number }

export interface TrackedPolicyResolver {
  isLocked(subject: Readonly<PolicySubject>): Promise<boolean>
}

export interface TrackedResourceClock {
  now(): TimeBoundary
}

export interface TimeEntryRecord extends TimeEntry {
  state: TrackedState
  noteMinimumLength: number
}

export interface ExpenseRecord extends Expense {
  state: TrackedState
}

export interface TimeEntryFilters {
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

export interface UpdateOrganizationTimeEntryNoteSettings {
  required?: boolean
  minimumLength?: number
}

export interface CreateTimeEntryRequest {
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

type TimeSettings = Pick<
  typeof organizations.$inferSelect,
  'timeEntryMode' | 'timeRounding'
>

const moneyUpperBound = 9_000_000_000_000

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

  async #ownedTimeEntry(userId: number, id: number): Promise<TimeEntry> {
    const [entry] = await this.#database
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.id, id), eq(timeEntries.userId, userId)))
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

  async #timeRecord(entry: TimeEntry): Promise<TimeEntryRecord> {
    const policyLocked = await this.#policy.isLocked({
      entityType: 'time_entry',
      entityId: entry.id,
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

  async #expenseRecord(expense: Expense): Promise<ExpenseRecord> {
    const policyLocked = await this.#policy.isLocked({
      entityType: 'expense',
      entityId: expense.id,
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

  #timeConditions(userId: number, filters: Readonly<TimeEntryFilters>): SQL[] {
    const conditions: SQL[] = [eq(timeEntries.userId, userId)]
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
      conditions.push(eq(timeEntries.approvalStatus, filters.approvalStatus))
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
      conditions.push(eq(expenses.approvalStatus, filters.approvalStatus))
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

  async timeEntryOptions(
    userId: number,
  ): Promise<readonly { projectId: number; taskId: number; noteMinimumLength: number }[]> {
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
      })),
    )
  }

  timeEntries(
    userId: number,
    filters: Readonly<TimeEntryFilters>,
  ): ResourceSource<TimeEntryRecord> {
    const conditions = this.#timeConditions(userId, filters)
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
        return Promise.all(rows.map((row) => this.#timeRecord(row)))
      },
    }
  }

  expenses(userId: number, filters: Readonly<ExpenseFilters>): ResourceSource<ExpenseRecord> {
    const conditions = this.#expenseConditions(userId, filters)
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
        return Promise.all(rows.map((row) => this.#expenseRecord(row)))
      },
    }
  }

  async getTimeEntry(userId: number, id: number): Promise<TimeEntryRecord> {
    return this.#timeRecord(await this.#ownedTimeEntry(userId, id))
  }

  async getExpense(userId: number, id: number): Promise<ExpenseRecord> {
    return this.#expenseRecord(await this.#ownedExpense(userId, id))
  }

  async createTimeEntry(
    userId: number,
    input: Readonly<CreateTimeEntryRequest>,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const settings = await this.#timeSettings()
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
    let created: TimeEntry
    if (settings.timeEntryMode === 'duration') {
      if (input.startedTime !== undefined || input.endedTime !== undefined) {
        throw inputProblem(
          'started_time',
          'mode_mismatch',
          'duration entries do not accept start/end times',
        )
      }
      if (input.seconds === undefined) {
        if (input.spentDate !== undefined && input.spentDate !== boundary.date) {
          throw inputProblem(
            'spent_date',
            'timer_owned',
            'a running timer must use the current organization-local date',
          )
        }
        const runningEntryPolicyLocked = await this.#policy.isLocked({
          entityType: 'running_time_entry_replacement',
          userId,
        })
        created = await startTimeEntry(this.#database, base, boundary, runningEntryPolicyLocked)
      } else {
        if (input.spentDate === undefined) {
          throw inputProblem('spent_date', 'required', 'spent_date is required for a stopped entry')
        }
        created = await createStoppedTimeEntry(this.#database, {
          ...base,
          spentDate: input.spentDate,
          seconds: input.seconds,
          createdAt: boundary.instant,
          updatedAt: boundary.instant,
        })
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
        if (input.spentDate !== undefined && input.spentDate !== boundary.date) {
          throw inputProblem(
            'spent_date',
            'timer_owned',
            'a running timer must use the current organization-local date',
          )
        }
        if (input.startedTime !== undefined && input.startedTime !== boundary.time) {
          throw inputProblem(
            'started_time',
            'timer_owned',
            'a running timer must use the current organization-local start time',
          )
        }
        const runningEntryPolicyLocked = await this.#policy.isLocked({
          entityType: 'running_time_entry_replacement',
          userId,
        })
        created = await startTimeEntry(this.#database, base, boundary, runningEntryPolicyLocked)
      } else {
        if (input.spentDate === undefined || input.startedTime === undefined) {
          throw inputProblem(
            'started_time',
            'required',
            'spent_date and started_time are required with ended_time',
          )
        }
        created = await createStoppedTimeEntry(this.#database, {
          ...base,
          spentDate: input.spentDate,
          startedTime: input.startedTime,
          endedTime: input.endedTime,
          createdAt: boundary.instant,
          updatedAt: boundary.instant,
        })
      }
    }
    return this.#timeRecord(created)
  }

  async updateTimeEntry(
    userId: number,
    id: number,
    input: Readonly<UpdateTimeEntryRequest>,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#ownedTimeEntry(userId, id)
    const settings = await this.#timeSettings()
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
    if (timingChanged) {
      secondsWithoutTimer = seconds
      roundedSeconds = roundSeconds(seconds, settings.timeRounding)
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
      )
    } catch (error) {
      await assertStoredTimeEntryNoteRequirement(this.#database, userId, projectId, notes)
      return translateTrackedNotFound(error, 'time entry')
    }
    return this.#timeRecord(mapReturnedTimeEntry(updated))
  }

  async deleteTimeEntry(userId: number, id: number): Promise<TimeEntryRecord> {
    const entry = await this.#ownedTimeEntry(userId, id)
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
                eq(timeEntries.userId, userId),
                eq(timeEntries.updatedAt, entry.updatedAt),
                mutationPredicate,
              ),
            )
            .returning(),
        () => concurrentProblem('time entry'),
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
    userId: number,
    id: number,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#ownedTimeEntry(userId, id)
    if (!isRunning(entry)) {
      throw inputProblem('time_entry', 'not_running', 'time entry is not running')
    }
    const policyLocked = await this.#policy.isLocked({ entityType: 'time_entry', entityId: id })
    try {
      return this.#timeRecord(await stopTimeEntry(this.#database, id, boundary, policyLocked))
    } catch (error) {
      return translateTrackedNotFound(error, 'time entry')
    }
  }

  async restartTimeEntry(
    userId: number,
    id: number,
    boundary: TimeBoundary,
  ): Promise<TimeEntryRecord> {
    const entry = await this.#ownedTimeEntry(userId, id)
    if (isRunning(entry)) {
      throw inputProblem('time_entry', 'already_running', 'time entry is already running')
    }
    const [policyLocked, runningEntryPolicyLocked] = await Promise.all([
      this.#policy.isLocked({ entityType: 'time_entry', entityId: id }),
      this.#policy.isLocked({ entityType: 'running_time_entry_replacement', userId }),
    ])
    try {
      return this.#timeRecord(
        await restartTimeEntry(
          this.#database,
          id,
          boundary,
          policyLocked,
          runningEntryPolicyLocked,
        ),
      )
    } catch (error) {
      return translateTrackedNotFound(error, 'time entry')
    }
  }

  async createExpense(
    userId: number,
    input: Readonly<CreateExpenseRequest>,
    boundary: TimeBoundary,
  ): Promise<ExpenseRecord> {
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
    if (totalCostCents < 0 || totalCostCents > moneyUpperBound) {
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
              ...(input.spentDate !== undefined ? { spentDate: input.spentDate } : {}),
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
