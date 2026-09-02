import { approvalCompatibleInstanceBootstrapExactStateTrigger } from './0012_instance_bootstrap.js'

// Provenance: ezacto-oss #68; Team/person administration and notification contract.
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

const reminderDaysValid = `json_valid(reminder_days)
  AND json_type(reminder_days) = 'array'`

const reminderDaysInvalid = `EXISTS (
    SELECT 1 FROM json_each(NEW.reminder_days)
    WHERE type <> 'text' OR value NOT IN (
      'monday','tuesday','wednesday','thursday','friday','saturday','sunday'
    )
  ) OR (SELECT count(*) FROM json_each(NEW.reminder_days)) <>
    (SELECT count(DISTINCT value) FROM json_each(NEW.reminder_days))`

const teamCompatibleInstanceBootstrapExactStateTrigger =
  approvalCompatibleInstanceBootstrapExactStateTrigger.replace(
    `'${JSON.stringify({ approval: true, expenses: true, invoices: true })}')`,
    `'${JSON.stringify({ approval: true, expenses: true, invoices: true })}',
            '${JSON.stringify({ approval: true, expenses: true, invoices: true, team: true })}')`,
  ).replace(
    `'${JSON.stringify({ expenses: true, invoices: true })}',`,
    `'${JSON.stringify({ expenses: true, invoices: true })}',
            '${JSON.stringify({ expenses: true, invoices: true, team: true })}',`,
  ).replace(
    `AND organization.timesheet_deadline IS NULL`,
    `AND organization.timezone = 'UTC'
          AND organization.timesheet_deadline IS NULL`,
  )

export const teamPeopleMigration = [
  `UPDATE organizations
    SET modules = json_set(modules, '$.team', json('true'))
    WHERE json_type(modules, '$.team') IS NULL`,
  `DROP TRIGGER IF EXISTS instance_bootstrap_exact_state`,
  teamCompatibleInstanceBootstrapExactStateTrigger,
  `ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 0
    CHECK (version BETWEEN 0 AND 9007199254740991)`,
  `ALTER TABLE users ADD COLUMN team_write_token TEXT`,
  `UPDATE users SET is_active = 1 WHERE is_owner = 1`,
  `CREATE TRIGGER organization_owner_activates_user_insert
    AFTER INSERT ON organization_owner BEGIN
      UPDATE users SET is_active = 1 WHERE id = NEW.user_id;
    END`,
  `CREATE TRIGGER organization_owner_activates_user_update
    AFTER UPDATE OF user_id ON organization_owner BEGIN
      UPDATE users SET is_active = 1 WHERE id = NEW.user_id;
    END`,
  `CREATE TRIGGER users_owner_cannot_be_deactivated
    BEFORE UPDATE OF is_active ON users
    WHEN OLD.is_owner = 1 AND NEW.is_active = 0
    BEGIN SELECT RAISE(ABORT, 'the organization owner cannot be deactivated'); END`,
  `CREATE TRIGGER users_last_active_administrator
    BEFORE UPDATE OF profile, is_active ON users
    WHEN OLD.profile = 'administrator' AND OLD.is_active = 1
      AND (NEW.profile <> 'administrator' OR NEW.is_active = 0)
      AND NOT EXISTS (
        SELECT 1 FROM users other
        WHERE other.id <> OLD.id AND other.profile = 'administrator' AND other.is_active = 1
      )
    BEGIN SELECT RAISE(ABORT, 'the organization must retain an active administrator'); END`,
  `CREATE TABLE notification_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    daily_reminder_enabled INTEGER NOT NULL DEFAULT 0 CHECK (daily_reminder_enabled IN (0,1)),
    reminder_time TEXT CHECK (
      reminder_time IS NULL OR reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'
        AND CAST(substr(reminder_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    ),
    reminder_days TEXT NOT NULL DEFAULT '[]' CHECK (${reminderDaysValid}),
    email_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_enabled IN (0,1)),
    desktop_enabled INTEGER NOT NULL DEFAULT 0 CHECK (desktop_enabled IN (0,1)),
    slack_enabled INTEGER NOT NULL DEFAULT 0 CHECK (slack_enabled IN (0,1)),
    include_in_team_reminders INTEGER NOT NULL DEFAULT 1 CHECK (include_in_team_reminders IN (0,1)),
    weekly_digest INTEGER NOT NULL DEFAULT 1 CHECK (weekly_digest IN (0,1)),
    notify_project_deleted INTEGER NOT NULL DEFAULT 1 CHECK (notify_project_deleted IN (0,1)),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (daily_reminder_enabled = 0 OR (
      reminder_time IS NOT NULL
      AND json_array_length(reminder_days) > 0
      AND (email_enabled = 1 OR desktop_enabled = 1 OR slack_enabled = 1)
    ))
  ) STRICT`,
  `CREATE TRIGGER notification_preferences_days_insert
    BEFORE INSERT ON notification_preferences
    WHEN ${reminderDaysInvalid}
    BEGIN SELECT RAISE(ABORT, 'reminder days must contain distinct weekdays'); END`,
  `CREATE TRIGGER notification_preferences_days_update
    BEFORE UPDATE OF reminder_days ON notification_preferences
    WHEN ${reminderDaysInvalid}
    BEGIN SELECT RAISE(ABORT, 'reminder days must contain distinct weekdays'); END`,
  `INSERT INTO notification_preferences (user_id, created_at, updated_at)
    SELECT id, created_at, updated_at FROM users ORDER BY id`,
  `CREATE TRIGGER users_create_notification_preferences
    AFTER INSERT ON users BEGIN
      INSERT INTO notification_preferences (user_id, created_at, updated_at)
      VALUES (NEW.id, NEW.created_at, NEW.updated_at);
    END`,
  `CREATE TABLE team_command_ledger (
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'person.update','person.assignments.replace','person.notifications.update',
      'person.billable_rate.append','person.cost_rate.append'
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
  `CREATE INDEX team_command_ledger_target
    ON team_command_ledger(target_user_id, occurred_at, command_kind, command_id)`,
  `CREATE TRIGGER team_command_ledger_reject_update
    BEFORE UPDATE ON team_command_ledger
    BEGIN SELECT RAISE(ABORT, 'team command receipts are immutable'); END`,
  `CREATE TRIGGER team_command_ledger_reject_delete
    BEFORE DELETE ON team_command_ledger
    BEGIN SELECT RAISE(ABORT, 'team command receipts are append-only'); END`,
] as const
