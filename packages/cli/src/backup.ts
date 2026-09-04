import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

export const BACKUP_FORMAT_VERSION = 1 as const

export interface ManifestTable {
  name: string
  row_count: number
  csv_sha256: string
  columns: string[]
}

export interface ManifestFile {
  path: string
  sha256: string
  byte_size: number
}

export interface BackupManifest {
  format_version: typeof BACKUP_FORMAT_VERSION
  created_at: string
  database_sha256: string
  tables: ManifestTable[]
  attachments: ManifestFile[]
}

const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')

const sha256File = async (path: string): Promise<string> =>
  sha256(await readFile(path))

/**
 * Query SQLite for all user tables (excluding internal migration ledger and
 * sqlite internals). Returns sorted table names.
 */
const listUserTables = (database: BetterSqlite3.Database): string[] => {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_ezacto_%'
         AND name NOT LIKE 'd1_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

/**
 * Return column names for a table in schema order.
 */
const tableColumns = (
  database: BetterSqlite3.Database,
  table: string,
): string[] => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string
  }>
  return rows.map((row) => row.name)
}

/**
 * Escape a CSV field per RFC 4180: wrap in double quotes if the value contains
 * a comma, double quote, or newline; double each internal quote.
 */
const csvEscape = (value: string): string => {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/**
 * Export a single table to CSV. Returns the number of rows written.
 */
const exportTableCsv = (
  database: BetterSqlite3.Database,
  table: string,
  columns: string[],
): { rowCount: number; content: string } => {
  const header = columns.map(csvEscape).join(',')
  const rows = database
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
    .all() as Array<Record<string, unknown>>
  const lines = [header]
  for (const row of rows) {
    const fields = columns.map((column) => {
      const value = row[column]
      if (value === null || value === undefined) return ''
      return csvEscape(String(value))
    })
    lines.push(fields.join(','))
  }
  const content = `${lines.join('\n')}\n`
  return { rowCount: rows.length, content }
}

const RESTORE_MD = `# Restoring this ezacto backup

This bundle was created by \`ez backup\` and contains a full export of the
ezacto database. It can be read without any ezacto software.

## Contents

- **db.sqlite** — A full SQLite database copy. Open with any \`sqlite3\` client.
- **tables/*.csv** — One CSV per table with column headers (RFC 4180).
- **attachments/** — Binary attachment files keyed by content hash.
- **manifest.json** — SHA-256 checksums and row counts for every file.

## How to verify integrity

\`\`\`bash
# Verify the database checksum
sha256sum db.sqlite
# Compare with the database_sha256 field in manifest.json

# Verify individual CSV checksums
sha256sum tables/*.csv
# Compare with each table's csv_sha256 in manifest.json
\`\`\`

## How to restore into a fresh ezacto instance

1. Stop the running ezacto container.
2. Copy \`db.sqlite\` to the data directory (default: \`/data/db.sqlite\`).
3. Copy the \`attachments/\` directory contents to the data directory
   (default: \`/data/attachments/\`).
4. Start the container. Migrations will run automatically if needed.

Alternatively, use \`ez restore <bundle-path> --database <target.sqlite>\`.

## How to read without ezacto

The CSV files can be opened in any spreadsheet application or processed with
standard Unix tools. Each file is named after its database table and includes
column headers as the first row.

\`\`\`bash
# List tables and row counts
jq '.tables[] | {name, row_count}' manifest.json

# Query the database directly
sqlite3 db.sqlite "SELECT * FROM users LIMIT 10"

# View CSV headers
head -1 tables/users.csv
\`\`\`
`

/**
 * Recursively collect all files under a directory, returning paths relative
 * to the base.
 */
const collectFiles = async (
  directory: string,
  base: string,
): Promise<string[]> => {
  const results: string[] = []
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results
    throw error
  }
  for (const name of names) {
    const full = join(directory, name)
    const fileStat = await stat(full)
    if (fileStat.isDirectory()) {
      results.push(...(await collectFiles(full, base)))
    } else if (fileStat.isFile()) {
      results.push(relative(base, full))
    }
  }
  return results.sort()
}

export interface BackupOptions {
  databasePath: string
  attachmentDirectory?: string | undefined
  outputDirectory: string
  now?: Date | undefined
}

export interface BackupResult {
  manifestPath: string
  manifest: BackupManifest
  bundleDirectory: string
}

/**
 * Create a full backup bundle. The bundle contains:
 * - db.sqlite (raw database copy)
 * - tables/*.csv (one CSV per table with headers)
 * - attachments/ (binary files)
 * - manifest.json (checksums and row counts)
 * - RESTORE.md (human-readable instructions)
 */
