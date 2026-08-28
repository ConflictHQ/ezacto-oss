import { and, eq, getTableColumns, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { resolveEntryRates } from './rate-resolver.js'
import { organizations, taskAssignments, timeEntries } from './schema.js'
import {
  executeAtomicTrackedMutation,
  type RunningTimeEntryReplacementReference,
  type TrackedEntityReference,
} from './tracked-state.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export const timeRoundingPolicies = [
  'none',
  'nearest_6',
  'nearest_15',
  'nearest_30',
  'up_6',
  'up_15',
  'up_30',
] as const

export type TimeRounding = (typeof timeRoundingPolicies)[number]
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
}

export type StartTimeEntryInput = TimeEntryBaseInput

export interface CreateStoppedTimeEntryInput extends TimeEntryBaseInput {
  spentDate: string
  /** Required in duration mode; rejected in start/end mode. */
  seconds?: number
  /** Required in start/end mode; rejected in duration mode. */
  startedTime?: string
  /** Required in start/end mode; rejected in duration mode. */
  endedTime?: string
  createdAt: string
  updatedAt: string
}

type OrganizationTimeSettings = Pick<
  typeof organizations.$inferSelect,
  'timeEntryMode' | 'timeRounding'
>

const increments: Record<Exclude<TimeRounding, 'none'>, number> = {
  nearest_6: 6 * 60,
  nearest_15: 15 * 60,
  nearest_30: 30 * 60,
  up_6: 6 * 60,
  up_15: 15 * 60,
  up_30: 30 * 60,
}

const assertNonnegativeSeconds = (seconds: number, field = 'seconds'): void => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`)
  }
}

export const roundSeconds = (seconds: number, policy: TimeRounding): number => {
  assertNonnegativeSeconds(seconds)
  if (policy === 'none') return seconds
  if (!Object.hasOwn(increments, policy))
    throw new RangeError(`unsupported time rounding: ${policy}`)
  const increment = increments[policy]
  const quotient = Math.floor(seconds / increment)
  const remainder = seconds % increment
  const roundedQuotient = policy.startsWith('nearest_')
    ? quotient + (remainder >= increment / 2 ? 1 : 0)
    : quotient + (remainder === 0 ? 0 : 1)
  const rounded = roundedQuotient * increment
  if (!Number.isSafeInteger(rounded))
    throw new RangeError('rounded seconds exceed safe integer range')
  return rounded
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
  return {
    harvestId: input.harvestId ?? null,
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
  }
}

export const startTimeEntry = async (
  database: Database,
  input: StartTimeEntryInput,
  boundary: TimeBoundary,
  runningEntryPolicyLocked: boolean,
): Promise<TimeEntry> => {
  validateBoundary(boundary)
  const settings = await getTimeSettings(database)
  const base = await valuesFromBase(database, input, boundary.date)
  const replacementReference: RunningTimeEntryReplacementReference = {
    entityType: 'running_time_entry_replacement',
    userId: input.userId,
    policyLocked: runningEntryPolicyLocked,
  }
  const created = await executeAtomicTrackedMutation(
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
          ${base.billable ? 1 : 0},
          ${base.budgeted ? 1 : 0},
          ${base.billableRateCents},
          ${base.costRateCents},
          ${'unsubmitted'},
          ${null},
          ${base.externalRef === null ? null : JSON.stringify(base.externalRef)},
          ${base.calendarEventRef === null ? null : JSON.stringify(base.calendarEventRef)},
          ${boundary.instant},
          ${boundary.instant}
        WHERE ${mutationPredicate}`,
        )
        .returning(),
    () => new Error('time entry could not be started'),
  )
  return mapReturnedTimeEntry(created)
}

export const createStoppedTimeEntry = async (
  database: Database,
  input: CreateStoppedTimeEntryInput,
): Promise<TimeEntry> => {
  parseDate(input.spentDate)
  parseInstant(input.createdAt)
  parseInstant(input.updatedAt)
  const settings = await getTimeSettings(database)
  let seconds: number
  let startedTime: string | null = null
  let endedTime: string | null = null
  if (settings.timeEntryMode === 'duration') {
    if (input.seconds === undefined) throw new Error('duration entries require seconds')
    if (input.startedTime !== undefined || input.endedTime !== undefined) {
      throw new Error('duration entries cannot contain start/end times')
    }
    assertNonnegativeSeconds(input.seconds)
    seconds = input.seconds
  } else {
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
  const [created] = await database
    .insert(timeEntries)
    .values({
      ...base,
      spentDate: input.spentDate,
      seconds,
      secondsWithoutTimer: seconds,
      roundedSeconds: roundSeconds(seconds, settings.timeRounding),
      timerStartedAt: null,
      startedTime,
      endedTime,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning()
  if (!created) throw new Error('time entry creation did not return a row')
  return created
}

export const stopTimeEntry = async (
  database: Database,
  timeEntryId: number,
  boundary: TimeBoundary,
  policyLocked: boolean,
): Promise<TimeEntry> => {
  validateBoundary(boundary)
  const mutationReference: TrackedEntityReference = {
    entityType: 'time_entry',
    entityId: timeEntryId,
    policyLocked,
  }
  const settings = await getTimeSettings(database)
  const entry = await getTimeEntry(database, timeEntryId)
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
          roundedSeconds: roundSeconds(seconds, settings.timeRounding),
          timerStartedAt: null,
          endedTime,
          updatedAt: boundary.instant,
        })
        .where(and(runningWhere, expectedCheckpoint, mutationPredicate))
        .returning(),
    () => new Error(`time entry ${timeEntryId} stopped concurrently`),
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
  const restarted = await executeAtomicTrackedMutation(
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
        .where(and(expectedCheckpoint, mutationPredicate))
        .returning(),
    () => new Error(`time entry ${timeEntryId} could not be restarted`),
  )
  return mapReturnedTimeEntry(restarted)
}
