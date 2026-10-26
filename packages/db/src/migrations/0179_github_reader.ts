import { githubAppSetupSchema } from '../github-app-setup.js'
import { githubReadSchema } from '../github-read-schema.js'
/** Native GitHub metadata reader and audited administrator bindings. */
export const githubReaderMigration = [
  ...githubReadSchema,
  ...githubAppSetupSchema,
  `ALTER TABLE github_read_connections ADD COLUMN work_item_connection_id INTEGER REFERENCES work_item_connections(id)`,
  `ALTER TABLE github_read_connections ADD COLUMN owner_user_id INTEGER REFERENCES users(id)`,
  `ALTER TABLE github_read_connections ADD COLUMN verified_at TEXT`,
  `ALTER TABLE github_read_resources ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5)`,
  `ALTER TABLE github_read_resources ADD COLUMN next_due INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE github_read_resources ADD COLUMN lease_token TEXT`,
  `ALTER TABLE github_read_resources ADD COLUMN lease_expires_at INTEGER`,
  `ALTER TABLE github_read_resources ADD COLUMN failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('rate_limited','server_error','gave_up','invalid_credentials','lost_scope','item_unavailable','invalid_response','transport_unavailable'))`,
  `CREATE INDEX github_read_resources_due ON github_read_resources(next_due,lease_expires_at)`,
  `CREATE TABLE github_reader_admin_receipts (
    command_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
    actor_user_id INTEGER NOT NULL REFERENCES users(id), operation TEXT NOT NULL CHECK(operation IN ('map','disconnect')),
    connection_id TEXT NOT NULL REFERENCES github_read_connections(id), accepted_generation INTEGER NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE github_reader_admin_guards (
    token TEXT PRIMARY KEY, command_id TEXT NOT NULL, body_hash TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, occurred_at TEXT NOT NULL,
    connection_id TEXT NOT NULL, expected_generation INTEGER NOT NULL
  ) STRICT`,
  `CREATE TRIGGER github_reader_admin_authority BEFORE INSERT ON github_reader_admin_guards BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE u.id=NEW.actor_user_id AND u.is_active=1 AND u.profile='administrator'
        AND s.id=NEW.session_id AND s.profile_snapshot='administrator' AND s.revoked_at IS NULL
        AND julianday(s.idle_expires_at)>julianday(NEW.occurred_at)
        AND julianday(s.absolute_expires_at)>julianday(NEW.occurred_at)
        AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id))
      THEN RAISE(ABORT,'github_reader_forbidden') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'migration_in_progress') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM github_reader_admin_receipts WHERE command_id=NEW.command_id
      AND (body_hash<>NEW.body_hash OR actor_user_id<>NEW.actor_user_id))
      THEN RAISE(ABORT,'github_reader_command_reused') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM github_reader_admin_receipts WHERE command_id=NEW.command_id)
      AND COALESCE((SELECT generation FROM github_read_connections WHERE id=NEW.connection_id),0)<>NEW.expected_generation
      THEN RAISE(ABORT,'github_reader_conflict') END;
  END`,
  `CREATE TRIGGER github_reader_receipt_immutable BEFORE UPDATE ON github_reader_admin_receipts
    BEGIN SELECT RAISE(ABORT,'github_reader_receipt_immutable'); END`,
  `CREATE TRIGGER github_reader_receipt_retained BEFORE DELETE ON github_reader_admin_receipts
    BEGIN SELECT RAISE(ABORT,'github_reader_receipt_retained'); END`,
  // Reuse the existing connection/link foundation. A legacy disconnect fences
  // every installation in the same transaction; metadata and local links remain.
  `CREATE TRIGGER github_reader_base_connect AFTER INSERT ON github_read_connections
   WHEN NEW.owner_user_id IS NOT NULL BEGIN
    INSERT INTO work_item_connections(provider,status,owner_user_id,credential_ref,connected_at,created_at,updated_at)
      VALUES('github','active',NEW.owner_user_id,'GITHUB_APP_PRIVATE_KEY',NEW.verified_at,NEW.verified_at,NEW.verified_at)
      ON CONFLICT(provider) DO UPDATE SET status='active',owner_user_id=excluded.owner_user_id,credential_ref=excluded.credential_ref,connected_at=excluded.connected_at,disconnected_at=NULL,updated_at=excluded.updated_at;
    UPDATE github_read_connections SET work_item_connection_id=(SELECT id FROM work_item_connections WHERE provider='github') WHERE id=NEW.id;
   END`,
  `CREATE TRIGGER github_reader_base_reconnect AFTER UPDATE OF state,generation ON github_read_connections
   WHEN NEW.state='active' AND NEW.owner_user_id IS NOT NULL BEGIN
    UPDATE work_item_connections SET status='active',credential_ref='GITHUB_APP_PRIVATE_KEY',disconnected_at=NULL,updated_at=NEW.verified_at WHERE id=NEW.work_item_connection_id;
   END`,
  `CREATE TRIGGER github_reader_base_disconnect AFTER UPDATE OF status ON work_item_connections
   WHEN NEW.provider='github' AND NEW.status='disconnected' AND OLD.status<>'disconnected' BEGIN
    UPDATE github_read_connections SET state='disconnected',generation=generation+1 WHERE work_item_connection_id=NEW.id AND state='active';
   END`,
  `CREATE TRIGGER github_reader_base_revoked AFTER UPDATE OF state ON github_read_connections
   WHEN NEW.state<>'active' AND OLD.state='active' BEGIN
    UPDATE work_item_connections SET status='disconnected',credential_ref=NULL,disconnected_at=COALESCE(NEW.verified_at,updated_at)
     WHERE id=NEW.work_item_connection_id AND NOT EXISTS(SELECT 1 FROM github_read_connections c WHERE c.work_item_connection_id=NEW.work_item_connection_id AND c.state='active');
   END`,
] as const
