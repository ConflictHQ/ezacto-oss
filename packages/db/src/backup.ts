/**
 * D18 L1: nightly logical export. Produces the D18 bundle format as a set of
 * objects under an R2 prefix. The same format is consumed by `ez backup` (CLI)
 * and surfaced in the settings backup-status widget (A-4).
 */

const SCHEMA_VERSION = 1
const BUNDLE_VERSION = '0036'

/**
 * Tables the bundle deliberately leaves out, and the only reason it leaves
 * anything out.
 *
 * Everything else is discovered from the database itself. A hand-written list
 * of tables to *include* is a list that silently falls behind the schema, and
 * it did: the deployed export carried 51 tables, this file said 57, and the
 * database had 127. Nobody noticed, because a backup that omits a table looks
 * exactly like a backup that does not.
 *
 * So the question this constant answers is the narrow one -- what is worthless
 * or harmful to restore -- and a new table is backed up by default. Getting
 * that wrong costs a few kilobytes; getting the old question wrong cost six
 * tables of real data, including the row naming the organization's owner.
 */
const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  // Re-applied from source on first boot. Restoring it would tell a fresh
  // database it had already run migrations it has not run.
  '_ezacto_migrations',
  // Live credentials, bound to a browser or a redirect that no longer exists.
  // Restoring them signs nobody in; it only carries bearer material forward.
  'sessions',
  'contact_sessions',
  'auth_tokens',
  'auth_first_run',
  'auth_rate_limits',
  'magic_link_tokens',
  'staff_magic_links',
  'two_factor_challenges',
  'oidc_app_codes',
  'oidc_transactions',
  'quickbooks_oauth_states',
])

/**
 * Every table the database has, minus the exclusions, in a stable order.
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
  return results
    .map((row) => row.name)
    .filter((name) => !EXCLUDED_TABLES.has(name))
}

export interface BackupObjectStore {
  put(key: string, body: string): Promise<void>
}

export interface BackupManifest {
  schema_version: number
  bundle_version: string
  exported_at: string
  tables: Record<string, { row_count: number; sha256: string }>
  table_count: number
  total_rows: number
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

This backup was produced by ezacto's nightly export (D18 L1). Each table is
a CSV file with a header row. You can open these in any spreadsheet, import
them into any database, or use the ezacto CLI to restore.

## Handle this like the database itself

The bundle carries everything a working instance needs, and that includes the
credential material: password hashes, authenticator seeds, recovery-code hashes
and API-token hashes. It has to — an instance whose people cannot sign in has
not been restored — but it means these files are exactly as sensitive as the
database they came from, and more portable. Store them accordingly.

Live sessions, sign-in links and OAuth transactions are deliberately *not*
here. They would sign nobody in and only carry bearer material forward.

## Files

- \`tables/<name>.csv\` — one file per table, UTF-8, RFC 4180 CSV.
- \`manifest.json\` — metadata: schema version, export timestamp, row counts,
  and SHA-256 checksums for every file.
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
ez restore <path-to-this-directory> --database <target.sqlite>
\`\`\`

## Restore without ezacto

Import the CSVs into any SQLite database. The column names in each CSV match
the schema exactly. Refer to the ezacto source for the CREATE TABLE DDL.
`

export const exportBundle = async (
  database: D1Database,
  store: BackupObjectStore,
  prefix: string,
): Promise<BackupManifest> => {
  const exportedAt = new Date().toISOString()
  const tables: BackupManifest['tables'] = {}
  let totalRows = 0

  const backedUp = await backupTables(database)
  for (const table of backedUp) {
    const { results } = await database
      .prepare(`SELECT * FROM ${table}`)
      .all<Record<string, unknown>>()

    const columns = results.length > 0 ? Object.keys(results[0]!) : []
    const lines = [toCsvRow(columns)]
    for (const row of results) {
      lines.push(toCsvRow(columns.map((col) => row[col])))
    }
    const csv = lines.join('\n') + '\n'
    const hash = await sha256Hex(csv)

    await store.put(`${prefix}tables/${table}.csv`, csv)
    tables[table] = { row_count: results.length, sha256: hash }
    totalRows += results.length
  }

  const manifest: BackupManifest = {
    schema_version: SCHEMA_VERSION,
    bundle_version: BUNDLE_VERSION,
    exported_at: exportedAt,
    tables,
    table_count: backedUp.length,
    total_rows: totalRows,
  }

  await store.put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2))
  await store.put(`${prefix}RESTORE.md`, RESTORE_MD)

  return manifest
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
  await database
    .prepare(
      `UPDATE backup_runs SET status = 'completed', completed_at = ?,
       r2_prefix = ?, manifest_json = ?, table_count = ?, total_rows = ?,
       updated_at = ? WHERE id = ?`,
    )
    .bind(
      now,
      prefix,
      JSON.stringify(manifest),
      manifest.table_count,
      manifest.total_rows,
      now,
      runId,
    )
    .run()
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
       error_message = ?, updated_at = ? WHERE id = ?`,
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

/**
 * Returns true when no nightly backup has started today (UTC date boundary).
 * The scheduled handler calls this every minute but only proceeds when due.
 */
export const shouldRunNightlyBackup = async (
  database: D1Database,
  now: Date,
): Promise<boolean> => {
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
  EXCLUDED_TABLES,
  backupTables,
  SCHEMA_VERSION,
  BUNDLE_VERSION,
  escapeCsvField,
  toCsvRow,
  sha256Hex,
}
