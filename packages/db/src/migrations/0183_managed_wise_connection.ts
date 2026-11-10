import { canonicalTimestamp } from './0029_outbox_delivery.js'
const digest = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`
// Tenant-owned read-only Wise custody. No provider or payment effects.
export const managedWiseConnectionMigration = [
  `CREATE TABLE wise_managed_connection (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('disconnected','configured','connected','unavailable')),
    profile_id TEXT CHECK(profile_id IS NULL OR length(trim(profile_id)) BETWEEN 1 AND 64),
    sealed_credential TEXT CHECK(sealed_credential IS NULL OR length(sealed_credential) BETWEEN 1 AND 8192),
    connected_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    health_at TEXT CHECK(health_at IS NULL OR ${canonicalTimestamp('health_at')}),
    updated_at TEXT CHECK(updated_at IS NULL OR ${canonicalTimestamp('updated_at')}),
    CHECK((status='disconnected' AND sealed_credential IS NULL AND profile_id IS NULL)
      OR (status<>'disconnected' AND sealed_credential IS NOT NULL AND profile_id IS NOT NULL))
  ) STRICT`,
  `INSERT INTO wise_managed_connection(singleton,generation,status)
    VALUES(1,0,'disconnected')`,
  `CREATE TRIGGER wise_managed_connection_generation BEFORE UPDATE ON wise_managed_connection
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.generation NOT IN (OLD.generation,OLD.generation+1)
    BEGIN SELECT RAISE(ABORT,'wise_generation_immutable'); END`,
  `CREATE TRIGGER wise_managed_connection_retain BEFORE DELETE ON wise_managed_connection
    BEGIN SELECT RAISE(ABORT,'wise_connection_retained'); END`,
  `CREATE TABLE wise_managed_commands (
    command_id TEXT PRIMARY KEY CHECK(${digest('command_id')}),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('native-session','guarded-session')),
    session_id INTEGER,
    action TEXT NOT NULL CHECK(action IN ('connect','disconnect')),
    profile_id TEXT,
    fingerprint TEXT NOT NULL CHECK(${digest('fingerprint')}),
    expected_generation INTEGER NOT NULL CHECK(expected_generation BETWEEN 0 AND 9007199254740990),
    accepted_generation INTEGER NOT NULL CHECK(accepted_generation=expected_generation+1),
    recorded_at TEXT NOT NULL CHECK(${canonicalTimestamp('recorded_at')}),
    CHECK((authority_kind='native-session' AND session_id IS NOT NULL AND session_id>0)
      OR (authority_kind='guarded-session' AND session_id IS NULL)),
    CHECK((action='connect' AND profile_id IS NOT NULL) OR (action='disconnect' AND profile_id IS NULL))
  ) STRICT`,
  `CREATE TRIGGER wise_managed_command_guard BEFORE INSERT ON wise_managed_commands BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'migration_in_progress') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND is_active=1 AND profile='administrator')
      OR (NEW.authority_kind='native-session' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND user_id=NEW.actor_id
        AND revoked_at IS NULL AND julianday(idle_expires_at)>julianday(NEW.recorded_at) AND julianday(absolute_expires_at)>julianday(NEW.recorded_at) AND profile_snapshot='administrator'
        AND julianday(created_at)<=julianday(NEW.recorded_at)
        AND julianday(created_at)>=julianday(NEW.recorded_at)-15.0/1440.0))
      THEN RAISE(ABORT,'managed_wise_authority_changed') END;
    SELECT CASE WHEN (SELECT generation FROM wise_managed_connection WHERE singleton=1)<>NEW.expected_generation
      THEN RAISE(ABORT,'managed_wise_connection_changed') END;
  END`,
  `CREATE TRIGGER wise_managed_command_immutable BEFORE UPDATE ON wise_managed_commands
    BEGIN SELECT RAISE(ABORT,'managed_wise_receipt_immutable'); END`,
] as const
