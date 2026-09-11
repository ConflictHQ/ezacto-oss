// A self-withdrawn week gets its own state, instead of borrowing a rejection's.
//
// `unsubmit` -- a person taking back their own week before anyone reviews it --
// had to write a reviewer, a review time and a reason, because the CHECK on
// `timesheet_submissions` said every unsubmitted row carries all three. That
// CHECK was written when a reviewer sending it back was the only way to reach
// `unsubmitted`. So the owner was recorded as their own reviewer and a fixed
// sentence stood in for the reason, and telling a withdrawal from a rejection
// meant matching that sentence. A reviewer who typed it verbatim was misread.
//
// The fourth branch below says what is actually true of a withdrawal: nobody
// reviewed it. `isSelfWithdrawn` becomes "unsubmitted with no reviewer", which
// no rejection can collide with, and `rejection_reason` goes back to holding
// only rejections.
//
// SQLite cannot alter a CHECK, so the table is rebuilt. That is the risky part:
// the rebuild has to restore two indexes and ten triggers whose final
// definitions are spread across 0027, 0028 and 0038, several superseded more
// than once. Hand-copying that much trigger SQL is what produced three silent
// validation bugs in issue 420 -- a lost `trim` argument, two objects that
// became booleans, a dropped distinct-check -- two of which *loosened*
// validation while every test still passed.
//
// So nothing here is transcribed. Each statement is imported from the migration
// that owns its final form, and the rebuilt table is derived from the original
// DDL by one replacement that throws if it does not match exactly once. The
// only SQL written out by hand is the new branch itself.

import {
  timesheetSubmissionsApproveEntries,
  timesheetSubmissionsEventInsert,
  timesheetSubmissionsImportEventInsert,
  timesheetSubmissionsInsertGuard,
  timesheetSubmissionsQueueIndex,
  timesheetSubmissionsRejectDelete,
  timesheetSubmissionsSubmitEntriesInsert,
  timesheetSubmissionsSubmitEntriesUpdate,
  timesheetSubmissionsTable,
  timesheetSubmissionsUserPeriodUniqueIndex,
} from './0027_timesheet_approvals.js'
import {
  timesheetSubmissionsRejectEntries,
  timesheetSubmissionsUpdateGuard,
} from './0028_timesheet_lock_policy.js'
import {
  eventOutboxTimesheetSubmissionInsertGuard,
  timesheetSubmissionsEventUpdate,
} from './0038_timesheet_bulk_approval.js'

/**
 * The sentence a withdrawal used to store in `rejection_reason`.
 *
 * Stated here rather than imported from `timesheet-approvals.ts` because a
 * migration records what the database said when it ran. The application is
 * about to stop writing this, and a migration that changed meaning when the
 * application changed its mind would not be a record of anything.
 */
const legacyWithdrawalReason = 'Taken back by the owner before review.'

/** The branch every unsubmitted row had to satisfy, reviewer and all. */
const rejectedBranch = `OR (status = 'unsubmitted' AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL
        AND length(trim(rejection_reason)) BETWEEN 1 AND 10000)`

/**
 * The same branch, now joined by one for a week nobody reviewed.
 *
 * `submitted_by_user_id IS NOT NULL` is what keeps this from being a hole: a
 * row can only be withdrawn if it was submitted, so the new branch cannot be
 * satisfied by a row that was never anything.
 */
const withdrawnBranch = `${rejectedBranch}
      OR (status = 'unsubmitted' AND reviewed_by_user_id IS NULL
        AND reviewed_at IS NULL AND rejection_reason IS NULL
        AND submitted_by_user_id IS NOT NULL)`

const replaceOnce = (source: string, find: string, replacement: string): string => {
  if (source.split(find).length - 1 !== 1) {
    throw new Error('self-withdrawal migration did not find the unsubmitted CHECK branch exactly once')
  }
  return source.replace(find, replacement)
}

const rebuiltTable = replaceOnce(timesheetSubmissionsTable, rejectedBranch, withdrawnBranch)

/**
 * A plain copy of the table under another name, to hold the rows while the real
 * one is replaced.
 *
 * The obvious rebuild -- rename the original aside, create the new one, copy,
 * drop -- cannot be used here. When `foreign_keys` is ON, SQLite rewrites the
 * `REFERENCES` clause of every table pointing at the one being renamed, so
 * `time_entries`, `expenses` and `timesheet_bulk_approval_command_items` would
 * all end up referring to the temporary name, and they would keep referring to
 * it after the rebuild finished. `PRAGMA legacy_alter_table` does not prevent
 * this -- on SQLite 3.53 the clauses are rewritten either way, which is worth
 * stating because two earlier rebuilds in this ledger set that pragma and
 * appear to work: nothing has a foreign key to the tables they rebuilt, so the
 * rewriting had nothing to catch.
 *
 * Staging instead of renaming keeps the name `timesheet_submissions` pointing
 * at a real table the whole way through, so no other table's DDL is touched.
 */
const stagingTable = replaceOnce(
  rebuiltTable,
  'CREATE TABLE timesheet_submissions (',
  'CREATE TABLE timesheet_submissions_0047 (',
)

