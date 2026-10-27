export const calendarOperatorCleanupMigration = [
  `CREATE TABLE calendar_operator_cleanup_receipts (
    obligation_id TEXT PRIMARY KEY REFERENCES calendar_cleanup_obligations(id) ON DELETE RESTRICT,
    subject_user_id INTEGER NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
    instance_nonce TEXT NOT NULL,generation INTEGER NOT NULL,credential_revision INTEGER NOT NULL,key_id TEXT NOT NULL,
    request_id TEXT,reason TEXT NOT NULL,previous_status TEXT NOT NULL,
    review_instance TEXT NOT NULL,administrator_user_id INTEGER NOT NULL,administrator_session_id INTEGER NOT NULL,
    evidence_reference TEXT NOT NULL CHECK(length(evidence_reference) BETWEEN 20 AND 1000),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),attested_at TEXT NOT NULL,
    assertion TEXT NOT NULL CHECK(assertion='operator_confirmed_provider_permission_removal')
  ) STRICT`,
  `CREATE TRIGGER calendar_operator_receipt_no_update BEFORE UPDATE ON calendar_operator_cleanup_receipts
   BEGIN SELECT RAISE(ABORT,'calendar operator receipt is immutable'); END`,
  `CREATE TRIGGER calendar_operator_receipt_no_delete BEFORE DELETE ON calendar_operator_cleanup_receipts
   BEGIN SELECT RAISE(ABORT,'calendar operator receipt is immutable'); END`,
] as const
