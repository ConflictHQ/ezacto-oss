// Provenance: ezacto-oss issue 731 and issue 735; the half of two-factor auth
// that was missing -- the sign-in actually stopping for it, and the ceiling
// that keeps the stop from being guessable.

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

/**
 * What stands between primary authentication and a session.
 *
 * 0040 stored the seed and the recovery codes, and every sign-in path issued a
 * session without ever asking for either. The row here is what a sign-in gets
 * instead when the user is enrolled: it names the user, it expires in minutes,
 * and it is worth nothing until a code is presented against it. Only then does
 * it turn into a session.
 *
 * It holds no attempt counter of its own. The token is 32 random bytes, so the
 * guessable thing is the six-digit code, and the ceiling for that belongs to
 * the enrolment -- otherwise an attacker requests a fresh challenge whenever
 * the count gets uncomfortable, which is to say never counts at all.
 *
 * `consumed_at` is set in the same UPDATE that reads the row, so two requests
 * carrying the same challenge cannot both become sessions.
 */
export const twoFactorChallengesMigration = [
  `CREATE TABLE two_factor_challenges (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (${sha256Hex('token_hash')}),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(expires_at) > julianday(created_at)),
    CHECK (consumed_at IS NULL OR julianday(consumed_at) <= julianday(expires_at))
  ) STRICT`,
  `CREATE INDEX two_factor_challenges_active_expiry
    ON two_factor_challenges(expires_at) WHERE consumed_at IS NULL`,
  `CREATE TRIGGER two_factor_challenges_identity_immutable
    BEFORE UPDATE ON two_factor_challenges
    WHEN OLD.id IS NOT NEW.id
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.token_hash IS NOT NEW.token_hash
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a two-factor challenge is single use and immutable'); END`,
  // The brute-force ceiling, on the enrolment rather than on whatever surface
  // presented the code. `POST /two-factor/confirm`, `DELETE /two-factor` and
  // the sign-in challenge all spend from the same count, so no amount of
  // switching between them buys an attacker more guesses.
  `ALTER TABLE user_totp_enrolments ADD COLUMN failed_attempts INTEGER NOT NULL
    DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 1000)`,
  `ALTER TABLE user_totp_enrolments ADD COLUMN locked_until TEXT
    CHECK (locked_until IS NULL OR (${canonicalTimestamp('locked_until')}))`,
] as const
