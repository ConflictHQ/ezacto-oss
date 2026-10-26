/** Frozen typed rows stay in D1 until bounded export pages are published. */
export const workerBackupCaptureMigration = [
  `CREATE TABLE worker_backup_snapshots (
    id TEXT PRIMARY KEY, prefix TEXT NOT NULL, created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('capturing','ready','completed'))
  ) STRICT`,
  `CREATE TABLE worker_backup_rows (
    snapshot_id TEXT NOT NULL REFERENCES worker_backup_snapshots(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL, ordinal INTEGER NOT NULL,
    encoded TEXT NOT NULL CHECK(length(CAST(encoded AS BLOB))<=2000000),
    PRIMARY KEY(snapshot_id,table_name,ordinal)
  ) STRICT`,
  `CREATE TABLE worker_backup_cleanup (
    prefix TEXT PRIMARY KEY, available_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
  ) STRICT`,
  `CREATE TRIGGER worker_backup_capture_cleanup AFTER DELETE ON worker_backup_snapshots
    WHEN OLD.state<>'completed' BEGIN
    INSERT INTO worker_backup_cleanup(prefix,available_at)
      VALUES(OLD.prefix,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))
      ON CONFLICT(prefix) DO UPDATE SET available_at=max(available_at,excluded.available_at);
  END`,
  `CREATE TRIGGER worker_backup_privacy_closure BEFORE INSERT ON account_closures BEGIN
    DELETE FROM worker_backup_snapshots;
  END`,
  `CREATE TRIGGER worker_backup_privacy_retention BEFORE INSERT ON account_retention_review_events
    WHEN NEW.decision='removed' BEGIN DELETE FROM worker_backup_snapshots; END`,
  `CREATE TRIGGER worker_backup_privacy_organization BEFORE DELETE ON organizations BEGIN
    DELETE FROM worker_backup_snapshots;
  END`,
  `CREATE TRIGGER worker_backup_privacy_user BEFORE DELETE ON users BEGIN
    DELETE FROM worker_backup_snapshots;
  END`,
] as const
