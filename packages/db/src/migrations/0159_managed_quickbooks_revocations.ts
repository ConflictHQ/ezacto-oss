import { canonicalTimestamp } from './0029_outbox_delivery.js'
const digest = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`
// A managed connection cannot be dropped, replaced or disconnected without a
// revocation intent that retains the one credential needed to revoke it.
const managedLive = `EXISTS(SELECT 1 FROM quickbooks_managed_grants g WHERE g.realm_id=OLD.realm_id
    AND g.recorded_at=OLD.connected_at
    AND g.accepted_generation=(SELECT generation FROM quickbooks_connection_generation WHERE singleton=1))`
const intentExists = `EXISTS(SELECT 1 FROM quickbooks_revocations r WHERE r.realm_id=OLD.realm_id
    AND r.expected_generation=(SELECT generation FROM quickbooks_connection_generation WHERE singleton=1))`
export const managedQuickBooksRevocationsMigration = [
  `CREATE TABLE quickbooks_revocations (
    revocation_id TEXT PRIMARY KEY CHECK(${digest('revocation_id')}),
    grant_id TEXT NOT NULL CHECK(${digest('grant_id')}),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('native-session','guarded-session')),
    session_id INTEGER,
    environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
    reason TEXT NOT NULL CHECK(reason IN ('disconnect','suspension','erasure')),
    realm_id TEXT NOT NULL CHECK(length(trim(realm_id)) BETWEEN 1 AND 64),
    expected_generation INTEGER NOT NULL CHECK(expected_generation BETWEEN 0 AND 9007199254740990),
    fenced_generation INTEGER NOT NULL CHECK(fenced_generation=expected_generation+1),
    -- Revocation custody: the credential is kept only while revocation is owed.
    refresh_token TEXT CHECK(refresh_token IS NULL OR length(refresh_token) BETWEEN 1 AND 4096),
    status TEXT NOT NULL CHECK(status IN ('pending','attempting','revoked')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
    fenced_at TEXT NOT NULL CHECK(${canonicalTimestamp('fenced_at')}),
    settled_at TEXT CHECK(settled_at IS NULL OR (${canonicalTimestamp('settled_at')})),
    CHECK((status='revoked' AND refresh_token IS NULL AND settled_at IS NOT NULL)
      OR (status<>'revoked' AND refresh_token IS NOT NULL AND settled_at IS NULL)),
    CHECK((authority_kind='native-session' AND session_id IS NOT NULL AND session_id>0)
      OR (authority_kind='guarded-session' AND session_id IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX quickbooks_revocations_generation ON quickbooks_revocations(expected_generation)`,
  `CREATE TRIGGER quickbooks_revocation_guard BEFORE INSERT ON quickbooks_revocations BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'migration_in_progress') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND is_active=1 AND profile='administrator')
      OR (NEW.authority_kind='native-session' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND user_id=NEW.actor_id
        AND revoked_at IS NULL AND julianday(idle_expires_at)>julianday(NEW.fenced_at) AND julianday(absolute_expires_at)>julianday(NEW.fenced_at) AND profile_snapshot='administrator'))
      THEN RAISE(ABORT,'managed_quickbooks_authority_changed') END;
    SELECT CASE WHEN (SELECT generation FROM quickbooks_connection_generation WHERE singleton=1) IS NOT NEW.expected_generation
      OR NOT EXISTS(SELECT 1 FROM quickbooks_connections c JOIN quickbooks_managed_grants g ON g.grant_id=NEW.grant_id
        WHERE c.id=1 AND c.disconnected_at IS NULL AND c.realm_id=NEW.realm_id AND g.realm_id=c.realm_id
          AND g.recorded_at=c.connected_at AND g.accepted_generation=NEW.expected_generation)
      THEN RAISE(ABORT,'managed_quickbooks_connection_changed') END;
  END`,
  `CREATE TRIGGER quickbooks_revocation_update BEFORE UPDATE ON quickbooks_revocations
    WHEN NEW.revocation_id IS NOT OLD.revocation_id OR NEW.grant_id IS NOT OLD.grant_id OR NEW.actor_id IS NOT OLD.actor_id
      OR NEW.authority_kind IS NOT OLD.authority_kind OR NEW.session_id IS NOT OLD.session_id OR NEW.environment IS NOT OLD.environment
      OR NEW.reason IS NOT OLD.reason OR NEW.realm_id IS NOT OLD.realm_id OR NEW.expected_generation IS NOT OLD.expected_generation
      OR NEW.fenced_generation IS NOT OLD.fenced_generation OR NEW.fenced_at IS NOT OLD.fenced_at
      OR NOT ((OLD.status='pending' AND NEW.status='attempting' AND NEW.attempts=OLD.attempts+1 AND NEW.refresh_token IS OLD.refresh_token)
        OR (OLD.status='attempting' AND NEW.status='revoked' AND NEW.attempts=OLD.attempts)
        OR (OLD.status='attempting' AND NEW.status='pending' AND NEW.attempts=OLD.attempts AND NEW.refresh_token IS OLD.refresh_token))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_revocation_immutable'); END`,
  `CREATE TRIGGER quickbooks_revocation_retain BEFORE DELETE ON quickbooks_revocations
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_revocation_retained'); END`,
  `CREATE TRIGGER quickbooks_connection_custody BEFORE UPDATE ON quickbooks_connections
    WHEN OLD.disconnected_at IS NULL
      AND (NEW.disconnected_at IS NOT NULL OR NEW.realm_id IS NOT OLD.realm_id OR NEW.connected_at IS NOT OLD.connected_at)
      AND ${managedLive} AND NOT ${intentExists}
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_fence_required'); END`,
] as const
