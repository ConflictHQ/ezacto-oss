import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { organizations } from '../src/schema.js'

interface TestDatabase {
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const now = '2026-08-27T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
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
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<T>()).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

for (const [runtime, factory] of factories) {
  describe(`organization and people schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await database.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        'Halcyon Studio',
        modules,
        now,
        now,
      )
      return database
    }

    const insertUser = async (db: TestDatabase, id: number): Promise<void> => {
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        `User${id}`,
        'Example',
        'member',
        '[]',
        0,
        now,
        now,
      )
    }

    it('[unit] rate insert closes the previous row and history is append-only (invariant 8)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await db.run(
        `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        1,
        10_000,
        '2026-01-01',
        now,
        now,
      )
      await db.run(
        `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        1,
        12_500,
        '2026-02-01',
        now,
        now,
      )
      expect(
        await db.rows<{ amount_cents: number; start_date: string; end_date: string | null }>(
          `SELECT amount_cents, start_date, end_date FROM user_billable_rates ORDER BY start_date`,
        ),
      ).toEqual([
        { amount_cents: 10_000, start_date: '2026-01-01', end_date: '2026-01-31' },
        { amount_cents: 12_500, start_date: '2026-02-01', end_date: null },
      ])
      await expect(
        db.run(`UPDATE user_billable_rates SET amount_cents = 1 WHERE amount_cents = 12500`),
      ).rejects.toThrow(/append-only/)
      await expect(db.run(`DELETE FROM user_billable_rates WHERE amount_cents = 12500`)).rejects
        .toThrow(/append-only/)
      await expect(
        db.run(
          `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, end_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          1,
          14_000,
          '2026-03-01',
          '2030-01-01',
          now,
          now,
        ),
      ).rejects.toThrow(/derived/)
      await expect(
        db.run(`UPDATE user_billable_rates SET end_date = '2030-01-01' WHERE amount_cents = 12500`),
      ).rejects.toThrow(/append-only/)
      await db.run(
        `INSERT INTO user_cost_rates (user_id, amount_cents, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        1,
        5_000,
        '2026-01-01',
        now,
        now,
      )
      await expect(
        db.run(`UPDATE user_cost_rates SET end_date = '2030-01-01' WHERE user_id = 1`),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.run(
          `INSERT INTO user_cost_rates (user_id, amount_cents, start_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          1,
          6_000,
          '2099-01-01',
          now,
          now,
        ),
      ).rejects.toThrow(/future/)
    })

    it('[unit] first verified address wins and invalidates pending duplicates (D19)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      for (const [id, userId, address] of [
        [1, 1, 'Ana@Example.com'],
        [2, 2, 'ana@example.com'],
      ] as const) {
        await db.run(
          `INSERT INTO user_emails (id, user_id, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          id,
          userId,
          address,
          now,
          now,
        )
      }
      await db.run(`UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE id = 1`, now, now)
      await db.run(`UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE id = 2`, now, now)
      expect(
        await db.rows<{ id: number; verified_at: string | null; invalidated_at: string | null }>(
          `SELECT id, verified_at, invalidated_at FROM user_emails ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, verified_at: now, invalidated_at: null },
        { id: 2, verified_at: null, invalidated_at: now },
      ])
      await expect(
        db.run(`UPDATE user_emails SET address = 'attacker@example.test' WHERE id = 1`),
      ).rejects.toThrow(/immutable/)
    })

    it('[unit] inserting a verified address invalidates an existing pending duplicate (D19)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      await db.run(
        `INSERT INTO user_emails (id, user_id, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        1,
        1,
        'shared@example.test',
        now,
        now,
      )
      await db.run(
        `INSERT INTO user_emails
          (id, user_id, address, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        2,
        2,
        'SHARED@example.test',
        now,
        now,
        now,
      )
      expect(
        await db.rows<{ id: number; invalidated_at: string | null }>(
          `SELECT id, invalidated_at FROM user_emails ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, invalidated_at: now },
        { id: 2, invalidated_at: null },
      ])
    })

    it('[unit] exactly one owner remains enforced (invariant 12)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      await expect(db.run(`UPDATE users SET is_owner = 1 WHERE id = 2`)).rejects.toThrow(/derived/)
      await db.run(`UPDATE organization_owner SET user_id = 2, updated_at = ? WHERE id = 1`, now)
      await db.run(`UPDATE organization_owner SET user_id = 2, updated_at = ? WHERE id = 1`, now)
      expect(await db.rows<{ owners: number }>(`SELECT count(*) AS owners FROM users WHERE is_owner = 1`))
        .toEqual([{ owners: 1 }])
      expect(await db.rows<{ id: number }>(`SELECT id FROM users WHERE is_owner = 1`)).toEqual([
        { id: 2 },
      ])
      await expect(db.run(`DELETE FROM organization_owner WHERE id = 1`)).rejects.toThrow(
        /exactly one owner/,
      )
    })

    it('[unit] the migration exposes the complete first schema slice', async () => {
      const db = await setup()
      const tables = await db.rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name`,
      )
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'organizations',
          'users',
          'user_emails',
          'user_identities',
          'roles',
          'departments',
          'user_roles',
          'user_departments',
          'teammate_assignments',
          'user_billable_rates',
          'user_cost_rates',
        ]),
      )
    })

    it('[unit] rejects an unknown time-rounding policy', async () => {
      const db = await setup()
      await expect(
        db.run(`UPDATE organizations SET time_rounding = 'garbage' WHERE id = 1`),
      ).rejects.toThrow(/CHECK constraint/)
      await db.run(`UPDATE organizations SET time_rounding = 'nearest_15' WHERE id = 1`)
      expect(
        await db.rows<{ time_rounding: string }>(
          `SELECT time_rounding FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ time_rounding: 'nearest_15' }])
    })

    it('[unit] migrations are idempotent on an initialized database', async () => {
      const db = await setup()
      await db.migrateAgain()
      expect(await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations`)).toEqual([
        { id: '0000_org_people' },
      ])
    })
  })
}

describe('Drizzle adapters', () => {
  it('[unit] query the shared schema through the container adapter', async () => {
    const sqlite = new BetterSqlite3(':memory:')
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite)
      await database.insert(organizations).values({
        name: 'Halcyon Studio',
        modules: { expenses: true },
        createdAt: now,
        updatedAt: now,
      })
      expect((await database.select().from(organizations))[0]?.name).toBe('Halcyon Studio')
    } finally {
      sqlite.close()
    }
  })

  it('[unit] query the shared schema through the D1 adapter', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      const database = createD1Database(d1)
      await database.insert(organizations).values({
        name: 'Halcyon Studio',
        modules: { expenses: true },
        createdAt: now,
        updatedAt: now,
      })
      expect((await database.select().from(organizations))[0]?.name).toBe('Halcyon Studio')
    } finally {
      await miniflare.dispose()
    }
  })

  it('[unit] enables foreign keys whenever a container connection is adapted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-db-'))
    const path = join(directory, 'org.sqlite')
    const first = new BetterSqlite3(path)
    migrateContainer(first)
    first.close()
    const reopened = new BetterSqlite3(path)
    try {
      createContainerDatabase(reopened)
      expect(reopened.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(() =>
        reopened
          .prepare(
            `INSERT INTO user_emails (user_id, address, created_at, updated_at) VALUES (999, ?, ?, ?)`,
          )
          .run('nobody@example.test', now, now),
      ).toThrow(/FOREIGN KEY/)
    } finally {
      reopened.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
