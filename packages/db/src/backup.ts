import { WORKER_BACKUP_CLEAR_TABLES } from '@ezacto/core'
import { captureWorkerSnapshot, discardWorkerSnapshot, type WorkerBackupFile } from './worker-backup-snapshot.js'
/**
 * D18 L1: nightly logical export. Produces the D18 bundle format as a set of
 * objects under an R2 prefix. The versioned Worker format is restored by `ez restore` (CLI)
 * and surfaced in the settings backup-status widget (A-4).
 */

const SCHEMA_VERSION = 1
const BUNDLE_VERSION = '0038'

/** Captured for evidence, then cleared by the supported typed restore reader.
 * Schema migration receipts are preserved; calendar connections are transformed
 * into re-consent and cleanup custody, not silently dropped.
 */
const EPHEMERAL_TABLES: readonly string[] = WORKER_BACKUP_CLEAR_TABLES

/**
 * Every table the database has, in a stable order.
 *
 * Discovered rather than listed. The bundle used to carry a hand-written list
 * of tables to include, so every migration that added one silently narrowed the
 * backup: production exported 51 tables, the source said 57, the database had
 * 127. A backup missing a table looks exactly like a backup that is not.
 *
 * Sorted because the manifest is checksummed and compared between runs: a
 * bundle whose table order drifted with SQLite's catalog would look changed
 * when nothing had changed.
 *
 * The enrolment seeds, password hashes and API-token hashes are all in here.
 * That is deliberate and it is the whole point of a restore: an instance whose
 * people cannot sign in has not been restored. It does mean the bundle carries
 * credential material and has to be handled exactly like the database it came
 * from -- RESTORE.md says so.
 */
const backupTables = async (database: D1Database): Promise<readonly string[]> => {
  const { results } = await database
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
        ORDER BY name`,
    )
    .all<{ name: string }>()
  return results.map((row) => row.name)
}

export interface BackupObjectStore {
  put(key: string, body: string): Promise<void>
  get?(key: string): Promise<Uint8Array | null>
  putBytes?(key: string, body: Uint8Array): Promise<void>
}

export interface BackupManifest {
  schema_version: number
  bundle_version: string
  exported_at: string
  tables: Record<string, { row_count: number; sha256: string }>
  table_count: number
  total_rows: number
  /**
   * Tables present in this bundle that a restore should not load. Carried here
   * rather than left to a reader of the source, because the bundle outlives the
   * version of ezacto that wrote it.
   */
  restore_skips: readonly string[]
  files?: Record<string, WorkerBackupFile>
  capture_id?: string
}

export interface BackupRunRecord {
  id: number
  status: 'running' | 'completed' | 'failed'
  trigger: 'nightly' | 'manual'
  started_at: string
  completed_at: string | null
  r2_prefix: string | null
  manifest_json: string | null
  table_count: number | null
  total_rows: number | null
  error_message: string | null
  created_at: string
  updated_at: string
}

const escapeCsvField = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const toCsvRow = (values: unknown[]): string => values.map(escapeCsvField).join(',')

const sha256Hex = async (data: string): Promise<string> => {
  const encoded = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const RESTORE_MD = `# Restoring from this backup

This backup was produced by ezacto's nightly export (D18 L1). CSV files are human-readable views. The authoritative schema and typed rows
preserve NULL, empty text, binary values, and numeric precision. You can open these in any spreadsheet, import
them into any database, or use the ezacto CLI to restore.

## Handle this like the database itself

The bundle carries database rows and verified attachment bytes, including the
credential material: password hashes, authenticator seeds, recovery-code hashes
and API-token hashes. It has to — an instance whose people cannot sign in has
not been restored — but it means these files are exactly as sensitive as the
database they came from, and more portable. Store them accordingly.

## Tables to skip when loading

The snapshot retains credential evidence. The supported restore clears live
sessions, API tokens, sign-in codes and OAuth transactions before publication;
calendar grants become cleanup obligations requiring fresh consent. It preserves
the migration ledger so schema migrations are not replayed into an existing schema.

\`restore_skips\` is the historical safety inventory, not an instruction to
blindly import CSV or discard migration history. Use the typed snapshot reader.

## Files

- \`tables/<name>.csv\` — one file per table, UTF-8, RFC 4180 CSV.
- \`manifest.json\` — metadata: schema version, export timestamp, row counts,
  and SHA-256 checksums for every file.
- \`schema.json\`, \`rows/\` — lossless versioned schema and typed rows.
- \`attachments/sha256/\` — verified file and brand asset bytes.
- \`RESTORE.md\` — this file.

## Verify integrity

Compare the SHA-256 of each CSV against the value in manifest.json:
\`\`\`
sha256sum tables/*.csv
\`\`\`

## Restore with ezacto

The bundle path is positional, and the database to write is required -- a
restore never guesses which instance it is for.

\`\`\`
ez restore <path-to-this-directory> --database <target.sqlite> --attachments <new-attachments-directory>
\`\`\`

The result is quarantined. Keep it offline and follow the current-evidence replay
and reviewed release procedure in the repository RESTORE.md before serving traffic.
Legacy Worker bundles (0037 and older) cannot be restored losslessly and are refused.

## Read without ezacto

CSV files are for inspection, not lossless restoration. schema.json and rows/
contain the versioned typed snapshot. Attachments are verified content-addressed
bytes under attachments/sha256/. Keep every manifest-listed file together.
`

export const exportBundle = async (
  database: D1Database,
  store: BackupObjectStore,
  prefix: string,
): Promise<BackupManifest> => {
  const exportedAt = new Date().toISOString()
  const snapshot = await captureWorkerSnapshot(database, store, prefix, toCsvRow)
  const tables = snapshot.tables
  const backedUp = Object.keys(tables)
  const manifest: BackupManifest = {
    schema_version: SCHEMA_VERSION,
    bundle_version: BUNDLE_VERSION,
    exported_at: exportedAt,
    tables,
    table_count: backedUp.length,
    // Carried in the manifest rather than left to a reader of the source: the
    // bundle outlives the version of ezacto that wrote it.
    restore_skips: EPHEMERAL_TABLES.filter((table) => backedUp.includes(table)),
    total_rows: snapshot.totalRows,
    files: snapshot.files,
    capture_id: snapshot.captureId,
  }

  try {
    await store.put(`${prefix}RESTORE.md`, RESTORE_MD)
    await store.put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2))
    return manifest
  } catch (error) {
    await discardWorkerSnapshot(database,snapshot.captureId)
    throw error
  }
}

