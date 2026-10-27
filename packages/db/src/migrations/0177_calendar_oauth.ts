export const calendarOAuthMigration = [
  `CREATE TABLE calendar_oauth_attempts(
    state_hash TEXT PRIMARY KEY CHECK(length(state_hash)=64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
    requester_hash TEXT NOT NULL CHECK(length(requester_hash)=64 AND requester_hash NOT GLOB '*[^0-9a-f]*'),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN('google','microsoft')),
    instance_nonce TEXT NOT NULL, expected_generation INTEGER NOT NULL CHECK(expected_generation>=0),
    expires_at TEXT NOT NULL, consumed_at TEXT,
    UNIQUE(user_id,session_id,provider)
  ) STRICT`,
  `CREATE INDEX calendar_oauth_attempts_expiry ON calendar_oauth_attempts(expires_at)`,
  `ALTER TABLE calendar_cleanup_obligations ADD COLUMN lease_holder TEXT`,
  `ALTER TABLE calendar_cleanup_obligations ADD COLUMN lease_expires_at TEXT`,
  `ALTER TABLE calendar_cleanup_obligations ADD COLUMN next_attempt_at TEXT`,
  `ALTER TABLE calendar_cleanup_obligations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE calendar_manual_cleanup_receipts(
    obligation_id TEXT PRIMARY KEY REFERENCES calendar_cleanup_obligations(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, provider TEXT NOT NULL CHECK(provider='microsoft'),
    instance_nonce TEXT NOT NULL, generation INTEGER NOT NULL, credential_revision INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN('disconnect','reauth')), attested_at TEXT NOT NULL,
    assertion TEXT NOT NULL CHECK(assertion='owner_confirmed_provider_permission_removal')
  ) STRICT`,
  `CREATE TRIGGER calendar_manual_cleanup_receipt_immutable BEFORE UPDATE ON calendar_manual_cleanup_receipts
    BEGIN SELECT RAISE(ABORT,'calendar manual cleanup receipt is immutable'); END`,
] as const
