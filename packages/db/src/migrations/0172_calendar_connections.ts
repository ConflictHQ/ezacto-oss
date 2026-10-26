import { canonicalTimestamp } from './0029_outbox_delivery.js'

export const calendarConnectionsMigration = [
  `CREATE TABLE calendar_sync_instance(singleton INTEGER PRIMARY KEY CHECK(singleton=1),nonce TEXT NOT NULL CHECK(length(nonce)=64)) STRICT`,
  `INSERT INTO calendar_sync_instance VALUES(1,lower(hex(randomblob(32))))`,
  `CREATE TABLE calendar_connections(
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN('google','microsoft')),
    instance_nonce TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
    credential_revision INTEGER NOT NULL CHECK(credential_revision BETWEEN 1 AND 9007199254740990),
    status TEXT NOT NULL CHECK(status IN('connected','needs_reauth','disconnected')),
    key_id TEXT,
    sealed_grant TEXT CHECK(sealed_grant IS NULL OR length(sealed_grant) BETWEEN 1 AND 65536),
    sealed_cursor TEXT CHECK(sealed_cursor IS NULL OR length(sealed_cursor) BETWEEN 1 AND 32768),
    window_from TEXT,window_to TEXT,
    last_synced_at TEXT,
    last_error TEXT CHECK(last_error IS NULL OR last_error IN('credential_unavailable','authorization','unavailable','invalid_source','limit','changed')),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
    lease_holder TEXT,lease_expires_at TEXT,
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')}),
    PRIMARY KEY(user_id,provider),
    CHECK((status='connected' AND sealed_grant IS NOT NULL AND key_id IS NOT NULL) OR (status<>'connected' AND sealed_grant IS NULL AND key_id IS NULL)),
    CHECK((lease_holder IS NULL)=(lease_expires_at IS NULL)),
    CHECK((window_from IS NULL)=(window_to IS NULL)),
    CHECK(status<>'disconnected' OR sealed_cursor IS NULL)
  ) STRICT`,
  `CREATE TRIGGER calendar_connection_generation BEFORE UPDATE ON calendar_connections
    WHEN NEW.user_id IS NOT OLD.user_id OR NEW.provider IS NOT OLD.provider
      OR NEW.generation NOT IN(OLD.generation,OLD.generation+1)
      OR (NEW.generation=OLD.generation AND NEW.credential_revision NOT IN(OLD.credential_revision,OLD.credential_revision+1))
      OR (NEW.generation<>OLD.generation AND NEW.credential_revision<>1)
      OR ((NEW.sealed_grant IS NOT OLD.sealed_grant OR NEW.key_id IS NOT OLD.key_id OR NEW.instance_nonce IS NOT OLD.instance_nonce)
        AND NEW.generation=OLD.generation AND NEW.credential_revision=OLD.credential_revision)
      OR NEW.lease_generation NOT IN(OLD.lease_generation,OLD.lease_generation+1)
    BEGIN SELECT RAISE(ABORT,'calendar connection generation changed'); END`,
  `CREATE TABLE calendar_cleanup_obligations(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN('google','microsoft')),
    instance_nonce TEXT NOT NULL,generation INTEGER NOT NULL,credential_revision INTEGER NOT NULL,
    key_id TEXT NOT NULL,sealed_grant TEXT,
    request_id TEXT,
    reason TEXT NOT NULL CHECK(reason IN('disconnect','closure','reauth','restore','reset')),
    status TEXT NOT NULL CHECK(status IN('pending','manual_required','revoked')),
    created_at TEXT NOT NULL,completed_at TEXT,
    sealed_receipt TEXT CHECK(sealed_receipt IS NULL OR json_valid(sealed_receipt)),
    UNIQUE(user_id,provider,instance_nonce,generation,credential_revision),
    CHECK((status='revoked')=(sealed_grant IS NULL)),
    CHECK((status='revoked')=(sealed_receipt IS NOT NULL)),
    CHECK((status='revoked')=(completed_at IS NOT NULL))
  ) STRICT`,
  `CREATE TRIGGER calendar_cleanup_identity BEFORE UPDATE ON calendar_cleanup_obligations
    WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.provider IS NOT OLD.provider
      OR NEW.instance_nonce IS NOT OLD.instance_nonce OR NEW.generation IS NOT OLD.generation
      OR NEW.credential_revision IS NOT OLD.credential_revision OR NEW.key_id IS NOT OLD.key_id
      OR NEW.request_id IS NOT OLD.request_id OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
      OR (NEW.sealed_grant IS NOT OLD.sealed_grant AND NEW.status<>'revoked')
    BEGIN SELECT RAISE(ABORT,'calendar cleanup identity changed'); END`,
  `CREATE TRIGGER calendar_connection_cleanup_before_delete BEFORE DELETE ON calendar_connections
    WHEN OLD.sealed_grant IS NOT NULL BEGIN
      INSERT OR IGNORE INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,request_id,reason,status,created_at)
      SELECT lower(hex(randomblob(32))),OLD.user_id,OLD.provider,OLD.instance_nonce,OLD.generation,OLD.credential_revision,OLD.key_id,OLD.sealed_grant,
        (SELECT request_id FROM account_closures WHERE user_id=OLD.user_id),'closure','pending',coalesce((SELECT closed_at FROM account_closures WHERE user_id=OLD.user_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END`,
  `CREATE TABLE calendar_sync_guard(allowed INTEGER NOT NULL CHECK(allowed=1)) STRICT`,
  `CREATE TRIGGER account_closures_erase_calendar_connections AFTER INSERT ON account_closures
    BEGIN DELETE FROM calendar_connections WHERE user_id=NEW.user_id; END`,
  `ALTER TABLE calendar_proposals ADD COLUMN observed_source_version TEXT`,
  `ALTER TABLE calendar_proposals ADD COLUMN source_changed_at TEXT`,
  `ALTER TABLE calendar_proposals ADD COLUMN source_cancelled_at TEXT`,
  `DROP INDEX calendar_proposals_event_identity`,
  `CREATE UNIQUE INDEX calendar_proposals_event_identity ON calendar_proposals(user_id,provider,calendar_id,event_id,occurrence)`,
  `CREATE TRIGGER calendar_proposals_calendar_immutable BEFORE UPDATE OF calendar_id ON calendar_proposals
    WHEN OLD.calendar_id IS NOT NEW.calendar_id BEGIN SELECT RAISE(ABORT,'a calendar proposal keeps its calendar'); END`,
] as const
