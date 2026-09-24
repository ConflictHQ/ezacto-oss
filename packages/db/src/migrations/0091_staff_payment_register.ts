/** Operator-recorded payments and historical settlement; no transfer is initiated. */
export const staffPaymentRegisterMigration = [
  `CREATE TABLE staff_payment_events (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
    version INTEGER NOT NULL CHECK (version > 0),
    kind TEXT NOT NULL CHECK (kind IN ('amount','payment','void','opening','reopen','note')),
    command_json TEXT NOT NULL CHECK (json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recorded_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    UNIQUE(user_id, month, version)
  ) STRICT`,
  `CREATE INDEX staff_payment_events_month ON staff_payment_events(month, user_id, version)`,
  `CREATE TRIGGER staff_payment_events_no_update BEFORE UPDATE ON staff_payment_events
    BEGIN SELECT RAISE(ABORT, 'staff payment history is immutable'); END`,
  `CREATE TRIGGER staff_payment_events_no_delete BEFORE DELETE ON staff_payment_events
    BEGIN SELECT RAISE(ABORT, 'staff payment history is immutable'); END`,
] as const
