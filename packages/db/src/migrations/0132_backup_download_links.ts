// Provenance: ezacto-pvt #39, operator export slice 2. A signed, single-use,
// expiring download link for one completed backup run.
//
// `backup_download_links` has one row per link minted. The token is a bearer
// secret and is never stored: only its SHA-256 is, so a copy of the database
// (which is exactly what the link hands out) cannot be used to mint a download
// of the next one. The row is immutable except for `consumed_at`, which is set
// once, by the statement that decides who gets the file, and is never deleted:
// it is the record of which links existed and which were spent.
//
// `backup_download_limits` is a per-minute attempt counter keyed on a hash of
// the caller, so the public route and the mint route can refuse a caller that
// is guessing or hammering without the table holding an address.
//
// Both tables are captured in a bundle and named in `restore_skips`: restoring
// a spent link as unspent, or a lapsed one as live, would revive a credential.
const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const backupDownloadLinksMigration = [
  `CREATE TABLE backup_download_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE RESTRICT,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- SHA-256 of the token, lower-case hex. The token itself is never stored.
    token_hash TEXT NOT NULL UNIQUE
      CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    consumed_at TEXT CHECK (consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')})
  ) STRICT`,

  `CREATE INDEX backup_download_links_run ON backup_download_links(backup_run_id)`,

  // The identity of a link never changes, and a spent link is never unspent.
  `CREATE TRIGGER backup_download_links_identity_immutable
    BEFORE UPDATE OF backup_run_id, created_by_user_id, token_hash, expires_at, created_at
      ON backup_download_links
    BEGIN SELECT RAISE(ABORT, 'a backup download link is immutable'); END`,
  `CREATE TRIGGER backup_download_links_consumed_once
    BEFORE UPDATE OF consumed_at ON backup_download_links
    WHEN OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a backup download link is single-use'); END`,
  `CREATE TRIGGER backup_download_links_no_delete
    BEFORE DELETE ON backup_download_links
    BEGIN SELECT RAISE(ABORT, 'a backup download link is immutable'); END`,

  `CREATE TABLE backup_download_limits (
    window_minute INTEGER NOT NULL CHECK (window_minute >= 0),
    client_hash TEXT NOT NULL CHECK (length(client_hash) = 64),
    attempts INTEGER NOT NULL CHECK (attempts >= 1),
    PRIMARY KEY (window_minute, client_hash)
  ) STRICT`,
] as const
