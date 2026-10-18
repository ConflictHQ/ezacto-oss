import { and, eq, getTableColumns, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  assertTimeRoundingPolicy,
  effectiveTimeRounding,
  roundTimeSeconds,
  type ApprovalStatus,
  type EffectiveTimeRounding,
} from '@ezacto/core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { resolveEntryRates } from './rate-resolver.js'
import { organizations, projects, taskAssignments, timeEntries } from './schema.js'
import {
  assertStoredTimeEntryNoteRequirement,
  currentTimeEntryNotePolicyAllows,
} from './time-entry-note-requirements.js'
import {
  executeAtomicTrackedMutation,
  executeAtomicWrite,
  type CompiledQuery,
  type RunningTimeEntryReplacementReference,
  type TrackedEntityReference,
} from './tracked-state.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type TimeEntry = typeof timeEntries.$inferSelect

export interface TimeBoundary {
  /** Canonical UTC timestamp used by duration timers and audit timestamps. */
  instant: string
  /** Organization-local ISO date supplied by the caller's clock seam. */
  date: string
  /** Organization-local canonical 24-hour time. */
  time: string
}

interface TimeEntryBaseInput {
  harvestId?: string | null
  userId: number
  projectId: number
  taskId: number
  userAssignmentId: number
  taskAssignmentId: number
  notes?: string | null
  budgeted?: boolean
  externalRef?: Record<string, unknown> | null
  calendarEventRef?: Record<string, unknown> | null
  approvalStatus?: ApprovalStatus
  timesheetSubmissionId?: number | null
  sourceApprovalStatus?: ApprovalStatus | null
}

export type StartTimeEntryInput = TimeEntryBaseInput

export interface CreateStoppedTimeEntryInput extends TimeEntryBaseInput {
  spentDate: string
  /** A duration entry's length: duration mode only, and never with times. */
  seconds?: number
  /**
   * A start/end entry's interval, with `endedTime`: required in start/end
   * mode, and accepted in duration mode too (issue 943). Seconds derive from it.
   */
  startedTime?: string
  /** Required with `startedTime`. */
  endedTime?: string
  createdAt: string
  updatedAt: string
}

type OrganizationTimeSettings = Pick<typeof organizations.$inferSelect, 'timeEntryMode'>

const assertNonnegativeSeconds = (seconds: number, field = 'seconds'): void => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`)
  }
}

/**
 * The rule an entry on this project is saved under (issue 949): the project's
 * own where it has one, else the organization's. Read when the entry is
 * written, so the rounded figure stored with it is the rule of that moment.
 * A project that does not exist reads as the organization's rule; the write
 * that asked is refused by its own foreign key.
 */
export const timeRoundingForProject = async (
  database: Database,
  projectId: number,
): Promise<EffectiveTimeRounding> => {
  const [row] = await database
    .select()
    .from(organizations)
    .leftJoin(projects, eq(projects.id, projectId))
    .where(eq(organizations.id, 1))
    .limit(1)
  if (!row) throw new Error('organization must exist before writing time entries')
  const project = row.projects
  return effectiveTimeRounding(
    assertTimeRoundingPolicy({
      mode: row.organizations.timeRoundingMode,
      minutes: row.organizations.timeRoundingMinutes,
    }),
    project === null || project.timeRoundingMode === null
      ? null
      : assertTimeRoundingPolicy({
          mode: project.timeRoundingMode,
          minutes: project.timeRoundingMinutes,
        }),
  )
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const timePattern = /^(\d{2}):(\d{2})$/
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const parseDate = (value: string): number => {
  const match = datePattern.exec(value)
  if (!match) throw new RangeError(`date must be canonical YYYY-MM-DD: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const milliseconds = Date.UTC(year, month - 1, day)
  const date = new Date(milliseconds)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`date must be a real calendar date: ${value}`)
  }
  return milliseconds
}

