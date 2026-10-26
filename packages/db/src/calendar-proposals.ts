import {
  calendarProposalEntryFields,
  calendarProposalTitle,
  CalendarProposalNotFoundError,
  CalendarProposalNotOpenError,
  effectiveTimeZone,
  startOfDayInTimeZone,
  type CalendarEventReference,
  type CalendarProposalStatus,
  type CalendarProvider,
} from '@ezacto/core'
import { and, asc, desc, eq, gt, gte, lt, lte } from 'drizzle-orm'
import { calendarProposals, organizations, users } from './schema.js'
import type {
  CreateTimeEntryRequest,
  DrizzleTrackedResourceRepository,
  ResourceSource,
  ResourceWindow,
  TimeEntryActor,
  TrackedResourceDatabase,
} from './tracked-resource-repository.js'
import type { TimeBoundary } from './time-entries.js'
import type { CompiledQuery } from './tracked-state.js'

/**
 * The calendar proposal store (issue 428, slice 1): events a person may accept
 * as time or discard, held apart from the timesheet.
 *
 * Provider-free on purpose. Nothing here knows how an event arrives; callers
 * hand over events already read from somewhere. Accepting is the one place this
 * touches real time, and it does so through the ordinary time-entry path, so
 * rounding, timesheet locks, approval membership, assignment and note rules
 * apply exactly as they do to an entry typed by hand.
 *
 * Every read and write is scoped to the owner. A proposal that is not yours is
 * indistinguishable from one that does not exist.
 */

export interface CalendarProposalRecord {
  id: number
  userId: number
  provider: CalendarProvider
  calendarId: string
  eventId: string
  occurrence: string
  title: string
  startsAt: string
  endsAt: string
  status: CalendarProposalStatus
  sourceVersion: string | null
  observedSourceVersion: string | null
  sourceChangedAt: string | null
  sourceCancelledAt: string | null
  timeEntryId: number | null
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}

/** One event as a provider reports it. All-day events carry no interval and are not representable. */
export interface CalendarEventInput {
  provider: CalendarProvider
  calendarId: string
  eventId: string
  /** Tells recurring instances apart where the provider's event id does not. */
  occurrence?: string
  summary: string | null
  startsAt: string
  endsAt: string
  /** The provider's edit stamp (an etag or updated time), kept for later reconciliation. */
  sourceVersion?: string | null
}

export interface CalendarProposalFilters {
  /** First local day, inclusive, on the owner's own calendar. */
  from?: string
  /** Last local day, inclusive. */
  to?: string
  /** Defaults to `proposed`: what is waiting for a decision. */
  status?: CalendarProposalStatus
}

export interface AcceptCalendarProposalRequest {
  projectId: number
  taskId: number
  /** Defaults to the event's title. */
  notes?: string | null
  budgeted?: boolean
}

export interface AcceptedCalendarProposal {
  proposal: CalendarProposalRecord
  /** The id of the time entry the ordinary path created. */
  timeEntryId: number
}

const instant = (value: string): string => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new RangeError(`not an instant: ${value}`)
  return new Date(parsed).toISOString()
}

