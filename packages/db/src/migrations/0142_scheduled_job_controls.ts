const timestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column},1,19)=strftime('%Y-%m-%dT%H:%M:%S',${column})
  AND (${column} GLOB '????-??-??T??:??:??Z' OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z')`
export const scheduledJobControlsMigration = [
  `ALTER TABLE scheduled_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)`,
  `ALTER TABLE scheduled_jobs ADD COLUMN last_checked_at TEXT CHECK(last_checked_at IS NULL OR (${timestamp('last_checked_at')}))`,
  `ALTER TABLE scheduled_jobs ADD COLUMN last_error TEXT CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000)`,
  `ALTER TABLE scheduled_jobs ADD COLUMN last_run_id INTEGER REFERENCES proposed_runs(id) ON DELETE RESTRICT`,
  `ALTER TABLE proposed_runs ADD COLUMN job_version INTEGER CHECK(job_version IS NULL OR job_version>=0)`,
  `CREATE INDEX scheduled_jobs_check_due ON scheduled_jobs(is_active,last_checked_at,id)`,
] as const
