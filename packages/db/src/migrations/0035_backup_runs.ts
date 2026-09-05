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

export const backupRunsMigration = [
  `CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    trigger TEXT NOT NULL CHECK (trigger IN ('nightly','manual')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    r2_prefix TEXT,
    manifest_json TEXT,
    table_count INTEGER,
    total_rows INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('started_at')}),
    CHECK (completed_at IS NULL OR (${canonicalTimestamp('completed_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (
      (status = 'running' AND completed_at IS NULL AND error_message IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL
        AND r2_prefix IS NOT NULL AND manifest_json IS NOT NULL
        AND table_count IS NOT NULL AND total_rows IS NOT NULL
        AND error_message IS NULL)
      OR (status = 'failed' AND completed_at IS NOT NULL
        AND error_message IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX backup_runs_status_started
    ON backup_runs(status, started_at DESC)`,
] as const
