import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupTables,
  completeBackupRun,
  exportBundle,
  failBackupRun,
  getLatestBackupRuns,
  recordBackupStart,
  shouldRunNightlyBackup,
  type BackupManifest,
  type BackupObjectStore,
} from '../src/backup.js'
import { migrateD1 } from '../src/migrate.js'

interface TestContext {
  database: D1Database
  close(): Promise<void>
}

const setup = async (): Promise<TestContext> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    database,
    close: () => miniflare.dispose(),
  }
}

const timestamp = '2026-09-01T03:00:00.000Z'
const laterTimestamp = '2026-09-01T03:01:00.000Z'

describe('backup module', () => {
  const contexts: TestContext[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close()))
  })

  const withDatabase = async (): Promise<TestContext> => {
    const context = await setup()
    contexts.push(context)
    return context
  }

  /**
   * The defect this replaces. The bundle carried a hand-written list of tables
   * to include, so every migration that added a table silently narrowed the
   * backup: the deployed export held 51 tables, the source said 57, and the
   * database had 127. A backup missing a table looks exactly like a backup that
   * is not, which is why it went unnoticed.
   */
  describe('what the bundle covers', () => {
    it('[security] covers every table the database has, with nothing left out', async () => {
      const { database } = await withDatabase()
      const present = (
        await database
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
          )
          .all<{ name: string }>()
      ).results.map((row) => row.name)

      const covered = await backupTables(database)
      // Capturing is cheap and a backup is a record. Nothing is held back.
      expect([...covered].sort()).toEqual([...present].sort())
    })

    it('[unit] orders tables stably, so an unchanged database yields an unchanged manifest', async () => {
      // The manifest is checksummed and compared between runs. Order drifting
      // with SQLite's catalog would read as a change when nothing changed.
      const { database } = await withDatabase()
      const covered = await backupTables(database)
      expect([...covered]).toEqual([...covered].sort())
    })

    it('[security] keeps what a restore needs to let anyone back in', async () => {
      // An instance whose people cannot sign in has not been restored. These
      // carry credential material, which is why RESTORE.md says the bundle must
      // be handled exactly like the database it came from.
      const { database } = await withDatabase()
      const covered = await backupTables(database)
      for (const table of [
        'users',
        'user_emails',
        'user_passwords',
        'user_identities',
        'user_totp_enrolments',
        'user_recovery_codes',
        'api_tokens',
        'organization_owner',
      ]) {
        expect(covered, table).toContain(table)
      }
    })

    it('[security] captures the ephemeral tables but tells a restore to skip them', async () => {
      // Two different decisions, and conflating them was the earlier mistake.
      // Leaving sessions out of the bundle destroys the record of who held one;
      // loading them back would revive what somebody deliberately revoked.
      const { database } = await withDatabase()
      const covered = await backupTables(database)
      const objects = new Map<string, string>()
      const manifest = await exportBundle(
        database,
        { async put(key, body) { objects.set(key, body) } },
        'backups/2026-09-01/',
      )
      for (const table of ['sessions', 'auth_tokens', 'oidc_transactions', '_ezacto_migrations']) {
        expect(covered, table).toContain(table)
        expect(objects.has(`backups/2026-09-01/tables/${table}.csv`), table).toBe(true)
        expect(manifest.restore_skips, table).toContain(table)
      }
      // And the skip list never names a table the bundle does not carry.
      for (const skipped of manifest.restore_skips) expect(covered).toContain(skipped)
    }, 20000)
  })

  describe('exportBundle', () => {
    it('exports all tables as CSV with manifest and RESTORE.md', async () => {
      const { database } = await withDatabase()
      const objects = new Map<string, string>()
      const store: BackupObjectStore = {
        async put(key, body) {
          objects.set(key, body)
        },
      }

      const manifest = await exportBundle(database, store, 'backups/2026-09-01/')

      expect(manifest.schema_version).toBe(1)
      expect(manifest.bundle_version).toBe('0037')
      expect(manifest.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const expected = await backupTables(database)
      expect(manifest.table_count).toBe(expected.length)
      expect(typeof manifest.total_rows).toBe('number')

      for (const table of expected) {
        const key = `backups/2026-09-01/tables/${table}.csv`
        expect(objects.has(key)).toBe(true)
        const csv = objects.get(key)!
        expect(csv.endsWith('\n')).toBe(true)
        expect(manifest.tables[table]).toBeDefined()
        expect(manifest.tables[table]!.sha256).toMatch(/^[0-9a-f]{64}$/)
      }

      expect(objects.has('backups/2026-09-01/manifest.json')).toBe(true)
      const parsedManifest = JSON.parse(objects.get('backups/2026-09-01/manifest.json')!)
      expect(parsedManifest.schema_version).toBe(1)

      expect(objects.has('backups/2026-09-01/RESTORE.md')).toBe(true)
      expect(objects.get('backups/2026-09-01/RESTORE.md')!).toContain('Restoring from this backup')
    })

    it('produces correct row counts for populated tables', async () => {
      const { database } = await withDatabase()

      await database
        .prepare(
          `INSERT INTO organizations (id, name, modules, created_at, updated_at)
           VALUES (1, 'Test', '{}', ?, ?)`,
        )
        .bind(timestamp, timestamp)
        .run()

      const objects = new Map<string, string>()
      const store: BackupObjectStore = {
        async put(key, body) {
          objects.set(key, body)
        },
      }

      const manifest = await exportBundle(database, store, 'test/')
      expect(manifest.tables['organizations']!.row_count).toBe(1)
      expect(manifest.total_rows).toBeGreaterThanOrEqual(1)

      const csv = objects.get('test/tables/organizations.csv')!
      const lines = csv.trim().split('\n')
      expect(lines.length).toBe(2)
      expect(lines[0]).toContain('id')
      expect(lines[0]).toContain('name')
    })
  })

  describe('backup run tracking', () => {
    it('records a running backup, completes it, and reads the status', async () => {
      const { database } = await withDatabase()

      const runId = await recordBackupStart(database, 'nightly', timestamp)
      expect(runId).toBeGreaterThan(0)

      const running = await getLatestBackupRuns(database, 1)
      expect(running).toHaveLength(1)
      expect(running[0]).toMatchObject({
        id: runId,
        status: 'running',
        trigger: 'nightly',
        started_at: timestamp,
      })

      const manifest: BackupManifest = {
        schema_version: 1,
        bundle_version: '0031',
        exported_at: timestamp,
        tables: { organizations: { row_count: 1, sha256: 'a'.repeat(64) } },
        table_count: 1,
        total_rows: 1,
        restore_skips: [],
      }

      await completeBackupRun(database, runId, manifest, 'backups/2026-09-01/', laterTimestamp)

      const completed = await getLatestBackupRuns(database, 1)
      expect(completed[0]).toMatchObject({
        id: runId,
        status: 'completed',
        completed_at: laterTimestamp,
        r2_prefix: 'backups/2026-09-01/',
        table_count: 1,
        total_rows: 1,
      })
    })

    it('records a failed backup run', async () => {
      const { database } = await withDatabase()

      const runId = await recordBackupStart(database, 'nightly', timestamp)
      await failBackupRun(database, runId, 'D1 connection lost', laterTimestamp)

      const runs = await getLatestBackupRuns(database, 1)
      expect(runs[0]).toMatchObject({
        id: runId,
        status: 'failed',
        error_message: 'D1 connection lost',
        completed_at: laterTimestamp,
      })
    })

    it('returns runs in descending started_at order', async () => {
      const { database } = await withDatabase()

      const id1 = await recordBackupStart(database, 'nightly', '2026-09-01T03:00:00.000Z')
      const id2 = await recordBackupStart(database, 'nightly', '2026-09-02T03:00:00.000Z')
      await failBackupRun(database, id1, 'test', '2026-09-01T03:01:00.000Z')
      await failBackupRun(database, id2, 'test', '2026-09-02T03:01:00.000Z')

      const runs = await getLatestBackupRuns(database, 10)
      expect(runs).toHaveLength(2)
      expect(runs[0]!.id).toBe(id2)
      expect(runs[1]!.id).toBe(id1)
    })
  })

  describe('shouldRunNightlyBackup', () => {
    it('returns true when no nightly backup has started today', async () => {
      const { database } = await withDatabase()
      const now = new Date('2026-09-03T03:00:00.000Z')
      expect(await shouldRunNightlyBackup(database, now)).toBe(true)
    })

    it('returns false when a nightly backup already started today', async () => {
      const { database } = await withDatabase()
      await recordBackupStart(database, 'nightly', '2026-09-03T03:00:00.000Z')
      const now = new Date('2026-09-03T04:00:00.000Z')
      expect(await shouldRunNightlyBackup(database, now)).toBe(false)
    })

    it('returns true for a new day even after yesterday backup', async () => {
      const { database } = await withDatabase()
      const yesterday = '2026-09-02T03:00:00.000Z'
      const runId = await recordBackupStart(database, 'nightly', yesterday)
      await failBackupRun(database, runId, 'test', '2026-09-02T03:01:00.000Z')
      const now = new Date('2026-09-03T03:00:00.000Z')
      expect(await shouldRunNightlyBackup(database, now)).toBe(true)
    })
  })

  describe('bundle CSV checksums', () => {
    it('[unit] SHA-256 in manifest matches the exported CSV content', async () => {
      const { database } = await withDatabase()

      await database
        .prepare(
          `INSERT INTO organizations (id, name, modules, created_at, updated_at)
           VALUES (1, 'Checksum Org', '{}', ?, ?)`,
        )
        .bind(timestamp, timestamp)
        .run()

      const objects = new Map<string, string>()
      const store: BackupObjectStore = {
        async put(key, body) {
          objects.set(key, body)
        },
      }

      const manifest = await exportBundle(database, store, 'verify/')
      const csv = objects.get('verify/tables/organizations.csv')!
      const encoded = new TextEncoder().encode(csv)
      const hash = await crypto.subtle.digest('SHA-256', encoded)
      const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      expect(manifest.tables['organizations']!.sha256).toBe(hex)
    })
  })
})
