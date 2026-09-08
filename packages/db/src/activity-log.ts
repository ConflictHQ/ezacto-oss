import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type ActivityDatabase = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

/**
 * The activity log is fed by the outbox, and money already arrives there: an
 * invoice transition writes its event in the same transaction as the state
 * change, and the `activity_log` subscriber records it exactly once. Sign-ins,
 * token grants, and the D18 export and restore never reached the outbox at
 * all, so the log could answer "what happened to this invoice" and not "who
 * signed in and took a copy of the database". This module is the writer that
 * puts them on the same rail, so one drain records every kind of event and
 * there is no second path to keep honest.
 *
 * Nothing here decides how long a row lives. Capture writes no expiry, no
 * class, and no ttl, because whether retention deletes rows or only narrows
 * what the surface shows is still an open question, and a column written today
 * would answer it by accident.
 */

/**
 * What the log will record, and the aggregate each kind belongs to. Closed on
 * purpose: an aggregate is a sequence, and a caller free to name its own can
 * split one subject's history across two names, after which "exactly once per
 * subject, in order" is no longer a property anything can check.
 */
export const ACTIVITY_EVENT_AGGREGATES = {
  'auth.signed_in': 'user_authentication',
  'auth.signed_out': 'user_authentication',
  'api_token.created': 'api_token',
  'api_token.revoked': 'api_token',
  'backup.exported': 'backup_run',
  'backup.restored': 'backup_restore',
} as const

export type ActivityEventType = keyof typeof ACTIVITY_EVENT_AGGREGATES

/**
 * Who caused the event, in the shape the invoice events already use, so a
 * reader of the log does not need a second rule for the rows that arrived from
 * here. `system` carries no id: a nightly export has no actor to name, and
 * writing the id of whoever configured the schedule would claim they ran it.
 */
export type ActivityActor =
  | { readonly type: 'user'; readonly id: number }
  | { readonly type: 'contact'; readonly id: number }
  | { readonly type: 'system' }