export const recordBackupStart = async (
  database: D1Database,
  trigger: 'nightly' | 'manual',
  now: string,
): Promise<number> => {
  const result = await database
    .prepare(
      `INSERT INTO backup_runs (status, trigger, started_at, created_at, updated_at)
       VALUES ('running', ?, ?, ?, ?) RETURNING id`,
    )
    .bind(trigger, now, now, now)
    .first<{ id: number }>()
  return result!.id
}

export const completeBackupRun = async (
  database: D1Database,
  runId: number,
  manifest: BackupManifest,
  prefix: string,
  now: string,
): Promise<void> => {
  if (manifest.bundle_version === '0038') {
    if (!manifest.capture_id) throw new Error('Worker backup completion requires its capture receipt.')
    const results = await database.batch([
      database.prepare(`UPDATE backup_runs SET status='completed',completed_at=?,r2_prefix=?,manifest_json=?,table_count=?,total_rows=?,updated_at=? WHERE id=? AND ((status='running' AND EXISTS(SELECT 1 FROM worker_backup_snapshots WHERE id=? AND prefix=? AND state='ready')) OR (status='completed' AND r2_prefix=? AND manifest_json=?))`)
        .bind(now,prefix,JSON.stringify(manifest),manifest.table_count,manifest.total_rows,now,runId,manifest.capture_id,prefix,prefix,JSON.stringify(manifest)),
      database.prepare(`UPDATE worker_backup_snapshots SET state='completed' WHERE id=? AND EXISTS(SELECT 1 FROM backup_runs WHERE id=? AND status='completed' AND manifest_json=?)`).bind(manifest.capture_id,runId,JSON.stringify(manifest)),
      database.prepare(`DELETE FROM worker_backup_snapshots WHERE id=? AND state='completed'`).bind(manifest.capture_id),
    ])
    if (!results[0]?.meta.changes) throw new Error('Worker backup was invalidated before completion.')
    return
  }
  await database.prepare(`UPDATE backup_runs SET status='completed',completed_at=?,r2_prefix=?,manifest_json=?,table_count=?,total_rows=?,updated_at=? WHERE id=?`)
    .bind(now,prefix,JSON.stringify(manifest),manifest.table_count,manifest.total_rows,now,runId).run()
}

