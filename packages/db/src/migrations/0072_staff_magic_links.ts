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

// Passwordless sign-in for staff users. One row per requested sign-in, keyed to
// the user and redeemable two ways: the high-entropy link token (from the email
// link) or the low-entropy 6-digit code (typed in the app). Only SHA-256s are
// stored. Single use is irreversible (see the trigger); the code path also
// carries an attempt counter so a low-entropy code cannot be brute-forced
// before it expires. `flow` records whether the redemption should end in a
// browser session (web) or the native app handoff (app).
export const staffMagicLinksMigration = [
  `CREATE TABLE staff_magic_links (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL CHECK (user_id > 0),
    token_hash TEXT NOT NULL UNIQUE CHECK (${sha256Hex('token_hash')}),
    code_hash TEXT NOT NULL CHECK (${sha256Hex('code_hash')}),
    flow TEXT NOT NULL CHECK (flow IN ('app', 'web')),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 1000),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(expires_at) > julianday(created_at)),
    CHECK (consumed_at IS NULL OR julianday(consumed_at) <= julianday(expires_at))
  ) STRICT`,
  `CREATE INDEX staff_magic_links_user_created
    ON staff_magic_links(user_id, created_at)`,
  `CREATE INDEX staff_magic_links_active_expiry
    ON staff_magic_links(expires_at) WHERE consumed_at IS NULL`,
  `CREATE TRIGGER staff_magic_links_id_collision_guard BEFORE INSERT ON staff_magic_links
    WHEN EXISTS (SELECT 1 FROM staff_magic_links current WHERE current.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'staff magic link id collision cannot replace identity'); END`,
  `CREATE TRIGGER staff_magic_links_identity_immutable BEFORE UPDATE ON staff_magic_links
    WHEN OLD.id IS NOT NEW.id
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.token_hash IS NOT NEW.token_hash
      OR OLD.code_hash IS NOT NEW.code_hash
      OR OLD.flow IS NOT NEW.flow
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
      OR NEW.attempts < OLD.attempts
    BEGIN SELECT RAISE(ABORT, 'staff magic link identity is immutable, consumption is irreversible, and attempts only increase'); END`,
] as const
