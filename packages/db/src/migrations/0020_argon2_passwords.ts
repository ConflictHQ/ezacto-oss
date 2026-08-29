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

/**
 * Preserve the exact legacy PBKDF2 representation while making every Argon2id
 * parameter explicit and immutable as one algorithm version. A future cost
 * change gets its own migration instead of allowing database-controlled work
 * factors to become a denial-of-service input.
 */
export const argon2PasswordsMigration = [
  `CREATE TABLE user_passwords_0020 (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    credential_version INTEGER NOT NULL CHECK (
      credential_version BETWEEN 1 AND 9007199254740991
    ),
    algorithm TEXT NOT NULL CHECK (algorithm IN ('pbkdf2-sha256','argon2id')),
    version INTEGER,
    iterations INTEGER,
    memory_kib INTEGER,
    time_cost INTEGER,
    parallelism INTEGER,
    salt TEXT NOT NULL CHECK (${base64Url('salt', 22)}),
    password_hash TEXT NOT NULL CHECK (${base64Url('password_hash', 43)}),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (
      (algorithm = 'pbkdf2-sha256'
        AND version IS NULL
        AND iterations = 600000
        AND memory_kib IS NULL
        AND time_cost IS NULL
        AND parallelism IS NULL)
      OR
      (algorithm = 'argon2id'
        AND version = 19
        AND iterations IS NULL
        AND memory_kib = 19456
        AND time_cost = 2
        AND parallelism = 1)
    )
  ) STRICT`,
  `INSERT INTO user_passwords_0020 (
      user_id, credential_version, algorithm, version, iterations, memory_kib, time_cost,
      parallelism, salt, password_hash, created_at, updated_at
    ) SELECT
      user_id, 1, algorithm, NULL, iterations, NULL, NULL,
      NULL, salt, password_hash, created_at, updated_at
    FROM user_passwords`,
  `DROP TRIGGER auth_first_run_requires_empty_identity`,
  `DROP TABLE user_passwords`,
  `ALTER TABLE user_passwords_0020 RENAME TO user_passwords`,
  `CREATE TRIGGER auth_first_run_requires_empty_identity BEFORE INSERT ON auth_first_run
    WHEN EXISTS (SELECT 1 FROM organizations)
      OR EXISTS (SELECT 1 FROM users)
      OR EXISTS (SELECT 1 FROM user_emails)
      OR EXISTS (SELECT 1 FROM user_passwords)
    BEGIN SELECT RAISE(ABORT, 'first-run signup requires empty identity state'); END`,
] as const
