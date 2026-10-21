import { timesheetSelfWithdrawalMigration } from './0047_timesheet_self_withdrawal.js'
const historical = (prefix: string): string => {
  const matches = timesheetSelfWithdrawalMigration.filter((statement) =>
    statement.startsWith(prefix),
  )
  if (matches.length !== 1)
    throw new Error('Automatic approval could not find the current timesheet trigger')
  return matches[0]!
}
const timesheetSubmissionsEventUpdate = historical(
  'CREATE TRIGGER timesheet_submissions_event_update',
)
const eventOutboxTimesheetSubmissionInsertGuard = historical(
  'CREATE TRIGGER event_outbox_timesheet_submission_insert_guard',
)
const replaceOnce = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2)
    throw new Error('Automatic approval found an unexpected historical trigger shape')
  return source.replace(before, after)
}
const receipt = (submission: string, version: string) =>
  `EXISTS(SELECT 1 FROM timesheet_automatic_approval_receipts automatic WHERE automatic.submission_id=${submission} AND automatic.approved_version=${version})`
const automaticJson = (submission: string, version: string) =>
  `(SELECT json_object('actor','system','authorized_by_user_id',automatic.authorized_by_user_id,'window_days',automatic.window_days,'effective_from',automatic.effective_from,'submitted_at',automatic.submitted_at,'approved_at',automatic.approved_at,'command_id',automatic.command_id) FROM timesheet_automatic_approval_receipts automatic WHERE automatic.submission_id=${submission} AND automatic.approved_version=${version})`
const originalActor = `'actor', json_object('type', 'user', 'id', CASE WHEN NEW.status = 'submitted'
            THEN NEW.submitted_by_user_id
            ELSE COALESCE(NEW.reviewed_by_user_id, NEW.user_id) END),`
let event = replaceOnce(
  timesheetSubmissionsEventUpdate,
  originalActor,
  `'actor', json(CASE WHEN NEW.status='approved' AND ${receipt('NEW.id', 'NEW.version')} THEN '{"type":"system"}' ELSE json_object('type','user','id',CASE WHEN NEW.status='submitted' THEN NEW.submitted_by_user_id ELSE COALESCE(NEW.reviewed_by_user_id,NEW.user_id) END) END),`,
)
event = replaceOnce(
  event,
  `'timesheet_submission', json_object(`,
  `'timesheet_submission', json_patch(json_object(`,
)
event = replaceOnce(
  event,
  `'after_status', NEW.status, 'rejection_reason', NEW.rejection_reason\n          )`,
  `'after_status', NEW.status, 'rejection_reason', NEW.rejection_reason
          ), CASE WHEN NEW.status='approved' AND ${receipt('NEW.id', 'NEW.version')} THEN json_object('automatic_approval',json(${automaticJson('NEW.id', 'NEW.version')})) ELSE '{}' END)`,
)

let guard = replaceOnce(
  eventOutboxTimesheetSubmissionInsertGuard,
  `AND receipt.actor_user_id = json_extract(NEW.payload_json, '$.actor.id')`,
  `AND (receipt.actor_user_id = json_extract(NEW.payload_json, '$.actor.id') OR EXISTS(SELECT 1 FROM timesheet_automatic_approval_receipts automatic WHERE automatic.command_id=NEW.command_id AND automatic.submission_id=NEW.aggregate_id AND automatic.authorized_by_user_id=receipt.actor_user_id AND automatic.approved_at=NEW.occurred_at))`,
)
guard = replaceOnce(
  guard,
  `AND json_extract(NEW.payload_json, '$.actor.type') = 'user'
                AND json_extract(NEW.payload_json, '$.actor.id') = CASE submission.status
                  WHEN 'submitted' THEN submission.submitted_by_user_id
                  ELSE COALESCE(submission.reviewed_by_user_id, submission.user_id) END`,
  `AND ((NOT (submission.status='approved' AND ${receipt('submission.id', 'submission.version')}) AND COALESCE(json_type(NEW.payload_json,'$.timesheet_submission.automatic_approval'),'null')='null' AND json_extract(NEW.payload_json, '$.actor.type')='user' AND json_extract(NEW.payload_json, '$.actor.id')=CASE submission.status WHEN 'submitted' THEN submission.submitted_by_user_id ELSE COALESCE(submission.reviewed_by_user_id, submission.user_id) END)
                  OR (NEW.event_type='timesheet.approved' AND ${receipt('submission.id', 'submission.version')} AND json_extract(NEW.payload_json, '$.actor.type')='system' AND json_type(NEW.payload_json, '$.actor.id') IS NULL AND json_extract(NEW.payload_json,'$.timesheet_submission.automatic_approval')=${automaticJson('submission.id', 'submission.version')}))`,
)
export const timesheetAutomaticReceiptsMigration = [
  `CREATE TABLE timesheet_automatic_approval_receipts (
    command_id TEXT PRIMARY KEY REFERENCES timesheet_bulk_approval_commands(command_id) ON DELETE RESTRICT,
    submission_id INTEGER NOT NULL REFERENCES timesheet_submissions(id) ON DELETE RESTRICT,
    approved_version INTEGER NOT NULL CHECK(approved_version BETWEEN 1 AND 9007199254740991),
    authorized_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    window_days INTEGER NOT NULL CHECK(window_days BETWEEN 1 AND 60),
    effective_from TEXT NOT NULL, submitted_at TEXT NOT NULL, approved_at TEXT NOT NULL,
    UNIQUE(submission_id,approved_version)
  ) STRICT`,
  `CREATE TRIGGER timesheet_automatic_receipts_immutable BEFORE UPDATE ON timesheet_automatic_approval_receipts BEGIN SELECT RAISE(ABORT,'Automatic approval receipts are immutable'); END`,
  `CREATE TRIGGER timesheet_automatic_receipts_append_only BEFORE DELETE ON timesheet_automatic_approval_receipts BEGIN SELECT RAISE(ABORT,'Automatic approval receipts are append-only'); END`,
  `DROP TRIGGER timesheet_submissions_event_update`,
  event,
  `DROP TRIGGER event_outbox_timesheet_submission_insert_guard`,
  guard,
] as const
