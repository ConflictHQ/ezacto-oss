import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCutoverMigrationLedger, assertUpgradeMigrationLedger, migrateContainer, migrateD1, migrationIds, type MigrationLedgerRow } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'

interface TestDatabase {
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrate(): Promise<void>
  close(): Promise<void>
}

const now = '2026-08-27T00:00:00.000Z'

// Spelled out rather than imported from the runner: the recipe is what every
// database carries forward, so a change to it silently invalidates every
// checksum already recorded. Sharing the helper would let that change pass.
const checksum = (statements: readonly string[]): string =>
  createHash('sha256').update(statements.join('\u0000')).digest('hex')

// The text of 0002 before `seconds` became signed (#279/#336). A database that
// applied it weeks ago still holds that CHECK, and this is the checksum it
// would have recorded had the column existed then.
const preAmendment0002 = projectsTimeMigration.map((statement) =>
  statement.replace('abs(seconds) <=', 'seconds BETWEEN 0 AND'),
)

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  return {
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrate: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  return {
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrate: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

for (const [runtime, factory] of factories) {
  describe(`migration ledger checksums (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[security #468] requires exact source ids and checksums before cutover', async () => {
      const db = await factory()
      database = db
      await db.migrate()
      const rows = await db.rows<MigrationLedgerRow>('SELECT id, statements_sha256 FROM _ezacto_migrations ORDER BY id')
      expect(() => assertCutoverMigrationLedger(rows)).not.toThrow()
      expect(() => assertCutoverMigrationLedger(rows.slice(0, -6))).toThrow(`missing=${migrationIds.slice(-6).join(',')}`)
      // A same-count ledger with the wrong id cannot satisfy set equality.
      expect(() => assertCutoverMigrationLedger([...rows.slice(0, -1), { ...rows.at(-1)!, id: '9999_unknown' }])).toThrow(/unexpected=9999_unknown/)
      expect(() => assertCutoverMigrationLedger([...rows, rows[0]!])).toThrow(/duplicates=0000_org_people/)
      expect(() => assertCutoverMigrationLedger(rows.map((row, i) => i === 0 ? { ...row, statements_sha256: null } : row))).toThrow(/unverifiable=0000_org_people/)
      expect(() => assertCutoverMigrationLedger(rows.map((row, i) => i === 0 ? { ...row, statements_sha256: '0'.repeat(64) } : row))).toThrow(/changed=0000_org_people/)
      // Readiness on an admitted artifact applies no additional migrations.
      const before = await db.rows('SELECT * FROM _ezacto_migrations ORDER BY id')
      await db.migrate()
      expect(await db.rows('SELECT * FROM _ezacto_migrations ORDER BY id')).toEqual(before)
    })

    it('[unit] an ordinary deploy permits pending migrations and refuses everything else', async () => {
      // The cutover assertion says in its own comment that cutover is stricter
      // than an upgrade, but there was only one function and the deploy
      // workflow ran it on every release. So a build carrying a new migration
      // could not ship: the database it deploys over cannot have applied a
      // migration that has not shipped yet. The first migration written after
      // the cutover deadlocked the pipeline, which is what this separates.
      const db = await factory()
      database = db
      await db.migrate()
      const rows = await db.rows<MigrationLedgerRow>('SELECT id, statements_sha256 FROM _ezacto_migrations ORDER BY id')

      // Nothing pending: a redeploy of the same build.
      expect(assertUpgradeMigrationLedger(rows)).toEqual([])

      // The build is ahead. Permitted, and it names what the Worker will apply
      // rather than counting it -- an operator reading a failed release later
      // needs the ids.
      const behind = rows.slice(0, -6)
      expect(assertUpgradeMigrationLedger(behind)).toEqual(migrationIds.slice(-6))

      // Everything the cutover refuses for a reason that is still a reason.
      expect(() => assertUpgradeMigrationLedger([...rows.slice(0, -1), { ...rows.at(-1)!, id: '9999_unknown' }])).toThrow(/unexpected=9999_unknown/)
      expect(() => assertUpgradeMigrationLedger([...rows, rows[0]!])).toThrow(/duplicates=0000_org_people/)
      expect(() => assertUpgradeMigrationLedger(rows.map((row, i) => i === 0 ? { ...row, statements_sha256: null } : row))).toThrow(/unverifiable=0000_org_people/)
      expect(() => assertUpgradeMigrationLedger(rows.map((row, i) => i === 0 ? { ...row, statements_sha256: '0'.repeat(64) } : row))).toThrow(/changed=0000_org_people/)

      // And the strict one is unchanged: the cutover still allows no pending.
      expect(() => assertCutoverMigrationLedger(behind)).toThrow(`missing=${migrationIds.slice(-6).join(',')}`)
    })

    it('[unit] records the statements it applied for every migration', async () => {
      const db = await factory()
      database = db
      await db.migrate()

      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE statements_sha256 IS NULL`,
        ),
      ).toEqual([])
      expect(
        await db.rows<{ statements_sha256: string }>(
          `SELECT statements_sha256 FROM _ezacto_migrations WHERE id = '0002_projects_time'`,
        ),
      ).toEqual([{ statements_sha256: checksum(projectsTimeMigration) }])
      await db.migrate()
    })

    it('[unit] refuses to run against a database that applied different statements', async () => {
      const db = await factory()
      database = db
      await db.migrate()
      expect(preAmendment0002).not.toEqual([...projectsTimeMigration])
      await db.run(
        `UPDATE _ezacto_migrations SET statements_sha256 = ? WHERE id = '0002_projects_time'`,
        checksum(preAmendment0002),
      )

      await expect(db.migrate()).rejects.toThrow(
        /migration ledger diverged from this build: migration_ids=0002_projects_time\b/u,
      )
      await expect(db.migrate()).rejects.toThrow(/Rebuild this database from empty/u)
    })

    it('[unit] leaves a row applied before the column unverifiable rather than backfilling it', async () => {
      const db = await factory()
      database = db
      await db.run(
        `CREATE TABLE _ezacto_migrations (
          id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
        ) STRICT`,
      )
      for (const statement of orgPeopleMigration) await db.run(statement)
      await db.run(
        `INSERT INTO _ezacto_migrations (id, applied_at) VALUES ('0000_org_people', ?)`,
        now,
      )

      await db.migrate()
      await db.migrate()

      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE statements_sha256 IS NULL ORDER BY id`,
        ),
      ).toEqual([{ id: '0000_org_people' }])
      expect(
        await db.rows<{ statements_sha256: string }>(
          `SELECT statements_sha256 FROM _ezacto_migrations WHERE id = '0001_clients'`,
        ),
      ).not.toEqual([{ statements_sha256: null }])
    })
  })
}