export interface ActivityEventInput {
  readonly eventType: ActivityEventType
  /**
   * The row the event is about: the user who signed in, the token that was
   * granted or revoked, the `backup_runs` row that was exported. A restore has
   * no such row — it is something done to the whole instance — so restores
   * pass the instance's own id, `1`, and read as one ordered history.
   */
  readonly subjectId: number
  readonly actor: ActivityActor
  readonly occurredAt: string
  /**
   * The caller's name for the work being recorded, stored as the event's
   * causation id. A retried sign-in handler or a re-run export step reuses it
   * and the second capture is a no-op rather than a second row in the log.
   */
  readonly captureId: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface ActivityCaptureResult {
  readonly eventId: string
  readonly aggregateType: string
  readonly aggregateId: number
  readonly aggregateSequence: number
  /** False when this capture id had already been recorded and nothing was written. */
  readonly captured: boolean
}

export interface CaptureActivityEventOptions {
  /** Overridable so a test can assert against a known event id. */
  readonly createEventId?: () => string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const captureIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const epoch = Date.parse(value)
  if (
    !canonicalTimestampPattern.test(value) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
}

const assertRowId = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive row id`)
  }
}

const nativeClient = (database: ActivityDatabase): NativeClient =>
  (database as ActivityDatabase & { $client: NativeClient }).$client

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const atomic = async (
  client: NativeClient,
  statements: readonly { sql: string; params: readonly unknown[] }[],
): Promise<Record<string, unknown>[][]> => {
  if (isD1Client(client)) {
    return (
      await client.batch(
        statements.map((statement) => client.prepare(statement.sql).bind(...statement.params)),
      )
    ).map((result) => (result.results ?? []) as Record<string, unknown>[])
  }
  return client.transaction(() =>
    statements.map(
      (statement) =>
        client.prepare(statement.sql).all(...statement.params) as Record<string, unknown>[],
    ),
  )()
}

interface CapturedRow {
  eventId: string
  aggregateSequence: number
}

const capturedRow = (row: Record<string, unknown> | undefined): CapturedRow | null =>
  typeof row?.eventId === 'string' && typeof row.aggregateSequence === 'number'
    ? { eventId: row.eventId, aggregateSequence: row.aggregateSequence }
    : null

/**
 * Appends one activity event to the outbox, from which the activity subscriber
 * records it.
 *
 * The sequence is chosen inside the insert rather than read first and written
 * back, because two sign-ins by the same user land close enough together that a
 * read-then-write pair loses one to the outbox's identity guard. The payload is
 * built here and its sequence patched in the same statement, so the envelope
 * cannot disagree with the column the drain orders by.
 */
export const captureActivityEvent = async (
  database: ActivityDatabase,
  input: ActivityEventInput,
  options: CaptureActivityEventOptions = {},
): Promise<ActivityCaptureResult> => {
  const aggregateType = ACTIVITY_EVENT_AGGREGATES[input.eventType]
  if (aggregateType === undefined) {
    throw new RangeError(`${input.eventType} is not an activity event type`)
  }
  assertRowId(input.subjectId, 'activity subject id')
  assertCanonicalTimestamp(input.occurredAt, 'activity occurred_at')
  if (!captureIdPattern.test(input.captureId)) {
    throw new RangeError('activity capture id must use 1-128 safe identifier characters')
  }
  if (input.actor.type !== 'system') assertRowId(input.actor.id, 'activity actor id')
  const detail = input.detail ?? {}
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    throw new RangeError('activity detail must be an object')
  }

  const eventId = (options.createEventId ?? (() => crypto.randomUUID()))()
  // Patched to the sequence the insert settles on; a literal here would be a
  // second answer to a question the row already answers.
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: input.eventType,
    occurred_at: input.occurredAt,
    aggregate: { type: aggregateType, id: input.subjectId, sequence: 0 },
    actor: {
      type: input.actor.type,
      id: input.actor.type === 'system' ? null : input.actor.id,
    },
    [aggregateType]: detail,
  })

  const [inserted, existing] = await atomic(nativeClient(database), [
    {
      sql: `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          command_id, event_index, payload_json, occurred_at, available_at
        )
        SELECT ?, ?, ?, next.sequence, ?, ?, 0,
          json_set(json(?), '$.aggregate.sequence', next.sequence), ?, ?
        FROM (
          SELECT coalesce(max(aggregate_sequence), 0) + 1 AS sequence
          FROM event_outbox WHERE aggregate_type = ? AND aggregate_id = ?
        ) next
        WHERE NOT EXISTS (
          SELECT 1 FROM event_outbox recorded
          WHERE recorded.aggregate_type = ? AND recorded.aggregate_id = ?
            AND recorded.command_id = ? AND recorded.event_index = 0
        )
        RETURNING id AS eventId, aggregate_sequence AS aggregateSequence`,
      params: [
        eventId,
        aggregateType,
        input.subjectId,
        input.eventType,
        input.captureId,
        payload,
        input.occurredAt,
        input.occurredAt,
        aggregateType,
        input.subjectId,
        aggregateType,
        input.subjectId,
        input.captureId,
      ],
    },
    {
      sql: `SELECT id AS eventId, aggregate_sequence AS aggregateSequence
        FROM event_outbox
        WHERE aggregate_type = ? AND aggregate_id = ? AND command_id = ? AND event_index = 0`,
      params: [aggregateType, input.subjectId, input.captureId],
    },
  ])

  const written = capturedRow(inserted?.[0])
  const recorded = written ?? capturedRow(existing?.[0])
  if (recorded === null) {
    throw new Error(`activity capture ${input.captureId} neither wrote nor found an event`)
  }
  return {
    eventId: recorded.eventId,
    aggregateType,
    aggregateId: input.subjectId,
    aggregateSequence: recorded.aggregateSequence,
    captured: written !== null,
  }
}
