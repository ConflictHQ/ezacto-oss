import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  ACTIVITY_LOG_SUBSCRIBER_ID,
  createContainerOutboxService,
  createD1OutboxService,
  type OutboxService,
  type OutboxSubscriber,
} from '../src/outbox.js'

interface TestDatabase {
  orm: InvoiceStateDatabase
  outbox(options?: Parameters<typeof createContainerOutboxService>[1]): OutboxService
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const sentAt = '2026-09-02T10:00:00.000Z'
const paidAt = '2026-09-02T10:01:00.000Z'
const drainAt = '2026-09-02T10:02:00.000Z'
const authorize = async () => true

const containerDatabase = (): TestDatabase => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    orm: createContainerDatabase(database),
    outbox: (options = {}) => createContainerOutboxService(database, options),
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
    outbox: (options = {}) => createD1OutboxService(database, options),
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

const installFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Outbox Test', '{"invoices":true}', ?, ?)`,
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
     VALUES (1, 'Outbox Client', 'USD', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, state,
      created_at, updated_at
    ) VALUES
      (1, 1, 'OUTBOX-1', 'USD', '2026-09-01', '2026-09-30', 'draft', ?, ?),
      (2, 1, 'OUTBOX-2', 'USD', '2026-09-01', '2026-09-30', 'open', ?, ?)`,
    sentAt,
    sentAt,
    sentAt,
    sentAt,
  )
}

const sendInvoice = async (database: TestDatabase): Promise<void> => {
  await executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: 'outbox-send',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 101,
    eventId: 'outbox-event-sent',
  })
}

const payInvoice = async (
  database: TestDatabase,
  invoiceId: number,
  expectedVersion: number,
  prefix: string,
): Promise<void> => {
  await recordInvoicePayment(database.orm, {
    invoiceId,
    commandId: `${prefix}-payment`,
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion,
    occurredAt: paidAt,
    eventIds: [`${prefix}-payment-recorded`, `${prefix}-invoice-paid`],
    payment: {
      type: 'manual',
      id: invoiceId * 100,
      currency: 'USD',
      amountCents: 100,
      paidAt,
      paidDate: null,
      recordedByUserId: 1,
    },
  })
}

for (const [runtime, factory] of factories) {
  describe(`outbox drainer (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] applies the activity subscriber once and publishes its durable receipt', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      const service = database.outbox({
        now: () => drainAt,
        createAttemptId: () => 'activity-attempt-1',
      })

      await expect(service.drain()).resolves.toEqual({
        examined: 1,
        delivered: 1,
        retried: 0,
        failed: 0,
        contention: 0,
      })
      await expect(service.drain()).resolves.toEqual({
        examined: 0,
        delivered: 0,
        retried: 0,
        failed: 0,
        contention: 0,
      })
      expect(await service.listActivity()).toEqual([
        expect.objectContaining({
          id: 'outbox-event-sent',
          eventType: 'invoice.sent',
          aggregateSequence: 1,
          recordedAt: drainAt,
        }),
      ])
      expect(await service.listDeliveries()).toEqual([
        expect.objectContaining({
          subscriberId: ACTIVITY_LOG_SUBSCRIBER_ID,
          eventId: 'outbox-event-sent',
          status: 'delivered',
          attemptCount: 1,
          deliveredAt: drainAt,
        }),
      ])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT published_at, attempt_count, last_error FROM event_outbox`,
        ),
      ).toEqual([{ published_at: drainAt, attempt_count: 1, last_error: null }])
    })

    it('[unit] preserves aggregate order and never invents missing import history', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await payInvoice(database, 1, 1, 'ordered')
      // Invoice 2 models an imported already-open invoice. Its native payment has
      // no preceding native invoice.sent event, and the drainer must not synthesize one.
      await payInvoice(database, 2, 0, 'imported-open')

      const delivered: string[] = []
      const subscriber: OutboxSubscriber = {
        id: 'capture',
        deliver: async (event) => void delivered.push(event.eventType),
      }
      const service = database.outbox({
        subscribers: [subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `ordered-attempt-${++id}`
        })(),
      })
      await expect(service.drain(10)).resolves.toMatchObject({ delivered: 5 })

      const sentIndex = delivered.indexOf('invoice.sent')
      const orderedPaidIndex = delivered.indexOf('invoice.paid')
      expect(sentIndex).toBeGreaterThanOrEqual(0)
      expect(orderedPaidIndex).toBeGreaterThan(sentIndex)
      expect(delivered.filter((type) => type === 'invoice.sent')).toHaveLength(1)
      expect(delivered).toEqual([
        'invoice.sent',
        'payment.recorded',
        'invoice.paid',
        'payment.recorded',
        'invoice.paid',
      ])
    })

    it('[unit] retries on the deterministic schedule, surfaces failure, and permits retry', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      let current = drainAt
      let reject = true
      const deliver = vi.fn(async () => {
        if (reject) throw new Error('subscriber secret must not be stored')
      })
      const service = database.outbox({
        subscribers: [{ id: 'failing', deliver }],
        now: () => current,
        createAttemptId: (() => {
          let id = 0
          return () => `failure-attempt-${++id}`
        })(),
        maxAttempts: 2,
        retryDelaySeconds: [60],
      })

      await expect(service.drain()).resolves.toMatchObject({ retried: 1 })
      await expect(service.drain()).resolves.toMatchObject({ examined: 0 })
      current = '2026-09-02T10:03:00.000Z'
      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      expect(await service.listDeliveries({ status: 'failed' })).toEqual([
        expect.objectContaining({
          subscriberId: 'failing',
          attemptCount: 2,
          lastErrorCode: 'subscriber_rejected',
          failedAt: current,
        }),
      ])
      expect(
        JSON.stringify(await service.listDeliveries({ status: 'failed' })),
      ).not.toContain('subscriber secret')

      reject = false
      await expect(service.retryFailed('failing', 'outbox-event-sent')).resolves.toMatchObject({
        status: 'pending',
        attemptCount: 0,
      })
      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })
      expect(deliver).toHaveBeenCalledTimes(3)
    })

    it('[concurrency] recovers an expired lease and fences the abandoned owner', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await database.run(
        `INSERT INTO outbox_delivery_receipts (
          subscriber_id, event_id, status, attempt_count, active_attempt_id,
          attempt_lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, 'processing', 1, ?, ?, ?, ?)`,
        'lease-test',
        'outbox-event-sent',
        'abandoned-attempt',
        '2026-09-02T10:01:00.000Z',
        sentAt,
        sentAt,
      )
      const delivered = vi.fn(async () => undefined)
      const service = database.outbox({
        subscribers: [{ id: 'lease-test', deliver: delivered }],
        now: () => drainAt,
        createAttemptId: () => 'lease-recovery-attempt',
      })

      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })
      expect(delivered).toHaveBeenCalledOnce()
      expect(await service.listDeliveries()).toEqual([
        expect.objectContaining({
          status: 'delivered',
          attemptCount: 2,
          deliveredAt: drainAt,
        }),
      ])
      await database.run(
        `UPDATE outbox_delivery_receipts SET status = 'failed'
         WHERE subscriber_id = 'lease-test' AND event_id = 'outbox-event-sent'
           AND active_attempt_id = 'abandoned-attempt'`,
      )
      expect(await service.listDeliveries()).toEqual([
        expect.objectContaining({ status: 'delivered' }),
      ])
    })

    it('[concurrency] terminally fences an expired final attempt without exceeding its budget', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await database.run(
        `INSERT INTO outbox_delivery_receipts (
          subscriber_id, event_id, status, attempt_count, active_attempt_id,
          attempt_lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, 'processing', 2, ?, ?, ?, ?)`,
        'final-lease',
        'outbox-event-sent',
        'final-abandoned-attempt',
        '2026-09-02T10:01:00.000Z',
        sentAt,
        sentAt,
      )
      const deliver = vi.fn(async () => undefined)
      const service = database.outbox({
        subscribers: [{ id: 'final-lease', deliver }],
        now: () => drainAt,
        createAttemptId: () => 'must-not-run',
        maxAttempts: 2,
        retryDelaySeconds: [60],
      })

      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      expect(deliver).not.toHaveBeenCalled()
      await expect(service.listDeliveries()).resolves.toEqual([
        expect.objectContaining({
          status: 'failed',
          attemptCount: 2,
          lastErrorCode: 'subscriber_timeout',
          failedAt: drainAt,
        }),
      ])

      await database.run(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence,
          event_type, payload_json, occurred_at, available_at
        ) VALUES ('lowered-policy-event', 'fixture', 1, 1,
          'fixture.committed', '{}', ?, ?)`,
        sentAt,
        sentAt,
      )
      await database.run(
        `INSERT INTO outbox_delivery_receipts (
          subscriber_id, event_id, status, attempt_count, created_at, updated_at
        ) VALUES ('final-lease', 'lowered-policy-event', 'pending', 2, ?, ?)`,
        sentAt,
        sentAt,
      )
      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      await expect(service.listDeliveries({ status: 'failed' })).resolves.toHaveLength(2)
      expect(deliver).not.toHaveBeenCalled()
    })

    it('[concurrency] permits only one live owner for a subscriber delivery', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const deliver = vi.fn(async () => {
        entered()
        await blocked
      })
      const first = database.outbox({
        subscribers: [{ id: 'exclusive', deliver }],
        now: () => drainAt,
        createAttemptId: () => 'exclusive-attempt-1',
      })
      const second = database.outbox({
        subscribers: [{ id: 'exclusive', deliver }],
        now: () => drainAt,
        createAttemptId: () => 'exclusive-attempt-2',
      })

      const firstDrain = first.drain()
      await started
      await expect(second.drain()).resolves.toMatchObject({ examined: 0 })
      release()
      await expect(firstDrain).resolves.toMatchObject({ delivered: 1 })
      expect(deliver).toHaveBeenCalledOnce()
    })

    it('[unit] classifies bounded handler timeouts without storing exception detail', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      const service = database.outbox({
        subscribers: [
          {
            id: 'timeout',
            deliver: async () => new Promise<void>(() => undefined),
          },
        ],
        now: () => drainAt,
        createAttemptId: () => 'timeout-attempt-1',
        maxAttempts: 1,
        retryDelaySeconds: [],
        handlerTimeoutMs: 1,
        attemptLeaseSeconds: 1,
      })

      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      await expect(service.listDeliveries({ status: 'failed' })).resolves.toEqual([
        expect.objectContaining({
          subscriberId: 'timeout',
          attemptCount: 1,
          lastErrorCode: 'subscriber_timeout',
        }),
      ])
    })

    it('[unit] quarantines a structurally invalid payload as a bounded visible failure', async () => {
      database = await factory()
      await database.run(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence,
          event_type, payload_json, occurred_at, available_at
        ) VALUES (?, 'fixture', 1, 1, 'fixture.invalid', '[]', ?, ?)`,
        'invalid-payload-event',
        sentAt,
        sentAt,
      )
      const service = database.outbox({
        now: () => drainAt,
        createAttemptId: () => 'invalid-payload-attempt',
        maxAttempts: 1,
        retryDelaySeconds: [],
      })

      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      await expect(service.listDeliveries()).resolves.toEqual([
        expect.objectContaining({
          subscriberId: ACTIVITY_LOG_SUBSCRIBER_ID,
          status: 'failed',
          lastErrorCode: 'subscriber_rejected',
        }),
      ])
      await expect(service.listActivity()).resolves.toEqual([])
    })

    it('[unit] publishes only after every explicit subscriber has a durable receipt', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      let rejectSecond = true
      const contexts: string[] = []
      const firstSubscriber: OutboxSubscriber = {
        id: 'first',
        deliver: async (_event, context) => void contexts.push(context.idempotencyKey),
      }
      const secondSubscriber: OutboxSubscriber = {
        id: 'second',
        deliver: async (_event, context) => {
          contexts.push(context.idempotencyKey)
          if (rejectSecond) throw new Error('not yet')
        },
      }
      const service = database.outbox({
        subscribers: [firstSubscriber, secondSubscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `multi-attempt-${++id}`
        })(),
        maxAttempts: 1,
        retryDelaySeconds: [],
      })

      await expect(service.drain(2)).resolves.toMatchObject({ delivered: 1, failed: 1 })
      expect(
        await database.rows<{ published_at: string | null }>(
          `SELECT published_at FROM event_outbox WHERE id = ?`,
          'outbox-event-sent',
        ),
      ).toEqual([{ published_at: null }])
      rejectSecond = false
      await expect(service.retryFailed('second', 'outbox-event-sent')).resolves.toMatchObject({
        status: 'pending',
      })
      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })
      expect(contexts).toEqual([
        'first:outbox-event-sent',
        'second:outbox-event-sent',
        'second:outbox-event-sent',
      ])
      expect(
        await database.rows<{ published_at: string | null }>(
          `SELECT published_at FROM event_outbox WHERE id = ?`,
          'outbox-event-sent',
        ),
      ).toEqual([{ published_at: drainAt }])
    })
  })
}
