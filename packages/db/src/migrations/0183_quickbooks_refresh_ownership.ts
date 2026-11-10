/** Additive durable ownership of a rotating managed grant. Unknown outcomes
 * remain held; a wall-clock lease cannot make a one-time exchange replayable.
 */
export const quickBooksRefreshOwnershipMigration = [
  `CREATE TABLE quickbooks_refresh_attempts (
    attempt_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK(generation>=0),
    realm_id TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    credential_hash TEXT NOT NULL CHECK(length(credential_hash)=64),
    result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64),
    status TEXT NOT NULL CHECK(status IN ('attempting','unknown','completed','orphaned','cancelled')),
    expected_refresh_token TEXT,
    candidate_access_token TEXT,
    candidate_refresh_token TEXT,
    retained_refresh_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((status='orphaned' AND retained_refresh_token IS NOT NULL) OR
      (status<>'orphaned' AND retained_refresh_token IS NULL)),
    CHECK((status IN ('completed','cancelled') AND expected_refresh_token IS NULL) OR
      (status NOT IN ('completed','cancelled') AND expected_refresh_token IS NOT NULL)),
    CHECK((status='attempting' AND ((result_hash IS NULL AND candidate_access_token IS NULL AND candidate_refresh_token IS NULL)
      OR (result_hash IS NOT NULL AND candidate_access_token IS NOT NULL AND candidate_refresh_token IS NOT NULL)))
      OR (status IN ('unknown','cancelled') AND result_hash IS NULL AND candidate_access_token IS NULL AND candidate_refresh_token IS NULL)
      OR (status IN ('completed','orphaned') AND result_hash IS NOT NULL AND candidate_access_token IS NULL AND candidate_refresh_token IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX quickbooks_refresh_one_owner ON quickbooks_refresh_attempts(generation,credential_hash) WHERE status<>'cancelled'`,
  `CREATE TRIGGER quickbooks_refresh_intent_immutable BEFORE UPDATE ON quickbooks_refresh_attempts
    WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.generation IS NOT OLD.generation
      OR NEW.realm_id IS NOT OLD.realm_id OR NEW.connected_at IS NOT OLD.connected_at
      OR NEW.actor_id IS NOT OLD.actor_id OR NEW.credential_hash IS NOT OLD.credential_hash
      OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'attempting'
      OR NOT (NEW.status IN ('unknown','completed','orphaned','cancelled') OR
        (NEW.status='attempting' AND OLD.result_hash IS NULL AND NEW.result_hash IS NOT NULL))
      OR (OLD.result_hash IS NOT NULL AND NEW.result_hash IS NOT OLD.result_hash)
      OR (NEW.status NOT IN ('completed','cancelled') AND NEW.expected_refresh_token IS NOT OLD.expected_refresh_token)
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_immutable'); END`,
  `CREATE TRIGGER quickbooks_refresh_retained BEFORE DELETE ON quickbooks_refresh_attempts
    WHEN OLD.status NOT IN ('completed','cancelled')
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_unresolved'); END`,
  `CREATE TRIGGER quickbooks_refresh_blocks_grant BEFORE INSERT ON quickbooks_managed_grants
    WHEN EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_unresolved'); END`,
  `CREATE TRIGGER quickbooks_refresh_blocks_connection_insert BEFORE INSERT ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_unresolved'); END`,
  `CREATE TRIGGER quickbooks_refresh_blocks_connection_replace BEFORE UPDATE ON quickbooks_connections
    WHEN NEW.disconnected_at IS NULL AND (NEW.realm_id IS NOT OLD.realm_id OR NEW.connected_at IS NOT OLD.connected_at)
      AND EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status NOT IN ('completed','cancelled'))
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_unresolved'); END`,
  `CREATE TRIGGER quickbooks_refresh_owned_token_write BEFORE UPDATE ON quickbooks_connections
    WHEN OLD.disconnected_at IS NULL AND NEW.disconnected_at IS NULL
      AND NEW.realm_id IS OLD.realm_id AND NEW.connected_at IS OLD.connected_at
      AND (NEW.access_token IS NOT OLD.access_token OR NEW.refresh_token IS NOT OLD.refresh_token)
      AND EXISTS(SELECT 1 FROM quickbooks_managed_grants grant_receipt
        WHERE grant_receipt.realm_id=OLD.realm_id AND grant_receipt.recorded_at=OLD.connected_at
          AND grant_receipt.accepted_generation=(SELECT generation FROM quickbooks_connection_generation WHERE singleton=1))
      AND NOT EXISTS(SELECT 1 FROM quickbooks_refresh_attempts receipt
        WHERE receipt.status='attempting' AND receipt.generation=(SELECT generation FROM quickbooks_connection_generation WHERE singleton=1)
          AND receipt.realm_id=OLD.realm_id AND receipt.connected_at=OLD.connected_at
          AND receipt.expected_refresh_token=OLD.refresh_token AND receipt.result_hash IS NOT NULL
          AND receipt.candidate_access_token=NEW.access_token AND receipt.candidate_refresh_token=NEW.refresh_token)
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_refresh_owner_required'); END`,
] as const
