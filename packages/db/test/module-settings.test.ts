import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createModuleSettingsRepository,
  type ModuleName,
} from '../src/module-settings.js'

type ModuleSettingsDatabase = Parameters<typeof createModuleSettingsRepository>[0]

interface TestDatabase {
  orm: ModuleSettingsDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
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
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<Row>()).results,
    close: async () => miniflare.dispose(),
  }
}

const seedOrganization = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (id, name, modules, created_at, updated_at)
     VALUES (1, 'Test Org', '{}', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
  )
}

const runtimes: readonly ['container', 'd1'] = ['container', 'd1']
const databaseFactory: Record<'container' | 'd1', () => Promise<TestDatabase>> = {
  container: containerDatabase,
  d1: d1Database,
}

for (const runtime of runtimes) {
  describe(`ModuleSettingsRepository [${runtime}]`, () => {
    let db: TestDatabase

    afterEach(async () => {
      if (db !== undefined) await db.close()
    })

    it('lists all known modules as disabled by default', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      const modules = await repo.list()
      expect(modules).toEqual([
        { module: 'approval', enabled: false },
        { module: 'expenses', enabled: false },
        { module: 'own_money', enabled: false },
      ])
    })

    it('gets a single module state', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      expect(await repo.get('approval')).toBe(false)
      expect(await repo.get('expenses')).toBe(false)
      expect(await repo.get('own_money')).toBe(false)
    })

    it('enables a module and returns updated list', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      const result = await repo.setEnabled('approval', true, '2024-06-01T12:00:00.000Z')
      expect(result).toEqual([
        { module: 'approval', enabled: true },
        { module: 'expenses', enabled: false },
        { module: 'own_money', enabled: false },
      ])
      expect(await repo.get('approval')).toBe(true)
    })

    it('disables a previously enabled module', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      await repo.setEnabled('approval', true, '2024-06-01T12:00:00.000Z')
      const result = await repo.setEnabled('approval', false, '2024-06-02T12:00:00.000Z')
      expect(result).toEqual([
        { module: 'approval', enabled: false },
        { module: 'expenses', enabled: false },
        { module: 'own_money', enabled: false },
      ])
      expect(await repo.get('approval')).toBe(false)
    })

    it('enables multiple modules independently', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      await repo.setEnabled('approval', true, '2024-06-01T12:00:00.000Z')
      await repo.setEnabled('expenses', true, '2024-06-02T12:00:00.000Z')
      const result = await repo.list()
      expect(result).toEqual([
        { module: 'approval', enabled: true },
        { module: 'expenses', enabled: true },
        { module: 'own_money', enabled: false },
      ])
    })

    /**
     * #520's default-off requirement, stated against a row that predates the
     * setting: an organization whose modules JSON was written before own_money
     * existed has no such key, and an instance that upgrades must not start
     * disclosing people's rates because a deploy happened. The absent key, not
     * a stored `false`, is what has to answer no.
     */
    it('leaves own_money off for an organization row written before it existed', async () => {
      db = await databaseFactory[runtime]()
      await db.run(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
         VALUES (1, 'Upgraded Org', '{"approval":true,"expenses":true}',
           '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      const repo = createModuleSettingsRepository(db.orm)
      expect(await repo.get('own_money')).toBe(false)
      expect(await repo.list()).toEqual([
        { module: 'approval', enabled: true },
        { module: 'expenses', enabled: true },
        { module: 'own_money', enabled: false },
      ])
    })

    it('updates updated_at on toggle', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)
      await repo.setEnabled('approval', true, '2024-06-15T10:30:00.000Z')
      const rows = await db.rows<{ updated_at: string }>(
        `SELECT updated_at FROM organizations WHERE id = 1`,
      )
      expect(rows[0]?.updated_at).toBe('2024-06-15T10:30:00.000Z')
    })

    it('does not rewrite organization name or other fields when toggling modules', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)

      // Enable approval
      await repo.setEnabled('approval', true, '2024-06-01T12:00:00.000Z')

      // Verify organization name is unchanged
      const rows = await db.rows<{ name: string; modules: string }>(
        `SELECT name, modules FROM organizations WHERE id = 1`,
      )
      expect(rows[0]?.name).toBe('Test Org')

      // The modules JSON should only contain the approval key
      const modules = JSON.parse(rows[0]?.modules ?? '{}') as Record<string, unknown>
      expect(modules.approval).toBe(true)

      // Disable approval
      await repo.setEnabled('approval', false, '2024-06-02T12:00:00.000Z')

      const after = await db.rows<{ name: string; modules: string }>(
        `SELECT name, modules FROM organizations WHERE id = 1`,
      )
      expect(after[0]?.name).toBe('Test Org')
      const afterModules = JSON.parse(after[0]?.modules ?? '{}') as Record<string, unknown>
      expect(afterModules.approval).toBe(false)
    })

    it('setEnabled is atomic: read-after-write returns consistent state', async () => {
      db = await databaseFactory[runtime]()
      await seedOrganization(db)
      const repo = createModuleSettingsRepository(db.orm)

      // Rapid sequential toggles should each return consistent state
      const results: (readonly { module: ModuleName; enabled: boolean }[])[] = []
      for (let index = 0; index < 5; index += 1) {
        const enabled = index % 2 === 0
        const result = await repo.setEnabled(
          'approval',
          enabled,
          `2024-06-01T12:0${index}:00.000Z`,
        )
        results.push(result)
      }

      // Each result should match the write that just happened
      for (let index = 0; index < 5; index += 1) {
        const expected = index % 2 === 0
        const approval = results[index]?.find((m) => m.module === 'approval')
        expect(approval?.enabled).toBe(expected)
      }
    })
  })
}
