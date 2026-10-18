/** Encrypted web custody is separate from native proof-only metadata. */
export const appleWebCustodyMigration = [
  `CREATE TABLE apple_web_connections (
    id TEXT PRIMARY KEY CHECK(length(id) = 43),
    subject_digest TEXT NOT NULL CHECK(length(subject_digest) = 64 AND subject_digest NOT GLOB '*[^0-9a-f]*'),
    browser_hash TEXT NOT NULL UNIQUE CHECK(length(browser_hash) = 64 AND browser_hash NOT GLOB '*[^0-9a-f]*'),
    user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    service_issuer TEXT NOT NULL CHECK(service_issuer = 'https://apple-auth.ezacto.com'),
    instance_origin TEXT NOT NULL,
    client_id TEXT NOT NULL CHECK(client_id = 'com.ezacto.web'),
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    sealed_capability TEXT CHECK(sealed_capability IS NULL OR json_valid(sealed_capability)),
    sealed_receipt TEXT CHECK(sealed_receipt IS NULL OR json_valid(sealed_receipt)),
    cleanup_request_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'pending', 'revoked', 'manual_required')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(instance_origin = 'https://app.example.com' OR
          (instance_origin = 'https://ezacto.io' AND user_id IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX apple_web_current_subject ON apple_web_connections(subject_digest, service_issuer, instance_origin, client_id) WHERE status != 'revoked'`,
  `CREATE INDEX apple_web_user ON apple_web_connections(user_id) WHERE user_id IS NOT NULL`,
  `CREATE TABLE apple_web_cleanup_requests (
    request_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    captured_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE apple_web_cleanup_obligations (
    request_id TEXT NOT NULL REFERENCES apple_web_cleanup_requests(request_id),
    connection_id TEXT NOT NULL REFERENCES apple_web_connections(id),
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'revoked', 'manual_required')),
    sealed_receipt TEXT CHECK(sealed_receipt IS NULL OR json_valid(sealed_receipt)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(request_id, connection_id),
    CHECK((status = 'revoked') = (sealed_receipt IS NOT NULL))
  ) STRICT`,
  `CREATE TRIGGER apple_web_cleanup_request_immutable BEFORE UPDATE ON apple_web_cleanup_requests
    BEGIN SELECT RAISE(ABORT, 'web Apple cleanup requests are immutable'); END`,
  `CREATE TRIGGER apple_web_pending_identity_guard BEFORE UPDATE ON apple_web_connections
    WHEN OLD.id IS NOT NEW.id OR OLD.subject_digest IS NOT NEW.subject_digest
      OR OLD.service_issuer IS NOT NEW.service_issuer OR OLD.instance_origin IS NOT NEW.instance_origin
      OR OLD.client_id IS NOT NEW.client_id OR OLD.created_at IS NOT NEW.created_at
      OR (OLD.cleanup_request_id IS NOT NULL AND OLD.cleanup_request_id IS NOT NEW.cleanup_request_id
        AND NOT (NEW.generation > OLD.generation
          AND NOT EXISTS(SELECT 1 FROM apple_web_cleanup_requests WHERE request_id = OLD.cleanup_request_id)
          AND EXISTS(SELECT 1 FROM apple_web_cleanup_obligations WHERE request_id = NEW.cleanup_request_id AND connection_id = OLD.id)))
    BEGIN SELECT RAISE(ABORT, 'web Apple custody identity is immutable'); END`,
] as const
