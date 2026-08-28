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

const sha256Hex = (column: string) => `length(${column}) = 64
  AND ${column} NOT GLOB '*[^0-9a-f]*'`

export const passwordAuthMigration = [
  `CREATE TABLE user_passwords (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    algorithm TEXT NOT NULL CHECK (algorithm = 'pbkdf2-sha256'),
    iterations INTEGER NOT NULL CHECK (iterations BETWEEN 600000 AND 9007199254740991),
    salt TEXT NOT NULL CHECK (${base64Url('salt', 22)}),
    password_hash TEXT NOT NULL CHECK (${base64Url('password_hash', 43)}),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE auth_tokens (
    id INTEGER PRIMARY KEY,
    selector TEXT NOT NULL UNIQUE CHECK (${base64Url('selector', 16)}),
    secret_hash TEXT NOT NULL CHECK (${sha256Hex('secret_hash')}),
    kind TEXT NOT NULL CHECK (kind IN ('verify_email','password_reset')),
    user_email_id INTEGER NOT NULL REFERENCES user_emails(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    used_at TEXT CHECK (used_at IS NULL OR (${canonicalTimestamp('used_at')})),
    used_nonce TEXT CHECK (used_nonce IS NULL OR (${base64Url('used_nonce', 16)})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK ((used_at IS NULL) = (used_nonce IS NULL)),
    CHECK (julianday(expires_at) > julianday(created_at)),
    CHECK (used_at IS NULL OR julianday(used_at) <= julianday(expires_at))
  ) STRICT`,
  `CREATE INDEX auth_tokens_email_kind ON auth_tokens(user_email_id, kind)`,
  `CREATE TRIGGER auth_tokens_identity_immutable BEFORE UPDATE ON auth_tokens
    WHEN OLD.selector IS NOT NEW.selector
      OR OLD.secret_hash IS NOT NEW.secret_hash
      OR OLD.kind IS NOT NEW.kind
      OR OLD.user_email_id IS NOT NEW.user_email_id
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.used_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'auth tokens are single-use and immutable'); END`,
  `CREATE TABLE auth_rate_limits (
    action TEXT NOT NULL CHECK (action IN ('signup','sign_in','verify_email','request_reset','reset_password')),
    key_hash TEXT NOT NULL CHECK (${sha256Hex('key_hash')}),
    window_started_at TEXT NOT NULL CHECK (${canonicalTimestamp('window_started_at')}),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 9007199254740991),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    PRIMARY KEY(action, key_hash)
  ) STRICT`,
  `CREATE TABLE auth_first_run (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    claim_nonce TEXT NOT NULL UNIQUE CHECK (${base64Url('claim_nonce', 16)}),
    completed_at TEXT CHECK (completed_at IS NULL OR (${canonicalTimestamp('completed_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TRIGGER auth_first_run_requires_empty_identity BEFORE INSERT ON auth_first_run
    WHEN EXISTS (SELECT 1 FROM organizations)
      OR EXISTS (SELECT 1 FROM users)
      OR EXISTS (SELECT 1 FROM user_emails)
      OR EXISTS (SELECT 1 FROM user_passwords)
    BEGIN SELECT RAISE(ABORT, 'first-run signup requires empty identity state'); END`,
  `CREATE TRIGGER auth_first_run_immutable BEFORE UPDATE ON auth_first_run
    WHEN OLD.claim_nonce IS NOT NEW.claim_nonce
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.completed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'first-run signup claim is immutable'); END`,
] as const