/**
 * Who the outbox records as the actor behind a status change.
 *
 * Both the event trigger and the guard that checks its payload read the actor
 * off `reviewed_by_user_id` for anything that is not a submission. A withdrawal
 * no longer has one, so the actor became NULL, the guard's `=` comparison
 * against NULL was never true, and every self-withdrawal failed with "timesheet
 * outbox event does not match its submission".
 *
 * `COALESCE` says the thing that was always meant: the reviewer if somebody
 * reviewed it, otherwise the owner -- who, for a withdrawal, is exactly who
 * acted. The event type is left alone; `submitted -> unsubmitted` still reports
 * `timesheet.rejected`, which is worth revisiting but is a change to what
 * consumers are told rather than to how this row is stored.
 */
const patchedEventUpdate = replaceOnce(
  timesheetSubmissionsEventUpdate,
  `'actor', json_object('type', 'user', 'id', CASE WHEN NEW.status = 'submitted'
            THEN NEW.submitted_by_user_id ELSE NEW.reviewed_by_user_id END),`,
  `'actor', json_object('type', 'user', 'id', CASE WHEN NEW.status = 'submitted'
            THEN NEW.submitted_by_user_id
            ELSE COALESCE(NEW.reviewed_by_user_id, NEW.user_id) END),`,
)

const patchedOutboxGuard = replaceOnce(
  eventOutboxTimesheetSubmissionInsertGuard,
  `AND json_extract(NEW.payload_json, '$.actor.id') = CASE submission.status
                  WHEN 'submitted' THEN submission.submitted_by_user_id
                  ELSE submission.reviewed_by_user_id END`,
  `AND json_extract(NEW.payload_json, '$.actor.id') = CASE submission.status
                  WHEN 'submitted' THEN submission.submitted_by_user_id
                  ELSE COALESCE(submission.reviewed_by_user_id, submission.user_id) END`,
)

/**
 * Every trigger and index the rebuild has to put back.
 *
 * Dropping a table drops the triggers defined ON it, and these are exactly
 * those -- triggers on `time_entries`, `expenses` and `event_outbox` that
 * merely *reference* submissions survive the rebuild untouched.
 */
const restored = [
  timesheetSubmissionsUserPeriodUniqueIndex,
  timesheetSubmissionsQueueIndex,
  timesheetSubmissionsInsertGuard,
  timesheetSubmissionsUpdateGuard,
  timesheetSubmissionsRejectDelete,
  timesheetSubmissionsSubmitEntriesInsert,
  timesheetSubmissionsSubmitEntriesUpdate,
  timesheetSubmissionsApproveEntries,
  timesheetSubmissionsRejectEntries,
  timesheetSubmissionsEventInsert,
  timesheetSubmissionsImportEventInsert,
  patchedEventUpdate,
] as const

export const timesheetSelfWithdrawalMigration = [
  // Foreign keys are enforced at COMMIT rather than per statement, so the rows
  // in `time_entries` and `expenses` may point at a submissions table that does
  // not exist for the few statements it takes to replace it. This is the one
  // pragma of the pair that works inside a transaction, which is what the
  // migration runner wraps every migration in.
  `PRAGMA defer_foreign_keys = ON`,

  `DROP TRIGGER timesheet_submissions_insert_guard`,
  `DROP TRIGGER timesheet_submissions_update_guard`,
  `DROP TRIGGER timesheet_submissions_reject_delete`,
  `DROP TRIGGER timesheet_submissions_submit_entries_insert`,
  `DROP TRIGGER timesheet_submissions_submit_entries_update`,
  `DROP TRIGGER timesheet_submissions_approve_entries`,
  `DROP TRIGGER timesheet_submissions_reject_entries`,
  `DROP TRIGGER timesheet_submissions_event_insert`,
  `DROP TRIGGER timesheet_submissions_import_event_insert`,
  `DROP TRIGGER timesheet_submissions_event_update`,
  `DROP INDEX timesheet_submissions_user_period_unique`,
  `DROP INDEX timesheet_submissions_queue`,

  stagingTable,
  // `SELECT *` rather than seventeen column names: staging is the rebuilt DDL
  // under another name, so the columns are the same in the same order by
  // construction. Listing them would be a transcription that could drift.
  `INSERT INTO timesheet_submissions_0047 SELECT * FROM timesheet_submissions`,
  `DROP TABLE timesheet_submissions`,
  rebuiltTable,
  `INSERT INTO timesheet_submissions SELECT * FROM timesheet_submissions_0047`,
  `DROP TABLE timesheet_submissions_0047`,

  // Before the triggers go back, because `timesheet_submissions_update_guard`
  // requires a version bump and an enabled approval module, and this is a
  // normalisation of what a row already meant rather than a transition.
  //
  // Narrow on purpose. A reviewer who happened to type that exact sentence when
  // rejecting somebody else's week is not matched, because the reviewer is not
  // the owner -- which is the collision this whole change exists to remove, and
  // it would be careless to reintroduce it here in the one statement that reads
  // the sentence for the last time.
  `UPDATE timesheet_submissions
    SET reviewed_by_user_id = NULL, reviewed_at = NULL, rejection_reason = NULL
    WHERE status = 'unsubmitted'
      AND reviewed_by_user_id = user_id
      AND rejection_reason = '${legacyWithdrawalReason}'
      AND submitted_by_user_id IS NOT NULL`,

  ...restored,

  // Not dropped by the rebuild -- this one is defined ON `event_outbox` -- so it
  // is replaced explicitly.
  `DROP TRIGGER event_outbox_timesheet_submission_insert_guard`,
  patchedOutboxGuard,
] as const