const parseTime = (value: string): number => {
  const match = timePattern.exec(value)
  if (!match) throw new RangeError(`time must be canonical HH:MM: ${value}`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw new RangeError(`time must be canonical HH:MM: ${value}`)
  return hours * 3600 + minutes * 60
}

const parseInstant = (value: string): number => {
  const match = instantPattern.exec(value)
  if (!match) throw new RangeError('timer instant must be a canonical ISO UTC timestamp')
  const milliseconds = Date.parse(value)
  const date = new Date(milliseconds)
  if (
    !Number.isFinite(milliseconds) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== Number((match[7] ?? '').padEnd(3, '0') || 0)
  ) {
    throw new RangeError('timer instant must be a real canonical ISO UTC timestamp')
  }
  return milliseconds
}

export const elapsedDurationSeconds = (
  checkpointSeconds: number,
  startedAt: string,
  stoppedAt: string,
): number => {
  assertNonnegativeSeconds(checkpointSeconds, 'checkpoint seconds')
  const elapsed = Math.floor((parseInstant(stoppedAt) - parseInstant(startedAt)) / 1000)
  if (elapsed < 0) throw new RangeError('timer stop cannot precede timer start')
  const total = checkpointSeconds + elapsed
  assertNonnegativeSeconds(total)
  return total
}

export const elapsedWallClockSeconds = (
  checkpointSeconds: number,
  startedDate: string,
  startedTime: string,
  stoppedDate: string,
  stoppedTime: string,
  allowImplicitOvernight = false,
): number => {
  assertNonnegativeSeconds(checkpointSeconds, 'checkpoint seconds')
  const daySeconds = (parseDate(stoppedDate) - parseDate(startedDate)) / 1000
  let elapsed = daySeconds + parseTime(stoppedTime) - parseTime(startedTime)
  if (allowImplicitOvernight && startedDate === stoppedDate && elapsed < 0) elapsed += 86_400
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new RangeError('timer stop cannot precede timer start')
  }
  const total = checkpointSeconds + elapsed
  assertNonnegativeSeconds(total)
  return total
}

const validateBoundary = (boundary: TimeBoundary): void => {
  parseInstant(boundary.instant)
  parseDate(boundary.date)
  parseTime(boundary.time)
}

const getTimeSettings = async (database: Database): Promise<OrganizationTimeSettings> => {
  const [settings] = await database
    .select()
    .from(organizations)
    .where(eq(organizations.id, 1))
    .limit(1)
  if (!settings) throw new Error('organization must exist before writing time entries')
  return settings
}

const getTaskBillable = async (database: Database, taskAssignmentId: number): Promise<boolean> => {
  const [assignment] = await database
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.id, taskAssignmentId))
    .limit(1)
  if (!assignment) throw new Error('task assignment must exist before writing a time entry')
  return assignment.billable
}

const getTimeEntry = async (database: Database, timeEntryId: number): Promise<TimeEntry> => {
  const [entry] = await database
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.id, timeEntryId))
    .limit(1)
  if (!entry) throw new Error(`time entry ${timeEntryId} does not exist`)
  return entry
}

const mapReturnedTimeEntry = (row: Record<string, unknown>): TimeEntry =>
  Object.fromEntries(
    Object.entries(getTableColumns(timeEntries)).map(([property, column]) => {
      const value = row[column.name]
      return [property, value === null ? null : column.mapFromDriverValue(value)]
    }),
  ) as TimeEntry

const runningWhere = or(
  isNotNull(timeEntries.timerStartedAt),
  and(isNotNull(timeEntries.startedTime), isNull(timeEntries.endedTime)),
)

