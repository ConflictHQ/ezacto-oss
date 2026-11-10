/** A new authorization must not race the prior grant's provider revocation.
 * Local disconnection is not provider completion. This is additive to0159;
 * existing custody, financial data and recorded generations are preserved.
 */
const unresolved = "EXISTS(SELECT 1 FROM quickbooks_revocations WHERE status<>'revoked')"
export const quickBooksReconnectFenceMigration = [
  // A prior version could already have accepted this unsafe overlap. Refuse
  // upgrade for explicit reconciliation instead of hiding/erasing credentials
  // or exposing that connection as healthy after the old revocation settles.
  `CREATE TABLE quickbooks_reconnect_upgrade_guard (ok INTEGER NOT NULL CHECK(ok=1)) STRICT`,
  `INSERT INTO quickbooks_reconnect_upgrade_guard SELECT CASE WHEN
    EXISTS(SELECT 1 FROM quickbooks_connections WHERE disconnected_at IS NULL) AND ${unresolved}
    THEN 0 ELSE 1 END`,
  `DROP TABLE quickbooks_reconnect_upgrade_guard`,
  `CREATE TRIGGER quickbooks_grant_revocations_resolved BEFORE INSERT ON quickbooks_managed_grants
    WHEN ${unresolved}
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_revocation_pending'); END`,
  `CREATE TRIGGER quickbooks_connection_insert_revocations_resolved BEFORE INSERT ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND ${unresolved}
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_revocation_pending'); END`,
  `CREATE TRIGGER quickbooks_connection_update_revocations_resolved BEFORE UPDATE ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND ${unresolved}
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_revocation_pending'); END`,
] as const
