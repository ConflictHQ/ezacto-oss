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

export const contactPortalMigration = [
  `CREATE TABLE magic_link_tokens (
    id INTEGER PRIMARY KEY,
    jti TEXT NOT NULL UNIQUE,
    contact_email TEXT NOT NULL,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('expires_at')}),
    CHECK (used_at IS NULL OR (${canonicalTimestamp('used_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (contact_email = lower(contact_email) AND length(contact_email) BETWEEN 3 AND 254),
    CHECK (length(jti) BETWEEN 1 AND 128 AND jti NOT GLOB '*[^A-Za-z0-9_-]*'),
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')
  ) STRICT`,
  `CREATE INDEX magic_link_tokens_contact_created
    ON magic_link_tokens(contact_id, created_at)`,
  `CREATE INDEX magic_link_tokens_expiry
    ON magic_link_tokens(expires_at) WHERE used_at IS NULL`,

  `CREATE TABLE contact_sessions (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    selector TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('last_seen_at')}),
    CHECK (${canonicalTimestamp('idle_expires_at')}),
    CHECK (${canonicalTimestamp('absolute_expires_at')}),
    CHECK (revoked_at IS NULL OR (${canonicalTimestamp('revoked_at')})),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (length(selector) = 16 AND selector NOT GLOB '*[^A-Za-z0-9_-]*'),
    CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*')
  ) STRICT`,
  `CREATE INDEX contact_sessions_contact_created
    ON contact_sessions(contact_id, created_at, id)`,
  `CREATE INDEX contact_sessions_active_expiry
    ON contact_sessions(idle_expires_at, absolute_expires_at)`,
] as const
