// Removing a rate somebody did not mean to add (#727).
//
// Rates are append-only, and for a good reason: a rate is what priced somebody's
// work, and a history that can be edited is a history that cannot explain the
// money it produced. That rule was written for rates that have done their job.
//
// It is the wrong rule for a rate thirty seconds old. Adding one is two clicks
// on a screen with a billable section and a cost section side by side, and the
// insert does not merely add a row -- `close_previous` ends the rate before it.
// So a misclick on the wrong section silently replaces a live rate with a
// different number, and with no way back the only remedy is appending a
// correction: a wrong row in the history for ever, and no remedy at all when
// the mistaken row starts earlier than anything that could correct it, because
// rates may only be appended forward.
//
// ## What makes a rate safe to remove
//
// Two conditions, both checkable here rather than trusted to a caller.
//
// It has to be the current rate -- the one with no end date. Removing a rate
// from the middle would leave the period it covered belonging to nothing, and
// the chain of end dates describing a range nobody ever charged.
//
// And nothing may have been priced from it. That is not "no entry has been
// touched since": an entry's `updated_at` moves when somebody fixes a typo in
// its notes, and a rate that becomes permanent because a colleague edited a
// note is the original problem wearing a different hat. Pricing leaves two
// specific marks -- an entry created after the rate existed, or a reprice
// recorded against one -- and those are what is tested.
//
// ## Removing it puts back what it displaced
//
// The insert closed the rate before it, so the delete has to reopen it, or
// removing the mistake would leave the damage: the rate somebody was actually
// on, still ended, and every day after it priced by nothing.
//
// That reopening is the one update the append-only rule now admits beyond the
// closing one, and only when no later rate remains -- which is another way of
// saying the row that closed it has just gone.

// Reproduced exactly from 0031 rather than rewritten: a rebuild that tightened
// this check would reject rows the old table already holds, and the failure
// would land in the middle of a migration on somebody else's data.
const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

// The ledger's own list of what a command may be. Widened by rebuilding the
// table, because SQLite cannot alter a CHECK -- and rebuilt rather than dropped,
// because the receipts in it are what make a command idempotent: losing them
// would make every past command replayable a second time.
const LEDGER_COLUMNS = `target_user_id, command_kind, command_id, input_fingerprint,
    actor_user_id, result_json, occurred_at`

const tables = ['user_billable_rates', 'user_cost_rates'] as const

export const rateRemovalMigration = [
  `DROP TRIGGER team_command_ledger_reject_update`,
  `DROP TRIGGER team_command_ledger_reject_delete`,
  `ALTER TABLE team_command_ledger RENAME TO team_command_ledger_old`,
  `CREATE TABLE team_command_ledger (
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'person.update','person.assignments.replace','person.notifications.update',
      'person.billable_rate.append','person.cost_rate.append',
      'person.billable_rate.remove','person.cost_rate.remove'
    )),
    command_id TEXT NOT NULL CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    result_json TEXT NOT NULL CHECK (
      json_valid(result_json)
      AND json_extract(result_json, '$.schema_version') = 1
      AND json_type(result_json, '$.data') = 'object'
    ),
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')}),
    PRIMARY KEY (command_kind, command_id)
  ) STRICT`,
  `INSERT INTO team_command_ledger (${LEDGER_COLUMNS})
    SELECT ${LEDGER_COLUMNS} FROM team_command_ledger_old`,
  `DROP TABLE team_command_ledger_old`,
  `CREATE INDEX team_command_ledger_target
    ON team_command_ledger(target_user_id, occurred_at, command_kind, command_id)`,
  `CREATE TRIGGER team_command_ledger_reject_update
    BEFORE UPDATE ON team_command_ledger
    BEGIN SELECT RAISE(ABORT, 'team command receipts are immutable'); END`,
  `CREATE TRIGGER team_command_ledger_reject_delete
    BEFORE DELETE ON team_command_ledger
    BEGIN SELECT RAISE(ABORT, 'team command receipts are append-only'); END`,
  ...tables.flatMap((table) => [
    `DROP TRIGGER ${table}_append_only_delete`,
    `DROP TRIGGER ${table}_append_only_update`,
    // Only the current rate. A closed one is a period somebody was charged
    // under, and removing it would leave that period belonging to nothing.
    `CREATE TRIGGER ${table}_delete_current_only BEFORE DELETE ON ${table}
      WHEN OLD.end_date IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'only the current rate may be removed'); END`,
    // Priced work, not touched work. An entry created after this rate existed
    // could have been priced by it, and a reprice recorded after it certainly
    // was; a note edited afterwards was not, and must not lock the rate.
    `CREATE TRIGGER ${table}_delete_unpriced_only BEFORE DELETE ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM time_entries entry
        WHERE entry.user_id = OLD.user_id
          AND entry.spent_date >= coalesce(OLD.start_date, '0000-01-01')
          AND (
            entry.created_at > OLD.created_at
            OR EXISTS (
              SELECT 1 FROM time_entry_rate_reprices reprice
              WHERE reprice.time_entry_id = entry.id
                AND reprice.repriced_at > OLD.created_at
            )
          )
      )
      BEGIN SELECT RAISE(ABORT, 'a rate that has priced work cannot be removed'); END`,
    // The inverse of `close_previous`: whatever this rate displaced becomes the
    // current one again. Ordered by start date rather than id, because an import
    // can write rates in any order and the newest row is not the latest rate.
    `CREATE TRIGGER ${table}_reopen_previous AFTER DELETE ON ${table} BEGIN
      UPDATE ${table} SET end_date = NULL
      WHERE id = (
        SELECT id FROM ${table} WHERE user_id = OLD.user_id
        ORDER BY coalesce(start_date, '0000-01-01') DESC LIMIT 1
      );
    END`,
    // Two shapes of update, and nothing else: closing a rate as a later one
    // arrives, and reopening one as the rate that closed it is removed. Every
    // other column stays exactly as it was in both.
    `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table}
      WHEN NOT (
        (OLD.end_date IS NULL AND NEW.end_date IS date((
          SELECT min(next.start_date) FROM ${table} next
          WHERE next.user_id = OLD.user_id
            AND coalesce(next.start_date, '0000-01-01') > coalesce(OLD.start_date, '0000-01-01')
        ), '-1 day'))
        OR (OLD.end_date IS NOT NULL AND NEW.end_date IS NULL AND NOT EXISTS (
          SELECT 1 FROM ${table} later
          WHERE later.user_id = OLD.user_id
            AND coalesce(later.start_date, '0000-01-01') > coalesce(OLD.start_date, '0000-01-01')
        ))
      )
        OR OLD.id <> NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
        OR OLD.user_id <> NEW.user_id OR OLD.amount_cents <> NEW.amount_cents
        OR OLD.start_date IS NOT NEW.start_date
        OR OLD.created_at <> NEW.created_at OR OLD.updated_at <> NEW.updated_at
      BEGIN SELECT RAISE(ABORT, 'rates are append-only'); END`,
  ]),
] as const
