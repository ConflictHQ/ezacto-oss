import {
  addDays,
  allocationCoversWeek,
  AllocationConflictError,
  AllocationNotFoundError,
  AllocationOverlapError,
  assertAllocationFields,
  canProfileUseApiScope,
  capacityWeeks,
  isOverAllocated,
  TrackedResourceInputError,
  type AllocationWeekStartDay,
  type TeamViewer,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import { and, asc, desc, eq, gt, gte, lte, sql, type SQL } from 'drizzle-orm'
import { allocations, organizations, projects, users } from './schema.js'
import { teamPersonAccessPredicate, teamPersonAccessSql, teamProjectAccessSql } from './team-access.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { ResourceSource, ResourceWindow } from './tracked-resource-repository.js'
import { executeAtomicWrite, type CompiledQuery } from './tracked-state.js'

/**
 * The allocation store and capacity read (issue 1007, slices 1 and 2): planned
 * hours per week for a person on a project over a range of dates, and the
 * person-by-week grid that sets them beside capacity and tracked time.
 *
 * Planned hours are not work. This file never writes `time_entries` and holds no
 * rate or money column; the capacity read only sums tracked time to set beside
 * the plan.
 *
 * Who sees what follows the team rules. An administrator or executive manager
 * sees everyone. A project manager sees their own allocations and the ones for
 * people and projects they manage. Everyone else sees only their own. Only the
 * first two groups write, and a project manager writes only inside the scope
 * they manage.
 */

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface AllocationRecord {
  id: number
  userId: number
  projectId: number
  startDate: string
  endDate: string
  plannedSecondsPerWeek: number
  createdAt: string
  updatedAt: string
}

export interface AllocationFilters {
  userId?: number
  projectId?: number
  /** Allocations that reach this day or later. */
  from?: string
  /** Allocations that begin on this day or earlier. */
  to?: string
}

export interface CreateAllocationRequest {
  userId: number
  projectId: number
  startDate: string
  endDate: string
  plannedSecondsPerWeek: number
}

/** The person and the project are fixed; to move a plan, delete it and make another. */
export interface UpdateAllocationRequest {
  startDate?: string
  endDate?: string
  plannedSecondsPerWeek?: number
}

export interface CapacityRequest {
  from: string
  to: string
}

export interface CapacityWeek {
  weekStart: string
  plannedSeconds: number
  trackedSeconds: number
  overAllocated: boolean
}

export interface CapacityPerson {
  userId: number
  firstName: string
  lastName: string
  weeklyCapacitySeconds: number
  weeks: CapacityWeek[]
}

export interface CapacityReport {
  weekStartDay: AllocationWeekStartDay
  weeks: string[]
  people: CapacityPerson[]
}

const record = (row: typeof allocations.$inferSelect): AllocationRecord => ({ ...row })

const overlapPattern = /allocation overlaps another allocation/

const hasMessage = (error: unknown, pattern: RegExp): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    if (pattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

/** Managers write; the scope table says which profiles that is. */
const canWrite = (viewer: Readonly<TeamViewer>): boolean =>
  canProfileUseApiScope(viewer.profile, 'schedule:write')

/** Whose allocations a viewer reads: see the header of this file. */
const readScope = (viewer: Readonly<TeamViewer>): SQL => {
  if (!canWrite(viewer)) {
    return sql`${allocations.userId} = ${viewer.userId}`
  }
  if (viewer.profile !== 'project_manager') return sql`1`
  return sql`(${allocations.userId} = ${viewer.userId} OR (
    EXISTS (SELECT 1 FROM users scoped_user WHERE scoped_user.id = ${allocations.userId}
      AND ${teamPersonAccessSql(viewer, 'scoped_user')})
    AND EXISTS (SELECT 1 FROM projects scoped_project WHERE scoped_project.id = ${allocations.projectId}
      AND ${teamProjectAccessSql(viewer, 'scoped_project')})
  ))`
}

/** Which allocations a viewer may change: the managed part of what they read. */
const writeScope = (viewer: Readonly<TeamViewer>): SQL => {
  if (!canWrite(viewer)) return sql`0`
  if (viewer.profile !== 'project_manager') return sql`1`
  return sql`(
    EXISTS (SELECT 1 FROM users scoped_user WHERE scoped_user.id = ${allocations.userId}
      AND ${teamPersonAccessSql(viewer, 'scoped_user')})
    AND EXISTS (SELECT 1 FROM projects scoped_project WHERE scoped_project.id = ${allocations.projectId}
      AND ${teamProjectAccessSql(viewer, 'scoped_project')})
  )`
}

type NativeClient = BetterSqlite3.Database | D1Database

/** The same people as `peopleScope`, for the raw aggregate, with `person` as the users alias. */
const peopleScopePredicate = (viewer: Readonly<TeamViewer>) => {
  if (!canWrite(viewer)) return { sql: 'person.id = ?', bindings: [viewer.userId] }
  return viewer.profile === 'project_manager'
    ? teamPersonAccessPredicate(viewer, 'person')
    : { sql: '1', bindings: [] as unknown[] }
}

const allRows = async <Row>(
  database: Database,
  query: string,
  bindings: readonly unknown[],
): Promise<Row[]> => {
  const client = (database as Database & { $client: NativeClient }).$client
  if ('batch' in client) return (await client.prepare(query).bind(...bindings).all<Row>()).results
  return client.prepare(query).all(...bindings) as Row[]
}

/** The people a capacity read lists, as a condition on `users`. */
const peopleScope = (viewer: Readonly<TeamViewer>): SQL => {
  if (!canWrite(viewer)) return sql`${users.id} = ${viewer.userId}`
  return viewer.profile === 'project_manager' ? teamPersonAccessSql(viewer, 'users') : sql`1`
}

type AllocationEventKind = 'created' | 'updated' | 'deleted'

const snapshot = (row: Readonly<AllocationRecord> | null) =>
  row === null
    ? null
    : {
        id: row.id,
        user_id: row.userId,
        project_id: row.projectId,
        start_date: row.startDate,
        end_date: row.endDate,
        planned_seconds_per_week: row.plannedSecondsPerWeek,
        updated_at: row.updatedAt,
      }

/**
 * The outbox row recording one change, which the activity log keeps like every
 * other event. Run it as the follow-up of the write it describes: it reads
 * `changes()` and, for a create, `last_insert_rowid()` from the statement before
 * it, so there is no allocation without its record and no record of a refused
 * write. The payload is whole before the write runs, so it carries no rates or
 * anything else the write did not set.
 */
const allocationEvent = (
  kind: AllocationEventKind,
  actorUserId: number,
  before: Readonly<AllocationRecord> | null,
  after: Readonly<AllocationRecord> | null,
  occurredAt: string,
): CompiledQuery => {
  const eventId = crypto.randomUUID()
  const eventType = `allocation.${kind}`
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    aggregate: { type: 'allocation', id: 0, sequence: 0 },
    actor: { type: 'user', id: actorUserId },
    allocation: { before: snapshot(before), after: snapshot(after) },
  })
  const created = kind === 'created'
  return {
    sql: `INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at
      )
      SELECT ?, 'allocation', subject.id, subject.sequence, ?,
        json_set(json(?),
          '$.aggregate.id', subject.id,
          '$.aggregate.sequence', subject.sequence${
            created ? ", '$.allocation.after.id', subject.id" : ''
          }),
        ?, ?
      FROM (
        SELECT target.id AS id, coalesce((
          SELECT max(aggregate_sequence) FROM event_outbox
          WHERE aggregate_type = 'allocation' AND aggregate_id = target.id
        ), 0) + 1 AS sequence
        FROM (SELECT ${created ? 'last_insert_rowid()' : '?'} AS id) target
      ) subject
      WHERE changes() = 1`,
    params: [eventId, eventType, payload, occurredAt, occurredAt, ...(created ? [] : [(before ?? after)!.id])],
  }
}