const valuesFromBase = async (database: Database, input: TimeEntryBaseInput, spentDate: string) => {
  const [billable, rates] = await Promise.all([
    getTaskBillable(database, input.taskAssignmentId),
    resolveEntryRates(database, { ...input, spentDate }),
  ])
  const harvestId = input.harvestId ?? null
  const sourceApprovalStatus =
    harvestId === null
      ? null
      : (input.sourceApprovalStatus ?? input.approvalStatus ?? 'unsubmitted')
  return {
    harvestId,
    userId: input.userId,
    projectId: input.projectId,
    taskId: input.taskId,
    userAssignmentId: input.userAssignmentId,
    taskAssignmentId: input.taskAssignmentId,
    notes: input.notes ?? null,
    billable,
    budgeted: input.budgeted ?? false,
    billableRateCents: rates.billableRateCents,
    costRateCents: rates.costRateCents,
    externalRef: input.externalRef ?? null,
    calendarEventRef: input.calendarEventRef ?? null,
    approvalStatus: harvestId === null ? (input.approvalStatus ?? 'unsubmitted') : 'unsubmitted',
    timesheetSubmissionId: harvestId === null ? (input.timesheetSubmissionId ?? null) : null,
    sourceApprovalStatus,
  }
}

export const startTimeEntry = async (
  database: Database,
  input: StartTimeEntryInput,
  boundary: TimeBoundary,
  runningEntryPolicyLocked: boolean,
): Promise<TimeEntry> => {
  validateBoundary(boundary)
  await assertStoredTimeEntryNoteRequirement(
    database,
    input.userId,
    input.projectId,
    input.notes,
  )
  const settings = await getTimeSettings(database)
  const base = await valuesFromBase(database, input, boundary.date)
  const replacementReference: RunningTimeEntryReplacementReference = {
    entityType: 'running_time_entry_replacement',
    userId: input.userId,
    policyLocked: runningEntryPolicyLocked,
  }
  let created: Record<string, unknown>
  try {
    created = await executeAtomicTrackedMutation(
      database,
      replacementReference,
      (mutationPredicate) =>
        database
          .insert(timeEntries)
          .select(
            sql`SELECT
          ${null},
          ${base.harvestId},
          ${base.userId},
          ${base.projectId},
          ${base.taskId},
          ${base.userAssignmentId},
          ${base.taskAssignmentId},
          ${boundary.date},
          ${0},
          ${0},
          ${0},
          ${settings.timeEntryMode === 'duration' ? boundary.instant : null},
          ${settings.timeEntryMode === 'start_end' ? boundary.time : null},
          ${null},
          ${base.notes},
          ${null},
          ${base.billable ? 1 : 0},
          ${base.budgeted ? 1 : 0},
          ${base.billableRateCents},
          ${base.costRateCents},
          ${base.approvalStatus},
          ${base.timesheetSubmissionId},
          ${base.sourceApprovalStatus},
          ${null},
          ${base.externalRef === null ? null : JSON.stringify(base.externalRef)},
          ${base.calendarEventRef === null ? null : JSON.stringify(base.calendarEventRef)},
          ${boundary.instant},
          ${boundary.instant}
        WHERE ${and(
          mutationPredicate,
          currentTimeEntryNotePolicyAllows(input.userId, input.projectId, input.notes),
        )}`,
          )
          .returning(),
      () => new Error('time entry could not be started'),
    )
  } catch (error) {
    await assertStoredTimeEntryNoteRequirement(
      database,
      input.userId,
      input.projectId,
      input.notes,
    )
    throw error
  }
  return mapReturnedTimeEntry(created)
}

/**
 * `followUps` commit with the insert or not at all; see
 * `executeAtomicWrite`. Without any, the insert runs exactly as it always has.
 */
