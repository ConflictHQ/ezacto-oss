// Provenance: ezacto-pvt #103. Persistence for the Deel time sync.
//
// `deel_transfer_log` is the safety story: Deel has no idempotency key on
// timesheet creation, so the only thing between one set of hours and being paid
// twice is a row here. One row per time entry that reached Deel, written with
// the fingerprint of exactly what was sent. The primary key makes a second row
// for an entry impossible, and the log is append-only: a transfer is a fact,
// and correcting it would turn the log into a summary of what we now believe.
//
// `entry_id` deliberately has no foreign key to `time_entries`. A transferred
// entry that is later deleted must not be blocked (or silently cascaded away);
// the reconciliation report is what notices the entry is gone while its hours
// were already sent.
//
// `deel_sync_runs` records each scheduled run. At most one may be `running`, so
// two overlapping invocations cannot both plan the same entries.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'`

export const deelTimeSyncMigration = [
  `CREATE TABLE deel_transfer_log (
    entry_id INTEGER PRIMARY KEY CHECK (entry_id > 0),
    fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) BETWEEN 1 AND 255),
    timesheet_id TEXT NOT NULL CHECK (length(trim(timesheet_id)) BETWEEN 1 AND 128),
    transferred_at TEXT NOT NULL CHECK (${canonicalTimestamp('transferred_at')})
  ) STRICT`,
  `CREATE INDEX deel_transfer_log_timesheet ON deel_transfer_log(timesheet_id)`,
  `CREATE TRIGGER deel_transfer_log_no_update
    BEFORE UPDATE ON deel_transfer_log
    BEGIN SELECT RAISE(ABORT, 'a deel transfer log record is immutable'); END`,
  `CREATE TRIGGER deel_transfer_log_no_delete
    BEFORE DELETE ON deel_transfer_log
    BEGIN SELECT RAISE(ABORT, 'a deel transfer log record is immutable'); END`,

  `CREATE TABLE deel_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL CHECK (${canonicalTimestamp('started_at')}),
    finished_at TEXT CHECK (finished_at IS NULL OR (${canonicalTimestamp('finished_at')})),
    outcome TEXT NOT NULL CHECK (outcome IN ('running', 'completed', 'failed')),
    timesheets_submitted INTEGER NOT NULL DEFAULT 0 CHECK (timesheets_submitted >= 0),
    entries_transferred INTEGER NOT NULL DEFAULT 0 CHECK (entries_transferred >= 0),
    detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 100000)),
    CHECK ((outcome = 'running') = (finished_at IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX deel_sync_runs_one_running ON deel_sync_runs(outcome)
    WHERE outcome = 'running'`,
] as const