export class DrizzleAllocationRepository {
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  #conditions(viewer: Readonly<TeamViewer>, filters: Readonly<AllocationFilters>): SQL[] {
    return [
      readScope(viewer),
      ...(filters.userId === undefined ? [] : [eq(allocations.userId, filters.userId)]),
      ...(filters.projectId === undefined ? [] : [eq(allocations.projectId, filters.projectId)]),
      ...(filters.from === undefined ? [] : [gte(allocations.endDate, filters.from)]),
      ...(filters.to === undefined ? [] : [lte(allocations.startDate, filters.to)]),
    ]
  }

  allocations(
    viewer: Readonly<TeamViewer>,
    filters: Readonly<AllocationFilters>,
  ): ResourceSource<AllocationRecord> {
    return {
      highWatermark: async () => {
        const [row] = await this.#database
          .select()
          .from(allocations)
          .where(and(...this.#conditions(viewer, filters)))
          .orderBy(desc(allocations.id))
          .limit(1)
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await this.#database
          .select()
          .from(allocations)
          .where(
            and(
              ...this.#conditions(viewer, filters),
              lte(allocations.id, throughId),
              ...(afterId === null ? [] : [gt(allocations.id, afterId)]),
            ),
          )
          .orderBy(asc(allocations.id))
          .limit(take)
        return rows.map(record)
      },
    }
  }

  async get(viewer: Readonly<TeamViewer>, id: number): Promise<AllocationRecord> {
    const [row] = await this.#database
      .select()
      .from(allocations)
      .where(and(eq(allocations.id, id), readScope(viewer)))
      .limit(1)
    if (row === undefined) throw new AllocationNotFoundError()
    return record(row)
  }

  /** The row, only when the viewer may change it; otherwise it does not exist to them. */
  async #writable(viewer: Readonly<TeamViewer>, id: number): Promise<AllocationRecord> {
    const [row] = await this.#database
      .select()
      .from(allocations)
      .where(and(eq(allocations.id, id), writeScope(viewer)))
      .limit(1)
    if (row === undefined) throw new AllocationNotFoundError()
    return record(row)
  }

  /** Plans are made for people and projects still in use, inside the viewer's scope. */
  async #assertPlannable(viewer: Readonly<TeamViewer>, userId: number, projectId: number) {
    const [person] = await this.#database
      .select()
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          canWrite(viewer) && viewer.profile === 'project_manager'
            ? teamPersonAccessSql(viewer, 'users')
            : sql`1`,
        ),
      )
      .limit(1)
    if (person === undefined) {
      throw new TrackedResourceInputError('user_id', 'unknown_user', 'user_id does not name a person you can plan')
    }
    if (!person.isActive) {
      throw new TrackedResourceInputError('user_id', 'inactive_user', 'this person is archived and cannot be planned')
    }
    const [project] = await this.#database
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          canWrite(viewer) && viewer.profile === 'project_manager'
            ? teamProjectAccessSql(viewer, 'projects')
            : sql`1`,
        ),
      )
      .limit(1)
    if (project === undefined) {
      throw new TrackedResourceInputError('project_id', 'unknown_project', 'project_id does not name a project you can plan')
    }
    if (!project.isActive) {
      throw new TrackedResourceInputError('project_id', 'inactive_project', 'this project is archived and cannot be planned')
    }
  }

  async create(
    viewer: Readonly<TeamViewer>,
    input: Readonly<CreateAllocationRequest>,
    now: string,
  ): Promise<AllocationRecord> {
    if (!canWrite(viewer)) throw new AllocationNotFoundError()
    assertAllocationFields(input)
    await this.#assertPlannable(viewer, input.userId, input.projectId)
    const values = { ...input, createdAt: now, updatedAt: now }
    const write = this.#database.insert(allocations).values(values).returning()
    // The event names the row the insert has just taken, so it is built with a
    // placeholder id that the statement replaces.
    const pending: AllocationRecord = { id: 0, ...values }
    let row: Record<string, unknown> | undefined
    try {
      row = await executeAtomicWrite(this.#database, write, [
        allocationEvent('created', viewer.userId, null, pending, now),
      ])
    } catch (error) {
      if (hasMessage(error, overlapPattern)) throw new AllocationOverlapError()
      throw error
    }
    return await this.get(viewer, Number(row?.id))
  }

  async update(
    viewer: Readonly<TeamViewer>,
    id: number,
    patch: Readonly<UpdateAllocationRequest>,
    now: string,
  ): Promise<AllocationRecord> {
    const before = await this.#writable(viewer, id)
    const next: AllocationRecord = {
      ...before,
      ...(patch.startDate === undefined ? {} : { startDate: patch.startDate }),
      ...(patch.endDate === undefined ? {} : { endDate: patch.endDate }),
      ...(patch.plannedSecondsPerWeek === undefined
        ? {}
        : { plannedSecondsPerWeek: patch.plannedSecondsPerWeek }),
      updatedAt: now,
    }
    assertAllocationFields(next)
    await this.#assertPlannable(viewer, before.userId, before.projectId)
    const write = this.#database
      .update(allocations)
      .set({
        startDate: next.startDate,
        endDate: next.endDate,
        plannedSecondsPerWeek: next.plannedSecondsPerWeek,
        updatedAt: now,
      })
      .where(
        and(eq(allocations.id, id), eq(allocations.updatedAt, before.updatedAt), writeScope(viewer)),
      )
      .returning()
    let row: Record<string, unknown> | undefined
    try {
      row = await executeAtomicWrite(this.#database, write, [
        allocationEvent('updated', viewer.userId, before, next, now),
      ])
    } catch (error) {
      if (hasMessage(error, overlapPattern)) throw new AllocationOverlapError()
      throw error
    }
    if (row === undefined) throw new AllocationConflictError()
    return await this.get(viewer, id)
  }

  /** Removing a plan stays possible for an archived person or project. */
  async delete(
    viewer: Readonly<TeamViewer>,
    id: number,
    now: string,
  ): Promise<AllocationRecord> {
    const before = await this.#writable(viewer, id)
    const write = this.#database
      .delete(allocations)
      .where(
        and(eq(allocations.id, id), eq(allocations.updatedAt, before.updatedAt), writeScope(viewer)),
      )
      .returning()
    const row = await executeAtomicWrite(this.#database, write, [
      allocationEvent('deleted', viewer.userId, before, null, now),
    ])
    if (row === undefined) throw new AllocationConflictError()
    return before
  }

  /**
   * Person by week: what is planned, what the person can do, what was tracked.
   *
   * Weeks begin on the organization's week start day and every date is a plain
   * local day. A range counts its full weekly figure for each week it touches.
   * Capacity is the person's current weekly capacity, not a history of it.
   * Archived people are left out, and so are plans on archived projects.
   */
  async capacity(
    viewer: Readonly<TeamViewer>,
    request: Readonly<CapacityRequest>,
  ): Promise<CapacityReport> {
    const [organization] = await this.#database
      .select()
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1)
    const weekStartDay = organization?.weekStartDay ?? 'monday'
    const weeks = capacityWeeks(request.from, request.to, weekStartDay)
    const first = weeks[0]!
    const lastDay = addDays(weeks[weeks.length - 1]!, 6)

    const people = await this.#database
      .select()
      .from(users)
      .where(and(eq(users.isActive, true), peopleScope(viewer)))
      .orderBy(sql`lower(${users.firstName})`, sql`lower(${users.lastName})`, asc(users.id))

    const planned = (
      await this.#database
        .select()
        .from(allocations)
        .where(
          and(
            gte(allocations.endDate, first),
            lte(allocations.startDate, lastDay),
            sql`EXISTS (SELECT 1 FROM users WHERE users.id = ${allocations.userId}
              AND users.is_active = 1 AND ${peopleScope(viewer)})`,
            sql`EXISTS (SELECT 1 FROM projects WHERE projects.id = ${allocations.projectId}
              AND projects.is_active = 1)`,
          ),
        )
    ).map(record)

    const scope = peopleScopePredicate(viewer)
    const tracked = await allRows<{ userId: number; spentDate: string; seconds: number }>(
      this.#database,
      `SELECT entry.user_id AS userId, entry.spent_date AS spentDate,
        coalesce(sum(entry.rounded_seconds), 0) AS seconds
      FROM time_entries entry JOIN users person ON person.id = entry.user_id
      WHERE person.is_active = 1 AND ${scope.sql} AND entry.spent_date BETWEEN ? AND ?
      GROUP BY entry.user_id, entry.spent_date`,
      [...scope.bindings, first, lastDay],
    )

    return {
      weekStartDay,
      weeks,
      people: people.map((person) => ({
        userId: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        weeklyCapacitySeconds: person.weeklyCapacity,
        weeks: weeks.map((weekStart) => {
          const plannedSeconds = planned
            .filter((row) => row.userId === person.id && allocationCoversWeek(row, weekStart))
            .reduce((total, row) => total + row.plannedSecondsPerWeek, 0)
          const weekEnd = addDays(weekStart, 6)
          const trackedSeconds = tracked
            .filter(
              (row) =>
                row.userId === person.id && row.spentDate >= weekStart && row.spentDate <= weekEnd,
            )
            .reduce((total, row) => total + Number(row.seconds), 0)
          return {
            weekStart,
            plannedSeconds,
            trackedSeconds,
            overAllocated: isOverAllocated(plannedSeconds, person.weeklyCapacity),
          }
        }),
      })),
    }
  }
}
