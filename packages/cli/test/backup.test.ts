import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBackup,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
} from '../src/backup.js'

/**
 * Create a realistic test schema and seed data directly via SQL. This avoids
 * depending on the full migration stack which requires native modules and
 * specific Node versions.
 */
const createTestDatabase = (databasePath: string): void => {
  const now = '2026-08-30T12:00:00.000Z'
  const database = new BetterSqlite3(databasePath)
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE time_entries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      spent_date TEXT NOT NULL,
      seconds INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO organizations (id, name, created_at, updated_at)
    VALUES (1, 'Test Org', '${now}', '${now}');

    INSERT INTO users (id, first_name, last_name, email, created_at, updated_at)
    VALUES (1, 'Alice', 'Tester', 'alice@example.test', '${now}', '${now}');

    INSERT INTO clients (id, name, created_at, updated_at)
    VALUES (1, 'ACME Corp', '${now}', '${now}');

    INSERT INTO projects (id, client_id, name, created_at, updated_at)
    VALUES (1, 1, 'Alpha', '${now}', '${now}');

    INSERT INTO tasks (id, name, created_at, updated_at)
    VALUES (1, 'Development', '${now}', '${now}');

    INSERT INTO time_entries (id, user_id, project_id, task_id, spent_date, seconds, notes, created_at, updated_at)
    VALUES (1, 1, 1, 1, '2026-08-30', 3600, 'Built the thing', '${now}', '${now}');
  `)
  database.close()
}

describe('ez backup / restore / verify', () => {
  let directory: string
  let databasePath: string
  let attachmentDirectory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-backup-'))
    databasePath = join(directory, 'db.sqlite')
    attachmentDirectory = join(directory, 'attachments')
    await mkdir(attachmentDirectory, { recursive: true })
    createTestDatabase(databasePath)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('[unit] bundle opens without our software (sqlite3 + CSV headers verified)', async () => {
    const result = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Verify db.sqlite is a valid SQLite database that can be opened independently
    const bundleDb = new BetterSqlite3(join(result.bundleDirectory, 'db.sqlite'), {
      readonly: true,
    })
    try {
      const integrityCheck = bundleDb.pragma('integrity_check') as Array<{
        integrity_check: string
      }>
      expect(integrityCheck).toEqual([{ integrity_check: 'ok' }])

      // Verify the database has the seeded data
      const orgCount = bundleDb
        .prepare('SELECT count(*) AS count FROM organizations')
        .get() as { count: number }
      expect(orgCount.count).toBe(1)

      const userCount = bundleDb
        .prepare('SELECT count(*) AS count FROM users')
        .get() as { count: number }
      expect(userCount.count).toBe(1)
    } finally {
      bundleDb.close()
    }

    // Verify CSV files exist and have proper headers
    const manifest = result.manifest

    // organizations table
    const orgTable = manifest.tables.find((table) => table.name === 'organizations')
    expect(orgTable).toBeDefined()
    expect(orgTable!.row_count).toBe(1)
    expect(orgTable!.columns).toContain('name')
    expect(orgTable!.columns).toContain('id')

    // Read the CSV and verify the header line
    const orgCsv = await readFile(
      join(result.bundleDirectory, 'tables', 'organizations.csv'),
      'utf8',
    )
    const orgHeader = orgCsv.split('\n')[0]!
    expect(orgHeader).toContain('id')
    expect(orgHeader).toContain('name')

    // users table
    const usersTable = manifest.tables.find((table) => table.name === 'users')
    expect(usersTable).toBeDefined()
    expect(usersTable!.row_count).toBe(1)

    const usersCsv = await readFile(
      join(result.bundleDirectory, 'tables', 'users.csv'),
      'utf8',
    )
    const usersHeader = usersCsv.split('\n')[0]!
    expect(usersHeader).toContain('first_name')
    expect(usersHeader).toContain('last_name')

    // time_entries table
    const timeTable = manifest.tables.find((table) => table.name === 'time_entries')
    expect(timeTable).toBeDefined()
    expect(timeTable!.row_count).toBe(1)

    // Verify RESTORE.md exists and is human-readable
    const restoreMd = await readFile(
      join(result.bundleDirectory, 'RESTORE.md'),
      'utf8',
    )
    expect(restoreMd).toContain('sqlite3')
    expect(restoreMd).toContain('CSV')
    expect(restoreMd).toContain('sha256')

    // Verify manifest.json is valid
    const manifestJson = JSON.parse(
      await readFile(join(result.bundleDirectory, 'manifest.json'), 'utf8'),
    ) as BackupManifest
    expect(manifestJson.format_version).toBe(1)
    expect(manifestJson.database_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifestJson.tables.length).toBeGreaterThan(0)
  })

  it('[unit] manifest checksum verification passes for a valid bundle', async () => {
    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    const result = await verifyBackup(backup.bundleDirectory)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.databaseChecksumValid).toBe(true)
    expect(result.tableChecksums.every((table) => table.valid)).toBe(true)
    expect(result.tableChecksums.every((table) => table.rowCountValid)).toBe(true)
    expect(result.tableChecksums.every((table) => table.columnsValid)).toBe(true)
  })

  it('[unit] verification detects a corrupted CSV', async () => {
    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Corrupt the users CSV
    const usersCsvPath = join(backup.bundleDirectory, 'tables', 'users.csv')
    const original = await readFile(usersCsvPath, 'utf8')
    await writeFile(usersCsvPath, `${original}extra corruption data\n`, 'utf8')

    const result = await verifyBackup(backup.bundleDirectory)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('users'))).toBe(true)
  })

  it('[unit] verification detects attachment checksum mismatch', async () => {
    // Create a test attachment
    await writeFile(join(attachmentDirectory, 'test-file.bin'), 'original content', 'utf8')

    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Corrupt the attachment in the bundle
    const attachmentPath = join(backup.bundleDirectory, 'attachments', 'test-file.bin')
    await writeFile(attachmentPath, 'corrupted content', 'utf8')

    const result = await verifyBackup(backup.bundleDirectory)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('attachment'))).toBe(true)
  })

  it('[e2e:backup-restore] backup -> wipe -> restore -> invariant suite green + counts match manifest', async () => {
    // Step 1: Create backup
    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Capture manifest counts for later comparison
    const manifestCounts = new Map(
      backup.manifest.tables.map((table) => [table.name, table.row_count]),
    )

    // Step 2: Wipe the original database and attachments
    await unlink(databasePath)
    await rm(attachmentDirectory, { recursive: true, force: true })

    // Verify wipe
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })

    // Step 3: Restore into a fresh database
    const restoredDbPath = join(directory, 'restored.sqlite')
    const restoredAttachmentDir = join(directory, 'restored-attachments')
    const restoreResult = await restoreBackup({
      bundleDirectory: backup.bundleDirectory,
      targetDatabasePath: restoredDbPath,
      targetAttachmentDirectory: restoredAttachmentDir,
    })

    expect(restoreResult.tablesRestored).toBe(backup.manifest.tables.length)

    // Step 4: Verify invariant suite: database integrity, foreign keys, row counts
    const restored = new BetterSqlite3(restoredDbPath)
    try {
      restored.pragma('foreign_keys = ON')

      // Integrity check
      const integrityCheck = restored.pragma('integrity_check') as Array<{
        integrity_check: string
      }>
      expect(integrityCheck).toEqual([{ integrity_check: 'ok' }])

      // Foreign key check
      const fkCheck = restored.pragma('foreign_key_check') as unknown[]
      expect(fkCheck).toEqual([])

      // Row counts match manifest
      for (const [tableName, expectedCount] of manifestCounts) {
        const result = restored
          .prepare(`SELECT count(*) AS count FROM "${tableName}"`)
          .get() as { count: number }
        expect(result.count, `row count mismatch for ${tableName}`).toBe(expectedCount)
      }

      // Verify domain data survived the round-trip
      const org = restored
        .prepare('SELECT name FROM organizations WHERE id = 1')
        .get() as { name: string }
      expect(org.name).toBe('Test Org')

      const user = restored
        .prepare('SELECT first_name, last_name FROM users WHERE id = 1')
        .get() as { first_name: string; last_name: string }
      expect(user.first_name).toBe('Alice')
      expect(user.last_name).toBe('Tester')

      const timeEntry = restored
        .prepare('SELECT seconds, spent_date FROM time_entries WHERE id = 1')
        .get() as { seconds: number; spent_date: string }
      expect(timeEntry.seconds).toBe(3600)
      expect(timeEntry.spent_date).toBe('2026-08-30')
    } finally {
      restored.close()
    }

    // Step 5: Verify the backup bundle itself
    const verifyResult = await verifyBackup(backup.bundleDirectory)
    expect(verifyResult.valid).toBe(true)
    expect(verifyResult.errors).toEqual([])
  })

  it('[e2e:backup-restore] runs the ez restore command both RESTORE.md files print', async () => {
    // RESTORE.md ships inside every bundle and is the only instruction a
    // self-hoster has. Asserting it exists and reads well -- which the bundle
    // test above does -- does not catch it naming a flag the CLI rejects.
    //
    // There are two of these documents and they had drifted apart: the one in
    // this package was right, and the one the Worker writes into R2 said
    // `ez restore --from <dir>`, which parses `--from` as the report-range flag,
    // leaves no positional argument, and exits on the usage line. Both are read
    // here so neither can drift alone (issue 99).
    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })
    const bundleDoc = await readFile(join(backup.bundleDirectory, 'RESTORE.md'), 'utf8')
    const workerDoc = await readFile(
      fileURLToPath(new URL('../../db/src/backup.ts', import.meta.url)),
      'utf8',
    )

    const documented = [...bundleDoc.matchAll(/ez restore [^`\n]+/gu)].map((m) => m[0].trim())
    const fromWorker = [...workerDoc.matchAll(/ez restore [^`\n]+/gu)].map((m) => m[0].trim())
    expect(documented.length).toBeGreaterThan(0)
    expect(fromWorker.length).toBeGreaterThan(0)

    const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
    let attempt = 0
    for (const command of [...documented, ...fromWorker]) {
      attempt += 1
      const target = join(directory, `restored-${String(attempt)}.sqlite`)
      const args = command
        .split(/\s+/u)
        .slice(1)
        .map((token) =>
          token.startsWith('<path') || token === '<bundle-path>'
            ? backup.bundleDirectory
            : token === '<target.sqlite>'
              ? target
              : token,
        )

      const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, ...args], {
          env: { ...process.env, EZACTO_CONFIG: join(directory, 'config.json') },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', reject)
        child.once('close', (code) => resolve({ code: code ?? 1, stderr }))
        child.stdin.end('')
      })

      expect(`${command} -> ${result.stderr}`).not.toContain('usage:')
      expect(`${command} -> exit ${String(result.code)}`).toContain('exit 0')

      // Exited 0 having actually written a database, rather than having done
      // nothing quietly.
      const restored = new BetterSqlite3(target, { readonly: true })
      try {
        const row = restored
          .prepare('SELECT count(*) AS n FROM organizations')
          .get() as { n: number }
        expect(row.n).toBeGreaterThan(0)
      } finally {
        restored.close()
      }
    }
  }, 60_000)

  it('[unit] restore refuses to overwrite an existing database', async () => {
    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Attempt to restore to the same path that already has a database
    await expect(
      restoreBackup({
        bundleDirectory: backup.bundleDirectory,
        targetDatabasePath: databasePath,
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('[unit] backup includes attachments in the bundle and manifest', async () => {
    // Create test attachments
    const content1 = 'attachment file one content'
    const content2 = Buffer.from([0x00, 0x01, 0x02, 0xff])
    await writeFile(join(attachmentDirectory, 'doc.txt'), content1, 'utf8')
    await mkdir(join(attachmentDirectory, 'nested'), { recursive: true })
    await writeFile(join(attachmentDirectory, 'nested', 'binary.dat'), content2)

    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    expect(backup.manifest.attachments.length).toBe(2)
    const docAttachment = backup.manifest.attachments.find((a) =>
      a.path.endsWith('doc.txt'),
    )
    expect(docAttachment).toBeDefined()
    expect(docAttachment!.byte_size).toBe(Buffer.byteLength(content1))

    const binaryAttachment = backup.manifest.attachments.find((a) =>
      a.path.endsWith('binary.dat'),
    )
    expect(binaryAttachment).toBeDefined()
    expect(binaryAttachment!.byte_size).toBe(content2.length)

    // Verify the attachments are in the bundle
    const bundledDoc = await readFile(
      join(backup.bundleDirectory, 'attachments', 'doc.txt'),
      'utf8',
    )
    expect(bundledDoc).toBe(content1)

    // Full verification passes
    const verifyResult = await verifyBackup(backup.bundleDirectory)
    expect(verifyResult.valid).toBe(true)
  })

  it('[unit] CSV escaping handles commas, quotes, and newlines', async () => {
    // Add a client with special characters in the name
    const database = new BetterSqlite3(databasePath)
    try {
      database.pragma('foreign_keys = ON')
      database.prepare(`
        INSERT INTO clients (id, name, currency, created_at, updated_at)
        VALUES (2, 'Acme, "Inc" & Sons', 'USD', '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z')
      `).run()
    } finally {
      database.close()
    }

    const backup = await createBackup({
      databasePath,
      attachmentDirectory,
      outputDirectory: directory,
      now: new Date('2026-08-30T12:00:00.000Z'),
    })

    // Read the clients CSV and verify it parses correctly
    const clientsCsv = await readFile(
      join(backup.bundleDirectory, 'tables', 'clients.csv'),
      'utf8',
    )
    // The CSV should contain the escaped name
    expect(clientsCsv).toContain('"Acme, ""Inc"" & Sons"')

    // The manifest should show the correct row count
    const clientsTable = backup.manifest.tables.find((table) => table.name === 'clients')
    expect(clientsTable).toBeDefined()
    expect(clientsTable!.row_count).toBe(2) // original + new one

    // Verification should still pass
    const verifyResult = await verifyBackup(backup.bundleDirectory)
    expect(verifyResult.valid).toBe(true)
  })
})
