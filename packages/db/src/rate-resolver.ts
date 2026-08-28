import { resolveRates, type RateResolution, type RateResolutionInput } from '@ezacto/core'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  projects,
  taskAssignments,
  timeEntries,
  userAssignments,
  userBillableRates,
  userCostRates,
} from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface RateSubject {
  spentDate: string
  userId: number
  projectId: number
  taskId: number
  userAssignmentId: number
  taskAssignmentId: number
}

export interface RepriceTimeEntryInput {
  timeEntryId: number
  repricedAt: string
  reason: string
}

export interface RateRepriceAudit {
  id: number
  timeEntryId: number
  previousBillableRateCents: number | null
  billableRateCents: number | null
  previousCostRateCents: number | null
  costRateCents: number | null
  reason: string
  repricedAt: string
}

export interface RepriceTimeEntryResult {
  entry: typeof timeEntries.$inferSelect
  resolution: RateResolution
  audit: RateRepriceAudit
}

const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/

const assertCanonicalInstant = (value: string): void => {
  const match = instantPattern.exec(value)
  if (!match) throw new RangeError('repricedAt must be a canonical millisecond ISO UTC timestamp')
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
    date.getUTCMilliseconds() !== Number(match[7])
  ) {
    throw new RangeError('repricedAt must be a real canonical ISO UTC timestamp')
  }
}

const one = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message)
  return value
}

/** Load the live sources once, then delegate every decision to the pure resolver. */
export const resolveEntryRates = async (
  database: Database,
  subject: RateSubject,
): Promise<RateResolution> => {
  const [projectRows, taskRows, userRows, billableRates, costRates] = await Promise.all([
    database.select().from(projects).where(eq(projects.id, subject.projectId)).limit(1),
    database
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.id, subject.taskAssignmentId))
      .limit(1),
    database
      .select()
      .from(userAssignments)
      .where(eq(userAssignments.id, subject.userAssignmentId))
      .limit(1),
    database.select().from(userBillableRates).where(eq(userBillableRates.userId, subject.userId)),
    database.select().from(userCostRates).where(eq(userCostRates.userId, subject.userId)),
  ])
  const project = one(projectRows[0], 'project must exist before resolving rates')
  const taskAssignment = one(taskRows[0], 'task assignment must exist before resolving rates')
  const userAssignment = one(userRows[0], 'user assignment must exist before resolving rates')
  if (taskAssignment.projectId !== subject.projectId || taskAssignment.taskId !== subject.taskId) {
    throw new Error('task assignment does not match the rate subject')
  }
  if (userAssignment.projectId !== subject.projectId || userAssignment.userId !== subject.userId) {
    throw new Error('user assignment does not match the rate subject')
  }

  const input: RateResolutionInput = {
    spentDate: subject.spentDate,
    project: {
      id: project.id,
      billingMethod: project.billingMethod,
      billBy: project.billBy,
      hourlyRateCents: project.hourlyRateCents,
      budgetBy: project.budgetBy,
      budgetSeconds: project.budgetSeconds,
      costBudgetCents: project.costBudgetCents,
    },
    taskAssignment: {
      id: taskAssignment.id,
      hourlyRateCents: taskAssignment.hourlyRateCents,
      budgetSeconds: taskAssignment.budgetSeconds,
      budgetCents: taskAssignment.budgetCents,
    },
    userAssignment: {
      id: userAssignment.id,
      useDefaultRates: userAssignment.useDefaultRates,
      hourlyRateCents: userAssignment.hourlyRateCents,
      budgetSeconds: userAssignment.budgetSeconds,
    },
    userBillableRates: billableRates.map(({ amountCents, startDate, endDate }) => ({
      amountCents,
      startDate,
      endDate,
    })),
    userCostRates: costRates.map(({ amountCents, startDate, endDate }) => ({
      amountCents,
      startDate,
      endDate,
    })),
  }
  return resolveRates(input)
}

/**
 * Explicitly re-resolve one historical entry and append its before/after audit.
 * The INSERT and its apply trigger are one SQLite statement, so D1 and container
 * SQLite cannot persist the snapshot update without the corresponding audit row.
 */
export const repriceTimeEntry = async (
  database: Database,
  input: RepriceTimeEntryInput,
): Promise<RepriceTimeEntryResult> => {
  if (!Number.isSafeInteger(input.timeEntryId) || input.timeEntryId < 1) {
    throw new RangeError('timeEntryId must be a positive safe integer')
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new RangeError('reprice reason must be a non-empty string')
  }
  if (input.reason.length > 500) throw new RangeError('reprice reason cannot exceed 500 characters')
  assertCanonicalInstant(input.repricedAt)

  const [before] = await database
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.id, input.timeEntryId))
    .limit(1)
  if (!before) throw new Error(`time entry ${input.timeEntryId} does not exist`)
  const resolution = await resolveEntryRates(database, before)

  const audit = await database.get<RateRepriceAudit>(sql`
    INSERT INTO time_entry_rate_reprices (
      time_entry_id,
      previous_billable_rate_cents,
      billable_rate_cents,
      previous_cost_rate_cents,
      cost_rate_cents,
      reason,
      repriced_at
    )
    SELECT
      ${timeEntries.id},
      ${timeEntries.billableRateCents},
      ${resolution.billableRateCents},
      ${timeEntries.costRateCents},
      ${resolution.costRateCents},
      ${input.reason},
      ${input.repricedAt}
    FROM ${timeEntries}
    WHERE ${timeEntries.id} = ${input.timeEntryId}
    RETURNING
      id,
      time_entry_id AS timeEntryId,
      previous_billable_rate_cents AS previousBillableRateCents,
      billable_rate_cents AS billableRateCents,
      previous_cost_rate_cents AS previousCostRateCents,
      cost_rate_cents AS costRateCents,
      reason,
      repriced_at AS repricedAt
  `)
  if (!audit) throw new Error(`time entry ${input.timeEntryId} disappeared during reprice`)
  const [entry] = await database
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.id, input.timeEntryId))
    .limit(1)
  if (!entry) throw new Error(`time entry ${input.timeEntryId} disappeared after reprice`)
  return { entry, resolution, audit }
}
