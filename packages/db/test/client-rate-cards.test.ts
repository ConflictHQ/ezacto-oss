import {
  RateCardClientNotFoundError,
  RateCardExistsError,
  RateCardNotFoundError,
  RateCardTaskNotFoundError,
  RateCardVersionOrderError,
} from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createClientRateCardRepository } from '../src/client-rate-cards.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { repriceTimeEntry } from '../src/rate-resolver.js'
import { createStoppedTimeEntry } from '../src/time-entries.js'

type DrizzleDatabase = Parameters<typeof createClientRateCardRepository>[0]

interface TestDatabase {
  drizzle: DrizzleDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const now = '2026-10-19T12:00:00.000Z'

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    drizzle: createContainerDatabase(sqlite),
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
    drizzle: createD1Database(d1),
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
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

// Clients: 1 root <- 2 <- 3 (leaf); 4 is the leaf's bill-to and is not an ancestor.
// Project 1 (leaf client, bill_by people), project 2 (leaf client, bill_by project).
const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', ?, ?)`,
    now,
    now,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 'Card', 'Tester', '[]', ?, ?)`,
    now,
    now,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, parent_client_id, created_at, updated_at) VALUES
      (1, 'Root', 'USD', NULL, ?, ?), (2, 'Child', 'USD', 1, ?, ?),
      (3, 'Leaf', 'USD', 2, ?, ?), (4, 'Bill-to', 'USD', NULL, ?, ?)`,
    ...Array<string>(8).fill(now),
  )
  await db.run(`UPDATE clients SET bill_to_client_id = 4 WHERE id = 3`)
  await db.run(
    `INSERT INTO projects
      (id, client_id, name, billing_method, bill_by, hourly_rate_cents, budget_by,
       created_at, updated_at) VALUES
      (1, 3, 'People', 'time_materials', 'people', NULL, 'none', ?, ?),
      (2, 3, 'Flat', 'time_materials', 'project', 15000, 'none', ?, ?)`,
    ...Array<string>(4).fill(now),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Dev', ?, ?), (2, 'Design', ?, ?)`,
    ...Array<string>(4).fill(now),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at) VALUES
      (1, 1, 1, 1, ?, ?), (2, 1, 2, 1, ?, ?), (3, 2, 1, 1, ?, ?)`,
    ...Array<string>(6).fill(now),
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, use_default_rates, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?), (2, 2, 1, 1, ?, ?)`,
    ...Array<string>(4).fill(now),
  )
  await db.run(
    `INSERT INTO user_billable_rates (id, user_id, amount_cents, start_date, created_at, updated_at)
     VALUES (1, 1, 10000, NULL, ?, ?)`,
    now,
    now,
  )
}

const entryInput = (projectId: number, taskId: number, spentDate: string) => ({
  userId: 1,
  projectId,
  taskId,
  userAssignmentId: projectId,
  taskAssignmentId: projectId === 2 ? 3 : taskId,
  spentDate,
  seconds: 3600,
  createdAt: now,
  updatedAt: now,
})

const single = (amountCents: number) => [{ taskId: null, amountCents }]

