import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
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
import {
  createContainerReminderScheduler,
  createD1ReminderScheduler,
  type ReminderScheduler,
  type ScheduledReminderRecord,
} from '../src/reminders.js'

interface TestDatabase {
  orm: InvoiceStateDatabase
  outbox(subscribers: Parameters<typeof createContainerOutboxService>[1]): OutboxService
  reminder(): ReminderScheduler
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
    reminder: () => createContainerReminderScheduler(database),
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
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: (await import('../src/adapters.js')).createD1Database(d1),
    outbox: (options = {}) => createD1OutboxService(d1, options),
    reminder: () => createD1ReminderScheduler(d1),
    run: async (sql, ...bindings) => {
      await d1
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (
        await d1
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

const installFixture = async (
  database: TestDatabase,
  options: { reminderPolicy?: string | null } = {},
): Promise<void> => {
  const reminderPolicy =
    options.reminderPolicy === undefined
      ? '{"first_after_days":3,"every_days":7}'
      : options.reminderPolicy
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Reminder Test', '{"invoices":true}', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, created_at, updated_at
    ) VALUES (1, 'Casey', 'Ng', 'administrator', '[]', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Acme Corp', 'USD', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, state,
      reminder_policy, created_at, updated_at
    ) VALUES (1, 1, 'REM-1', 'USD', '2026-09-01', '2026-09-15', 'draft', ?, ?, ?)`,
    reminderPolicy,
    sentAt,
    sentAt,
  )
}

const sendInvoice = async (database: TestDatabase): Promise<void> => {
  await executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: 'reminder-send',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 201,
    eventId: 'reminder-event-sent',
  })
}

const payInvoice = async (database: TestDatabase): Promise<void> => {
  await recordInvoicePayment(database.orm, {
    invoiceId: 1,
    commandId: 'reminder-payment',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 1,
    occurredAt: paidAt,
    eventIds: ['reminder-payment-recorded', 'reminder-invoice-paid'],
    payment: {
      type: 'manual',
      id: 500,
      currency: 'USD',
      amountCents: 100,
      paidAt,
      paidDate: null,
      recordedByUserId: 1,
    },
  })
}

for (const [runtime, factory] of factories) {
  describe(`reminder scheduling (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] invoice.sent schedules a reminder when reminder_policy is configured', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      const scheduler = database.reminder()
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: () => 'reminder-schedule-attempt',
      })

      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })

      const pending = await scheduler.listPending(1)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        invoiceId: 1,
        // due_date 2026-09-15 + first_after_days 3 = 2026-09-18
        scheduledAt: '2026-09-18T00:00:00.000Z',
        intervalDays: 7,
        status: 'pending',
        template: 'reminder',
      })
    })

    it('[unit] invoice.sent does not schedule when reminder_policy is null', async () => {
      database = await factory()
      await installFixture(database, { reminderPolicy: null })
      await sendInvoice(database)

      const scheduler = database.reminder()
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: () => 'no-policy-attempt',
      })

      await expect(service.drain()).resolves.toMatchObject({ delivered: 1 })

      const pending = await scheduler.listPending(1)
      expect(pending).toHaveLength(0)
    })

    it('[unit] payment event cancels pending reminders', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      const scheduler = database.reminder()

      // First, drain the sent event to schedule the reminder
      const service1 = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `cancel-attempt-${++id}`
        })(),
      })
      await service1.drain()

      // Verify reminder is pending
      expect(await scheduler.listPending(1)).toHaveLength(1)

      // Now pay the invoice
      await payInvoice(database)

      // Drain the payment events — the invoice.paid event should cancel the reminder
      const service2 = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => '2026-09-02T10:03:00.000Z',
        createAttemptId: (() => {
          let id = 10
          return () => `cancel-attempt-${++id}`
        })(),
      })
      await service2.drain(10)

      // Verify reminder was cancelled
      const pending = await scheduler.listPending(1)
      expect(pending).toHaveLength(0)

      // Verify the row exists with cancelled status
      const allReminders = await database.rows<{ status: string }>(
        `SELECT status FROM scheduled_reminders WHERE invoice_id = 1`,
      )
      expect(allReminders).toEqual([{ status: 'cancelled' }])
    })

    it('[e2e:invoice-cycle] overdue fixture advances clock and reminder queued with correct template', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      const scheduler = database.reminder()

      // Drain the sent event to schedule the reminder
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `e2e-attempt-${++id}`
        })(),
      })
      await service.drain()

      // Verify the reminder is scheduled for due_date + first_after_days
      const pending = await scheduler.listPending(1)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.scheduledAt).toBe('2026-09-18T00:00:00.000Z')
      expect(pending[0]!.template).toBe('reminder')

      // Before the scheduled date, processReminders finds nothing
      const earlyResult = await scheduler.processReminders({
        now: '2026-09-17T23:59:59.000Z',
        send: vi.fn(),
      })
      expect(earlyResult).toEqual({ examined: 0, sent: 0, scheduled: 0 })

      // Advance clock past the scheduled reminder date
      const sentReminders: ScheduledReminderRecord[] = []
      const result = await scheduler.processReminders({
        now: '2026-09-18T09:00:00.000Z',
        send: async (reminder) => {
          sentReminders.push(reminder)
        },
      })

      expect(result).toEqual({ examined: 1, sent: 1, scheduled: 1 })
      expect(sentReminders).toHaveLength(1)
      expect(sentReminders[0]).toMatchObject({
        invoiceId: 1,
        template: 'reminder',
        intervalDays: 7,
      })

      // Verify it was marked as sent
      const afterSent = await database.rows<{ status: string; scheduled_at: string }>(
        `SELECT status, scheduled_at FROM scheduled_reminders WHERE invoice_id = 1 ORDER BY id`,
      )
      expect(afterSent).toEqual([
        { status: 'sent', scheduled_at: '2026-09-18T00:00:00.000Z' },
        { status: 'pending', scheduled_at: '2026-09-25T00:00:00.000Z' },
      ])

      // Process again at the next interval
      const sentReminders2: ScheduledReminderRecord[] = []
      const result2 = await scheduler.processReminders({
        now: '2026-09-25T09:00:00.000Z',
        send: async (reminder) => {
          sentReminders2.push(reminder)
        },
      })

      expect(result2).toEqual({ examined: 1, sent: 1, scheduled: 1 })
      expect(sentReminders2[0]).toMatchObject({
        invoiceId: 1,
        template: 'reminder',
        scheduledAt: '2026-09-25T00:00:00.000Z',
      })
    })

    it('[unit] processReminders cancels reminders for invoices no longer open', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      const scheduler = database.reminder()
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: () => 'stale-attempt',
      })
      await service.drain()

      // Directly update invoice state to simulate it being paid without going
      // through the outbox (e.g. direct import reconciliation)
      await database.run(
        `UPDATE invoices SET state = 'paid', paid_at = ?, version = 2,
         updated_at = ? WHERE id = 1`,
        paidAt,
        paidAt,
      )

      const result = await scheduler.processReminders({
        now: '2026-09-18T09:00:00.000Z',
        send: vi.fn(),
      })

      // The reminder was examined but auto-cancelled, not sent
      expect(result).toEqual({ examined: 1, sent: 0, scheduled: 0 })
      expect(await scheduler.listPending(1)).toHaveLength(0)
    })

    it('[unit] subscriber is idempotent — duplicate sent events do not create duplicate reminders', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      const scheduler = database.reminder()

      // Drain twice — the subscriber should not create a second reminder
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `idempotent-attempt-${++id}`
        })(),
      })
      await service.drain()

      // The event is already delivered, but let's simulate a second delivery
      // by calling the subscriber directly
      await scheduler.subscriber.deliver(
        {
          id: 'reminder-event-sent-duplicate',
          aggregateType: 'invoice',
          aggregateId: 1,
          aggregateSequence: 99,
          eventType: 'invoice.sent',
          payload: {},
          occurredAt: sentAt,
          availableAt: sentAt,
        },
        {
          idempotencyKey: 'duplicate',
          attemptId: 'duplicate-attempt',
          recordedAt: drainAt,
          signal: AbortSignal.timeout(5000),
        },
      )

      const pending = await scheduler.listPending(1)
      expect(pending).toHaveLength(1)
    })

    it('[unit] processReminders respects the limit parameter', async () => {
      database = await factory()
      await installFixture(database)
      // Create a second invoice
      await database.run(
        `INSERT INTO invoices (
          id, client_id, number, currency, issue_date, due_date, state,
          reminder_policy, created_at, updated_at
        ) VALUES (2, 1, 'REM-2', 'USD', '2026-09-01', '2026-09-10', 'open',
          '{"first_after_days":0,"every_days":5}', ?, ?)`,
        sentAt,
        sentAt,
      )
      await sendInvoice(database)

      const scheduler = database.reminder()
      const service = database.outbox({
        subscribers: [scheduler.subscriber],
        now: () => drainAt,
        createAttemptId: (() => {
          let id = 0
          return () => `limit-attempt-${++id}`
        })(),
      })
      await service.drain()

      // Manually insert a second reminder for invoice 2
      await database.run(
        `INSERT INTO scheduled_reminders (
          invoice_id, scheduled_at, interval_days, status, template,
          causation_event_id, created_at, updated_at
        ) VALUES (2, '2026-09-10T00:00:00.000Z', 5, 'pending', 'reminder',
          'manual-causation', ?, ?)`,
        drainAt,
        drainAt,
      )

      const sentReminders: ScheduledReminderRecord[] = []
      const result = await scheduler.processReminders({
        now: '2026-09-20T00:00:00.000Z',
        limit: 1,
        send: async (reminder) => {
          sentReminders.push(reminder)
        },
      })

      expect(result.examined).toBe(1)
      expect(result.sent).toBe(1)
      expect(sentReminders).toHaveLength(1)
    })
  })
}
