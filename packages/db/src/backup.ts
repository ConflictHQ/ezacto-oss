/**
 * D18 L1: nightly logical export. Produces the D18 bundle format as a set of
 * objects under an R2 prefix. The same format is consumed by `ez backup` (CLI)
 * and surfaced in the settings backup-status widget (A-4).
 */

const SCHEMA_VERSION = 1
const BUNDLE_VERSION = '0031'

const BACKUP_TABLES = [
  'organizations',
  'users',
  'user_emails',
  'user_roles',
  'user_departments',
  'departments',
  'roles',
  'clients',
  'contacts',
  'projects',
  'project_tags',
  'project_tag_assignments',
  'project_milestones',
  'tasks',
  'task_assignments',
  'user_assignments',
  'teammate_assignments',
  'user_billable_rates',
  'user_cost_rates',
  'time_entries',
  'expenses',
  'expense_categories',
  'invoices',
  'invoice_line_items',
  'invoice_item_categories',
  'invoice_messages',
  'invoice_payments',
  'invoice_number_sequence',
  'invoice_command_ledger',
  'estimates',
  'estimate_line_items',
  'estimate_item_categories',
  'estimate_messages',
  'estimate_command_ledger',
  'recurring_invoices',
  'retainers',
  'retainer_ledger',
  'bank_deposits',
  'payment_provider_accounts',
  'attachments',
  'file_objects',
  'resource_create_commands',
  'timesheet_submissions',
  'timesheet_bulk_approval_commands',
  'timesheet_bulk_approval_command_items',
  'timesheet_lock_windows',
  'email_log',
  'event_outbox',
  'backup_runs',
  'sso_provisioning_domains',
] as const

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

\`\`\`
ez restore --from <path-to-this-directory>
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

  for (const table of BACKUP_TABLES) {
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
    table_count: BACKUP_TABLES.length,
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

export { BACKUP_TABLES, SCHEMA_VERSION, BUNDLE_VERSION, escapeCsvField, toCsvRow, sha256Hex }
