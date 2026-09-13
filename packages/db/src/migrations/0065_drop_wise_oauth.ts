// The Wise OAuth tables, removed (issue 543).
//
// 0063 built `wise_grants` and `wise_oauth_states` for a flow where each
// contractor authorised their own Wise account. That is not the product: an app
// token authenticates as the business that actually sends the money, and what a
// contractor supplies is a destination rather than a grant. Nothing ever wrote
// to either table.
//
// Dropped rather than left standing. An empty table with triggers on it reads
// as a feature somebody has not finished, and the next person to find
// `wise_grants` would reasonably conclude that payouts still hang off a
// per-person credential.
//
// Undone by a migration rather than by editing 0063, because the ledger is a
// record of what every database has already been through. A deployment that
// applied 0063 has those tables; editing the file would leave them there with
// nothing to say where they came from.

export const dropWiseOauthMigration = [
  `DROP TRIGGER IF EXISTS wise_grants_revoked_tokens_frozen`,
  `DROP TRIGGER IF EXISTS wise_grants_revoke_final`,
  `DROP TRIGGER IF EXISTS wise_grants_identity_immutable`,
  `DROP INDEX IF EXISTS wise_oauth_states_expiry`,
  `DROP TABLE IF EXISTS wise_oauth_states`,
  `DROP INDEX IF EXISTS wise_grants_profile_current`,
  `DROP INDEX IF EXISTS wise_grants_current`,
  `DROP TABLE IF EXISTS wise_grants`,
] as const
