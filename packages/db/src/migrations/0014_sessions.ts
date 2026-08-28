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

export const sessionsMigration = [
  `CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    selector TEXT NOT NULL UNIQUE CHECK (${base64Url('selector', 16)}),
    secret_hash TEXT NOT NULL CHECK (${sha256Hex('secret_hash')}),
    profile_snapshot TEXT NOT NULL CHECK (profile_snapshot IN (
      'member','project_manager','people_admin','accounting',
      'executive_manager','administrator'
    )),
    manager_grants_snapshot TEXT NOT NULL CHECK (
      json_valid(manager_grants_snapshot)
      AND json_type(manager_grants_snapshot) = 'array'
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    last_seen_at TEXT NOT NULL CHECK (${canonicalTimestamp('last_seen_at')}),
    idle_expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('idle_expires_at')}),
    absolute_expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('absolute_expires_at')}),
    revoked_at TEXT CHECK (revoked_at IS NULL OR (${canonicalTimestamp('revoked_at')})),
    revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN (
      'user_revoked','privilege_change','password_reset','user_disabled'
    )),
    rotation_nonce TEXT UNIQUE CHECK (
      rotation_nonce IS NULL OR (${base64Url('rotation_nonce', 16)})
    ),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(last_seen_at) >= julianday(created_at)),
    CHECK (julianday(idle_expires_at) > julianday(last_seen_at)),
    CHECK (julianday(idle_expires_at) <= julianday(absolute_expires_at)),
    CHECK (julianday(absolute_expires_at) > julianday(created_at)),
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
    CHECK (
      (rotation_nonce IS NULL AND (
        revocation_reason IS NULL OR revocation_reason <> 'privilege_change'
      ))
      OR (rotation_nonce IS NOT NULL AND revocation_reason = 'privilege_change')
    )
  ) STRICT`,
  `CREATE INDEX sessions_user_created_id
    ON sessions(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX sessions_active_expiry
    ON sessions(idle_expires_at, absolute_expires_at)
    WHERE revoked_at IS NULL`,
  `CREATE TRIGGER sessions_manager_grants_guard BEFORE INSERT ON sessions
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.manager_grants_snapshot) WHERE type <> 'text'
    )
    BEGIN SELECT RAISE(ABORT, 'session manager grants snapshot must contain strings'); END`,
  `CREATE TRIGGER sessions_id_collision_guard BEFORE INSERT ON sessions
    WHEN EXISTS (SELECT 1 FROM sessions current WHERE current.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'session id collision cannot replace identity'); END`,
  `CREATE TRIGGER sessions_selector_collision_guard BEFORE INSERT ON sessions
    WHEN EXISTS (SELECT 1 FROM sessions current WHERE current.selector = NEW.selector)
    BEGIN SELECT RAISE(ABORT, 'session selector collision cannot replace identity'); END`,
  `CREATE TRIGGER sessions_rotation_collision_guard BEFORE INSERT ON sessions
    WHEN NEW.rotation_nonce IS NOT NULL AND EXISTS (
      SELECT 1 FROM sessions current WHERE current.rotation_nonce = NEW.rotation_nonce
    )
    BEGIN SELECT RAISE(ABORT, 'session rotation collision cannot replace identity'); END`,
  `CREATE TRIGGER sessions_identity_immutable BEFORE UPDATE ON sessions
    WHEN OLD.id IS NOT NEW.id
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.selector IS NOT NEW.selector
      OR OLD.secret_hash IS NOT NEW.secret_hash
      OR OLD.profile_snapshot IS NOT NEW.profile_snapshot
      OR OLD.manager_grants_snapshot IS NOT NEW.manager_grants_snapshot
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.absolute_expires_at IS NOT NEW.absolute_expires_at
      OR OLD.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'session identity is immutable and revocation is irreversible'); END`,
  `CREATE TRIGGER sessions_last_seen_monotonic BEFORE UPDATE OF last_seen_at ON sessions
    WHEN julianday(NEW.last_seen_at) < julianday(OLD.last_seen_at)
    BEGIN SELECT RAISE(ABORT, 'session last_seen_at cannot move backward'); END`,
  `CREATE TRIGGER sessions_idle_expiry_monotonic BEFORE UPDATE OF idle_expires_at ON sessions
    WHEN julianday(NEW.idle_expires_at) < julianday(OLD.idle_expires_at)
    BEGIN SELECT RAISE(ABORT, 'session idle expiry cannot move backward'); END`,
] as const
