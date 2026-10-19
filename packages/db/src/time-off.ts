import {
  assertTimeOffFields,
  canProfileUseApiScope,
  TimeOffConflictError,
  TimeOffNotFoundError,
  TimeOffOverlapError,
  TrackedResourceInputError,
  type TeamViewer,
  type TimeOffKind,
} from '@ezacto/core'
import { and, asc, desc, eq, gt, gte, lte, sql, type SQL } from 'drizzle-orm'
import { timeOff, users } from './schema.js'
import { teamPersonAccessSql } from './team-access.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { ResourceSource, ResourceWindow } from './tracked-resource-repository.js'
import { executeAtomicWrite, type CompiledQuery } from './tracked-state.js'

/**
 * Time off (issue 1007, slice 3): days a person is away, entered by an
 * administrator. The capacity read in `allocations.ts` subtracts it from what a
 * person can do in a week; nothing here approves, requests or bills anything,
 * and nothing here touches `time_entries`.
 *
 * Who sees what follows the allocation rules. An administrator or executive
 * manager sees and writes everyone's. A project manager sees their own and the
 * people they manage, and writes only for those people. Everyone else reads only
 * their own and cannot write.
 */

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface TimeOffRecord {
  id: number
  userId: number
  startDate: string
  endDate: string
  kind: TimeOffKind
  secondsPerDay: number | null
  createdAt: string
  updatedAt: string
}

export interface TimeOffFilters {
  userId?: number
  /** Time off that reaches this day or later. */
  from?: string
  /** Time off that begins on this day or earlier. */
  to?: string
}

export interface CreateTimeOffRequest {
  userId: number
  startDate: string
  endDate: string
  kind: TimeOffKind
  secondsPerDay: number | null
}

/** The person is fixed; to move time off to someone else, delete it and make another. */
export interface UpdateTimeOffRequest {
  startDate?: string
  endDate?: string
  kind?: TimeOffKind
  secondsPerDay?: number | null
}

const record = (row: typeof timeOff.$inferSelect): TimeOffRecord => ({ ...row })

const overlapPattern = /time off overlaps other time off/

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

const canWrite = (viewer: Readonly<TeamViewer>): boolean =>
  canProfileUseApiScope(viewer.profile, 'schedule:write')

/** Whose time off a viewer reads. */
const readScope = (viewer: Readonly<TeamViewer>): SQL => {
  if (!canWrite(viewer)) return sql`${timeOff.userId} = ${viewer.userId}`
  if (viewer.profile !== 'project_manager') return sql`1`
  return sql`(${timeOff.userId} = ${viewer.userId} OR EXISTS (
    SELECT 1 FROM users scoped_user WHERE scoped_user.id = ${timeOff.userId}
      AND ${teamPersonAccessSql(viewer, 'scoped_user')}))`
}

/** Which time off a viewer may change: the managed people's. */
const writeScope = (viewer: Readonly<TeamViewer>): SQL => {
  if (!canWrite(viewer)) return sql`0`
  if (viewer.profile !== 'project_manager') return sql`1`
  return sql`EXISTS (SELECT 1 FROM users scoped_user WHERE scoped_user.id = ${timeOff.userId}
    AND ${teamPersonAccessSql(viewer, 'scoped_user')})`
}

type TimeOffEventKind = 'created' | 'updated' | 'deleted'

const snapshot = (row: Readonly<TimeOffRecord> | null) =>
  row === null
    ? null
    : {
        id: row.id,
        user_id: row.userId,
        start_date: row.startDate,
        end_date: row.endDate,
        kind: row.kind,
        seconds_per_day: row.secondsPerDay,
        updated_at: row.updatedAt,
      }

/**
 * The outbox row recording one change, run as the follow-up of the write it
 * describes (it reads `changes()` and, for a create, `last_insert_rowid()`), so
 * there is no time off without its record and no record of a refused write.
 */
const timeOffEvent = (
  kind: TimeOffEventKind,
  actorUserId: number,
  before: Readonly<TimeOffRecord> | null,
  after: Readonly<TimeOffRecord> | null,
  occurredAt: string,
): CompiledQuery => {
  const eventId = crypto.randomUUID()
  const eventType = `time_off.${kind}`
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    aggregate: { type: 'time_off', id: 0, sequence: 0 },
    actor: { type: 'user', id: actorUserId },
    time_off: { before: snapshot(before), after: snapshot(after) },
  })
  const created = kind === 'created'
  return {
    sql: `INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at
      )
      SELECT ?, 'time_off', subject.id, subject.sequence, ?,
        json_set(json(?),
          '$.aggregate.id', subject.id,
          '$.aggregate.sequence', subject.sequence${
            created ? ", '$.time_off.after.id', subject.id" : ''
          }),
        ?, ?
      FROM (
        SELECT target.id AS id, coalesce((
          SELECT max(aggregate_sequence) FROM event_outbox
          WHERE aggregate_type = 'time_off' AND aggregate_id = target.id
        ), 0) + 1 AS sequence
        FROM (SELECT ${created ? 'last_insert_rowid()' : '?'} AS id) target
      ) subject
      WHERE changes() = 1`,
    params: [eventId, eventType, payload, occurredAt, occurredAt, ...(created ? [] : [(before ?? after)!.id])],
  }
}