export const createBackup = async (
  options: BackupOptions,
): Promise<BackupResult> => {
  const now = options.now ?? new Date()
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '')
  const bundleName = `ezacto-backup-${timestamp}`
  const bundleDirectory = join(options.outputDirectory, bundleName)

  await mkdir(bundleDirectory, { recursive: true })
  await mkdir(join(bundleDirectory, 'tables'), { recursive: true })
  await mkdir(join(bundleDirectory, 'attachments'), { recursive: true })

  // 1. Copy the database file
  const dbTarget = join(bundleDirectory, 'db.sqlite')
  // Use VACUUM INTO for a consistent snapshot if available, fall back to file copy
  const sourceDb = new BetterSqlite3(options.databasePath, { readonly: true })
  try {
    sourceDb.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`)
  } finally {
    sourceDb.close()
  }
  const databaseSha256 = await sha256File(dbTarget)

  // 2. Export each table to CSV
  const exportDb = new BetterSqlite3(dbTarget, { readonly: true })
  const tables: ManifestTable[] = []
  try {
    const tableNames = listUserTables(exportDb)
    for (const name of tableNames) {
      const columns = tableColumns(exportDb, name)
      const csvPath = join(bundleDirectory, 'tables', `${name}.csv`)
      const { rowCount, content } = exportTableCsv(exportDb, name, columns)
      await writeFile(csvPath, content, 'utf8')
      tables.push({
        name,
        row_count: rowCount,
        csv_sha256: sha256(content),
        columns,
      })
    }
  } finally {
    exportDb.close()
  }

  // 3. Copy attachments
  const attachmentFiles: ManifestFile[] = []
  if (options.attachmentDirectory !== undefined) {
    const sourceFiles = await collectFiles(
      options.attachmentDirectory,
      options.attachmentDirectory,
    )
    for (const relativePath of sourceFiles) {
      const sourcePath = join(options.attachmentDirectory, relativePath)
      const targetPath = join(bundleDirectory, 'attachments', relativePath)
      const targetDirectory = join(bundleDirectory, 'attachments', relativePath, '..')
      await mkdir(targetDirectory, { recursive: true })
      await copyFile(sourcePath, targetPath)
      const fileStat = await stat(targetPath)
      attachmentFiles.push({
        path: `attachments/${relativePath}`,
        sha256: await sha256File(targetPath),
        byte_size: fileStat.size,
      })
    }
  }

  // 4. Build and write manifest
  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    created_at: now.toISOString(),
    database_sha256: databaseSha256,
    tables,
    attachments: attachmentFiles,
  }
  const manifestPath = join(bundleDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 5. Write RESTORE.md
  await writeFile(join(bundleDirectory, 'RESTORE.md'), RESTORE_MD, 'utf8')

  return { manifestPath, manifest, bundleDirectory }
}

export interface RestoreOptions {
  bundleDirectory: string
  targetDatabasePath: string
  targetAttachmentDirectory?: string | undefined
}

export interface RestoreResult {
  tablesRestored: number
  totalRows: number
  attachmentsRestored: number
}

/**
 * Restore from a backup bundle into a target database path.
 * The target must not already exist (fresh instance requirement).
 */
export const restoreBackup = async (
  options: RestoreOptions,
): Promise<RestoreResult> => {
  // Verify the bundle has a manifest
  const manifestPath = join(options.bundleDirectory, 'manifest.json')
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as BackupManifest
  if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `unsupported backup format version: ${String(manifest.format_version)}`,
    )
  }

  // Verify the target does not exist
  try {
    await stat(options.targetDatabasePath)
    throw new Error(
      `target database already exists: ${options.targetDatabasePath}; restore requires a fresh path`,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Verify database checksum before restoring
  const sourceDatabasePath = join(options.bundleDirectory, 'db.sqlite')
  const actualSha256 = await sha256File(sourceDatabasePath)
  if (actualSha256 !== manifest.database_sha256) {
    throw new Error(
      `database checksum mismatch: expected ${manifest.database_sha256}, got ${actualSha256}`,
    )
  }

  // Copy database
  const targetDirectory = join(options.targetDatabasePath, '..')
  await mkdir(targetDirectory, { recursive: true })
  await copyFile(sourceDatabasePath, options.targetDatabasePath)

  // Verify restored database integrity
  const database = new BetterSqlite3(options.targetDatabasePath)
  let totalRows = 0
  try {
    database.pragma('foreign_keys = ON')
    const integrityCheck = database.pragma('integrity_check') as Array<{
      integrity_check: string
    }>
    if (integrityCheck.length !== 1 || integrityCheck[0]!.integrity_check !== 'ok') {
      throw new Error('restored database failed integrity check')
    }

    // Verify row counts match manifest
    for (const table of manifest.tables) {
      const result = database
        .prepare(`SELECT count(*) AS count FROM "${table.name}"`)
        .get() as { count: number }
      if (result.count !== table.row_count) {
        throw new Error(
          `row count mismatch for ${table.name}: manifest says ${table.row_count}, database has ${result.count}`,
        )
      }
      totalRows += result.count
    }
  } finally {
    database.close()
  }

  // Copy attachments
  let attachmentsRestored = 0
  if (options.targetAttachmentDirectory !== undefined) {
    await mkdir(options.targetAttachmentDirectory, { recursive: true })
    for (const attachment of manifest.attachments) {
      const sourceAttachmentPath = join(options.bundleDirectory, attachment.path)
      // Strip the "attachments/" prefix to get the relative path within
      const relativePath = attachment.path.replace(/^attachments\//, '')
      const targetAttachmentPath = join(
        options.targetAttachmentDirectory,
        relativePath,
      )
      const targetAttachmentDirectory = join(targetAttachmentPath, '..')
      await mkdir(targetAttachmentDirectory, { recursive: true })
      await copyFile(sourceAttachmentPath, targetAttachmentPath)
      attachmentsRestored++
    }
  }

  return {
    tablesRestored: manifest.tables.length,
    totalRows,
    attachmentsRestored,
  }
}

export interface VerifyResult {
  valid: boolean
  errors: string[]
  databaseChecksumValid: boolean
  tableChecksums: Array<{
    name: string
    valid: boolean
    rowCountValid: boolean
    columnsValid: boolean
  }>
  attachmentChecksums: Array<{ path: string; valid: boolean }>
}

/**
 * Verify a backup bundle. Checks:
 * - manifest.json is parseable with known format version
 * - db.sqlite checksum matches manifest
 * - Each CSV checksum matches manifest
 * - CSV headers match manifest columns
 * - Row counts in CSV match manifest
 * - Attachment checksums match manifest
 */
export const verifyBackup = async (
  bundleDirectory: string,
): Promise<VerifyResult> => {
  const errors: string[] = []
  const tableChecksums: VerifyResult['tableChecksums'] = []
  const attachmentChecksums: VerifyResult['attachmentChecksums'] = []
  let databaseChecksumValid = false

  // Parse manifest
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(
      await readFile(join(bundleDirectory, 'manifest.json'), 'utf8'),
    ) as BackupManifest
    if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
      errors.push(
        `unsupported format version: ${String(manifest.format_version)}`,
      )
      return {
        valid: false,
        errors,
        databaseChecksumValid,
        tableChecksums,
        attachmentChecksums,
      }
    }
  } catch (error) {
    errors.push(
      `cannot read manifest: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {
      valid: false,
      errors,
      databaseChecksumValid,
      tableChecksums,
      attachmentChecksums,
    }
  }

  // Verify database checksum
  try {
    const dbPath = join(bundleDirectory, 'db.sqlite')
    const actualSha256 = await sha256File(dbPath)
    databaseChecksumValid = actualSha256 === manifest.database_sha256
    if (!databaseChecksumValid) {
      errors.push(
        `database checksum mismatch: expected ${manifest.database_sha256}, got ${actualSha256}`,
      )
    }
  } catch (error) {
    errors.push(
      `cannot read db.sqlite: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Verify each CSV
  for (const table of manifest.tables) {
    const csvPath = join(bundleDirectory, 'tables', `${table.name}.csv`)
    let checksumValid = false
    let rowCountValid = false
    let columnsValid = false
    try {
      const content = await readFile(csvPath, 'utf8')
      const actualChecksum = sha256(content)
      checksumValid = actualChecksum === table.csv_sha256
      if (!checksumValid) {
        errors.push(
          `CSV checksum mismatch for ${table.name}: expected ${table.csv_sha256}, got ${actualChecksum}`,
        )
      }

      // Verify headers match columns
      const firstLine = content.split('\n')[0]
      if (firstLine !== undefined) {
        const headers = parseCsvHeader(firstLine)
        columnsValid =
          headers.length === table.columns.length &&
          headers.every((header, index) => header === table.columns[index])
        if (!columnsValid) {
          errors.push(
            `CSV column mismatch for ${table.name}: expected [${table.columns.join(',')}], got [${headers.join(',')}]`,
          )
        }
      }

      // Verify row count (subtract header line and trailing newline)
      const lines = content.trimEnd().split('\n')
      const csvRowCount = lines.length - 1 // minus header
      rowCountValid = csvRowCount === table.row_count
      if (!rowCountValid) {
        errors.push(
          `CSV row count mismatch for ${table.name}: manifest says ${table.row_count}, CSV has ${csvRowCount}`,
        )
      }
    } catch (error) {
      errors.push(
        `cannot read ${table.name}.csv: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    tableChecksums.push({
      name: table.name,
      valid: checksumValid,
      rowCountValid,
      columnsValid,
    })
  }

  // Verify attachment checksums
  for (const attachment of manifest.attachments) {
    const attachmentPath = join(bundleDirectory, attachment.path)
    let valid = false
    try {
      const actualChecksum = await sha256File(attachmentPath)
      valid = actualChecksum === attachment.sha256
      if (!valid) {
        errors.push(
          `attachment checksum mismatch for ${attachment.path}: expected ${attachment.sha256}, got ${actualChecksum}`,
        )
      }
    } catch (error) {
      errors.push(
        `cannot read ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    attachmentChecksums.push({ path: attachment.path, valid })
  }

  return {
    valid: errors.length === 0,
    errors,
    databaseChecksumValid,
    tableChecksums,
    attachmentChecksums,
  }
}

/**
 * Parse a CSV header line, handling quoted fields.
 */
const parseCsvHeader = (line: string): string[] => {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const character = line[i]!
    if (inQuotes) {
      if (character === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += character
      }
    } else {
      if (character === '"') {
        inQuotes = true
      } else if (character === ',') {
        fields.push(current)
        current = ''
      } else {
        current += character
      }
    }
  }
  fields.push(current)
  return fields
}
