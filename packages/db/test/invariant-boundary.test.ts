import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createClient, type NewClient } from '../src/operations.js'

type OrmDatabase = Parameters<typeof createClient>[0]

interface TestDatabase {
  orm: OrmDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-08-29T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['sqlite', async () => containerDatabase()],
  ['d1', d1Database],
] as const

const seedOrganization = async (
  database: TestDatabase,
  name: string,
  currency: string,
): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, currency, modules, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    name,
    currency,
    modules,
    timestamp,
    timestamp,
  )
}

const newClient = (name: string): NewClient => ({
  name,
  createdAt: timestamp,
  updatedAt: timestamp,
})

for (const [runtime, factory] of factories) {
  describe(`structural organization boundary (${runtime})`, () => {
    it('[unit] [inv-13] isolates identical keys by database and exposes no organization-id seam', async () => {
      const first = await factory()
      const second = await factory()
      try {
        await seedOrganization(first, 'Halcyon North', 'USD')
        await seedOrganization(second, 'Halcyon South', 'EUR')

        const firstClient = await createClient(first.orm, newClient('North client'))
        const secondClient = await createClient(second.orm, newClient('South client'))
        expect(firstClient).toMatchObject({ id: 1, name: 'North client', currency: 'USD' })
        expect(secondClient).toMatchObject({ id: 1, name: 'South client', currency: 'EUR' })

        await first.run(`UPDATE clients SET name = 'North only' WHERE id = 1`)
        expect(await first.rows<{ name: string }>(`SELECT name FROM clients WHERE id = 1`)).toEqual(
          [{ name: 'North only' }],
        )
        expect(
          await second.rows<{ name: string }>(`SELECT name FROM clients WHERE id = 1`),
        ).toEqual([{ name: 'South client' }])

        for (const database of [first, second]) {
          expect(
            await database.rows<{ name: string }>(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND sql IS NOT NULL
                 AND (lower(sql) LIKE '%org_id%' OR lower(sql) LIKE '%organization_id%')`,
            ),
          ).toEqual([])
        }
        expectTypeOf<NewClient>().not.toHaveProperty('orgId')
        expectTypeOf<NewClient>().not.toHaveProperty('organizationId')
      } finally {
        await Promise.all([first.close(), second.close()])
      }
    })
  })
}
