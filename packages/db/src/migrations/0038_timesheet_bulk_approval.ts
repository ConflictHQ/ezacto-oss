// Provenance: ezacto-oss #217; D20; richer approvals epic; depends on #19.
import { maximumBulkApprovalSelections } from '@ezacto/core'
import { timesheetLockPolicyMigration } from './0028_timesheet_lock_policy.js'

/**
 * An approver working the filtered queue picks a handful of periods and approves
 * them as one act. That act needs an identity of its own: without it the outbox
 * records N unrelated `timesheet.approved` events and nothing downstream can
 * tell "Priya approved these six on Monday" from six coincidental approvals.
 *
 * The receipt is a two-table ledger rather than a column on the submission,
 * because a submission can be approved, withdrawn and approved again, each time
 * under a different command, and because 0027 makes submission identity
 * immutable. The item row also carries what the approver was looking at when
 * they chose — the version they expected — so the receipt records the decision,
 * not just its outcome.
 *
 * The item row is what makes the batch atomic. Its `submission_id` is NOT NULL
 * and the caller fills it from a subquery that only returns a row when the
 * submission is still submitted, still at the expected version, and still
 * reviewable by this actor. One ineligible selection therefore fails its INSERT,
 * and both runtimes roll the whole batch back: a D1 `batch()` is one
 * transaction, and the container path runs an immediate one.
 */
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

const bulkApprovalLedger = [
  `CREATE TABLE timesheet_bulk_approval_commands (
    command_id TEXT PRIMARY KEY CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    submission_count INTEGER NOT NULL
      CHECK (submission_count BETWEEN 1 AND ${maximumBulkApprovalSelections}),
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')})
  ) STRICT`,
  `CREATE TABLE timesheet_bulk_approval_command_items (
    command_id TEXT NOT NULL
      REFERENCES timesheet_bulk_approval_commands(command_id) ON DELETE RESTRICT,
    submission_id INTEGER NOT NULL
      REFERENCES timesheet_submissions(id) ON DELETE RESTRICT,
    expected_version INTEGER NOT NULL
      CHECK (expected_version BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (command_id, submission_id)
  ) STRICT`,
  `CREATE INDEX timesheet_bulk_approval_command_items_submission
    ON timesheet_bulk_approval_command_items(submission_id)`,
  `CREATE TRIGGER timesheet_bulk_approval_commands_immutable
    BEFORE UPDATE ON timesheet_bulk_approval_commands
    BEGIN SELECT RAISE(ABORT, 'timesheet bulk approval receipts are immutable'); END`,
  `CREATE TRIGGER timesheet_bulk_approval_commands_reject_delete
    BEFORE DELETE ON timesheet_bulk_approval_commands
    BEGIN SELECT RAISE(ABORT, 'timesheet bulk approval receipts are append-only'); END`,
  `CREATE TRIGGER timesheet_bulk_approval_command_items_immutable
    BEFORE UPDATE ON timesheet_bulk_approval_command_items
    BEGIN SELECT RAISE(ABORT, 'timesheet bulk approval receipts are immutable'); END`,
  `CREATE TRIGGER timesheet_bulk_approval_command_items_reject_delete
    BEFORE DELETE ON timesheet_bulk_approval_command_items
    BEGIN SELECT RAISE(ABORT, 'timesheet bulk approval receipts are append-only'); END`,
  `CREATE TRIGGER timesheet_bulk_approval_command_items_within_count
    BEFORE INSERT ON timesheet_bulk_approval_command_items
    WHEN (
      SELECT count(*) FROM timesheet_bulk_approval_command_items item
      WHERE item.command_id = NEW.command_id
    ) >= (
      SELECT command.submission_count FROM timesheet_bulk_approval_commands command
      WHERE command.command_id = NEW.command_id
    )
    BEGIN SELECT RAISE(ABORT, 'timesheet bulk approval command is full'); END`,
] as const

/**
 * The 0028 event trigger and its guard are extended by replacement over their
 * own text, the way 0037 extended 0026's guard, so that a reshaped upstream
 * trigger fails the migration instead of silently losing what it enforced.
 */
const historicalStatement = (prefix: string): string => {
  const found = timesheetLockPolicyMigration.filter((statement) => statement.startsWith(prefix))
  if (found.length !== 1) {
    throw new Error(`bulk approval migration could not find the historical ${prefix}`)
  }
  return found[0]!
}

