import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { requestAccountDeletion } from '../src/account-deletion.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

/**
 * A person asking for their own account to be deleted, from the mobile app
 * (App Store Guideline 5.1.1(v), Google Play's account deletion policy). The
 * request is recorded and names the administrators who decide. The account
 * itself must not move: on the public demo it is the account every reviewer
 * signs in as.
 */

const at = '2026-09-01T12:00:00.000Z'

interface TestDatabase {
  orm: Parameters<typeof requestAccountDeletion>[0]
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite) as never,
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    exec: async (sql) => {
      sqlite.exec(sql)
    },
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
    orm: createD1Database(d1) as never,
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    exec: async (sql) => {
      for (const statement of sql
        .split(';')
        .map((text) => text.trim())
        .filter((text) => text !== '')) {
        await d1.prepare(statement).run()
      }
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

// Who is on the instance: the person asking, a member, and four
// administrators of whom only one can be told -- one is archived, one's
// address was replaced, one has never had a primary address.
const seed = `
  INSERT INTO organizations (name, modules, created_at, updated_at)
    VALUES ('Deletion Org', '{}', '${at}', '${at}');
  INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
    VALUES (1, 'Ana', 'Admin', 'administrator', 1, '[]', '${at}', '${at}'),
           (2, 'Arch', 'Ived', 'administrator', 0, '[]', '${at}', '${at}'),
           (3, 'Old', 'Address', 'administrator', 1, '[]', '${at}', '${at}'),
           (4, 'Pat', 'Example', 'member', 1, '[]', '${at}', '${at}'),
           (5, 'Acc', 'Ounting', 'accounting', 1, '[]', '${at}', '${at}'),
           (6, 'No', 'Address', 'administrator', 1, '[]', '${at}', '${at}');
  INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at)
    VALUES (1, 1, 'ana@deletion.example', '${at}', 1, NULL, '${at}', '${at}'),
           (2, 2, 'archived@deletion.example', '${at}', 1, NULL, '${at}', '${at}'),
           (3, 3, 'replaced@deletion.example', '${at}', 0, '${at}', '${at}', '${at}'),
           (4, 4, 'pat@deletion.example', '${at}', 1, NULL, '${at}', '${at}'),
           (5, 5, 'acc@deletion.example', '${at}', 1, NULL, '${at}', '${at}')
`

for (const [runtime, factory] of factories) {
  describe(`a request to delete one's own account (${runtime})`, () => {
    let database: TestDatabase | null = null
    afterEach(async () => {
      await database?.close()
      database = null
    })
    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await database.exec(seed)
      return database
    }

    it('[security] records the ask, names who decides, and leaves the account alone', async () => {
      const db = await setup()
      const before = await db.rows(`SELECT * FROM users ORDER BY id`)

      const first = await requestAccountDeletion(db.orm, {
        userId: 4,
        occurredAt: '2026-09-02T10:00:00.000Z',
        captureId: 'request-1',
      })
      expect(first).toEqual({
        requestedAt: '2026-09-02T10:00:00.000Z',
        recorded: true,
        person: { name: 'Pat Example', email: 'pat@deletion.example' },
        administrators: ['ana@deletion.example'],
      })
      // Nothing about anyone changed: not active, not profile, not version.
      expect(await db.rows(`SELECT * FROM users ORDER BY id`)).toEqual(before)
      expect(
        await db.rows(
          `SELECT aggregate_type AS aggregateType, aggregate_id AS aggregateId,
             event_type AS eventType, command_id AS captureId
           FROM event_outbox WHERE event_type = 'account.deletion_requested'`,
        ),
      ).toEqual([
        {
          aggregateType: 'user_account',
          aggregateId: 4,
          eventType: 'account.deletion_requested',
          captureId: 'request-1',
        },
      ])
    })

    it('[unit] keeps the first time asked, and records a retry once', async () => {
      const db = await setup()
      await requestAccountDeletion(db.orm, {
        userId: 4,
        occurredAt: '2026-09-02T10:00:00.000Z',
        captureId: 'request-1',
      })
      const retry = await requestAccountDeletion(db.orm, {
        userId: 4,
        occurredAt: '2026-09-02T10:00:05.000Z',
        captureId: 'request-1',
      })
      expect(retry).toMatchObject({ requestedAt: '2026-09-02T10:00:00.000Z', recorded: false })
      const again = await requestAccountDeletion(db.orm, {
        userId: 4,
        occurredAt: '2026-09-09T08:00:00.000Z',
        captureId: 'request-2',
      })
      expect(again).toMatchObject({ requestedAt: '2026-09-02T10:00:00.000Z', recorded: true })
      expect(
        await db.rows(`SELECT count(*) AS asks FROM event_outbox WHERE event_type = 'account.deletion_requested'`),
      ).toEqual([{ asks: 2 }])
    })

    it('[unit] refuses a request for somebody who does not exist', async () => {
      const db = await setup()
      await expect(
        requestAccountDeletion(db.orm, { userId: 99, occurredAt: at, captureId: 'request-x' }),
      ).rejects.toThrow('the person asking must exist')
    })
  })
}