export const createStoppedTimeEntry = async (
  database: Database,
  input: CreateStoppedTimeEntryInput,
  followUps: readonly CompiledQuery[] = [],
): Promise<TimeEntry> => {
  parseDate(input.spentDate)
  parseInstant(input.createdAt)
  parseInstant(input.updatedAt)
  const settings = await getTimeSettings(database)
  let seconds: number
  let startedTime: string | null = null
  let endedTime: string | null = null
  if (
    settings.timeEntryMode === 'duration' &&
    input.startedTime === undefined &&
    input.endedTime === undefined
  ) {
    if (input.seconds === undefined) throw new Error('duration entries require seconds')
    assertNonnegativeSeconds(input.seconds)
    seconds = input.seconds
  } else {
    // A start/end entry, in either mode: a duration organization holds the
    // intervals the calendar records beside its durations (issue 943).
    if (input.seconds !== undefined) throw new Error('start/end entries derive seconds')
    if (input.startedTime === undefined || input.endedTime === undefined) {
      throw new Error('stopped start/end entries require both canonical times')
    }
    startedTime = input.startedTime
    endedTime = input.endedTime
    seconds = elapsedWallClockSeconds(
      0,
      input.spentDate,
      startedTime,
      input.spentDate,
      endedTime,
      true,
    )
  }
  const base = await valuesFromBase(database, input, input.spentDate)
  await assertStoredTimeEntryNoteRequirement(
    database,
    input.userId,
    input.projectId,
    input.notes,
  )
  const insert = database
    .insert(timeEntries)
    .select(
      sql`SELECT
        ${null},
        ${base.harvestId},
        ${base.userId},
        ${base.projectId},
        ${base.taskId},
        ${base.userAssignmentId},
        ${base.taskAssignmentId},
        ${input.spentDate},
        ${seconds},
        ${seconds},
        ${roundTimeSeconds(seconds, await timeRoundingForProject(database, input.projectId))},
        ${null},
        ${startedTime},
        ${endedTime},
        ${base.notes},
        ${null},
        ${base.billable ? 1 : 0},
        ${base.budgeted ? 1 : 0},
        ${base.billableRateCents},
        ${base.costRateCents},
        ${base.approvalStatus},
        ${base.timesheetSubmissionId},
        ${base.sourceApprovalStatus},
        ${null},
        ${base.externalRef === null ? null : JSON.stringify(base.externalRef)},
        ${base.calendarEventRef === null ? null : JSON.stringify(base.calendarEventRef)},
        ${input.createdAt},
        ${input.updatedAt}
      WHERE ${currentTimeEntryNotePolicyAllows(input.userId, input.projectId, input.notes)}`,
    )
    .returning()
  let created: TimeEntry | undefined
  if (followUps.length === 0) {
    ;[created] = await insert
  } else {
    const row = await executeAtomicWrite(database, insert, followUps)
    created = row === undefined ? undefined : mapReturnedTimeEntry(row)
  }
  if (!created) {
    await assertStoredTimeEntryNoteRequirement(
      database,
      input.userId,
      input.projectId,
      input.notes,
    )
    throw new Error('time entry creation did not return a row')
  }
  return base.sourceApprovalStatus === null ? created : getTimeEntry(database, created.id)
}

export const stopTimeEntry = async (
  database: Database,
  timeEntryId: number,
  boundary: TimeBoundary,
  policyLocked: boolean,
  followUps: readonly CompiledQuery[] = [],
): Promise<TimeEntry> => {
  validateBoundary(boundary)
  const mutationReference: TrackedEntityReference = {
    entityType: 'time_entry',
    entityId: timeEntryId,
    policyLocked,
  }
  const entry = await getTimeEntry(database, timeEntryId)
  const rounding = await timeRoundingForProject(database, entry.projectId)
  let seconds: number
  let endedTime = entry.endedTime
  if (entry.timerStartedAt !== null) {
    seconds = elapsedDurationSeconds(
      entry.secondsWithoutTimer,
      entry.timerStartedAt,
      boundary.instant,
    )
  } else if (entry.startedTime !== null && entry.endedTime === null) {
    seconds = elapsedWallClockSeconds(
      entry.secondsWithoutTimer,
      entry.spentDate,
      entry.startedTime,
      boundary.date,
      boundary.time,
    )
    endedTime = boundary.time
  } else {
    throw new Error(`time entry ${timeEntryId} is not running`)
  }
  const expectedCheckpoint = sql`
    ${timeEntries.userId} = ${entry.userId}
    AND
    ${timeEntries.spentDate} = ${entry.spentDate}
    AND ${timeEntries.seconds} = ${entry.seconds}
    AND ${timeEntries.secondsWithoutTimer} = ${entry.secondsWithoutTimer}
    AND ${timeEntries.timerStartedAt} IS ${entry.timerStartedAt}
    AND ${timeEntries.startedTime} IS ${entry.startedTime}
    AND ${timeEntries.endedTime} IS ${entry.endedTime}
    AND ${timeEntries.updatedAt} = ${entry.updatedAt}
  `
  const stopped = await executeAtomicTrackedMutation(
    database,
    mutationReference,
    (mutationPredicate) =>
      database
        .update(timeEntries)
        .set({
          seconds,
          secondsWithoutTimer: seconds,
          roundedSeconds: roundTimeSeconds(seconds, rounding),
          timerStartedAt: null,
          endedTime,
          updatedAt: boundary.instant,
        })
        .where(and(runningWhere, expectedCheckpoint, mutationPredicate))
        .returning(),
    () => new Error(`time entry ${timeEntryId} stopped concurrently`),
    followUps,
  )
  return mapReturnedTimeEntry(stopped)
}

