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

const sha256Hex = (column: string) => `length(${column}) = 64
  AND ${column} NOT GLOB '*[^0-9a-f]*'`

// Single-use, short-lived codes that bridge an OIDC (or GitHub) sign-in started
// from the native app to an API token. The callback, when the flow was started
// with ?flow=app, mints one of these bound to the verified user and redirects
// to the app's custom scheme; the app exchanges it once, over POST, for a
// token. Only the SHA-256 of the code is stored, never the code itself.
// Consumption is irreversible (see the immutability trigger), so a code cannot
// be redeemed twice even under a race.
export const oidcAppCodesMigration = [
  `CREATE TABLE oidc_app_codes (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (
      length(provider) BETWEEN 1 AND 100
      AND provider GLOB '[a-z]*'
      AND provider NOT GLOB '*[^a-z0-9._-]*'
    ),
    code_hash TEXT NOT NULL UNIQUE CHECK (${sha256Hex('code_hash')}),
    user_id INTEGER NOT NULL CHECK (user_id > 0),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(expires_at) > julianday(created_at)),
    CHECK (consumed_at IS NULL OR julianday(consumed_at) <= julianday(expires_at))
  ) STRICT`,
  `CREATE INDEX oidc_app_codes_active_expiry
    ON oidc_app_codes(expires_at) WHERE consumed_at IS NULL`,
  `CREATE TRIGGER oidc_app_codes_id_collision_guard BEFORE INSERT ON oidc_app_codes
    WHEN EXISTS (SELECT 1 FROM oidc_app_codes current WHERE current.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'OIDC app code id collision cannot replace identity'); END`,
  `CREATE TRIGGER oidc_app_codes_identity_immutable BEFORE UPDATE ON oidc_app_codes
    WHEN OLD.id IS NOT NEW.id
      OR OLD.provider IS NOT NEW.provider
      OR OLD.code_hash IS NOT NEW.code_hash
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'OIDC app code identity is immutable and consumption is irreversible'); END`,
] as const
