import {
  completeBackupRun,
  exportBundle,
  failBackupRun,
  recordBackupStart,
  shouldRunNightlyBackup,
  type BackupObjectStore,
} from '@ezacto/db/d1'

const createR2BackupStore = (bucket: R2Bucket): BackupObjectStore => ({
  async put(key, body) {
    await bucket.put(key, body)
  },
})

/**
 * D18 L1: runs the nightly logical export to R2. Idempotent per UTC day —
 * if a nightly backup already started today, this is a no-op.
 */
export const runNightlyExport = async (
  database: D1Database,
  bucket: R2Bucket,
): Promise<void> => {
  if (!(await shouldRunNightlyBackup(database, new Date()))) return

  const now = new Date().toISOString()
  const date = now.slice(0, 10)
  const prefix = `backups/${date}/`

  const runId = await recordBackupStart(database, 'nightly', now)
  try {
    const store = createR2BackupStore(bucket)
    const manifest = await exportBundle(database, store, prefix)
    await completeBackupRun(database, runId, manifest, prefix, new Date().toISOString())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failBackupRun(database, runId, message, new Date().toISOString())
  }
}