export const restartTimeEntry = async (
  database: Database,
  timeEntryId: number,
  boundary: TimeBoundary,
  policyLocked: boolean,
  runningEntryPolicyLocked: boolean,
): Promise<TimeEntry> => {
  validateBoundary(boundary)
  const mutationReference: TrackedEntityReference = {
    entityType: 'time_entry',
    entityId: timeEntryId,
    policyLocked,
  }
  const settings = await getTimeSettings(database)
  const entry = await getTimeEntry(database, timeEntryId)
  if (entry.timerStartedAt !== null || (entry.startedTime !== null && entry.endedTime === null)) {
    throw new Error(`time entry ${timeEntryId} is already running`)
  }
  await assertStoredTimeEntryNoteRequirement(
    database,
    entry.userId,
    entry.projectId,
    entry.notes,
  )
  const replacementReference: RunningTimeEntryReplacementReference = {
    entityType: 'running_time_entry_replacement',
    userId: entry.userId,
    policyLocked: runningEntryPolicyLocked,
  }
  const expectedCheckpoint = sql`
    ${timeEntries.userId} = ${entry.userId}
    AND
    ${timeEntries.spentDate} = ${entry.spentDate}
    AND ${timeEntries.seconds} = ${entry.seconds}
    AND ${timeEntries.secondsWithoutTimer} = ${entry.secondsWithoutTimer}
    AND ${timeEntries.timerStartedAt} IS ${entry.timerStartedAt}
    AND ${timeEntries.startedTime} IS ${entry.startedTime}
    AND ${timeEntries.endedTime} IS ${entry.endedTime}
    AND ${timeEntries.updatedAt} = ${entry.updatedAt}
  `
  // The organization's mode decides what a running timer looks like, not the
  // entry's: in a duration organization a start/end entry (issue 943) restarts
  // as a duration timer, its times cleared and its seconds carried on.
  let restarted: Record<string, unknown>
  try {
    restarted = await executeAtomicTrackedMutation(
      database,
      [mutationReference, replacementReference],
      (mutationPredicate) =>
        database
          .update(timeEntries)
          .set({
            spentDate: settings.timeEntryMode === 'start_end' ? boundary.date : entry.spentDate,
            secondsWithoutTimer: entry.seconds,
            timerStartedAt: settings.timeEntryMode === 'duration' ? boundary.instant : null,
            startedTime: settings.timeEntryMode === 'start_end' ? boundary.time : null,
            endedTime: null,
            updatedAt: boundary.instant,
          })
          .where(
            and(
              expectedCheckpoint,
              mutationPredicate,
              currentTimeEntryNotePolicyAllows(entry.userId, entry.projectId, entry.notes),
            ),
          )
          .returning(),
      () => new Error(`time entry ${timeEntryId} could not be restarted`),
    )
  } catch (error) {
    await assertStoredTimeEntryNoteRequirement(
      database,
      entry.userId,
      entry.projectId,
      entry.notes,
    )
    throw error
  }
  return mapReturnedTimeEntry(restarted)
}
