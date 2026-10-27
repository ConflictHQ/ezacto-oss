import {
  completeBackupRun,
  exportBundle,
  expireWorkerSnapshots,
  discardWorkerSnapshot,
  failBackupRun,
  recordBackupStart,
  shouldRunNightlyBackup,
  type BackupObjectStore,
} from "@ezacto/db/d1";

const createR2BackupStore = (bucket: R2Bucket): BackupObjectStore => ({
  async get(key) {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  async putBytes(key, body) {
    await bucket.put(key, body);
  },
  async put(key, body) {
    await bucket.put(key, body);
  },
});

/** Delete only capture-specific failed prefixes after in-flight writers have expired. */
export const cleanupAbandonedWorkerBackups = async (
  database: D1Database,
  bucket: R2Bucket,
): Promise<void> => {
  await expireWorkerSnapshots(database);
  const cleanup = await database
    .prepare(
      "SELECT prefix,generation FROM worker_backup_cleanup WHERE julianday(available_at)<=julianday('now') AND (last_error IS NULL OR last_error<>'invalid_prefix') AND NOT EXISTS(SELECT 1 FROM backup_runs WHERE status='completed' AND r2_prefix=worker_backup_cleanup.prefix) ORDER BY available_at LIMIT 1",
    )
    .first<{ prefix: string; generation: number }>();
  if (
    cleanup &&
    /^backups\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/$/u.test(cleanup.prefix)
  ) {
    try {
      let empty = false;
      for (let page = 0; page < 2; page++) {
        const objects = await bucket.list({
          prefix: cleanup.prefix,
          limit: 1000,
        });
        if (!objects.objects.length) {
          empty = true;
          break;
        }
        await bucket.delete(objects.objects.map((object) => object.key));
      }
      if (empty)
        await database
          .prepare(
            "DELETE FROM worker_backup_cleanup WHERE prefix=? AND generation=?",
          )
          .bind(cleanup.prefix, cleanup.generation)
          .run();
    } catch {
      await database
        .prepare(
          "UPDATE worker_backup_cleanup SET attempts=attempts+1,last_error='storage_unavailable' WHERE prefix=? AND generation=?",
        )
        .bind(cleanup.prefix, cleanup.generation)
        .run();
    }
  } else if (cleanup) {
    await database
      .prepare(
        "UPDATE worker_backup_cleanup SET last_error='invalid_prefix' WHERE prefix=? AND generation=?",
      )
      .bind(cleanup.prefix, cleanup.generation)
      .run();
  }
};

/**
 * D18 L1: runs the nightly logical export to R2. Idempotent per UTC day —
 * if a nightly backup already started today, this is a no-op.
 */
export const runNightlyExport = async (
  database: D1Database,
  bucket: R2Bucket,
): Promise<void> => {
  await cleanupAbandonedWorkerBackups(database, bucket);
  if (!(await shouldRunNightlyBackup(database, new Date()))) return;

  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const prefix = `backups/${date}/${crypto.randomUUID()}/`;

  const runId = await recordBackupStart(database, "nightly", now);
  try {
    const store = createR2BackupStore(bucket);
    const manifest = await exportBundle(database, store, prefix);
    await completeBackupRun(
      database,
      runId,
      manifest,
      prefix,
      new Date().toISOString(),
    );
  } catch (error) {
    await discardWorkerSnapshot(database, "", prefix);
    const message = error instanceof Error ? error.message : String(error);
    await failBackupRun(database, runId, message, new Date().toISOString());
  }
};
