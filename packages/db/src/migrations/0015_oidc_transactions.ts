const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

const base64Url = (column: string) =>
  `length(${column}) BETWEEN 43 AND 128
    AND ${column} NOT GLOB '*[^A-Za-z0-9._~-]*'`

const sha256Hex = (column: string) => `length(${column}) = 64
  AND ${column} NOT GLOB '*[^0-9a-f]*'`

export const oidcTransactionsMigration = [
  `CREATE TABLE oidc_transactions (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (
      length(provider) BETWEEN 1 AND 100
      AND provider GLOB '[a-z]*'
      AND provider NOT GLOB '*[^a-z0-9._-]*'
    ),
    issuer TEXT NOT NULL CHECK (
      length(issuer) BETWEEN 1 AND 2048
      AND issuer GLOB 'https://*'
    ),
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
    client_key_hash TEXT NOT NULL CHECK (${sha256Hex('client_key_hash')}),
    state_hash TEXT NOT NULL UNIQUE CHECK (${sha256Hex('state_hash')}),
    code_verifier TEXT NOT NULL CHECK (${base64Url('code_verifier')}),
    nonce TEXT NOT NULL CHECK (${base64Url('nonce')}),
    redirect_uri TEXT NOT NULL CHECK (
      length(redirect_uri) BETWEEN 1 AND 2048
      AND redirect_uri GLOB 'https://*'
    ),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    consume_nonce TEXT UNIQUE CHECK (
      consume_nonce IS NULL OR (
        length(consume_nonce) = 16
        AND consume_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(expires_at) > julianday(created_at)),
    CHECK ((consumed_at IS NULL) = (consume_nonce IS NULL)),
    CHECK (consumed_at IS NULL OR julianday(consumed_at) <= julianday(expires_at))
  ) STRICT`,
  `CREATE INDEX oidc_transactions_active_expiry
    ON oidc_transactions(expires_at) WHERE consumed_at IS NULL`,
  `CREATE INDEX oidc_transactions_client_created
    ON oidc_transactions(client_key_hash, created_at)`,
  `CREATE TRIGGER oidc_transactions_id_collision_guard BEFORE INSERT ON oidc_transactions
    WHEN EXISTS (SELECT 1 FROM oidc_transactions current WHERE current.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'OIDC transaction id collision cannot replace identity'); END`,
  `CREATE TRIGGER oidc_transactions_consume_collision_guard BEFORE UPDATE ON oidc_transactions
    WHEN NEW.consume_nonce IS NOT NULL AND EXISTS (
      SELECT 1 FROM oidc_transactions current
      WHERE current.consume_nonce = NEW.consume_nonce AND current.id <> OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'OIDC transaction consume collision cannot replace identity'); END`,
  `CREATE TRIGGER oidc_transactions_identity_immutable BEFORE UPDATE ON oidc_transactions
    WHEN OLD.id IS NOT NEW.id
      OR OLD.provider IS NOT NEW.provider
      OR OLD.issuer IS NOT NEW.issuer
      OR OLD.client_id IS NOT NEW.client_id
      OR OLD.client_key_hash IS NOT NEW.client_key_hash
      OR OLD.state_hash IS NOT NEW.state_hash
      OR OLD.code_verifier IS NOT NEW.code_verifier
      OR OLD.nonce IS NOT NEW.nonce
      OR OLD.redirect_uri IS NOT NEW.redirect_uri
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'OIDC transaction identity is immutable and consumption is irreversible'); END`,
] as const
