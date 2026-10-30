import { canonicalTimestamp } from './0029_outbox_delivery.js'
const digest = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`
// Issue 1252. One tenant-owned BILL company connection per tenant database. The
// credential is only ever a sealed envelope (tenant-bound AES-GCM, sealed by the
// host before it reaches SQL); nothing here can decrypt it or call BILL.
// The generation is a monotonic incarnation counter: connect, rotation,
// disconnect and erasure each advance it exactly once and nothing may reset it.
// `binding_company_id` is retained across disconnect so history keyed by BILL
// ids (bill_links) is never silently re-pointed at a different company.
export const managedBillConnectionMigration = [
  `CREATE TABLE bill_managed_connection (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('disconnected','configured','connected','unavailable')),
    company_id TEXT CHECK(company_id IS NULL OR length(trim(company_id)) BETWEEN 1 AND 64),
    binding_company_id TEXT CHECK(binding_company_id IS NULL OR length(trim(binding_company_id)) BETWEEN 1 AND 64),
    environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
    can_send_from_bill INTEGER NOT NULL CHECK(can_send_from_bill IN (0,1)),
    sealed_credential TEXT CHECK(sealed_credential IS NULL OR length(sealed_credential) BETWEEN 1 AND 4096),
    connected_by_user_id INTEGER,
    health_at TEXT CHECK(health_at IS NULL OR ${canonicalTimestamp('health_at')}),
    updated_at TEXT CHECK(updated_at IS NULL OR ${canonicalTimestamp('updated_at')}),
    CHECK((status='disconnected' AND sealed_credential IS NULL AND company_id IS NULL)
      OR (status<>'disconnected' AND sealed_credential IS NOT NULL AND company_id IS NOT NULL))
  ) STRICT`,
  `INSERT INTO bill_managed_connection(singleton,generation,status,environment,can_send_from_bill)
    VALUES(1,0,'disconnected','production',0)`,
  `CREATE TRIGGER bill_managed_connection_generation BEFORE UPDATE ON bill_managed_connection
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.generation NOT IN (OLD.generation,OLD.generation+1)
    BEGIN SELECT RAISE(ABORT,'bill_generation_immutable'); END`,
  `CREATE TRIGGER bill_managed_connection_retain BEFORE DELETE ON bill_managed_connection
    BEGIN SELECT RAISE(ABORT,'bill_connection_retained'); END`,
  `CREATE TABLE bill_managed_commands (
    command_id TEXT PRIMARY KEY CHECK(${digest('command_id')}),
    actor_id INTEGER NOT NULL,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('native-session','guarded-session')),
    session_id INTEGER,
    action TEXT NOT NULL CHECK(action IN ('connect','disconnect')),
    company_id TEXT,
    fingerprint TEXT NOT NULL CHECK(${digest('fingerprint')}),
    expected_generation INTEGER NOT NULL CHECK(expected_generation BETWEEN 0 AND 9007199254740990),
    accepted_generation INTEGER NOT NULL CHECK(accepted_generation=expected_generation+1),
    recorded_at TEXT NOT NULL CHECK(${canonicalTimestamp('recorded_at')}),
    CHECK((authority_kind='native-session' AND session_id IS NOT NULL AND session_id>0)
      OR (authority_kind='guarded-session' AND session_id IS NULL)),
    CHECK((action='connect' AND company_id IS NOT NULL) OR (action='disconnect' AND company_id IS NULL))
  ) STRICT`,
  `CREATE TRIGGER bill_managed_command_guard BEFORE INSERT ON bill_managed_commands BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'migration_in_progress') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND is_active=1 AND profile='administrator')
      OR (NEW.authority_kind='native-session' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND user_id=NEW.actor_id
        AND revoked_at IS NULL AND julianday(idle_expires_at)>julianday(NEW.recorded_at) AND julianday(absolute_expires_at)>julianday(NEW.recorded_at) AND profile_snapshot='administrator'))
      THEN RAISE(ABORT,'managed_bill_authority_changed') END;
    SELECT CASE WHEN (SELECT generation FROM bill_managed_connection WHERE singleton=1)<>NEW.expected_generation
      THEN RAISE(ABORT,'managed_bill_connection_changed') END;
    SELECT CASE WHEN NEW.action='connect' AND EXISTS(SELECT 1 FROM bill_managed_connection WHERE singleton=1
        AND binding_company_id IS NOT NULL AND binding_company_id<>NEW.company_id)
      AND EXISTS(SELECT 1 FROM bill_links)
      THEN RAISE(ABORT,'managed_bill_binding_retained') END;
  END`,
  `CREATE TRIGGER bill_managed_command_immutable BEFORE UPDATE ON bill_managed_commands
    BEGIN SELECT RAISE(ABORT,'managed_bill_receipt_immutable'); END`,
] as const
