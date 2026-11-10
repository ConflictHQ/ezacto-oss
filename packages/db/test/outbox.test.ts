import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  executeInvoiceEdit,
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { FollowUpDeliveryDeferred } from '../src/follow-up-deferred.js'
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

const workerOptions = { modules: true,
  script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] } as const
let templateRoot: string, sqliteTemplate: Buffer
const templateOwnership = { worker: undefined as Miniflare | undefined, disposal: undefined as Promise<void> | undefined }
const disposeTemplate = () => templateOwnership.disposal ??= templateOwnership.worker?.dispose() ?? Promise.resolve()
let templateClosed = false
const caseClosers: (() => Promise<void>)[] = []
const closeCases = async () => {
  const results = await Promise.allSettled(caseClosers.splice(0).map(close => close()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Outbox fixture cleanup failed')
}
beforeAll(() => {
  const sqlite = new BetterSqlite3(':memory:')
  try { migrateContainer(sqlite); sqliteTemplate = sqlite.serialize() } finally { sqlite.close() }
})
const prepareD1Template = async () => {
  templateRoot = await mkdtemp(join(tmpdir(), 'outbox-schema-'))
  if (templateClosed) {
    await rm(templateRoot, { recursive: true, force: true })
    throw new Error('Outbox fixture setup was closed')
  }
  const template = new Miniflare({ ...workerOptions, d1Persist: join(templateRoot, 'd1') })
  templateOwnership.worker = template
  try { await migrateD1(await template.getD1Database('DB')) }
  finally { await disposeTemplate() }
  if (templateClosed) throw new Error('Outbox fixture setup was closed')
}
afterEach(closeCases)
afterAll(async () => {
  templateClosed = true
  try { await closeCases() }
  finally {
    try { await disposeTemplate() }
    finally { if (templateRoot) await rm(templateRoot, { recursive: true, force: true }) }
  }
})

const containerDatabase = (): TestDatabase => {
  const database = new BetterSqlite3(Buffer.from(sqliteTemplate))
  let disposed = false
  const close = async () => { if (!disposed) { disposed = true; database.close() } }
  caseClosers.push(close)
  return {
    orm: createContainerDatabase(database),
    outbox: (options = {}) => createContainerOutboxService(database, options),
    run: async (sql, ...bindings) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      database.prepare(sql).all(...bindings) as T[],
    close,
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), 'outbox-case-'))
  const resources = { worker: undefined as Miniflare | undefined, disposed: false,
    closing: undefined as Promise<void> | undefined }
  const close = () => resources.closing ??= (async () => {
    resources.disposed = true
    try { await resources.worker?.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })()
  caseClosers.push(close)
  try {
    await cp(join(templateRoot, 'd1'), join(directory, 'd1'), { recursive: true })
    if (templateClosed || resources.disposed) throw new Error('Outbox fixture startup was closed')
    resources.worker = new Miniflare({ ...workerOptions, d1Persist: join(directory, 'd1') })
    const database = await resources.worker.getD1Database('DB')
    return {
      orm: createD1Database(database),
      outbox: (options = {}) => createD1OutboxService(database, options),
      run: async (sql, ...bindings) => { await database.prepare(sql).bind(...bindings).run() },
      rows: async <T>(sql: string, ...bindings: unknown[]) =>
        (await database.prepare(sql).bind(...bindings).all<T>()).results,
      close,
    }
  } catch (error) {
    await close()
    // A cancelled copy may have finished after its first cleanup.
    await rm(directory, { recursive: true, force: true })
    throw error
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
  // Invoice 1 owes exactly what payInvoice pays, because a payment may not
  // overpay. Invoice 2 is inserted open, and an open invoice takes a line only
  // through a command, so the test that pays it adds one first.
  await database.run(
    `INSERT INTO invoice_line_items (
      invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents,
      created_at, updated_at
    ) VALUES (1, 0, 'Service', 'Outbox work', 1, 100, 100, ?, ?)`,
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
    if (runtime === 'D1') beforeAll(prepareD1Template)

    afterEach(async () => database?.close())

    it('[regression] keeps each migrated fixture physically isolated with foreign keys enabled', async () => {
      const first = await factory(), second = await factory()
      await installFixture(first)
      expect(await first.rows('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
      expect(await second.rows('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
      expect(await second.rows('SELECT count(*) AS n FROM organizations')).toEqual([{ n: 0 }])
      const later = await factory()
      expect(await later.rows('SELECT count(*) AS n FROM organizations')).toEqual([{ n: 0 }])
      expect(await first.rows('SELECT name FROM organizations')).toEqual([{ name: 'Outbox Test' }])
    })

    it('[regression] pausing an expired final owner preserves the retry limit and fences its stale acknowledgement', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await database.run(`INSERT INTO outbox_delivery_receipts
        (subscriber_id,event_id,status,attempt_count,active_attempt_id,attempt_lease_expires_at,created_at,updated_at)
        VALUES('paused-final','outbox-event-sent','processing',1,'old-owner',?,?,?)`,
        '2026-09-02T10:01:00.000Z',sentAt,sentAt)
      let available = false, now = drainAt
      const deliver = vi.fn(async () => {})
      const options = { subscribers: [{ id: 'paused-final', available: () => available, deliver }],
        now: () => now, maxAttempts: 1, retryDelaySeconds: [] }
      expect(await database.outbox(options).drain()).toMatchObject({ delivered: 0, failed: 0 })
      expect(await database.rows("SELECT status,attempt_count,active_attempt_id FROM outbox_delivery_receipts WHERE subscriber_id='paused-final'"))
        .toEqual([{ status: 'pending', attempt_count: 1, active_attempt_id: null }])
      available = true; now = '2026-09-02T10:03:00.000Z'
      expect(await database.outbox(options).drain()).toMatchObject({ failed: 1, delivered: 0 })
      expect(deliver).not.toHaveBeenCalled()
      expect(await database.rows("SELECT status,attempt_count,next_attempt_at FROM outbox_delivery_receipts WHERE subscriber_id='paused-final'"))
        .toEqual([{ status: 'failed', attempt_count: 1, next_attempt_at: null }])
    })

    it('[regression] pauses unavailable provider intent without attempts, unrelated stalls or resending completed mail after restart', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await database.run(`INSERT INTO event_outbox
        (id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
        VALUES('unrelated','fixture',9,1,'fixture.changed','{}',?,?)`,sentAt,sentAt)
      let enabled = false, now = drainAt
      const mail = vi.fn(async () => {}), mirror = vi.fn(async () => {})
      const subscribers: OutboxSubscriber[] = [
        { id: 'mail', deliver: async event => { if (event.eventType === 'invoice.sent') await mail() } },
        { id: 'bill', available: async event => event.eventType !== 'invoice.sent' || enabled,
          deliver: async event => { if (event.eventType === 'invoice.sent') await mirror() } },
      ]
      const options = { subscribers, now: () => now, maxAttempts: 1, retryDelaySeconds: [] }
      expect(await database.outbox(options).drain()).toMatchObject({ failed: 0, retried: 0 })
      expect(mail).toHaveBeenCalledTimes(1)
      expect(mirror).not.toHaveBeenCalled()
      expect(await database.rows("SELECT status,attempt_count,last_error_code FROM outbox_delivery_receipts WHERE subscriber_id='bill' AND event_id='outbox-event-sent'"))
        .toEqual([{ status: 'pending', attempt_count: 0, last_error_code: null }])
      expect(await database.rows("SELECT id FROM event_outbox WHERE published_at IS NOT NULL"))
        .toEqual([{ id: 'unrelated' }])
      enabled = true
      now = '2026-09-02T10:03:00.000Z'
      const restarted = database.outbox(options)
      expect(await restarted.drain()).toMatchObject({ delivered: 1, failed: 0, retried: 0 })
      expect(mirror).toHaveBeenCalledTimes(1)
      expect(mail).toHaveBeenCalledTimes(1)
      expect(await database.rows("SELECT status,attempt_count FROM outbox_delivery_receipts WHERE subscriber_id='bill' AND event_id='outbox-event-sent'"))
        .toEqual([{ status: 'delivered', attempt_count: 1 }])
      expect(await database.rows('SELECT id FROM event_outbox WHERE published_at IS NULL')).toEqual([])
      expect(await restarted.drain()).toMatchObject({ examined: 0 })
      expect(mirror).toHaveBeenCalledTimes(1)
    })

    if (runtime === 'container') {
      it.each(['before', 'after'] as const)('[regression] finalizes once after a lost %s-commit completion response', async (when) => {
        database = await factory()
        await installFixture(database)
        await sendInvoice(database)
        const failure = new Error('D1_ERROR: Network connection lost.')
        let injected = false
        let activityWrites = 0
        const prepare = BetterSqlite3.prototype.prepare
        const transaction = BetterSqlite3.prototype.transaction
        vi.spyOn(BetterSqlite3.prototype, 'prepare').mockImplementation(function (
            this: BetterSqlite3.Database, query: string,
          ) {
            if (/INSERT INTO activity_log/u.test(query)) activityWrites++
            if (when === 'before' && !injected && /UPDATE outbox_delivery_receipts\s+SET status = 'delivered'/u.test(query)) {
              injected = true
              throw failure
            }
            return prepare.call(this, query)
          } as typeof prepare)
        if (when === 'after') {
          vi.spyOn(BetterSqlite3.prototype, 'transaction').mockImplementation(function (
            this: BetterSqlite3.Database, fn: () => unknown,
          ) {
            const commit = transaction.call(this, fn as never) as () => unknown
            return (() => {
              const result = commit()
              const receipt = this.prepare("SELECT status FROM outbox_delivery_receipts WHERE event_id='outbox-event-sent'").get() as { status: string } | undefined
              if (!injected && receipt?.status === 'delivered') {
                injected = true
                throw failure
              }
              return result
            }) as never
          } as never)
        }
        try {
          const service = database.outbox({ now: () => drainAt, createAttemptId: () => 'lost-completion' })
          await expect(service.drain()).resolves.toMatchObject({ examined: 1, failed: 0 })
          expect(injected).toBe(true)
          expect(await service.listActivity()).toHaveLength(1)
          expect(await service.listDeliveries()).toEqual([expect.objectContaining({ status: 'delivered', attemptCount: 1 })])
          expect(await database.rows('SELECT id FROM event_outbox WHERE published_at IS NOT NULL')).toHaveLength(1)
          await expect(service.drain()).resolves.toMatchObject({ examined: 0 })
          expect(await service.listActivity()).toHaveLength(1)
          expect(activityWrites).toBe(1)
        } finally {
          vi.restoreAllMocks()
        }
      })

      it.each(['before', 'after'] as const)('[regression:failure-finalization] preserves one terminal rejection after a lost %s-commit reply', async (when) => {
        database = await factory()
        await installFixture(database)
        await sendInvoice(database)
        const failure = new Error('D1_ERROR: Network connection lost.')
        let injected = false
        const deliver = vi.fn(async () => { throw new Error('private rejected handler detail') })
        const prepare = BetterSqlite3.prototype.prepare
        const transaction = BetterSqlite3.prototype.transaction
        vi.spyOn(BetterSqlite3.prototype, 'prepare').mockImplementation(function (
          this: BetterSqlite3.Database, query: string,
        ) {
          if (when === 'before' && !injected && /UPDATE outbox_delivery_receipts\s+SET status = \?/u.test(query)) {
            injected = true
            throw failure
          }
          return prepare.call(this, query)
        } as typeof prepare)
        if (when === 'after') {
          vi.spyOn(BetterSqlite3.prototype, 'transaction').mockImplementation(function (
            this: BetterSqlite3.Database, fn: () => unknown,
          ) {
            const commit = transaction.call(this, fn as never) as () => unknown
            return (() => {
              const result = commit()
              const receipt = this.prepare("SELECT status FROM outbox_delivery_receipts WHERE subscriber_id='rejecting' AND event_id='outbox-event-sent'").get() as { status: string } | undefined
              if (!injected && receipt?.status === 'failed') { injected = true; throw failure }
              return result
            }) as never
          } as never)
        }
        try {
          const service = database.outbox({ subscribers: [{ id: 'rejecting', deliver }], now: () => drainAt,
            createAttemptId: () => 'lost-failure-completion', maxAttempts: 1, retryDelaySeconds: [] })
          await expect(service.drain()).resolves.toMatchObject({ examined: 1, delivered: 0 })
          expect(injected).toBe(true)
          expect(deliver).toHaveBeenCalledTimes(1)
          const receipts = await service.listDeliveries()
          expect(receipts).toEqual([expect.objectContaining({ status: 'failed', attemptCount: 1,
            lastErrorCode: 'subscriber_rejected', failedAt: drainAt })])
          expect(JSON.stringify(receipts)).not.toContain('private rejected')
          expect(await database.rows('SELECT published_at,last_error FROM event_outbox')).toEqual([
            { published_at: null, last_error: 'subscriber_rejected' },
          ])
          await expect(service.drain()).resolves.toMatchObject({ examined: 0 })
          expect(deliver).toHaveBeenCalledTimes(1)
        } finally { vi.restoreAllMocks() }
      })

      it('[regression:claim-commit-loss] recovers a committed claim after its lease without replaying a handler', async () => {
        database = await factory()
        await installFixture(database)
        await sendInvoice(database)
        const transaction = BetterSqlite3.prototype.transaction
        const failure = new Error('D1_ERROR: Network connection lost.')
        let injected = false
        const deliver = vi.fn(async () => undefined)
        let now = drainAt
        let attempt = 0
        vi.spyOn(BetterSqlite3.prototype, 'transaction').mockImplementation(function (
          this: BetterSqlite3.Database, fn: () => unknown,
        ) {
          const commit = transaction.call(this, fn as never) as () => unknown
          return (() => {
            const result = commit()
            const receipt = this.prepare("SELECT status FROM outbox_delivery_receipts WHERE subscriber_id='owned' AND event_id='outbox-event-sent'").get() as { status: string } | undefined
            if (!injected && receipt?.status === 'processing') { injected = true; throw failure }
            return result
          }) as never
        } as never)
        try {
          const service = database.outbox({ subscribers: [{ id: 'owned', deliver }], now: () => now,
            createAttemptId: () => `owned-claim-${++attempt}`, handlerTimeoutMs: 10, attemptLeaseSeconds: 1 })
          await expect(service.drain()).resolves.toMatchObject({ examined: 1, delivered: 0, interrupted: failure })
          expect(injected).toBe(true)
          expect(deliver).not.toHaveBeenCalled()
          expect(await service.listDeliveries()).toEqual([expect.objectContaining({ status: 'processing', attemptCount: 1 })])
          await expect(service.drain()).resolves.toMatchObject({ examined: 0 })
          expect(deliver).not.toHaveBeenCalled()
          now = '2026-09-02T10:02:02.000Z'
          await expect(service.drain()).resolves.toMatchObject({ delivered: 1, failed: 0 })
          expect(deliver).toHaveBeenCalledTimes(1)
          expect(await service.listDeliveries()).toEqual([expect.objectContaining({ status: 'delivered', attemptCount: 2 })])
          await expect(service.drain()).resolves.toMatchObject({ examined: 0 })
          expect(deliver).toHaveBeenCalledTimes(1)
        } finally { vi.restoreAllMocks() }
      })

      it('[unit] a database failure while claiming ends the tick, reports it, and leaves the event for the next tick', async () => {
        database = await factory()
        await installFixture(database)
        await sendInvoice(database)
        const transaction = BetterSqlite3.prototype.transaction
        let transactions = 0
        vi.spyOn(BetterSqlite3.prototype, 'transaction').mockImplementation(function (
          this: BetterSqlite3.Database,
          fn: () => unknown,
        ) {
          transactions += 1
          if (transactions === 1) throw new Error('D1_ERROR: Network connection lost.')
          return transaction.call(this, fn as never)
        } as never)
        const service = database.outbox({
          now: () => drainAt,
          createAttemptId: () => 'activity-attempt-1',
        })

        const interrupted = await service.drain()
        expect(interrupted).toMatchObject({
          examined: 1,
          delivered: 0,
          interrupted: expect.objectContaining({ message: 'D1_ERROR: Network connection lost.' }),
        })
        expect(await service.listDeliveries()).toEqual([])
        vi.restoreAllMocks()

        await expect(service.drain()).resolves.toEqual({
          examined: 1,
          delivered: 1,
          retried: 0,
          failed: 0,
          contention: 0,
        })
      })
    }

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

    it('[unit] keeps capturing while the activity_log module is off: hiding is not stopping the evidence', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.activity_log', json('false'))`,
      )
      await sendInvoice(database)
      const service = database.outbox({
        now: () => drainAt,
        createAttemptId: () => 'activity-attempt-off',
      })

      await expect(service.drain()).resolves.toMatchObject({ delivered: 1, failed: 0 })
      expect(await service.listActivity()).toEqual([
        expect.objectContaining({ id: 'outbox-event-sent', eventType: 'invoice.sent' }),
      ])
    })

    it('[unit] preserves aggregate order and never invents missing import history', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await payInvoice(database, 1, 1, 'ordered')
      // Invoice 2 models an imported already-open invoice. Its native history
      // has no invoice.sent event -- it starts with the edit that gives it
      // something to owe, then its payment -- and the drainer must not
      // synthesize one.
      await executeInvoiceEdit(database.orm, {
        invoiceId: 2,
        commandId: 'imported-open-line',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: paidAt,
        eventIds: ['imported-open-line-updated'],
        edit: {
          type: 'line_insert',
          lineId: 201,
          position: 0,
          kind: 'Service',
          description: 'Outbox work',
          quantity: 1,
          unitPriceCents: 100,
          amountCents: 100,
        },
      })
      await payInvoice(database, 2, 1, 'imported-open')

      const delivered: string[] = []
      const byInvoice = new Map<number, string[]>()
      const subscriber: OutboxSubscriber = {
        id: 'capture',
        deliver: async (event) => {
          delivered.push(event.eventType)
          byInvoice.set(event.aggregateId, [
            ...(byInvoice.get(event.aggregateId) ?? []),
            event.eventType,
          ])
        },
      }
      const service = database.outbox({
        subscribers: [subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `ordered-attempt-${++id}`
        })(),
      })
      await expect(service.drain(10)).resolves.toMatchObject({ delivered: 6 })

      const sentIndex = delivered.indexOf('invoice.sent')
      const orderedPaidIndex = delivered.indexOf('invoice.paid')
      expect(sentIndex).toBeGreaterThanOrEqual(0)
      expect(orderedPaidIndex).toBeGreaterThan(sentIndex)
      expect(delivered.filter((type) => type === 'invoice.sent')).toHaveLength(1)
      // Each invoice's own history, in its own order; the second never gains
      // an invoice.sent it did not have.
      expect(byInvoice.get(1)).toEqual(['invoice.sent', 'payment.recorded', 'invoice.paid'])
      expect(byInvoice.get(2)).toEqual(['invoice.updated', 'payment.recorded', 'invoice.paid'])
    })

    it('[money] defers a waiting follow-up without exhausting failure attempts', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      let now = Date.parse(drainAt), ready = false
      const deliver = vi.fn(async () => { if (!ready) throw new FollowUpDeliveryDeferred() })
      const service = database.outbox({ subscribers: [{ id: 'invoice_thank_you', deliver }], now: () => new Date(now).toISOString(),
        createAttemptId: (() => { let id = 0; return () => `deferred-${++id}` })(), maxAttempts: 2, retryDelaySeconds: [60] })
      for (let i = 0; i < 6; i++) {
        await expect(service.drain()).resolves.toMatchObject({ retried: 1, failed: 0 })
        expect(await service.listDeliveries({ status: 'pending' })).toEqual([expect.objectContaining({ subscriberId: 'invoice_thank_you', attemptCount: 0 })])
        now += 300_000
      }
      ready = true
      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })
      expect(deliver).toHaveBeenCalledTimes(7)
    })

    it('[money] preserves prior real failures when the next follow-up attempt is deferred', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      let now = Date.parse(drainAt), state: 'failure' | 'waiting' | 'ready' = 'failure'
      const service = database.outbox({ subscribers: [{ id: 'invoice_thank_you', deliver: async () => {
        if (state === 'failure') throw new Error('fixture failure')
        if (state === 'waiting') throw new FollowUpDeliveryDeferred()
      } }], now: () => new Date(now).toISOString(), maxAttempts: 2, retryDelaySeconds: [60] })
      await expect(service.drain()).resolves.toMatchObject({ retried: 1 })
      now += 60_000; state = 'waiting'
      await expect(service.drain()).resolves.toMatchObject({ retried: 1, failed: 0 })
      expect(await service.listDeliveries({ status: 'pending' })).toEqual([
        expect.objectContaining({ subscriberId: 'invoice_thank_you', attemptCount: 1, lastErrorCode: 'subscriber_rejected' }),
      ])
      now += 300_000; state = 'ready'
      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })
    })

    it('[security] does not grant follow-up deferral to another subscriber', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      const service = database.outbox({ subscribers: [{ id: 'other', deliver: async () => { throw new FollowUpDeliveryDeferred() } }],
        now: () => drainAt, maxAttempts: 1, retryDelaySeconds: [] })
      await expect(service.drain()).resolves.toMatchObject({ failed: 1 })
      expect(await service.listDeliveries({ status: 'failed' })).toEqual([
        expect.objectContaining({ subscriberId: 'other', attemptCount: 1, lastErrorCode: 'subscriber_rejected' }),
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