const assertOnce = (statement: string, fragment: string): void => {
  if (statement.split(fragment).length - 1 !== 1) {
    throw new Error('bulk approval migration found an unexpected historical trigger shape')
  }
}

/**
 * Resolves the command a status update belongs to, or NULL when the update was
 * not part of one. `occurred_at` is part of the match because the same period
 * can be approved under one command, withdrawn, and approved again under
 * another; the pair is unique because a submission's `updated_at` is the instant
 * that particular transition happened.
 */
const commandForUpdate = `        (SELECT (
          SELECT item.command_id FROM timesheet_bulk_approval_command_items item
          JOIN timesheet_bulk_approval_commands receipt
            ON receipt.command_id = item.command_id
          WHERE item.submission_id = NEW.id AND receipt.occurred_at = NEW.updated_at
        ) AS id) command`

const historicalEventUpdate = historicalStatement(
  'CREATE TRIGGER timesheet_submissions_event_update',
)
const eventColumns = `        payload_json, occurred_at, available_at, attempt_count\n`
const payloadOpening = `        json_object(\n          'schema_version', 1, 'event_id', event.id,`
const payloadClosing = `        ), NEW.updated_at, NEW.updated_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;`
assertOnce(historicalEventUpdate, eventColumns)
assertOnce(historicalEventUpdate, payloadOpening)
assertOnce(historicalEventUpdate, payloadClosing)

// json_patch with an empty object returns its target byte for byte, so an
// approval outside a command keeps exactly the payload 0028 wrote.
export const timesheetSubmissionsEventUpdate = historicalEventUpdate
  .replace(
    eventColumns,
    `        payload_json, command_id, event_index, occurred_at, available_at, attempt_count\n`,
  )
  .replace(payloadOpening, `        json_patch(json_object(\n          'schema_version', 1, 'event_id', event.id,`)
  .replace(
    payloadClosing,
    `        ), CASE WHEN command.id IS NULL THEN '{}'
          ELSE json_object('command', json_object('id', command.id)) END),
        command.id, CASE WHEN command.id IS NULL THEN NULL ELSE 0 END,
        NEW.updated_at, NEW.updated_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event,
${commandForUpdate};`,
  )

const historicalSubmissionGuard = historicalStatement(
  'CREATE TRIGGER event_outbox_timesheet_submission_insert_guard',
)
const guardCausation = `      SELECT CASE WHEN NEW.command_id IS NOT NULL OR NEW.event_index IS NOT NULL\n`
assertOnce(historicalSubmissionGuard, guardCausation)

/**
 * 0028 admitted no causation at all on a timesheet event. It now admits exactly
 * the one shape bulk approval writes — an approval, at event index 0, whose
 * payload names the same command as the column, backed by a receipt for this
 * submission by this actor at this instant — and still refuses everything else,
 * including a payload that claims a command the column does not carry.
 */
export const eventOutboxTimesheetSubmissionInsertGuard = historicalSubmissionGuard.replace(
  guardCausation,
  `      SELECT CASE WHEN (NEW.command_id IS NULL) <> (NEW.event_index IS NULL)
        OR (NEW.command_id IS NULL AND json_type(NEW.payload_json, '$.command') IS NOT NULL)
        OR (NEW.command_id IS NOT NULL AND NOT (
          NEW.event_type = 'timesheet.approved' AND NEW.event_index = 0
          AND json_extract(NEW.payload_json, '$.command.id') = NEW.command_id
          AND EXISTS (
            SELECT 1 FROM timesheet_bulk_approval_command_items item
            JOIN timesheet_bulk_approval_commands receipt
              ON receipt.command_id = item.command_id
            WHERE item.command_id = NEW.command_id
              AND item.submission_id = NEW.aggregate_id
              AND receipt.occurred_at = NEW.occurred_at
              AND receipt.actor_user_id = json_extract(NEW.payload_json, '$.actor.id')
          )
        ))\n`,
)

export const timesheetBulkApprovalMigration = [
  ...bulkApprovalLedger,
  `DROP TRIGGER timesheet_submissions_event_update`,
  timesheetSubmissionsEventUpdate,
  `DROP TRIGGER event_outbox_timesheet_submission_insert_guard`,
  eventOutboxTimesheetSubmissionInsertGuard,
] as const
