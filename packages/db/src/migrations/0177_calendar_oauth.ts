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
] as const
