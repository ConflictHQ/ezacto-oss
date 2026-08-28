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

const ecmaScriptWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
  8201, 8202, 8232, 8233, 8239, 8287, 12_288, 65_279,
]
  .map((codePoint) => `char(${codePoint})`)
  .join(' || ')

/**
 * Reserved after #94's 0009 and #126's 0010. Those migrations intentionally do
 * not exist on this branch yet; this number must not be collapsed into the gap.
 * The scope list below snapshots the shared core policy at migration 0011; any
 * future scope addition must replace the guard in a later numbered migration.
 */
export const apiTokensMigration = [
  `CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    selector TEXT NOT NULL UNIQUE CHECK (
      length(selector) = 16 AND selector NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    secret_hash TEXT NOT NULL CHECK (
      length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'
    ),
    name TEXT NOT NULL CHECK (
      name = trim(name, ${ecmaScriptWhitespace}) AND length(name) BETWEEN 1 AND 100
    ),
    scopes TEXT NOT NULL CHECK (
      json_valid(scopes) AND json_type(scopes) = 'array'
    ),
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (last_used_at IS NULL OR (${canonicalTimestamp('last_used_at')})),
    CHECK (expires_at IS NULL OR (${canonicalTimestamp('expires_at')})),
    CHECK (revoked_at IS NULL OR (${canonicalTimestamp('revoked_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (expires_at IS NULL OR julianday(expires_at) > julianday(created_at)),
    CHECK (last_used_at IS NULL OR julianday(last_used_at) >= julianday(created_at)),
    CHECK (revoked_at IS NULL OR julianday(revoked_at) >= julianday(created_at))
  ) STRICT`,
  `CREATE INDEX api_tokens_user_created_id
    ON api_tokens(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX api_tokens_active_expiry
    ON api_tokens(expires_at) WHERE revoked_at IS NULL`,
  `CREATE TRIGGER api_tokens_identity_immutable
    BEFORE UPDATE OF user_id, selector, secret_hash, scopes, created_at ON api_tokens
    WHEN OLD.user_id IS NOT NEW.user_id OR OLD.selector IS NOT NEW.selector
      OR OLD.secret_hash IS NOT NEW.secret_hash OR OLD.scopes IS NOT NEW.scopes
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'API token identity and scopes are immutable'); END`,
  `CREATE TRIGGER api_tokens_last_used_monotonic
    BEFORE UPDATE OF last_used_at ON api_tokens
    WHEN OLD.last_used_at IS NOT NULL AND (
      NEW.last_used_at IS NULL
      OR julianday(NEW.last_used_at) < julianday(OLD.last_used_at)
    )
    BEGIN SELECT RAISE(ABORT, 'API token last_used_at cannot move backward'); END`,
  `CREATE TRIGGER api_tokens_revocation_irreversible
    BEFORE UPDATE OF revoked_at ON api_tokens
    WHEN OLD.revoked_at IS NOT NULL AND (
      NEW.revoked_at IS NULL
      OR julianday(NEW.revoked_at) < julianday(OLD.revoked_at)
    )
    BEGIN SELECT RAISE(ABORT, 'API token revocation is irreversible'); END`,
  `CREATE TRIGGER api_tokens_scopes_insert_guard
    BEFORE INSERT ON api_tokens
    WHEN json_valid(NEW.scopes) AND json_type(NEW.scopes) = 'array' AND (
      EXISTS (SELECT 1 FROM json_each(NEW.scopes) WHERE type <> 'text')
      OR (SELECT count(*) FROM json_each(NEW.scopes)) NOT BETWEEN 1 AND 100
      OR (SELECT count(*) FROM json_each(NEW.scopes))
        <> (SELECT count(DISTINCT value) FROM json_each(NEW.scopes))
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.scopes)
        WHERE value NOT IN (
          'time_entries:read','time_entries:write','projects:read','projects:write',
          'clients:read','clients:write','invoices:read','invoices:write',
          'expenses:read','expenses:write','team:read','schedule:read',
          'schedule:write','reports:read'
        )
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(NEW.scopes) current
        JOIN json_each(NEW.scopes) successor
          ON CAST(successor.key AS INTEGER) = CAST(current.key AS INTEGER) + 1
        WHERE current.value >= successor.value
      )
    )
    BEGIN SELECT RAISE(ABORT, 'API token scopes must be canonical sorted unique strings'); END`,
] as const
