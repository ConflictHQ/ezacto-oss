import { canonicalTimestamp } from './0029_outbox_delivery.js'
const digest = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`
// Connection incarnation is distinct from rotating access/refresh credentials.
export const managedQuickBooksGrantsMigration = [
  `CREATE TABLE quickbooks_connection_generation (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  ) STRICT`,
  `INSERT INTO quickbooks_connection_generation VALUES(1,0)`,
  `CREATE TRIGGER quickbooks_generation_identity BEFORE UPDATE ON quickbooks_connection_generation
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.generation<>OLD.generation+1
    BEGIN SELECT RAISE(ABORT,'quickbooks_generation_immutable'); END`,
  `CREATE TRIGGER quickbooks_generation_retain BEFORE DELETE ON quickbooks_connection_generation
    BEGIN SELECT RAISE(ABORT,'quickbooks_generation_retained'); END`,
  ...['INSERT', 'DELETE'].map(
    (
      verb,
    ) => `CREATE TRIGGER quickbooks_connection_${verb.toLowerCase()}_generation AFTER ${verb} ON quickbooks_connections
    BEGIN UPDATE quickbooks_connection_generation SET generation=generation+1 WHERE singleton=1; END`,
  ),
  `CREATE TRIGGER quickbooks_connection_update_generation AFTER UPDATE ON quickbooks_connections
    WHEN NEW.realm_id IS NOT OLD.realm_id OR NEW.disconnected_at IS NOT OLD.disconnected_at
      OR NEW.connected_by_user_id IS NOT OLD.connected_by_user_id OR NEW.connected_at IS NOT OLD.connected_at
    BEGIN UPDATE quickbooks_connection_generation SET generation=generation+1 WHERE singleton=1; END`,
  `CREATE TABLE quickbooks_managed_grants (
    grant_id TEXT PRIMARY KEY CHECK(${digest('grant_id')}),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('native-session','guarded-session')),
    session_id INTEGER,
    browser_hash TEXT NOT NULL CHECK(${digest('browser_hash')}),
    credential_hash TEXT NOT NULL CHECK(${digest('credential_hash')}),
    command_fingerprint TEXT NOT NULL CHECK(${digest('command_fingerprint')}),
    expected_generation INTEGER NOT NULL CHECK(expected_generation BETWEEN 0 AND 9007199254740990),
    accepted_generation INTEGER NOT NULL CHECK(accepted_generation=expected_generation+1),
    realm_id TEXT NOT NULL CHECK(length(trim(realm_id)) BETWEEN 1 AND 64),
    expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 1 AND 8640000000000000),
    recorded_at TEXT NOT NULL CHECK(${canonicalTimestamp('recorded_at')}),
    CHECK((authority_kind='native-session' AND session_id IS NOT NULL AND session_id>0)
      OR (authority_kind='guarded-session' AND session_id IS NULL))
  ) STRICT`,
  `CREATE TRIGGER quickbooks_managed_grant_guard BEFORE INSERT ON quickbooks_managed_grants BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'migration_in_progress') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND is_active=1 AND profile='administrator')
      OR (NEW.authority_kind='native-session' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND user_id=NEW.actor_id
        AND revoked_at IS NULL AND julianday(idle_expires_at)>julianday(NEW.recorded_at) AND julianday(absolute_expires_at)>julianday(NEW.recorded_at) AND profile_snapshot='administrator'))
      THEN RAISE(ABORT,'managed_quickbooks_authority_changed') END;
    SELECT CASE WHEN (SELECT generation FROM quickbooks_connection_generation WHERE singleton=1) IS NOT NEW.expected_generation
      OR EXISTS(SELECT 1 FROM quickbooks_connections WHERE id=1 AND disconnected_at IS NULL)
      THEN RAISE(ABORT,'managed_quickbooks_connection_changed') END;
    SELECT CASE WHEN NEW.expires_at<=(julianday(NEW.recorded_at)-2440587.5)*86400000
      THEN RAISE(ABORT,'managed_quickbooks_grant_expired') END;
  END`,
  `CREATE TRIGGER quickbooks_managed_grant_immutable BEFORE UPDATE ON quickbooks_managed_grants
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_receipt_immutable'); END`,
  // The canonical closure statement owns transient-credential cleanup atomically.
  // Its user deactivation also prevents any later acceptance for this actor.
  `CREATE TRIGGER quickbooks_managed_grants_account_closure AFTER INSERT ON account_closures
    BEGIN DELETE FROM quickbooks_managed_grants WHERE actor_id=NEW.user_id; END`,
] as const
