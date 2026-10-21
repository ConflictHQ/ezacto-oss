// An executor owns an item for fifteen minutes. A process that dies leaves a
// recoverable lease; a stale process can never settle a newer owner's attempt.
export const scheduledRunLeasesMigration = [
  `ALTER TABLE run_items ADD COLUMN lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128)`,
  `ALTER TABLE run_items ADD COLUMN lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL)`,
  `CREATE INDEX run_items_recoverable ON run_items(state,lease_expires_at,attempt_count) WHERE state<>'done'`,
] as const