export class DrizzleTimeOffRepository {
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  #conditions(viewer: Readonly<TeamViewer>, filters: Readonly<TimeOffFilters>): SQL[] {
    return [
      readScope(viewer),
      ...(filters.userId === undefined ? [] : [eq(timeOff.userId, filters.userId)]),
      ...(filters.from === undefined ? [] : [gte(timeOff.endDate, filters.from)]),
      ...(filters.to === undefined ? [] : [lte(timeOff.startDate, filters.to)]),
    ]
  }

  entries(
    viewer: Readonly<TeamViewer>,
    filters: Readonly<TimeOffFilters>,
  ): ResourceSource<TimeOffRecord> {
    return {
      highWatermark: async () => {
        const [row] = await this.#database
          .select()
          .from(timeOff)
          .where(and(...this.#conditions(viewer, filters)))
          .orderBy(desc(timeOff.id))
          .limit(1)
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await this.#database
          .select()
          .from(timeOff)
          .where(
            and(
              ...this.#conditions(viewer, filters),
              lte(timeOff.id, throughId),
              ...(afterId === null ? [] : [gt(timeOff.id, afterId)]),
            ),
          )
          .orderBy(asc(timeOff.id))
          .limit(take)
        return rows.map(record)
      },
    }
  }

  async get(viewer: Readonly<TeamViewer>, id: number): Promise<TimeOffRecord> {
    const [row] = await this.#database
      .select()
      .from(timeOff)
      .where(and(eq(timeOff.id, id), readScope(viewer)))
      .limit(1)
    if (row === undefined) throw new TimeOffNotFoundError()
    return record(row)
  }

  /** The row, only when the viewer may change it; otherwise it does not exist to them. */
  async #writable(viewer: Readonly<TeamViewer>, id: number): Promise<TimeOffRecord> {
    const [row] = await this.#database
      .select()
      .from(timeOff)
      .where(and(eq(timeOff.id, id), writeScope(viewer)))
      .limit(1)
    if (row === undefined) throw new TimeOffNotFoundError()
    return record(row)
  }

  /** Time off is entered for people still in use, inside the viewer's scope. */
  async #assertEnterable(viewer: Readonly<TeamViewer>, userId: number): Promise<void> {
    const [person] = await this.#database
      .select()
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          viewer.profile === 'project_manager' ? teamPersonAccessSql(viewer, 'users') : sql`1`,
        ),
      )
      .limit(1)
    if (person === undefined) {
      throw new TrackedResourceInputError('user_id', 'unknown_user', 'user_id does not name a person you can enter time off for')
    }
    if (!person.isActive) {
      throw new TrackedResourceInputError('user_id', 'inactive_user', 'this person is archived and cannot be given time off')
    }
  }

  async create(
    viewer: Readonly<TeamViewer>,
    input: Readonly<CreateTimeOffRequest>,
    now: string,
  ): Promise<TimeOffRecord> {
    if (!canWrite(viewer)) throw new TimeOffNotFoundError()
    assertTimeOffFields(input)
    await this.#assertEnterable(viewer, input.userId)
    const values = { ...input, createdAt: now, updatedAt: now }
    const write = this.#database.insert(timeOff).values(values).returning()
    // The event names the row the insert has just taken, so it is built with a
    // placeholder id that the statement replaces.
    const pending: TimeOffRecord = { id: 0, ...values }
    let row: Record<string, unknown> | undefined
    try {
      row = await executeAtomicWrite(this.#database, write, [
        timeOffEvent('created', viewer.userId, null, pending, now),
      ])
    } catch (error) {
      if (hasMessage(error, overlapPattern)) throw new TimeOffOverlapError()
      throw error
    }
    return await this.get(viewer, Number(row?.id))
  }

  async update(
    viewer: Readonly<TeamViewer>,
    id: number,
    patch: Readonly<UpdateTimeOffRequest>,
    now: string,
  ): Promise<TimeOffRecord> {
    const before = await this.#writable(viewer, id)
    const next: TimeOffRecord = {
      ...before,
      ...(patch.startDate === undefined ? {} : { startDate: patch.startDate }),
      ...(patch.endDate === undefined ? {} : { endDate: patch.endDate }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.secondsPerDay === undefined ? {} : { secondsPerDay: patch.secondsPerDay }),
      updatedAt: now,
    }
    assertTimeOffFields(next)
    await this.#assertEnterable(viewer, before.userId)
    const write = this.#database
      .update(timeOff)
      .set({
        startDate: next.startDate,
        endDate: next.endDate,
        kind: next.kind,
        secondsPerDay: next.secondsPerDay,
        updatedAt: now,
      })
      .where(and(eq(timeOff.id, id), eq(timeOff.updatedAt, before.updatedAt), writeScope(viewer)))
      .returning()
    let row: Record<string, unknown> | undefined
    try {
      row = await executeAtomicWrite(this.#database, write, [
        timeOffEvent('updated', viewer.userId, before, next, now),
      ])
    } catch (error) {
      if (hasMessage(error, overlapPattern)) throw new TimeOffOverlapError()
      throw error
    }
    if (row === undefined) throw new TimeOffConflictError()
    return await this.get(viewer, id)
  }

  /** Removing time off stays possible for an archived person. */
  async delete(viewer: Readonly<TeamViewer>, id: number, now: string): Promise<TimeOffRecord> {
    const before = await this.#writable(viewer, id)
    const write = this.#database
      .delete(timeOff)
      .where(and(eq(timeOff.id, id), eq(timeOff.updatedAt, before.updatedAt), writeScope(viewer)))
      .returning()
    const row = await executeAtomicWrite(this.#database, write, [
      timeOffEvent('deleted', viewer.userId, before, null, now),
    ])
    if (row === undefined) throw new TimeOffConflictError()
    return before
  }
}