const nextDay = (date: string): string => {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

const notOpenPattern = /calendar proposal is not open/

const isNotOpenWriteError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    if (notOpenPattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

const record = (row: typeof calendarProposals.$inferSelect): CalendarProposalRecord => ({ ...row })

/**
 * Offers events to a person. An event already held, in any state, is left
 * exactly as it is: re-reading a calendar must never revive a meeting someone
 * discarded or disturb one they accepted. Returns how many were new.
 */
export const proposeCalendarEvents = async (
  database: TrackedResourceDatabase,
  userId: number,
  events: readonly CalendarEventInput[],
  now: string,
): Promise<{ inserted: number; existing: number }> => {
  let inserted = 0
  for (const event of events) {
    const created = await database
      .insert(calendarProposals)
      .values({
        userId,
        provider: event.provider,
        calendarId: event.calendarId,
        eventId: event.eventId,
        occurrence: event.occurrence ?? '',
        title: calendarProposalTitle(event.summary),
        startsAt: instant(event.startsAt),
        endsAt: instant(event.endsAt),
        status: 'proposed',
        sourceVersion: event.sourceVersion ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning()
    inserted += created.length
  }
  return { inserted, existing: events.length - inserted }
}

export class DrizzleCalendarProposalRepository {
  readonly #database: TrackedResourceDatabase
  readonly #tracked: Pick<DrizzleTrackedResourceRepository, 'createTimeEntry' | 'timeEntrySettings'>

  constructor(
    database: TrackedResourceDatabase,
    tracked: Pick<DrizzleTrackedResourceRepository, 'createTimeEntry' | 'timeEntrySettings'>,
  ) {
    this.#database = database
    this.#tracked = tracked
  }

  /** The zone this person's days are kept in: their own, then the organization's. */
  async #zone(userId: number): Promise<string> {
    const [user] = await this.#database.select().from(users).where(eq(users.id, userId)).limit(1)
    const [organization] = await this.#database
      .select()
      .from(organizations)
      .where(eq(organizations.id, 1))
      .limit(1)
    return effectiveTimeZone(user?.timezone ?? null, organization?.timezone ?? 'UTC')
  }

  async #owned(userId: number, id: number): Promise<CalendarProposalRecord> {
    const [row] = await this.#database
      .select()
      .from(calendarProposals)
      .where(and(eq(calendarProposals.id, id), eq(calendarProposals.userId, userId)))
      .limit(1)
    if (row === undefined) throw new CalendarProposalNotFoundError()
    return record(row)
  }

  async #conditions(userId: number, filters: Readonly<CalendarProposalFilters>) {
    const zone =
      filters.from !== undefined || filters.to !== undefined ? await this.#zone(userId) : 'UTC'
    return [
      eq(calendarProposals.userId, userId),
      eq(calendarProposals.status, filters.status ?? 'proposed'),
      ...(filters.from === undefined
        ? []
        : [gte(calendarProposals.startsAt, startOfDayInTimeZone(filters.from, zone))]),
      ...(filters.to === undefined
        ? []
        : [lt(calendarProposals.startsAt, startOfDayInTimeZone(nextDay(filters.to), zone))]),
    ]
  }

  proposals(
    userId: number,
    filters: Readonly<CalendarProposalFilters>,
  ): ResourceSource<CalendarProposalRecord> {
    return {
      highWatermark: async () => {
        const [row] = await this.#database
          .select()
          .from(calendarProposals)
          .where(and(...(await this.#conditions(userId, filters))))
          .orderBy(desc(calendarProposals.id))
          .limit(1)
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await this.#database
          .select()
          .from(calendarProposals)
          .where(
            and(
              ...(await this.#conditions(userId, filters)),
              lte(calendarProposals.id, throughId),
              ...(afterId === null ? [] : [gt(calendarProposals.id, afterId)]),
            ),
          )
          .orderBy(asc(calendarProposals.id))
          .limit(take)
        return rows.map(record)
      },
    }
  }

  async get(userId: number, id: number): Promise<CalendarProposalRecord> {
    return this.#owned(userId, id)
  }

  async discard(userId: number, id: number, decidedAt: string): Promise<CalendarProposalRecord> {
    const [row] = await this.#database
      .update(calendarProposals)
      .set({ status: 'discarded', decidedAt: instant(decidedAt), updatedAt: decidedAt })
      .where(
        and(
          eq(calendarProposals.id, id),
          eq(calendarProposals.userId, userId),
          eq(calendarProposals.status, 'proposed'),
        ),
      )
      .returning()
    if (row !== undefined) return record(row)
    // Nothing changed: it is somebody else's or missing, or already decided.
    throw new CalendarProposalNotOpenError((await this.#owned(userId, id)).status)
  }

  /**
   * Turns a proposal into a time entry through the ordinary creation path.
   *
   * The entry and the proposal's change to `accepted` commit in one batch. The
   * second statement runs after the entry exists and links it by the row just
   * written; a trigger refuses it when the proposal was already decided, which
   * rolls the entry back with it. So a double accept, from two tabs or a retry,
   * leaves one entry, and an entry the path refuses (a locked day, an
   * unassigned task, a missing note) leaves the proposal open.
   */
  async accept(
    actor: TimeEntryActor,
    id: number,
    input: Readonly<AcceptCalendarProposalRequest>,
    boundary: TimeBoundary,
  ): Promise<AcceptedCalendarProposal> {
    const proposal = await this.#owned(actor.userId, id)
    if (proposal.status !== 'proposed') throw new CalendarProposalNotOpenError(proposal.status)
    const [settings, zone] = await Promise.all([
      this.#tracked.timeEntrySettings(),
      this.#zone(actor.userId),
    ])
    const fields = calendarProposalEntryFields({
      mode: settings.mode,
      startsAt: proposal.startsAt,
      endsAt: proposal.endsAt,
      timeZone: zone,
    })
    const reference: CalendarEventReference = {
      provider: proposal.provider,
      event_id: proposal.eventId,
      calendar_id: proposal.calendarId,
    }
    const request: CreateTimeEntryRequest = {
      projectId: input.projectId,
      taskId: input.taskId,
      spentDate: fields.spentDate,
      ...(fields.kind === 'duration'
        ? { seconds: fields.seconds }
        : { startedTime: fields.startedTime, endedTime: fields.endedTime }),
      notes: input.notes !== undefined ? input.notes : proposal.title,
      ...(input.budgeted !== undefined ? { budgeted: input.budgeted } : {}),
      calendarEventRef: { ...reference },
    }
    const markAccepted: CompiledQuery = {
      sql: `UPDATE calendar_proposals
        SET status = 'accepted', time_entry_id = last_insert_rowid(), decided_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
      params: [instant(boundary.instant), boundary.instant, id, actor.userId],
    }
    try {
      const entry = await this.#tracked.createTimeEntry(actor, request, boundary, [markAccepted])
      return { proposal: await this.#owned(actor.userId, id), timeEntryId: entry.id }
    } catch (error) {
      if (!isNotOpenWriteError(error)) throw error
      throw new CalendarProposalNotOpenError((await this.#owned(actor.userId, id)).status)
    }
  }
}
