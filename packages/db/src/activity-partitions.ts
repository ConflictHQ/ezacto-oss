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
