/** Shared by local imports and queued D1 migration admission. */
export const LEASE_SCHEMA: readonly { sql: string; bindings: readonly unknown[] }[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      holder TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence >= 1),
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      previous_holder TEXT,
      snapshot_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL
    ) STRICT`,
    bindings: [],
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_lease_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      fence INTEGER NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('claimed', 'taken_over', 'released')),
      holder TEXT NOT NULL,
      previous_holder TEXT,
      at INTEGER NOT NULL,
      UNIQUE (fence, event)
    ) STRICT`,
    bindings: [],
  },
  {
    // One row, rewritten by every guarded batch. Its CHECK is the whole point:
    // writing a 0 into it fails the statement, and a failed statement in a batch
    // rolls the batch back.
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      lease_held INTEGER NOT NULL CHECK (lease_held = 1)
    ) STRICT`,
    bindings: [],
  },
]
