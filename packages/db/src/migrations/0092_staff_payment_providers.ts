/** Provider preferences are independent of monthly obligations and receipts. */
export const staffPaymentProvidersMigration = [
  `CREATE TABLE staff_payment_provider_events (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    scope TEXT NOT NULL CHECK (scope = CASE WHEN user_id IS NULL THEN 'organization' ELSE 'user:' || user_id END),
    version INTEGER NOT NULL CHECK (version > 0),
    provider TEXT CHECK (provider IN ('wise','deel')),
    command_json TEXT NOT NULL CHECK (json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recorded_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    CHECK (user_id IS NOT NULL OR provider IS NOT NULL),
    UNIQUE(scope, version)
  ) STRICT`,
  `CREATE TRIGGER staff_payment_provider_events_no_update BEFORE UPDATE ON staff_payment_provider_events
    BEGIN SELECT RAISE(ABORT, 'staff payment provider history is immutable'); END`,
  `CREATE TRIGGER staff_payment_provider_events_no_delete BEFORE DELETE ON staff_payment_provider_events
    BEGIN SELECT RAISE(ABORT, 'staff payment provider history is immutable'); END`,
] as const
