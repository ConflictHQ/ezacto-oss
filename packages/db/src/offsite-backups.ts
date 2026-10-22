import { sql } from 'drizzle-orm'
import {
  backupBase64,
  OffsiteBackupError,
  backupSha256,
  encryptBackupObject,
  type OffsiteBackupRun,
  type OffsiteBackupStatus,
} from '@ezacto/core'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import type { BackupManifest } from './backup.js'
interface SyncRow {
  id: string
  backup_run_id: number
  destination_id: string
  destination_label: string
  encryption_key_id: string
  source_prefix: string
  source_manifest_json: string
  target_prefix: string
  status: OffsiteBackupRun['status']
  started_at: string
  completed_at: string | null
  error_message: string | null
}
interface ObjectRow {
  name: string
  source_sha256: string
  nonce: string
}
export type OffsiteBackupSettings =
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      destinationId: string
      label: string
      targetPrefix: string
      keyId: string
      key: Uint8Array
      source: { get(key: string): Promise<Uint8Array | null> }
      target: {
        ensureObject(name: string, bytes: Uint8Array): Promise<{ sha256: string; size: number }>
      }
    }
const safeError = (error: unknown) =>
  error instanceof OffsiteBackupError
    ? error.message
    : 'The backup source, encryption or checkpoint could not be verified. Check the original L1 bundle and server logs before retrying.'
