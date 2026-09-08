// Provenance: ezacto-oss #97; the second factor for the native password login.

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

const base64Url = (column: string, length: number) => `length(${column}) = ${length}
  AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*'`

const base32 = (column: string, length: number) => `length(${column}) = ${length}
  AND ${column} NOT GLOB '*[^A-Z2-7]*'`

/**
 * The TOTP seed and the recovery codes that stand in for it.
 *
 * The two are stored differently on purpose. Verifying a TOTP code means
 * recomputing an HMAC over the seed, so the seed has to come back out of the
 * database in the form it went in; a hash of it would verify nothing. A
 * recovery code only ever has to be compared, so it goes in under the same
 * Argon2id parameters as a password and never comes back out at all — the
 * columns here are the same shape `user_passwords` uses, so a leaked backup
 * yields as little from one table as from the other. They are pinned rather
 * than merely recorded for the reason 0020 pins them: a work factor the
 * database can choose is a work factor an attacker can choose.
 *
 * `confirmed_at` is what separates an enrolment from a lockout. A seed that
 * has been generated but never proved is inert: the user's own authenticator
 * may hold a different one, or none, and switching the login over on the
 * strength of a row nobody verified is how an account becomes unreachable.
 * The first accepted code sets `confirmed_at` and `last_used_step` together,
 * which is why the CHECK ties them.
 *
 * `last_used_step` is the replay guard. A code stays valid for thirty seconds
 * and the drift window widens that to ninety, which is long enough for someone
 * who read it over a shoulder to type it in after its owner did; recording the
 * step spends it.
 */
export const twoFactorMigration = [
  `CREATE TABLE user_totp_enrolments (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL CHECK (${base32('secret', 32)}),
    confirmed_at TEXT CHECK (confirmed_at IS NULL OR (${canonicalTimestamp('confirmed_at')})),
    last_used_step INTEGER CHECK (
      last_used_step IS NULL OR last_used_step BETWEEN 0 AND 9007199254740991
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK ((confirmed_at IS NULL) = (last_used_step IS NULL))
  ) STRICT`,
  `CREATE TABLE user_recovery_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    selector TEXT NOT NULL CHECK (${base32('selector', 8)}),
    algorithm TEXT NOT NULL CHECK (algorithm = 'argon2id'),
    version INTEGER NOT NULL CHECK (version = 19),
    memory_kib INTEGER NOT NULL CHECK (memory_kib = 19456),
    time_cost INTEGER NOT NULL CHECK (time_cost = 2),
    parallelism INTEGER NOT NULL CHECK (parallelism = 1),
    salt TEXT NOT NULL CHECK (${base64Url('salt', 22)}),
    code_hash TEXT NOT NULL CHECK (${base64Url('code_hash', 43)}),
    used_at TEXT CHECK (used_at IS NULL OR (${canonicalTimestamp('used_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    UNIQUE(user_id, selector),
    CHECK (used_at IS NULL OR julianday(used_at) >= julianday(created_at))
  ) STRICT`,
  `CREATE INDEX user_recovery_codes_unused ON user_recovery_codes(user_id)
    WHERE used_at IS NULL`,
  // Spending a code is the only thing that may happen to it. Rewriting the
  // hash would let a used code be handed back out, and clearing used_at would
  // let a code that has already got someone in do it a second time.
  `CREATE TRIGGER user_recovery_codes_single_use BEFORE UPDATE ON user_recovery_codes
    WHEN OLD.user_id IS NOT NEW.user_id
      OR OLD.selector IS NOT NEW.selector
      OR OLD.code_hash IS NOT NEW.code_hash
      OR OLD.salt IS NOT NEW.salt
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.used_at IS NOT NULL
      OR NEW.used_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'recovery codes are single use and immutable'); END`,
  // An enrolment that has been proved keeps its seed. Rotating it silently
  // would leave the authenticator the user already scanned generating codes
  // for a secret the server no longer holds.
  `CREATE TRIGGER user_totp_enrolments_confirmed_secret_immutable
    BEFORE UPDATE ON user_totp_enrolments
    WHEN OLD.confirmed_at IS NOT NULL
      AND (OLD.secret IS NOT NEW.secret OR NEW.confirmed_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'a confirmed TOTP enrolment is immutable'); END`,
] as const
