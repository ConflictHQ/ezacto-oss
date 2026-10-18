// Provenance: ezacto-pvt #935. Notification preferences were stored and the
// product said delivery was inactive; this is what delivery needs of the schema.
//
// The company schedule for the week-end submission reminder is a day and a
// time, both or neither, off by default. Nothing is sent until an administrator
// sets it. The trigger, not the application, holds "both or neither": a day
// with no time would be a reminder that is never due.
//
// `include_in_team_reminders` was 0 for everyone because the delivery-unavailable
// rule forced it, not because anybody chose it, and the issue asks for a
// per-person opt-out. Opting out only means something against a default of in,
// so existing rows and new users both start in. Nobody is mailed by this alone:
// the schedule above is off until an administrator turns it on, and each person
// can switch themselves out under Settings.
export const timeRemindersMigration = [
  `ALTER TABLE organizations ADD COLUMN submission_reminder_day TEXT CHECK (
    submission_reminder_day IS NULL OR submission_reminder_day IN (
      'monday','tuesday','wednesday','thursday','friday','saturday','sunday'
    )
  )`,
  `ALTER TABLE organizations ADD COLUMN submission_reminder_time TEXT CHECK (
    submission_reminder_time IS NULL OR (
      submission_reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(submission_reminder_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    )
  )`,
  `CREATE TRIGGER organizations_submission_reminder_pair
    BEFORE UPDATE OF submission_reminder_day, submission_reminder_time ON organizations
    WHEN (NEW.submission_reminder_day IS NULL) <> (NEW.submission_reminder_time IS NULL)
    BEGIN SELECT RAISE(ABORT, 'submission reminder needs both a day and a time'); END`,
  `UPDATE notification_preferences SET include_in_team_reminders = 1`,
  `DROP TRIGGER users_create_notification_preferences`,
  `CREATE TRIGGER users_create_notification_preferences
    AFTER INSERT ON users BEGIN
      INSERT INTO notification_preferences (user_id, include_in_team_reminders, created_at, updated_at)
      VALUES (NEW.id, 1, NEW.created_at, NEW.updated_at);
    END`,
] as const
