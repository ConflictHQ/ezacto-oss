/** Confirmed, replay-safe mutations launched from Detailed time (#717). */
export const reportTimeCommandsMigration = [
  `CREATE TABLE report_time_commands (
    command_id TEXT PRIMARY KEY CHECK (length(trim(command_id)) BETWEEN 1 AND 128),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 2 AND 4000),
    action TEXT NOT NULL CHECK (action IN ('mark_invoiced','mark_uninvoiced','move')),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    completed_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX report_time_commands_actor_completed
    ON report_time_commands(actor_user_id, completed_at DESC)`,
] as const
