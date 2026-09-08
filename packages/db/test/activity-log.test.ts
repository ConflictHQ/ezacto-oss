import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { captureActivityEvent } from '../src/activity-log.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerOutboxService,
  createD1OutboxService,
  type OutboxService,
} from '../src/outbox.js'

interface TestDatabase {
  orm: InvoiceStateDatabase
  outbox(): OutboxService
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const signedInAt = '2026-09-08T09:00:00.000Z'
const sentAt = '2026-09-08T10:00:00.000Z'
const paidAt = '2026-09-08T10:01:00.000Z'
const drainAt = '2026-09-08T10:02:00.000Z'
const authorize = async () => true

const containerDatabase = (): TestDatabase => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    orm: createContainerDatabase(database),
    outbox: () => createContainerOutboxService(database, { now: () => drainAt }),
    run: async (sql, ...bindings) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      database.prepare(sql).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    orm: createD1Database(database),
    outbox: () => createD1OutboxService(database, { now: () => drainAt }),
    run: async (sql, ...bindings) => {
      await database
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(sql)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const installInvoiceFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Activity Test', '{"invoices":true}', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, created_at, updated_at
    ) VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Activity Client', 'USD', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at
    ) VALUES (1, 1, 'ACTIVITY-1', 'USD', '2026-09-01', '2026-09-30', 'draft', ?, ?)`,
    sentAt,
    sentAt,
  )
}

const sendAndPayInvoice = async (database: TestDatabase): Promise<void> => {
  await executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: 'activity-send',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 101,
    eventId: 'activity-event-sent',
  })
  await recordInvoicePayment(database.orm, {
    invoiceId: 1,
    commandId: 'activity-payment',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 1,
    occurredAt: paidAt,
    eventIds: ['activity-event-payment', 'activity-event-paid'],
    payment: {
      type: 'manual',
      id: 100,
      currency: 'USD',
      amountCents: 100,
      paidAt,
      paidDate: null,
      recordedByUserId: 1,
    },
  })
}

for (const [runtime, factory] of factories) {
  describe(`activity capture (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] records a sign-in the drain turns into one activity row', async () => {
      database = await factory()

      await expect(
        captureActivityEvent(
          database.orm,
          {
            eventType: 'auth.signed_in',
            subjectId: 7,
            actor: { type: 'user', id: 7 },
            occurredAt: signedInAt,
            captureId: 'session-abc',
            detail: { method: 'password' },
          },
          { createEventId: () => 'activity-signin-1' },
        ),
      ).resolves.toEqual({
        eventId: 'activity-signin-1',
        aggregateType: 'user_authentication',
        aggregateId: 7,
        aggregateSequence: 1,
        captured: true,
      })

      const service = database.outbox()
      await service.drain()
      await service.drain()

      expect(await service.listActivity()).toEqual([
        expect.objectContaining({
          id: 'activity-signin-1',
          eventType: 'auth.signed_in',
          aggregateType: 'user_authentication',
          aggregateId: 7,
          aggregateSequence: 1,
          occurredAt: signedInAt,
          recordedAt: drainAt,
          payload: {
            schema_version: 1,
            event_id: 'activity-signin-1',
            event_type: 'auth.signed_in',
            occurred_at: signedInAt,
            aggregate: { type: 'user_authentication', id: 7, sequence: 1 },
            actor: { type: 'user', id: 7 },
            user_authentication: { method: 'password' },
          },
        }),
      ])
    })

    it('[unit] records the export and the restore with the actor that ran each', async () => {
      database = await factory()

      await captureActivityEvent(
        database.orm,
        {
          eventType: 'backup.exported',
          subjectId: 12,
          actor: { type: 'system' },
          occurredAt: '2026-09-08T03:00:00.000Z',
          captureId: 'backup-run-12',
          detail: { trigger: 'nightly', r2_prefix: 'backups/2026-09-08/' },
        },
        { createEventId: () => 'activity-export-1' },
      )
      await captureActivityEvent(
        database.orm,
        {
          eventType: 'backup.restored',
          subjectId: 1,
          actor: { type: 'user', id: 1 },
          occurredAt: '2026-09-08T04:00:00.000Z',
          captureId: 'restore-2026-09-08',
          detail: { bundle_version: '0031', table_count: 55 },
        },
        { createEventId: () => 'activity-restore-1' },
      )

      const service = database.outbox()
      await service.drain()

      const recorded = await service.listActivity()
      expect(
        recorded.map((entry) => ({
          eventType: entry.eventType,
          actor: entry.payload.actor,
          detail: entry.payload[entry.aggregateType],
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            eventType: 'backup.exported',
            actor: { type: 'system', id: null },
            detail: { trigger: 'nightly', r2_prefix: 'backups/2026-09-08/' },
          },
          {
            eventType: 'backup.restored',
            actor: { type: 'user', id: 1 },
            detail: { bundle_version: '0031', table_count: 55 },
          },
        ]),
      )
    })

    it('[unit] records every invoice state transition exactly once alongside a capture', async () => {
      database = await factory()
      await installInvoiceFixture(database)
      await sendAndPayInvoice(database)
      await captureActivityEvent(
        database.orm,
        {
          eventType: 'auth.signed_in',
          subjectId: 1,
          actor: { type: 'user', id: 1 },
          occurredAt: signedInAt,
          captureId: 'session-money',
        },
        { createEventId: () => 'activity-signin-money' },
      )

      const service = database.outbox()
      await service.drain()
      await service.drain()

      const recorded = await service.listActivity()
      expect(recorded.map((entry) => entry.eventType).sort()).toEqual([
        'auth.signed_in',
        'invoice.paid',
        'invoice.sent',
        'payment.recorded',
      ])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM activity_log
           WHERE event_id NOT IN (SELECT id FROM event_outbox)`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE published_at IS NULL`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] treats a replayed capture id as the event it already recorded', async () => {
      database = await factory()
      const first = await captureActivityEvent(
        database.orm,
        {
          eventType: 'api_token.created',
          subjectId: 4,
          actor: { type: 'user', id: 1 },
          occurredAt: signedInAt,
          captureId: 'token-grant-4',
        },
        { createEventId: () => 'activity-token-1' },
      )
      const replay = await captureActivityEvent(
        database.orm,
        {
          eventType: 'api_token.created',
          subjectId: 4,
          actor: { type: 'user', id: 1 },
          occurredAt: signedInAt,
          captureId: 'token-grant-4',
        },
        { createEventId: () => 'activity-token-2' },
      )

      expect(first).toEqual({
        eventId: 'activity-token-1',
        aggregateType: 'api_token',
        aggregateId: 4,
        aggregateSequence: 1,
        captured: true,
      })
      expect(replay).toEqual({ ...first, captured: false })
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE aggregate_type = 'api_token'`,
        ),
      ).toEqual([{ count: 1 }])
    })

    it("[unit] numbers each subject's history on its own", async () => {
      database = await factory()
      const sequences: number[] = []
      for (const [subjectId, captureId] of [
        [7, 'session-1'],
        [7, 'session-2'],
        [9, 'session-3'],
      ] as const) {
        const result = await captureActivityEvent(database.orm, {
          eventType: 'auth.signed_in',
          subjectId,
          actor: { type: 'user', id: subjectId },
          occurredAt: signedInAt,
          captureId,
        })
        sequences.push(result.aggregateSequence)
      }

      expect(sequences).toEqual([1, 2, 1])
    })

    it('[unit] refuses input the log cannot represent', async () => {
      database = await factory()
      const base = {
        eventType: 'auth.signed_in',
        subjectId: 7,
        actor: { type: 'user', id: 7 },
        occurredAt: signedInAt,
        captureId: 'session-invalid',
      } as const

      await expect(
        captureActivityEvent(database.orm, {
          ...base,
          eventType: 'invoice.sent' as never,
        }),
      ).rejects.toThrow('invoice.sent is not an activity event type')
      await expect(
        captureActivityEvent(database.orm, { ...base, occurredAt: '2026-09-08 09:00:00' }),
      ).rejects.toThrow('activity occurred_at must be a canonical UTC timestamp')
      await expect(
        captureActivityEvent(database.orm, { ...base, captureId: 'session invalid' }),
      ).rejects.toThrow('activity capture id must use 1-128 safe identifier characters')
      await expect(captureActivityEvent(database.orm, { ...base, subjectId: 0 })).rejects.toThrow(
        'activity subject id must be a positive row id',
      )
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM event_outbox`),
      ).toEqual([{ count: 0 }])
    })
  })
}
