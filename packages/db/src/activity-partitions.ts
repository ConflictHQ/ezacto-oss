// Rolling a finished year of the activity log into its own table.
//
// Why a roll rather than a purge. The log is append-only at the database level:
// a trigger aborts every DELETE, which is what makes it evidence rather than a
// list. Retention that deleted rows would have to remove that trigger, and a
// deletion path that exists can later be pointed at anything. Renaming needs no
// DELETE, so the guarantee survives the retention policy intact.
//
// What follows a rename, and what does not. SQLite carries a table's indexes
// and triggers across `ALTER TABLE ... RENAME TO`, keeping their names and
// repointing the triggers at the new name. That is almost what we want and
// exactly the wrong thing by default: the archived year would hold the names the
// new hot table needs, so creating the hot table fails on a duplicate index and
// its triggers would fire on last year instead. There is no ALTER INDEX RENAME,
// so each has to be dropped and recreated under a year-qualified name.
//
// The archive keeps its own copies of all three guards. A table nobody writes to
// still should not be writable: an archive that could be edited is a worse
// audit record than a hot table that cannot, because nobody is watching it.

import {
  activityCaptureStatements,
  atomic,
  nativeClient,
  type ActivityDatabase,
} from './activity-log.js'
import { canonicalTimestamp } from './migrations/0029_outbox_delivery.js'

const partitionName = (year: number): string => `activity_log_${year}`

/** The guards the hot table carries, restated for a partition or a fresh table. */
const guards = (table: string, suffix: string): readonly string[] => [
  `CREATE INDEX activity_log_recorded_event${suffix}
    ON ${table}(recorded_at DESC, event_id DESC)`,
  `CREATE TRIGGER activity_log_identity_guard${suffix}
    BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} current WHERE current.event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'activity log event already exists'); END`,
  `CREATE TRIGGER activity_log_immutable${suffix}
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'activity log entries are immutable'); END`,
  `CREATE TRIGGER activity_log_reject_delete${suffix}
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'activity log entries are append-only'); END`,
]

export const activityRollStatements = (year: number): readonly string[] => {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError('activity partition year must be a four-digit year')
  }
  const archive = partitionName(year)
  const suffix = `_${year}`
  return [
    `ALTER TABLE activity_log RENAME TO ${archive}`,

    // The index and triggers came across with the table under the hot table's
    // names. Drop them before the new hot table claims those names back.
    `DROP INDEX IF EXISTS activity_log_recorded_event`,
    `DROP TRIGGER IF EXISTS activity_log_identity_guard`,
    `DROP TRIGGER IF EXISTS activity_log_immutable`,
    `DROP TRIGGER IF EXISTS activity_log_reject_delete`,

    ...guards(archive, suffix),

    // Same shape as 0029, including the foreign key: an archived row still
    // names an outbox event, and ON DELETE RESTRICT keeps that event from being
    // removed out from under it.
    `CREATE TABLE activity_log (
      event_id TEXT PRIMARY KEY REFERENCES event_outbox(id) ON DELETE RESTRICT,
      recorded_at TEXT NOT NULL CHECK (${canonicalTimestamp('recorded_at')})
    ) STRICT`,
    ...guards('activity_log', ''),
  ]
}

/**
 * The finished years the hot table still holds rows for, oldest first: what the
 * surface offers to roll. A year already rolled is not here, because its rows
 * left the hot table when it was rolled.
 */
export const rollableActivityYears = async (
  database: ActivityDatabase,
  now: string,
): Promise<{ year: number; entries: number }[]> => {
  const currentYear = new Date(now).getUTCFullYear()
  const [rows] = await atomic(nativeClient(database), [
    {
      sql: `SELECT CAST(substr(recorded_at, 1, 4) AS INTEGER) AS year, count(*) AS entries
        FROM activity_log
        WHERE CAST(substr(recorded_at, 1, 4) AS INTEGER) < ?
        GROUP BY year ORDER BY year`,
      params: [currentYear],
    },
  ])
  return (rows ?? []).map((row) => ({ year: Number(row.year), entries: Number(row.entries) }))
}

/**
 * The roll as the API's port wants it: a refusal is an outcome, not a throw,
 * and the clock belongs to the composition root. Anything else a roll throws
 * is a failure and propagates as one.
 */
export const createActivityRoll = (
  database: ActivityDatabase,
  clock: () => string,
) => ({
  rollable: () => rollableActivityYears(database, clock()),
  roll: async (input: {
    year: number
    actorUserId: number
    requestId: string
  }): Promise<'rolled' | ActivityRollRefusal> => {
    try {
      await rollActivityLog(database, {
        year: input.year,
        actorUserId: input.actorUserId,
        now: clock(),
        captureId: input.requestId,
      })
      return 'rolled'
    } catch (error) {
      if (error instanceof ActivityRollError) return error.code
      throw error
    }
  },
})

export type ActivityRollRefusal = 'current_year' | 'partition_exists'

/** A roll that was refused before anything changed. */
export class ActivityRollError extends Error {
  constructor(
    readonly code: ActivityRollRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'ActivityRollError'
  }
}

export interface ActivityRollInput {
  /** The finished year to roll off the hot table. */
  readonly year: number
  /** The acting administrator, recorded as the roll's actor. */
  readonly actorUserId: number
  /** When the roll runs. Its UTC year is the current year, which is never rolled. */
  readonly now: string
  /** Names the request, so a retried request records the roll once. */
  readonly captureId: string
}

/**
 * Rolls a finished year of the log into `activity_log_<year>` and records the
 * roll itself as an activity event, in one batch: the rename, the guards, the
 * new hot table and the outbox row stand together or not at all, so a roll is
 * never in the database without its record, nor recorded without having
 * happened. Nothing is deleted.
 *
 * The archive holds everything the hot table held when it was rolled. A rename
 * cannot split a table and the log has no DELETE to trim one with, so rows
 * recorded after the year ended but before the roll travel with it. Reads find
 * a row by table and never by the year in a name, so nothing is lost or
 * doubled by that; the name says which roll made the table.
 *
 * Refused without touching anything: the current year (its rows are still
 * arriving, and a roll would split a year across two tables) and a year that
 * already has a partition (a second roll would have nothing to rename onto).
 * The partition is checked first for a clear answer; the rename also fails on
 * an existing name, so a roll that races another still cannot overwrite one.
 */
export const rollActivityLog = async (
  database: ActivityDatabase,
  input: ActivityRollInput,
): Promise<void> => {
  const statements = activityRollStatements(input.year)
  const currentYear = new Date(input.now).getUTCFullYear()
  if (input.year >= currentYear) {
    throw new ActivityRollError(
      'current_year',
      `Only a finished year can be rolled; ${input.year} is not before ${currentYear}.`,
    )
  }
  const client = nativeClient(database)
  const [existing] = await atomic(client, [
    {
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      params: [partitionName(input.year)],
    },
  ])
  if ((existing?.length ?? 0) > 0) {
    throw new ActivityRollError(
      'partition_exists',
      `The activity log for ${input.year} has already been rolled.`,
    )
  }
  const capture = activityCaptureStatements({
    eventType: 'activity_log.rolled',
    subjectId: input.year,
    actor: { type: 'user', id: input.actorUserId },
    occurredAt: input.now,
    captureId: input.captureId,
    detail: { year: input.year, table: partitionName(input.year) },
  })
  await atomic(client, [
    ...statements.map((sql) => ({ sql, params: [] as readonly unknown[] })),
    ...capture.statements,
  ])
}