for (const [runtime, factory] of factories) {
  describe(`client rate cards (${runtime})`, () => {
    let database: TestDatabase | undefined
    afterEach(async () => database?.close())

    const setup = async () => {
      database = await factory()
      await installFixture(database)
      return { db: database, cards: createClientRateCardRepository(database.drizzle) }
    }

    it('[container/D1] creates one card per client and appends versions only', async () => {
      const { db, cards } = await setup()
      expect(await cards.get(1)).toBeNull()
      const created = await cards.create(1, { name: '  Standard  ' }, now)
      expect(created).toMatchObject({ clientId: 1, name: 'Standard', versions: [] })
      await expect(cards.create(1, { name: 'Again' }, now)).rejects.toThrow(RateCardExistsError)
      await expect(cards.create(99, { name: 'X' }, now)).rejects.toThrow(RateCardClientNotFoundError)
      await expect(cards.create(2, { name: '   ' }, now)).rejects.toThrow(RangeError)
      await expect(cards.get(99)).rejects.toThrow(RateCardClientNotFoundError)
      await expect(cards.appendVersion(2, { startDate: null, lines: [] }, now)).rejects.toThrow(
        RateCardNotFoundError,
      )

      await cards.appendVersion(1, { startDate: '2026-01-01', lines: single(12_000) }, now)
      const after = await cards.appendVersion(
        1,
        {
          startDate: '2026-07-01',
          lines: [
            { taskId: 1, amountCents: 15_000 },
            { taskId: null, amountCents: 11_000 },
          ],
        },
        now,
      )
      expect(after.versions.map((version) => version.startDate)).toEqual(['2026-01-01', '2026-07-01'])
      expect(after.versions[1]!.lines).toEqual([
        { taskId: 1, amountCents: 15_000 },
        { taskId: null, amountCents: 11_000 },
      ])

      // A correction is a later version; the past cannot be rewritten.
      await expect(
        cards.appendVersion(1, { startDate: '2026-07-01', lines: single(1) }, now),
      ).rejects.toThrow(RateCardVersionOrderError)
      await expect(
        cards.appendVersion(1, { startDate: '2026-03-01', lines: single(1) }, now),
      ).rejects.toThrow(RateCardVersionOrderError)
      await expect(
        cards.appendVersion(1, { startDate: null, lines: single(1) }, now),
      ).rejects.toThrow(RateCardVersionOrderError)
      await expect(
        cards.appendVersion(1, { startDate: '2026-08-01', lines: [{ taskId: 77, amountCents: 1 }] }, now),
      ).rejects.toThrow(RateCardTaskNotFoundError)
      await expect(
        cards.appendVersion(1, { startDate: '2026-08-01', lines: single(-5) }, now),
      ).rejects.toThrow(RangeError)
      expect((await cards.get(1))!.versions).toHaveLength(2)

      const statements = [
        `UPDATE client_rate_card_versions SET lines = '[]'`,
        `DELETE FROM client_rate_card_versions`,
        `UPDATE client_rate_cards SET name = 'renamed'`,
        `DELETE FROM client_rate_cards`,
        `INSERT INTO client_rate_card_versions (card_id, start_date, lines, created_at)
         VALUES (1, '2027-01-01', 'not json', '${now}')`,
        `INSERT INTO client_rate_card_versions (card_id, start_date, lines, created_at)
         VALUES (1, '2027-01-01', '{}', '${now}')`,
      ]
      for (const statement of statements) await expect(db.run(statement)).rejects.toThrow()
    })

    it('[container/D1] effective lookup names the ancestor that supplied the rate', async () => {
      const { db, cards } = await setup()
      await expect(cards.effective(3, 1, '2026-10-19')).rejects.toThrow(RateCardNotFoundError)
      await expect(cards.effective(99, 1, '2026-10-19')).rejects.toThrow(RateCardClientNotFoundError)

      await cards.create(1, { name: 'Root card' }, now)
      await cards.appendVersion(1, { startDate: '2026-01-01', lines: single(12_000) }, now)
      expect(await cards.effective(3, 1, '2026-10-19')).toEqual({
        clientId: 3,
        suppliedByClientId: 1,
        depth: 2,
        cardId: 1,
        cardName: 'Root card',
        versionStartDate: '2026-01-01',
        taskId: null,
        amountCents: 12_000,
      })
      await expect(cards.effective(3, 1, '2025-12-31')).rejects.toThrow(RateCardNotFoundError)

      // The bill-to client is not an ancestor: its card never prices the leaf.
      await cards.create(4, { name: 'Bill-to card' }, now)
      await cards.appendVersion(4, { startDate: null, lines: single(99_000) }, now)
      expect((await cards.effective(3, 1, '2026-10-19')).suppliedByClientId).toBe(1)

      // A node's own card overrides the inherited one, per task line first.
      await cards.create(3, { name: 'Leaf card' }, now)
      await cards.appendVersion(
        3,
        { startDate: null, lines: [{ taskId: 2, amountCents: 20_000 }] },
        now,
      )
      expect(await cards.effective(3, 2, '2026-10-19')).toMatchObject({
        suppliedByClientId: 3,
        depth: 0,
        taskId: 2,
        amountCents: 20_000,
      })
      // No line for task 1 on the leaf card: it falls through to the root card.
      expect(await cards.effective(3, 1, '2026-10-19')).toMatchObject({
        suppliedByClientId: 1,
        amountCents: 12_000,
      })
      // An empty latest version retires a card.
      await cards.appendVersion(1, { startDate: '2026-09-01', lines: [] }, now)
      await expect(cards.effective(3, 1, '2026-10-19')).rejects.toThrow(RateCardNotFoundError)
      expect((await cards.effective(3, 1, '2026-08-31')).amountCents).toBe(12_000)
      expect(await db.rows(`SELECT 1 FROM client_rate_cards`)).toHaveLength(3)
    })

    it('[container/D1] new entries resolve through the client chain; existing snapshots and reprice stay explicit', async () => {
      const { db, cards } = await setup()
      const before = await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-01'))
      expect(before.billableRateCents).toBe(10_000)

      await cards.create(1, { name: 'Root card' }, now)
      await cards.appendVersion(
        1,
        {
          startDate: '2026-10-10',
          lines: [
            { taskId: 1, amountCents: 17_500 },
            { taskId: null, amountCents: 13_000 },
          ],
        },
        now,
      )
      const snapshot = async (id: number) =>
        (
          await db.rows<{ billable_rate_cents: number | null }>(
            `SELECT billable_rate_cents FROM time_entries WHERE id = ?`,
            id,
          )
        )[0]!.billable_rate_cents

      // Adding a card changed no existing entry.
      expect(await snapshot(before.id)).toBe(10_000)

      const taskOne = await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-15'))
      const taskTwo = await createStoppedTimeEntry(db.drizzle, entryInput(1, 2, '2026-10-15'))
      const early = await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-09'))
      expect(taskOne.billableRateCents).toBe(17_500)
      expect(taskTwo.billableRateCents).toBe(13_000)
      expect(early.billableRateCents).toBe(10_000)

      // bill_by=project is untouched by cards.
      const flat = await createStoppedTimeEntry(db.drizzle, entryInput(2, 1, '2026-10-15'))
      expect(flat.billableRateCents).toBe(15_000)

      // use_default_rates=false keeps the assignment override ahead of the card.
      await db.run(`UPDATE user_assignments SET use_default_rates = 0, hourly_rate_cents = 9000 WHERE id = 1`)
      const override = await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-16'))
      expect(override.billableRateCents).toBe(9_000)
      await db.run(`UPDATE user_assignments SET use_default_rates = 1 WHERE id = 1`)

      // A card change affects future work only.
      await cards.appendVersion(1, { startDate: '2026-10-18', lines: single(20_000) }, now)
      expect(await snapshot(taskOne.id)).toBe(17_500)
      expect(await snapshot(taskTwo.id)).toBe(13_000)
      expect((await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-19'))).billableRateCents).toBe(20_000)

      // Moving the client under a different parent changes only later resolution.
      await db.run(`UPDATE clients SET parent_client_id = NULL WHERE id = 3`)
      expect(await snapshot(taskOne.id)).toBe(17_500)
      expect((await createStoppedTimeEntry(db.drizzle, entryInput(1, 1, '2026-10-19'))).billableRateCents).toBe(10_000)
      await db.run(`UPDATE clients SET parent_client_id = 2 WHERE id = 3`)

      // Only the existing audited reprice rewrites a snapshot.
      const repriced = await repriceTimeEntry(db.drizzle, {
        timeEntryId: taskOne.id,
        reason: 'Card agreed retroactively',
        repricedAt: '2026-10-19T13:00:00.000Z',
      })
      expect(repriced.entry.billableRateCents).toBe(17_500)
      const outside = await repriceTimeEntry(db.drizzle, {
        timeEntryId: before.id,
        reason: 'Check',
        repricedAt: '2026-10-19T13:00:00.000Z',
      })
      expect(outside.audit).toMatchObject({ previousBillableRateCents: 10_000, billableRateCents: 10_000 })
    })
  })
}
