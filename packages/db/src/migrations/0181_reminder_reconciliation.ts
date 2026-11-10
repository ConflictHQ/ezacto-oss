/** Durable bounded sweep progress. This table never grants permission to resend. */
export const reminderReconciliationMigration = [
  `CREATE TABLE reminder_reconciliation_cursor (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    after_id INTEGER NOT NULL DEFAULT 0 CHECK(after_id BETWEEN 0 AND 9007199254740991),
    next_due INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
  ) STRICT`,
  `INSERT INTO reminder_reconciliation_cursor(id) VALUES(1)`,
  `CREATE INDEX email_log_held_mailgun_id ON email_log(id)
    WHERE status = 'queued' AND provider = 'mailgun' AND active_attempt_id IS NOT NULL`,
] as const
