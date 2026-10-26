/** Transient admission is written and reset inside the same snapshot transaction. */
export const workerBackupCaptureMigration = [
  `CREATE TABLE worker_backup_capture (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN (0,1)),
    estimated_bytes INTEGER NOT NULL DEFAULT 0 CHECK(estimated_bytes>=0)
  ) STRICT`,
  `INSERT INTO worker_backup_capture(singleton,admitted,estimated_bytes) VALUES(1,0,0)`,
] as const
