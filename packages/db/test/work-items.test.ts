import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkItemConnectionInactiveError,
  WorkItemConnectionNotFoundError,
  WorkItemLinkExistsError,
  WorkItemLinkNotFoundError,
  WorkItemTargetNotFoundError,
} from '@ezacto/core'
import { captureActivityEvent } from '../src/activity-log.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1, migrationIds } from '../src/migrate.js'
import type { TrackedResourceDatabase } from '../src/tracked-resource-repository.js'
import { DrizzleWorkItemRepository, type WorkItemActor } from '../src/work-items.js'

/**
 * Issue 1008, slice 1. The store knows two things: which trackers the instance
 * has connected, and which tracker item a time entry or project points at. It
 * never calls a tracker and never holds a credential. Each case runs on both
 * runtimes because the guarantees that matter (one connection per provider,
 * links surviving a disconnect, cascade on delete) are enforced in the schema.
 */

interface TestDatabase {
  orm: TrackedResourceDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-10-01T12:00:00.000Z'
const t1 = '2026-10-02T12:00:00.000Z'

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

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const ada: WorkItemActor = { userId: 10, profile: 'administrator' }
const maya: WorkItemActor = { userId: 1, profile: 'member' }
const milo: WorkItemActor = { userId: 6, profile: 'member' }

const fixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations
       (name, modules, time_entry_mode, time_rounding_mode, time_rounding_minutes, created_at, updated_at)
     VALUES ('Fictional Studio', '{}', 'duration', 'exact', 15, ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, timezone, created_at, updated_at)
     VALUES (10, 'Ada', 'Admin', 'administrator', '[]', 'UTC', ?, ?),
       (1, 'Maya', 'Member', 'member', '[]', 'UTC', ?, ?),
       (6, 'Milo', 'Member', 'member', '[]', 'UTC', ?, ?)`,
    ...Array<string>(6).fill(t0),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Project', 'people', ?, ?)`,
    t0,
    t0,
  )
  await db.run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Task', ?, ?)`, t0, t0)
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?), (2, 1, 6, ?, ?)`,
    ...Array<string>(4).fill(t0),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  for (const [id, userId, assignment] of [
    [1, 1, 1],
    [2, 6, 2],
  ] as const) {
    await db.run(
      `INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
       VALUES (?, ?, 1, 1, ?, 1, '2026-10-01', 3600, 3600, 3600, 1, ?, ?)`,
      id,
      userId,
      assignment,
      t0,
      t0,
    )
  }
}

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  while (open.length > 0) await open.pop()!()
})

const setup = async (make: () => Promise<TestDatabase>) => {
  const db = await make()
  open.push(() => db.close())
  await fixture(db)
  return { db, store: new DrizzleWorkItemRepository(db.orm) }
}

const drain = async (
  source: ReturnType<DrizzleWorkItemRepository['links']>,
): Promise<number[]> => {
  const through = await source.highWatermark()
  if (through === null) return []
  return (await source.list({ afterId: null, throughId: through, take: 100 })).map((row) => row.id)
}

describe('work item migration ledger', () => {
  it('[unit] carries the reserved migration in the real ledger', () => {
    expect(migrationIds).toContain('0123_work_item_links')
  })
})

for (const [runtime, make] of factories) {
  describe(`work item store (${runtime})`, () => {
    it('[container] connects once per provider and takes the credential reference from the provider table', async () => {
      const { db, store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      expect(connection).toMatchObject({
        provider: 'github',
        status: 'active',
        ownerUserId: 10,
        credentialRef: 'GITHUB_WORK_ITEMS_CREDENTIAL',
        connectedAt: t0,
        disconnectedAt: null,
      })
      // A retry changes nothing: not the owner, not the date.
      const again = await store.connect('github', 1, t1)
      expect(again).toEqual(connection)
      expect(await db.rows('SELECT id FROM work_item_connections')).toHaveLength(1)
      expect(await store.connections()).toEqual([connection])
    })

    it('[container] disconnect drops the credential reference and keeps the row and its links', async () => {
      const { db, store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      const link = await store.createLink(ada, { connectionId: connection.id, timeEntryId: 1, providerItemId: 'o/r#1' }, t0)
      const disconnected = await store.disconnect(connection.id, t1)
      expect(disconnected).toMatchObject({ status: 'disconnected', credentialRef: null, disconnectedAt: t1 })
      // Disconnecting again is not an event: the row is exactly as it was.
      expect(await store.disconnect(connection.id, '2026-10-03T12:00:00.000Z')).toEqual(disconnected)
      expect(await store.getLink(ada, link.id)).toMatchObject({ providerItemId: 'o/r#1' })
      expect(await db.rows('SELECT credential_ref FROM work_item_connections')).toEqual([{ credential_ref: null }])
      await expect(store.disconnect(999, t1)).rejects.toBeInstanceOf(WorkItemConnectionNotFoundError)
    })

    it('[container] reconnecting revives the same connection so earlier links stay attached', async () => {
      const { store } = await setup(make)
      const first = await store.connect('github', ada.userId, t0)
      const link = await store.createLink(ada, { connectionId: first.id, timeEntryId: 1, providerItemId: 'o/r#1' }, t0)
      await store.disconnect(first.id, t1)
      const revived = await store.connect('github', 6, '2026-10-03T12:00:00.000Z')
      expect(revived).toMatchObject({
        id: first.id,
        status: 'active',
        ownerUserId: 6,
        credentialRef: 'GITHUB_WORK_ITEMS_CREDENTIAL',
        disconnectedAt: null,
      })
      expect(await drain(store.links(ada, { connectionId: first.id }))).toEqual([link.id])
    })

    it('[container] refuses a link through a disconnected connection, in the store and in the schema', async () => {
      const { db, store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      await store.disconnect(connection.id, t1)
      await expect(
        store.createLink(ada, { connectionId: connection.id, timeEntryId: 1, providerItemId: 'o/r#1' }, t1),
      ).rejects.toBeInstanceOf(WorkItemConnectionInactiveError)
      await expect(
        db.run(
          `INSERT INTO work_item_links (connection_id, time_entry_id, provider_item_id, created_by, created_at, updated_at)
           VALUES (?, 1, 'o/r#1', 10, ?, ?)`,
          connection.id,
          t1,
          t1,
        ),
      ).rejects.toThrow(/not active/)
      expect(await db.rows('SELECT id FROM work_item_links')).toEqual([])
    })

    it('[container] gives a time entry one item per connection and an item any number of entries', async () => {
      const { store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      const input = { connectionId: connection.id, providerItemId: 'o/r#1' }
      await store.createLink(maya, { ...input, timeEntryId: 1 }, t0)
      await store.createLink(milo, { ...input, timeEntryId: 2 }, t0)
      await expect(
        store.createLink(maya, { ...input, providerItemId: 'o/r#2', timeEntryId: 1 }, t0),
      ).rejects.toBeInstanceOf(WorkItemLinkExistsError)
      await store.createLink(ada, { ...input, projectId: 1 }, t0)
      await expect(store.createLink(ada, { ...input, projectId: 1 }, t0)).rejects.toBeInstanceOf(
        WorkItemLinkExistsError,
      )
      // Another item on the same project is fine.
      await store.createLink(ada, { ...input, providerItemId: 'o/r#2', projectId: 1 }, t0)
    })

    it('[security] scopes links to the actor: an entry that is not yours answers as missing', async () => {
      const { store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      const base = { connectionId: connection.id, providerItemId: 'o/r#1' }
      await expect(store.createLink(maya, { ...base, timeEntryId: 2 }, t0)).rejects.toBeInstanceOf(
        WorkItemTargetNotFoundError,
      )
      await expect(store.createLink(maya, { ...base, timeEntryId: 99 }, t0)).rejects.toBeInstanceOf(
        WorkItemTargetNotFoundError,
      )
      await expect(store.createLink(maya, { ...base, projectId: 1 }, t0)).rejects.toBeInstanceOf(
        WorkItemTargetNotFoundError,
      )
      const mine = await store.createLink(maya, { ...base, timeEntryId: 1 }, t0)
      const theirs = await store.createLink(ada, { ...base, timeEntryId: 2 }, t0)
      expect(await drain(store.links(maya, {}))).toEqual([mine.id])
      expect(await drain(store.links(milo, {}))).toEqual([theirs.id])
      expect(await drain(store.links(ada, {}))).toEqual([mine.id, theirs.id])
      await expect(store.getLink(maya, theirs.id)).rejects.toBeInstanceOf(WorkItemLinkNotFoundError)
      await expect(store.deleteLink(maya, theirs.id)).rejects.toBeInstanceOf(WorkItemLinkNotFoundError)
      await store.deleteLink(maya, mine.id)
      expect(await drain(store.links(ada, {}))).toEqual([theirs.id])
    })

    it('[container] filters by item and target, and rejects malformed input before it is stored', async () => {
      const { store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      const a = await store.createLink(ada, { connectionId: connection.id, timeEntryId: 1, providerItemId: 'o/r#1', url: 'https://github.com/o/r/issues/1' }, t0)
      await store.createLink(ada, { connectionId: connection.id, timeEntryId: 2, providerItemId: 'o/r#2' }, t0)
      expect(a.url).toBe('https://github.com/o/r/issues/1')
      expect(await drain(store.links(ada, { providerItemId: 'o/r#1' }))).toEqual([a.id])
      expect(await drain(store.links(ada, { timeEntryId: 2 }))).toHaveLength(1)
      const bad = { connectionId: connection.id, timeEntryId: 1 }
      await expect(store.createLink(ada, { ...bad, providerItemId: 'two words' }, t0)).rejects.toThrow(RangeError)
      await expect(store.createLink(ada, { ...bad, providerItemId: 'x', url: 'javascript:alert(1)' }, t0)).rejects.toThrow(RangeError)
      await expect(store.createLink(ada, { connectionId: connection.id, providerItemId: 'x' }, t0)).rejects.toThrow(RangeError)
      await expect(
        store.createLink(ada, { connectionId: 99, timeEntryId: 1, providerItemId: 'x' }, t0),
      ).rejects.toBeInstanceOf(WorkItemConnectionNotFoundError)
    })

    it('[container] removes a link with its time entry, and never lets a link move to another item', async () => {
      const { db, store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      const link = await store.createLink(ada, { connectionId: connection.id, timeEntryId: 1, providerItemId: 'o/r#1' }, t0)
      await expect(
        db.run(`UPDATE work_item_links SET provider_item_id = 'o/r#9' WHERE id = ?`, link.id),
      ).rejects.toThrow(/keeps its target/)
      await expect(
        db.run(`UPDATE work_item_connections SET provider = 'jira' WHERE id = ?`, connection.id),
      ).rejects.toThrow(/keeps its provider/)
      await db.run('PRAGMA foreign_keys = ON')
      await db.run('DELETE FROM time_entries WHERE id = 1')
      expect(await db.rows('SELECT id FROM work_item_links')).toEqual([])
    })

    it('[unit] records connecting and disconnecting on the activity rail under their own aggregate', async () => {
      const { db } = await setup(make)
      const orm = db.orm as unknown as Parameters<typeof captureActivityEvent>[0]
      for (const [eventType, captureId] of [
        ['work_item_connection.connected', 'req-1'],
        ['work_item_connection.disconnected', 'req-2'],
      ] as const) {
        await captureActivityEvent(orm, {
          eventType,
          subjectId: 1,
          actor: { type: 'user', id: 10 },
          occurredAt: t0,
          captureId,
          detail: { provider: 'github' },
        })
      }
      expect(
        await db.rows(
          `SELECT aggregate_type, aggregate_sequence, event_type FROM event_outbox ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { aggregate_type: 'work_item_connection', aggregate_sequence: 1, event_type: 'work_item_connection.connected' },
        { aggregate_type: 'work_item_connection', aggregate_sequence: 2, event_type: 'work_item_connection.disconnected' },
      ])
    })

    it('[security] holds no credential: the row has only the secret name, and none once disconnected', async () => {
      const { db, store } = await setup(make)
      const connection = await store.connect('github', ada.userId, t0)
      await store.disconnect(connection.id, t1)
      const columns = await db.rows<{ name: string }>(`SELECT name FROM pragma_table_info('work_item_connections')`)
      expect(columns.map(({ name }) => name).filter((name) => /secret|token|key|password/.test(name))).toEqual([])
      await expect(
        db.run(
          `UPDATE work_item_connections SET credential_ref = 'X' WHERE id = ?`,
          connection.id,
        ),
      ).rejects.toThrow()
    })
  })
}