const maxPlainBytes = 16 * 1024 * 1024
export const createOffsiteBackupSyncService = (
  database: InvoiceStateDatabase,
  settings: OffsiteBackupSettings,
  clock = () => new Date().toISOString(),
  reportError: (error: unknown) => void = () => {},
) => {
  const history = async (completed = false) =>
    (
      await database.all<OffsiteBackupRun>(sql`
   SELECT sync.id,sync.backup_run_id,sync.status,sync.started_at,sync.completed_at,sync.error_message,
    (SELECT COUNT(*) FROM offsite_backup_objects WHERE sync_id=sync.id AND uploaded_at IS NOT NULL) AS uploaded_objects,
    (SELECT COUNT(*) FROM offsite_backup_objects WHERE sync_id=sync.id) AS total_objects
   FROM offsite_backup_syncs sync ${settings.kind === 'ready' ? sql`WHERE destination_id=${settings.destinationId} ${completed ? sql`AND status='completed'` : sql``}` : completed ? sql`WHERE status='completed'` : sql``}
   ORDER BY sync.started_at DESC,sync.id DESC LIMIT 1`)
    )[0] ?? null
  const load = async (source: { get(key: string): Promise<Uint8Array | null> }, key: string) => {
    const bytes = await source.get(key)
    if (!bytes)
      throw new OffsiteBackupError(
        'An original L1 backup object is missing. Restore the original bundle in its source store before retrying.',
      )
    if (bytes.length > maxPlainBytes)
      throw new OffsiteBackupError(
        'An L1 backup object exceeds the 16 MiB scheduled-sync limit. Use an operator export for larger tables.',
      )
    return bytes
  }
  const service = {
    async checkDestination() {
      if (settings.kind !== 'ready')
        throw new OffsiteBackupError(
          settings.kind === 'error'
            ? settings.message
            : 'Configure the dedicated backup bucket, access keys and encryption key before checking the off-site destination.',
        )
      const bytes = new TextEncoder().encode(
        'eZacto encrypted off-site destination check. This is not a backup.',
      )
      const cipher = await encryptBackupObject(
        {
          name: 'destination-check.txt',
          bytes,
          sha256: await backupSha256(bytes),
          nonce: crypto.getRandomValues(new Uint8Array(12)),
        },
        settings.key,
      )
      const result = await settings.target.ensureObject(
        settings.targetPrefix + 'checks/' + crypto.randomUUID() + '/destination-check.txt.ezenc',
        cipher,
      )
      if (result.sha256 !== (await backupSha256(cipher)) || result.size !== cipher.length)
        throw new OffsiteBackupError(
          'The destination did not verify the encrypted preflight object. Check checksum support and read/write bucket permissions.',
        )
      return { verified: true as const, checked_at: clock() }
    },
    async status(): Promise<OffsiteBackupStatus> {
      const [latest, lastCompleted] = await Promise.all([history(), history(true)])
      const error =
        settings.kind === 'error'
          ? { code: 'E14' as const, message: settings.message }
          : latest?.status === 'failed'
            ? {
                code: 'E14' as const,
                message: latest.error_message ?? 'The off-site backup failed.',
              }
            : null
      return {
        configured: settings.kind !== 'disabled',
        state:
          settings.kind === 'disabled'
            ? 'disabled'
            : settings.kind === 'error'
              ? 'misconfigured'
              : latest === null
                ? 'waiting'
                : latest.status === 'pending'
                  ? 'running'
                  : latest.status,
        destination: settings.kind === 'ready' ? settings.label : null,
        last_completed: lastCompleted,
        latest,
        error,
      }
    },
    async processDue() {
      if (settings.kind !== 'ready') return { uploaded: 0 }
      const now = clock()
      let row = (
        await database.all<SyncRow>(sql`SELECT * FROM offsite_backup_syncs
     WHERE destination_id=${settings.destinationId} AND status<>'completed'
       AND (retry_at IS NULL OR retry_at<=${now}) AND (lease_expires_at IS NULL OR lease_expires_at<=${now})
     ORDER BY started_at,id LIMIT 1`)
      )[0]
      if (!row) {
        const backup = (
          await database.all<{ id: number; r2_prefix: string; manifest_json: string }>(sql`
      SELECT id,r2_prefix,manifest_json FROM backup_runs backup WHERE status='completed'
       AND r2_prefix IS NOT NULL AND manifest_json IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM offsite_backup_syncs WHERE backup_run_id=backup.id AND destination_id=${settings.destinationId})
      ORDER BY started_at DESC,id DESC LIMIT 1`)
        )[0]
        if (!backup) return { uploaded: 0 }
        const id = crypto.randomUUID()
        await database.run(sql`INSERT INTO offsite_backup_syncs(id,backup_run_id,destination_id,destination_label,encryption_key_id,
      source_prefix,source_manifest_json,target_prefix,started_at,updated_at)
      VALUES(${id},${backup.id},${settings.destinationId},${settings.label},${settings.keyId},${backup.r2_prefix},${backup.manifest_json},
        ${settings.targetPrefix + id + '/'},${now},${now}) ON CONFLICT(backup_run_id,destination_id) DO NOTHING`)
        row = (
          await database.all<SyncRow>(
            sql`SELECT * FROM offsite_backup_syncs WHERE backup_run_id=${backup.id} AND destination_id=${settings.destinationId}`,
          )
        )[0]
      }
      if (!row) return { uploaded: 0 }
      const token = crypto.randomUUID(),
        expires = new Date(Date.parse(now) + 120000).toISOString()
      const claimed = await database.all<{
        id: string
      }>(sql`UPDATE offsite_backup_syncs SET status='running',lease_token=${token},lease_expires_at=${expires},retry_at=NULL,updated_at=${now}
    WHERE id=${row.id} AND status<>'completed' AND (retry_at IS NULL OR retry_at<=${now})
      AND (lease_expires_at IS NULL OR lease_expires_at<=${now}) RETURNING id`)
      if (!claimed.length) return { uploaded: 0 }
      let uploaded = 0
      try {
        const existing = await database.all<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM offsite_backup_objects WHERE sync_id=${row.id}`,
        )
        if (existing[0]?.count === 0) {
          const stored = await load(settings.source, row.source_prefix + 'manifest.json')
          if (
            JSON.stringify(JSON.parse(new TextDecoder().decode(stored))) !==
            JSON.stringify(JSON.parse(row.source_manifest_json))
          )
            throw new OffsiteBackupError(
              'The L1 manifest differs from its completed run receipt. Restore the original manifest before retrying.',
            )
          const manifest = JSON.parse(row.source_manifest_json) as BackupManifest
          const names = Object.keys(manifest.tables).sort()
          if (
            names.length !== manifest.table_count ||
            names.some(
              (name) =>
                !/^[A-Za-z0-9_]+$/u.test(name) ||
                !/^[0-9a-f]{64}$/u.test(manifest.tables[name]!.sha256),
            )
          )
            throw new OffsiteBackupError(
              'The original L1 manifest is invalid. Check the completed backup before retrying.',
            )
          const restore = await load(settings.source, row.source_prefix + 'RESTORE.md')
          const plan = [
            ...names.map((name) => ({
              name: `tables/${name}.csv`,
              sha: manifest.tables[name]!.sha256,
            })),
            { name: 'RESTORE.md', sha: await backupSha256(restore) },
            { name: 'manifest.json', sha: await backupSha256(stored) },
          ]
          await runAtomic(
            database,
            plan.map((object) => ({
              text: `INSERT INTO offsite_backup_objects(sync_id,name,encryption_key_id,nonce,source_sha256)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM offsite_backup_syncs WHERE id=? AND lease_token=? AND status='running')`,
              params: [
                row!.id,
                object.name,
                settings.keyId,
                backupBase64(crypto.getRandomValues(new Uint8Array(12))),
                object.sha,
                row!.id,
                token,
              ],
            })),
          )
        }
        const pending =
          await database.all<ObjectRow>(sql`SELECT name,source_sha256,nonce FROM offsite_backup_objects
      WHERE sync_id=${row.id} AND uploaded_at IS NULL ORDER BY CASE WHEN name='manifest.json' THEN 1 ELSE 0 END,name LIMIT 10`)
        const deadline = Date.now() + 20000
        for (const object of pending) {
          if (Date.now() >= deadline) break
          const bytes = await load(settings.source, row.source_prefix + object.name)
          if ((await backupSha256(bytes)) !== object.source_sha256)
            throw new OffsiteBackupError(
              'An L1 object no longer matches its captured checksum. Restore the original source bundle before retrying.',
            )
          const nonce = Uint8Array.from(
            atob(object.nonce.replaceAll('-', '+').replaceAll('_', '/')),
            (c) => c.charCodeAt(0),
          )
          const cipher = await encryptBackupObject(
            { name: object.name, sha256: object.source_sha256, nonce, bytes },
            settings.key,
          )
          const owner = await database.all<{ id: string }>(
            sql`SELECT id FROM offsite_backup_syncs WHERE id=${row.id} AND lease_token=${token} AND lease_expires_at>${clock()}`,
          )
          if (!owner.length) return { uploaded }
          const receipt = await settings.target.ensureObject(
            row.target_prefix + object.name + '.ezenc',
            cipher,
          )
          if (receipt.sha256 !== (await backupSha256(cipher)) || receipt.size !== cipher.length)
            throw new OffsiteBackupError(
              'The destination upload receipt did not verify the encrypted bytes; the checkpoint will retry.',
            )
          const saved = await database.all<{
            name: string
          }>(sql`UPDATE offsite_backup_objects SET uploaded_at=${clock()},cipher_sha256=${receipt.sha256},cipher_size=${receipt.size}
       WHERE sync_id=${row.id} AND name=${object.name} AND uploaded_at IS NULL AND EXISTS(
         SELECT 1 FROM offsite_backup_syncs WHERE id=${row.id} AND lease_token=${token} AND lease_expires_at>${clock()}) RETURNING name`)
          uploaded += saved.length
        }
        await database.run(sql`UPDATE offsite_backup_syncs SET
     status=CASE WHEN EXISTS(SELECT 1 FROM offsite_backup_objects WHERE sync_id=${row.id} AND uploaded_at IS NULL) THEN 'pending' ELSE 'completed' END,
     completed_at=CASE WHEN EXISTS(SELECT 1 FROM offsite_backup_objects WHERE sync_id=${row.id} AND uploaded_at IS NULL) THEN NULL ELSE ${clock()} END,
     lease_token=NULL,lease_expires_at=NULL,retry_at=NULL,error_message=NULL,updated_at=${clock()}
     WHERE id=${row.id} AND lease_token=${token} AND lease_expires_at>${clock()}`)
      } catch (error) {
        try {
          reportError(error)
        } catch {
          /* Reporting must not lose the durable failure. */
        }
        await database.run(sql`UPDATE offsite_backup_syncs SET status='failed',error_message=${safeError(error)},retry_at=${new Date(Date.parse(clock()) + 300000).toISOString()},
      lease_token=NULL,lease_expires_at=NULL,updated_at=${clock()} WHERE id=${row.id} AND lease_token=${token}`)
      }
      return { uploaded }
    },
  }
  return service
}
