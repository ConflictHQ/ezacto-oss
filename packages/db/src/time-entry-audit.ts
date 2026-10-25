import type { TimeEntry } from './time-entries.js'
import type { CompiledQuery } from './tracked-state.js'

/**
 * A change an administrator made to somebody else's time (#917), as an event
 * in the outbox, which the activity log records like every other event.
 *
 * The event is written in the same transaction (or D1 batch) as the change it
 * describes and guarded on `changes() = 1`, so there is no corrected entry
 * without its record and no record of a correction that was refused. `actor`
 * is the person who made the change; `time_entry.user_id` is the person whose
 * time it is -- the same split the timesheet events make between the reviewer
 * and the submitter.
 *
 * Only changes made on somebody else's behalf are recorded. A person editing
 * their own week is the ordinary case and has never been logged here.
 */
export const timeEntryOnBehalfEventTypes = {
  create: 'time_entry.created_on_behalf',
  update: 'time_entry.updated_on_behalf',
  stop: 'time_entry.stopped_on_behalf',
  delete: 'time_entry.deleted_on_behalf',
} as const

export type TimeEntryOnBehalfAction = keyof typeof timeEntryOnBehalfEventTypes

/** What happened to the entry: created, or changed from how the write found it. */
export type TimeEntryChange =
  | { readonly action: 'create' }
  | {
      readonly action: Exclude<TimeEntryOnBehalfAction, 'create'>
      /**
       * The entry as the request read it before writing. An update or delete
       * is guarded on that row's `updated_at`, so for those it is exactly the
       * row the write replaced.
       */
      readonly before: TimeEntry
    }

export type TimeEntryOnBehalfChange = TimeEntryChange & {
  readonly actorUserId: number
  readonly ownerUserId: number
  readonly occurredAt: string
}

/**
 * What the record shows of an entry, before and after. The keys are the column
 * names, so one list builds both halves: `before` from the row the request
 * read, `after` from the row as the write left it, inside the same statement.
 *
 * No rates. The activity log is readable by everyone who reads reports, and a
 * cost rate is the administrator's alone (`canViewMoneyField`); a correction
 * record must not become the way round that.
 */
const snapshotFields = [
  ['project_id', 'projectId'],
  ['task_id', 'taskId'],
  ['spent_date', 'spentDate'],
  ['seconds', 'seconds'],
  ['started_time', 'startedTime'],
  ['ended_time', 'endedTime'],
  ['timer_started_at', 'timerStartedAt'],
  ['notes', 'notes'],
  ['billable', 'billable'],
  ['budgeted', 'budgeted'],
  ['approval_status', 'approvalStatus'],
  ['updated_at', 'updatedAt'],
] as const satisfies readonly (readonly [string, keyof TimeEntry])[]

const booleanColumns: ReadonlySet<string> = new Set(['billable', 'budgeted'])

const snapshot = (entry: TimeEntry): Record<string, unknown> =>
  Object.fromEntries(snapshotFields.map(([column, property]) => [column, entry[property]]))

// The two flags are stored as 0/1; spelled as JSON booleans so the `after`
// half reads exactly like the `before` half built from the mapped row.
const snapshotObject = `json_object(${snapshotFields
  .map(([column]) =>
    booleanColumns.has(column)
      ? `'${column}', json(CASE WHEN entry.${column} = 1 THEN 'true' ELSE 'false' END)`
      : `'${column}', entry.${column}`,
  )
  .join(', ')})`

/**
 * The outbox insert recording one on-behalf change. Run it as a follow-up of
 * the write it describes (`executeAtomicTrackedMutation`, `executeAtomicWrite`):
 * it reads `changes()` from the preceding statement. For a create, the
 * target is the newest time row in this same serialized batch: intervening
 * atomic ledger follow-ups may have changed last_insert_rowid().
 */
export const timeEntryOnBehalfEvent = (change: TimeEntryOnBehalfChange): CompiledQuery => {
  const eventId = crypto.randomUUID()
  const eventType = timeEntryOnBehalfEventTypes[change.action]
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    occurred_at: change.occurredAt,
    // Both patched by the statement: a created entry's id is the one the insert
    // has just taken, and the sequence is chosen where it is written.
    aggregate: { type: 'time_entry', id: 0, sequence: 0 },
    actor: { type: 'user', id: change.actorUserId },
    time_entry: {
      user_id: change.ownerUserId,
      before: change.action === 'create' ? null : snapshot(change.before),
      after: null,
    },
  })
  return {
    sql: `INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at
      )
      SELECT ?, 'time_entry', subject.id, subject.sequence, ?,
        json_set(json(?),
          '$.aggregate.id', subject.id,
          '$.aggregate.sequence', subject.sequence,
          '$.time_entry.after', json((
            SELECT ${snapshotObject} FROM time_entries entry WHERE entry.id = subject.id
          ))),
        ?, ?
      FROM (
        SELECT target.id AS id, coalesce((
          SELECT max(aggregate_sequence) FROM event_outbox
          WHERE aggregate_type = 'time_entry' AND aggregate_id = target.id
        ), 0) + 1 AS sequence
        FROM (SELECT ${change.action === 'create' ? '(SELECT max(id) FROM time_entries)' : '?'} AS id) target
      ) subject
      WHERE changes() = 1`,
    params: [
      eventId,
      eventType,
      payload,
      change.occurredAt,
      change.occurredAt,
      ...(change.action === 'create' ? [] : [change.before.id]),
    ],
  }
}
