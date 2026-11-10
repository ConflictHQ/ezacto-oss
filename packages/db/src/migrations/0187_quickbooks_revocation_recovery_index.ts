/** Bounded, oldest-first recovery of pending and uncertain revocations. */
export const quickBooksRevocationRecoveryIndexMigration = [
  `CREATE INDEX quickbooks_revocations_recovery ON quickbooks_revocations(status, fenced_at, revocation_id)`,
] as const
