/** Exact financial intent is retained before transport. Original UTF-8 bodies
 * are stored in immutable chunks, never credentials or Authorization headers.
 */
export const quickBooksWriteIntentsMigration = [
  `CREATE TABLE quickbooks_write_effects (
    id TEXT PRIMARY KEY CHECK(length(id)=36),
    request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 50),
    generation INTEGER NOT NULL CHECK(generation>=0),
    realm_id TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    resource TEXT NOT NULL CHECK(resource IN ('customer','invoice','payment')),
    native_id INTEGER NOT NULL CHECK(native_id>0),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    invoice_version INTEGER NOT NULL CHECK(invoice_version>=0),
    operation TEXT NOT NULL CHECK(operation IN ('create','update')),
    source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
    payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
    body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
    path TEXT NOT NULL CHECK(path IN ('/customer','/invoice','/payment')),
    minor_version TEXT NOT NULL,
    body_bytes INTEGER NOT NULL CHECK(body_bytes>=2),
    body_chunks INTEGER NOT NULL CHECK(body_chunks>0),
    state TEXT NOT NULL CHECK(state IN ('drafting','prepared','sending','unknown','completed','orphaned','cancelled','conflicted')),
    owner_id TEXT,
    owner_expires_at TEXT,
    owner_invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    owner_invoice_version INTEGER NOT NULL CHECK(owner_invoice_version>=0),
    result_attempt_id TEXT,
    recovery_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((owner_id IS NULL AND owner_expires_at IS NULL) OR (length(owner_id)=36 AND owner_expires_at IS NOT NULL)),
    CHECK((state IN ('completed','orphaned','conflicted') AND result_attempt_id IS NOT NULL) OR
      (state NOT IN ('completed','orphaned','conflicted') AND result_attempt_id IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX quickbooks_write_logical_intent ON quickbooks_write_effects
    (generation,resource,native_id,operation,source_hash,payload_hash,minor_version) WHERE state<>'cancelled'`,
  `CREATE UNIQUE INDEX quickbooks_write_owner ON quickbooks_write_effects(owner_id) WHERE owner_id IS NOT NULL`,
  `CREATE INDEX quickbooks_write_pending ON quickbooks_write_effects(state,owner_expires_at,created_at)`,
  `CREATE TRIGGER quickbooks_write_intent_immutable BEFORE UPDATE ON quickbooks_write_effects
    WHEN NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.generation IS NOT OLD.generation
      OR NEW.realm_id IS NOT OLD.realm_id OR NEW.connected_at IS NOT OLD.connected_at OR NEW.actor_id IS NOT OLD.actor_id
      OR NEW.resource IS NOT OLD.resource OR NEW.native_id IS NOT OLD.native_id OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.invoice_version IS NOT OLD.invoice_version
      OR NEW.operation IS NOT OLD.operation OR NEW.source_hash IS NOT OLD.source_hash OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.body_hash IS NOT OLD.body_hash
      OR NEW.path IS NOT OLD.path OR NEW.minor_version IS NOT OLD.minor_version OR NEW.body_bytes IS NOT OLD.body_bytes
      OR NEW.body_chunks IS NOT OLD.body_chunks OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_intent_immutable'); END`,
  `CREATE TRIGGER quickbooks_write_intent_retained BEFORE DELETE ON quickbooks_write_effects
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_intent_retained'); END`,
  `CREATE TABLE quickbooks_write_attempts (
    id TEXT PRIMARY KEY CHECK(length(id)=36),
    effect_id TEXT NOT NULL REFERENCES quickbooks_write_effects(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('sending','unknown','observed','cancelled_unsent')),
    response_hash TEXT,
    response_bytes INTEGER,
    response_chunks INTEGER,
    provider_id TEXT,
    sync_token TEXT,
    started_at TEXT NOT NULL,
    observed_at TEXT,
    CHECK((response_hash IS NULL AND response_bytes IS NULL AND response_chunks IS NULL AND provider_id IS NULL AND sync_token IS NULL)
      OR (length(response_hash)=64 AND response_bytes>=2 AND response_chunks>0 AND length(provider_id)>0 AND length(sync_token)>0)),
    CHECK((state='observed' AND response_hash IS NOT NULL AND observed_at IS NOT NULL)
      OR (state<>'observed' AND observed_at IS NULL))
  ) STRICT`,
  `CREATE TRIGGER quickbooks_write_attempt_identity BEFORE UPDATE ON quickbooks_write_attempts
    WHEN NEW.id IS NOT OLD.id OR NEW.effect_id IS NOT OLD.effect_id OR NEW.started_at IS NOT OLD.started_at
      OR OLD.state IN ('observed','cancelled_unsent')
      OR (OLD.response_hash IS NOT NULL AND (NEW.response_hash IS NOT OLD.response_hash OR NEW.response_bytes IS NOT OLD.response_bytes
        OR NEW.response_chunks IS NOT OLD.response_chunks OR NEW.provider_id IS NOT OLD.provider_id OR NEW.sync_token IS NOT OLD.sync_token))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_attempt_immutable'); END`,
  `CREATE TRIGGER quickbooks_write_attempt_retained BEFORE DELETE ON quickbooks_write_attempts
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_attempt_retained'); END`,
  `CREATE TABLE quickbooks_write_request_chunks (
    effect_id TEXT NOT NULL REFERENCES quickbooks_write_effects(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position>=0),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 65536),
    data TEXT NOT NULL CHECK(length(data) BETWEEN 1 AND 87384),
    PRIMARY KEY(effect_id,position)
  ) STRICT`,
  `CREATE TRIGGER quickbooks_write_request_chunk_insert BEFORE INSERT ON quickbooks_write_request_chunks
    WHEN NOT EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE id=NEW.effect_id AND state='drafting' AND NEW.position<body_chunks)
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_request_not_drafting'); END`,
  `CREATE TABLE quickbooks_write_response_chunks (
    attempt_id TEXT NOT NULL REFERENCES quickbooks_write_attempts(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position>=0),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 65536),
    data TEXT NOT NULL CHECK(length(data) BETWEEN 1 AND 87384),
    PRIMARY KEY(attempt_id,position)
  ) STRICT`,
  `CREATE TRIGGER quickbooks_write_response_chunk_insert BEFORE INSERT ON quickbooks_write_response_chunks
    WHEN NOT EXISTS(SELECT 1 FROM quickbooks_write_attempts WHERE id=NEW.attempt_id AND state IN ('sending','unknown')
      AND response_hash IS NOT NULL AND NEW.position<response_chunks)
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_response_not_captured'); END`,
  ...['quickbooks_write_request_chunks','quickbooks_write_response_chunks'].flatMap(table => [
    `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_chunk_immutable'); END`,
    `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_chunk_retained'); END`,
  ]),
  `CREATE TRIGGER quickbooks_write_blocks_grant BEFORE INSERT ON quickbooks_managed_grants
    WHEN EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE state NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_unresolved'); END`,
  `CREATE TRIGGER quickbooks_write_blocks_connection_insert BEFORE INSERT ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE state NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_unresolved'); END`,
  `CREATE TRIGGER quickbooks_write_blocks_connection_replace BEFORE UPDATE ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND (NEW.realm_id IS NOT OLD.realm_id OR NEW.connected_at IS NOT OLD.connected_at)
      AND EXISTS(SELECT 1 FROM quickbooks_write_effects WHERE state NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_write_unresolved'); END`,
] as const