export const failBackupRun = async (
  database: D1Database,
  runId: number,
  error: string,
  now: string,
): Promise<void> => {
  await database
    .prepare(
      `UPDATE backup_runs SET status = 'failed', completed_at = ?,
       error_message = ?, updated_at = ? WHERE id = ? AND status <> 'completed'`,
    )
    .bind(now, error, now, runId)
    .run()
}

export const getLatestBackupRuns = async (
  database: D1Database,
  limit: number,
): Promise<BackupRunRecord[]> => {
  const { results } = await database
    .prepare(
      `SELECT id, status, trigger, started_at, completed_at, r2_prefix,
       manifest_json, table_count, total_rows, error_message, created_at, updated_at
       FROM backup_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BackupRunRecord>()
  return results
}

export interface BackupRunFilter {
  status?: BackupRunRecord['status']
  trigger?: BackupRunRecord['trigger']
}

export interface BackupRunPageWindow extends BackupRunFilter {
  /** Where the previous page ended, newest first; null on the first page. */
  after: { startedAt: string; id: number } | null
  /** Runs started later than this are left out, so a traversal holds still. */
  startedThrough: string
  take: number
}

const backupRunFilter = (
  filter: BackupRunFilter,
): { conditions: string[]; bindings: unknown[] } => {
  const conditions: string[] = []
  const bindings: unknown[] = []
  if (filter.status !== undefined) {
    conditions.push('status = ?')
    bindings.push(filter.status)
  }
  if (filter.trigger !== undefined) {
    conditions.push('trigger = ?')
    bindings.push(filter.trigger)
  }
  return { conditions, bindings }
}

/** The latest start in the whole history, or null when nothing has run. */
export const getBackupRunsSnapshot = async (database: D1Database): Promise<string | null> => {
  const row = await database
    .prepare('SELECT max(started_at) AS latest FROM backup_runs')
    .first<{ latest: string | null }>()
  return row?.latest ?? null
}

/** Backup runs, newest first, a keyset page at a time (issue 929). */
export const pageBackupRuns = async (
  database: D1Database,
  window: BackupRunPageWindow,
): Promise<BackupRunRecord[]> => {
  const { conditions, bindings } = backupRunFilter(window)
  conditions.push('started_at <= ?')
  bindings.push(window.startedThrough)
  if (window.after !== null) {
    conditions.push('(started_at < ? OR (started_at = ? AND id < ?))')
    bindings.push(window.after.startedAt, window.after.startedAt, window.after.id)
  }
  const { results } = await database
    .prepare(
      `SELECT id, status, trigger, started_at, completed_at, r2_prefix,
       manifest_json, table_count, total_rows, error_message, created_at, updated_at
       FROM backup_runs WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .bind(...bindings, window.take)
    .all<BackupRunRecord>()
  return results
}

export const countBackupRuns = async (
  database: D1Database,
  filter: BackupRunFilter,
): Promise<number> => {
  const { conditions, bindings } = backupRunFilter(filter)
  const row = await database
    .prepare(
      `SELECT count(*) AS total FROM backup_runs
       ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}`,
    )
    .bind(...bindings)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/**
 * Returns true when no nightly backup has started today (UTC date boundary).
 * The scheduled handler calls this every minute but only proceeds when due.
 */
export const shouldRunNightlyBackup = async (database: D1Database, now: Date): Promise<boolean> => {
  const todayStart = now.toISOString().slice(0, 10) + 'T00:00:00.000Z'
  const { results } = await database
    .prepare(
      `SELECT 1 AS found FROM backup_runs
       WHERE trigger = 'nightly' AND started_at >= ?
       LIMIT 1`,
    )
    .bind(todayStart)
    .all<{ found: number }>()
  return results.length === 0
}

export {
  EPHEMERAL_TABLES,
  backupTables,
  SCHEMA_VERSION,
  BUNDLE_VERSION,
  escapeCsvField,
  toCsvRow,
  sha256Hex,
}
