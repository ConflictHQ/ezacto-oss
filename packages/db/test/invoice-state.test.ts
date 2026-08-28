import { InvoiceLifecycleError } from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  deleteInvoicePayment,
  executeInvoiceLifecycleCommand,
  executeInvoiceEdit,
  InvoiceCommandReuseError,
  InvoiceTriggerRowConflictError,
  InvoiceVersionConflictError,
  recordInvoicePayment,
  updateInvoicePayment,
} from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { reconcileImportedInvoice } from '../src/internal/invoice-import.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'

type OperationDatabase = Parameters<typeof executeInvoiceLifecycleCommand>[0]

interface TestDatabase {
  orm: OperationDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  mutateBeforeNextAtomic(sql: string, ...params: unknown[]): void
  close(): Promise<void>
}

const timestamp = '2026-08-27T12:00:00.000Z'
const laterTimestamp = '2026-08-27T12:00:01.000Z'
const thirdTimestamp = '2026-08-27T12:00:02.000Z'
const fourthTimestamp = '2026-08-27T12:00:03.000Z'
const fifthTimestamp = '2026-08-27T12:00:04.000Z'
const authorize = async (): Promise<boolean> => true
const eventPayloadKeys = [
  'actor',
  'aggregate',
  'command',
  'event_id',
  'event_type',
  'invoice',
  'occurred_at',
  'payment',
  'schema_version',
  'trigger',
]
const invoicePayloadKeys = [
  'amount_cents',
  'close_reason',
  'close_write_off_cents',
  'closed_at',
  'due_amount_cents',
  'paid_at',
  'paid_date',
  'payment_count',
  'payment_status',
  'sent_at',
  'state',
  'updated_at',
  'version',
  'written_off_cents',
]
const paymentPayloadKeys = [
  'amount_cents',
  'currency',
  'id',
  'paid_at',
  'paid_date',
  'provider',
  'shape',
]

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    mutateBeforeNextAtomic: (sql, ...params) => {
      const mutable = sqlite as unknown as {
        transaction: (callback: () => unknown) => () => unknown
      }
      const original = mutable.transaction.bind(sqlite)
      mutable.transaction = (callback) => {
        mutable.transaction = original
        return original(() => {
          sqlite.prepare(sql).run(...params)
          return callback()
        })
      }
    },
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(d1)
  const orm = createD1Database(d1)
  return {
    orm,
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
    migrateAgain: async () => migrateD1(d1),
    mutateBeforeNextAtomic: (sql, ...params) => {
      const originalClient = orm.$client
      const proxied = new Proxy(originalClient, {
        get: (target, property) => {
          if (property === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              Object.defineProperty(orm, '$client', { value: originalClient, configurable: true })
              await target
                .prepare(sql)
                .bind(...params)
                .run()
              return target.batch(statements)
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      Object.defineProperty(orm, '$client', { value: proxied, configurable: true })
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

it('[unit] rejects an unauthorized command before touching the database', async () => {
  let databaseTouched = false
  const unreachable = Object.defineProperty({}, '$client', {
    get: () => {
      databaseTouched = true
      throw new Error('database must not be touched')
    },
  }) as OperationDatabase
  await expect(
    executeInvoiceLifecycleCommand(unreachable, {
      invoiceId: 1,
      commandId: 'denied-before-database',
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => false,
      expectedVersion: 0,
      occurredAt: timestamp,
      messageId: 90,
      eventId: 'denied-event',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(databaseTouched).toBe(false)
})

const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const installThrough0005 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0005) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const installFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users
      (id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 'Sanitized', 'Actor', '[]', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES
      (1, 1, 'INV-STATE-1', 'USD', '2026-08-01', '2026-08-31', ?, ?),
      (2, 1, 'INV-STATE-2', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`invoice state operation (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] authorizes before lookup and reauthorizes a stored retry', async () => {
      database = await factory()
      await installFixture(database)
      const input = {
        invoiceId: 1,
        commandId: 'authorization-send',
        command: 'send' as const,
        actor: { type: 'user' as const, id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 91,
        eventId: 'authorization-event',
      }
      await executeInvoiceLifecycleCommand(database.orm, input)

      let retryAuthorizationCalls = 0
      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          ...input,
          authorize: async () => ++retryAuthorizationCalls === 1,
          occurredAt: laterTimestamp,
          eventId: 'unused-authorization-candidate',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(retryAuthorizationCalls).toBe(2)

      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          ...input,
          actor: { type: 'contact', id: 9 },
          authorize,
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandReuseError)
    })

    it('[unit] reads a concurrent system-view snapshot inside the atomic batch', async () => {
      database = await factory()
      await installFixture(database)
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'view-send',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 92,
        eventId: 'view-send-event',
      })
      database.mutateBeforeNextAtomic(
        `UPDATE invoices SET version = 7, updated_at = ? WHERE id = 1`,
        laterTimestamp,
      )
      // The test-only hook runs after the operation's preliminary read but before its batch.
      // Dropping the transition guard lets the hook model another already-authorized writer.
      await database.run(`DROP TRIGGER invoices_d22_transition_guard`)
      const viewed = await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'view-current',
        command: 'view',
        actor: { type: 'system', id: null },
        authorize,
        occurredAt: thirdTimestamp,
        messageId: 93,
        eventId: 'view-current-event',
      })
      expect(viewed).toMatchObject({ invoice: { version: 7, updated_at: laterTimestamp } })
      const [row] = await database.rows<{ payload_json: string }>(
        `SELECT payload_json FROM event_outbox WHERE id = 'view-current-event'`,
      )
      const payload = JSON.parse(row?.payload_json ?? '{}') as {
        schema_version: number
        aggregate: Record<string, unknown>
        command: Record<string, unknown>
        actor: Record<string, unknown>
        trigger: Record<string, unknown>
        invoice: { before: Record<string, unknown>; after: Record<string, unknown> }
        payment: Record<string, unknown>
      }
      expect(Object.keys(payload).sort()).toEqual(eventPayloadKeys)
      expect(payload.schema_version).toBe(1)
      expect(payload.aggregate).toEqual({ type: 'invoice', id: 1, sequence: 2 })
      expect(payload.command).toEqual({ id: 'view-current', kind: 'invoice.view', event_index: 0 })
      expect(payload.actor).toEqual({ type: 'system', id: null })
      expect(payload.trigger).toEqual({ type: 'invoice_message', id: 93 })
      expect(payload.payment).toEqual({ before: null, after: null })
      expect(Object.keys(payload.invoice.before).sort()).toEqual(invoicePayloadKeys)
      expect(Object.keys(payload.invoice.after).sort()).toEqual(invoicePayloadKeys)
      expect(payload.invoice.before).toEqual(payload.invoice.after)
      expect(payload.invoice.after).toMatchObject({ version: 7, updated_at: laterTimestamp })
    })

    it('[unit] atomically commits a lifecycle event and returns the original retry result', async () => {
      database = await factory()
      await installFixture(database)
      const first = await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'send-1',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 101,
        eventId: 'event-send-1',
      })
      expect(first).toMatchObject({
        schema_version: 1,
        event_ids: ['event-send-1'],
        first_aggregate_sequence: 1,
        event_count: 1,
        invoice: { id: 1, version: 1, state: 'open', payment_status: 'unpaid' },
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.state, invoice.version, message.event_type,
             ledger.completed, ledger.event_count, event.aggregate_sequence,
             event.command_id, event.event_index
           FROM invoices invoice
           JOIN invoice_messages message ON message.invoice_id = invoice.id
           JOIN invoice_command_ledger ledger ON ledger.invoice_id = invoice.id
           JOIN event_outbox event ON event.aggregate_id = invoice.id
           WHERE invoice.id = 1`,
        ),
      ).toEqual([
        {
          state: 'open',
          version: 1,
          event_type: 'send',
          completed: 1,
          event_count: 1,
          aggregate_sequence: 1,
          command_id: 'send-1',
          event_index: 0,
        },
      ])

      const retry = await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'send-1',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: laterTimestamp,
        messageId: 101,
        eventId: 'unused-retry-candidate',
      })
      expect(retry).toEqual(first)
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE aggregate_id = 1`,
        ),
      ).toEqual([{ count: 1 }])
      await expect(
        database.run(
          `DELETE FROM invoice_command_ledger WHERE invoice_id = 1 AND command_id = 'send-1'`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        database.run(`DELETE FROM event_outbox WHERE id = 'event-send-1'`),
      ).rejects.toThrow(/immutable/)

      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'send-1',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 0,
          occurredAt: timestamp,
          messageId: 999,
          eventId: 'event-reused-command',
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandReuseError)
      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'stale-send',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 0,
          occurredAt: laterTimestamp,
          messageId: 102,
          eventId: 'event-stale',
        }),
      ).rejects.toBeInstanceOf(InvoiceVersionConflictError)
      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 2,
          commandId: 'caller-view',
          command: 'view',
          actor: { type: 'user', id: 1 },
          authorize,
          occurredAt: timestamp,
          messageId: 103,
          eventId: 'event-illegal-view',
        }),
      ).rejects.toBeInstanceOf(InvoiceLifecycleError)
    })

    it('[unit] persists every legal lifecycle command across its state variants', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (3, 1, 'INV-STATE-3', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES
          (1101, 1, 0, 'Service', 1, 1000, 1000, ?, ?),
          (1103, 3, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      let messageId = 1200
      const lifecycle = async (
        invoiceId: number,
        commandId: string,
        command: 'send' | 'view' | 'draft' | 'cancel' | 'write_off' | 'reopen' | 'source_close',
        expectedVersion: number | undefined,
        occurredAt: string,
      ) =>
        executeInvoiceLifecycleCommand(database!.orm, {
          invoiceId,
          commandId,
          command,
          actor: command === 'view' ? { type: 'system', id: null } : { type: 'user', id: 1 },
          authorize,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          occurredAt,
          messageId: ++messageId,
          eventId: `${commandId}-event`,
        })

      await lifecycle(1, 'matrix-send-draft', 'send', 0, timestamp)
      await lifecycle(1, 'matrix-view-open', 'view', undefined, timestamp)
      await lifecycle(1, 'matrix-send-open', 'send', 1, timestamp)
      await lifecycle(1, 'matrix-draft-open', 'draft', 2, timestamp)
      await lifecycle(1, 'matrix-send-again', 'send', 3, timestamp)
      await lifecycle(1, 'matrix-write-off', 'write_off', 4, timestamp)
      await lifecycle(1, 'matrix-view-closed', 'view', undefined, timestamp)
      await lifecycle(1, 'matrix-reopen-written-off', 'reopen', 5, timestamp)
      await lifecycle(1, 'matrix-source-close-open', 'source_close', 6, timestamp)
      await lifecycle(1, 'matrix-reopen-source', 'reopen', 7, timestamp)
      await lifecycle(1, 'matrix-cancel-open', 'cancel', 8, timestamp)
      await lifecycle(1, 'matrix-reopen-cancelled', 'reopen', 9, timestamp)

      await lifecycle(2, 'matrix-cancel-draft', 'cancel', 0, laterTimestamp)
      await lifecycle(2, 'matrix-reopen-draft-cancel', 'reopen', 1, laterTimestamp)
      await lifecycle(2, 'matrix-return-draft', 'draft', 2, laterTimestamp)
      await lifecycle(2, 'matrix-source-close-draft', 'source_close', 3, laterTimestamp)

      await lifecycle(3, 'matrix-send-paid', 'send', 0, thirdTimestamp)
      await recordInvoicePayment(database.orm, {
        invoiceId: 3,
        commandId: 'matrix-record-paid',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: thirdTimestamp,
        eventIds: ['matrix-record-paid-event', 'matrix-paid-event'],
        payment: {
          type: 'manual',
          id: 1303,
          currency: 'USD',
          amountCents: 1000,
          paidAt: thirdTimestamp,
          paidDate: null,
        },
      })
      await lifecycle(3, 'matrix-view-paid', 'view', undefined, thirdTimestamp)
      await lifecycle(3, 'matrix-source-close-paid', 'source_close', 2, thirdTimestamp)
      await lifecycle(3, 'matrix-reopen-paid', 'reopen', 3, thirdTimestamp)

      for (const [invoiceId, command, expectedVersion] of [
        [2, 'send', 4],
        [3, 'draft', 4],
        [3, 'cancel', 4],
        [3, 'write_off', 4],
        [1, 'reopen', 10],
        [2, 'source_close', 4],
      ] as const) {
        await expect(
          lifecycle(
            invoiceId,
            `matrix-illegal-${command}`,
            command,
            expectedVersion,
            fourthTimestamp,
          ),
        ).rejects.toBeInstanceOf(InvoiceLifecycleError)
      }

      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, state, version, close_reason, close_write_off_cents,
             written_off_cents, due_amount_cents, paid_at, paid_date, closed_at
           FROM invoices ORDER BY id`,
        ),
      ).toEqual([
        {
          id: 1,
          state: 'open',
          version: 10,
          close_reason: null,
          close_write_off_cents: 0,
          written_off_cents: 0,
          due_amount_cents: 1000,
          paid_at: null,
          paid_date: null,
          closed_at: null,
        },
        {
          id: 2,
          state: 'closed',
          version: 4,
          close_reason: 'source_closed',
          close_write_off_cents: 0,
          written_off_cents: 0,
          due_amount_cents: 0,
          paid_at: null,
          paid_date: null,
          closed_at: laterTimestamp,
        },
        {
          id: 3,
          state: 'paid',
          version: 4,
          close_reason: null,
          close_write_off_cents: 0,
          written_off_cents: 0,
          due_amount_cents: 0,
          paid_at: thirdTimestamp,
          paid_date: null,
          closed_at: null,
        },
      ])
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM event_outbox
           WHERE aggregate_id = 1 ORDER BY aggregate_sequence`,
        ),
      ).toEqual(
        [
          'invoice.sent',
          'invoice.viewed',
          'invoice.sent',
          'invoice.drafted',
          'invoice.sent',
          'invoice.written_off',
          'invoice.viewed',
          'invoice.reopened',
          'invoice.closed',
          'invoice.reopened',
          'invoice.cancelled',
          'invoice.reopened',
        ].map((event_type) => ({ event_type })),
      )
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM event_outbox
           WHERE aggregate_id = 2 ORDER BY aggregate_sequence`,
        ),
      ).toEqual(
        ['invoice.cancelled', 'invoice.reopened', 'invoice.drafted', 'invoice.closed'].map(
          (event_type) => ({ event_type }),
        ),
      )
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM event_outbox
           WHERE aggregate_id = 3 ORDER BY aggregate_sequence`,
        ),
      ).toEqual(
        [
          'invoice.sent',
          'payment.recorded',
          'invoice.paid',
          'invoice.viewed',
          'invoice.closed',
          'invoice.reopened',
        ].map((event_type) => ({ event_type })),
      )
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM invoice_messages ORDER BY id`,
        ),
      ).toEqual(
        [
          'send',
          'view',
          'send',
          'draft',
          'send',
          'write_off',
          'view',
          're-open',
          'close',
          're-open',
          'cancel',
          're-open',
          'cancel',
          're-open',
          'draft',
          'close',
          'send',
          'view',
          'close',
          're-open',
        ].map((event_type) => ({ event_type })),
      )
      expect(
        await database.rows<{ ledger: number; outbox: number }>(
          `SELECT
             (SELECT count(*) FROM invoice_command_ledger
               WHERE command_id LIKE 'matrix-illegal-%') AS ledger,
             (SELECT count(*) FROM event_outbox
               WHERE command_id LIKE 'matrix-illegal-%') AS outbox`,
        ),
      ).toEqual([{ ledger: 0, outbox: 0 }])
    })

    it('[unit] rolls back a late outbox collision and permits a clean retry', async () => {
      database = await factory()
      await installFixture(database)
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 2,
        commandId: 'send-owner',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 201,
        eventId: 'shared-event-id',
      })

      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'send-late-failure',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 0,
          occurredAt: timestamp,
          messageId: 202,
          eventId: 'shared-event-id',
        }),
      ).rejects.toMatchObject({ code: 'command_storage_conflict' })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT state, version,
             (SELECT count(*) FROM invoice_messages WHERE invoice_id = 1) AS messages,
             (SELECT count(*) FROM invoice_command_ledger WHERE invoice_id = 1) AS ledger,
             (SELECT count(*) FROM event_outbox WHERE aggregate_id = 1) AS events
           FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ state: 'draft', version: 0, messages: 0, ledger: 0, events: 0 }])

      const retried = await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'send-late-failure',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 202,
        eventId: 'replacement-event-id',
      })
      expect(retried).toMatchObject({
        event_ids: ['replacement-event-id'],
        invoice: { state: 'open', version: 1 },
      })
    })

    it('[unit] orders payment events before paid, partial, and unpaid outcomes', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'send-payment-invoice',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 301,
        eventId: 'event-payment-send',
      })
      await expect(
        database.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
             created_at, updated_at)
           VALUES (999, 1, 'USD', 1, ?, 'manual', 'manual', ?, ?)`,
          laterTimestamp,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/pending command/)

      const recorded = await recordInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId: 'record-payment-1',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: laterTimestamp,
        eventIds: ['event-payment-recorded', 'event-invoice-paid'],
        payment: {
          type: 'manual',
          id: 401,
          currency: 'USD',
          amountCents: 1000,
          paidAt: laterTimestamp,
          paidDate: null,
        },
      })
      expect(recorded).toMatchObject({
        event_ids: ['event-payment-recorded', 'event-invoice-paid'],
        event_count: 2,
        invoice: { version: 2, state: 'paid', due_amount_cents: 0, payment_count: 1 },
      })
      await expect(
        recordInvoicePayment(database.orm, {
          invoiceId: 1,
          commandId: 'record-payment-1',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 1,
          occurredAt: laterTimestamp,
          eventIds: ['unused-record-event', 'unused-paid-event'],
          payment: {
            type: 'manual',
            id: 401,
            currency: 'USD',
            amountCents: 1000,
            paidAt: laterTimestamp,
            paidDate: null,
            notes: null,
          },
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandReuseError)
      await expect(
        database.run(`UPDATE invoice_payments SET notes = 'raw' WHERE id = 401`),
      ).rejects.toThrow(/pending command/)
      await expect(database.run(`DELETE FROM invoice_payments WHERE id = 401`)).rejects.toThrow(
        /pending command/,
      )

      const updated = await updateInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId: 'update-payment-1',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 2,
        occurredAt: thirdTimestamp,
        eventIds: ['event-payment-updated', 'event-invoice-partial'],
        paymentId: 401,
        expectedPaymentUpdatedAt: laterTimestamp,
        amountCents: 500,
        paidAt: thirdTimestamp,
        paidDate: null,
      })
      expect(updated).toMatchObject({
        event_ids: ['event-payment-updated', 'event-invoice-partial'],
        invoice: { version: 3, state: 'open', due_amount_cents: 500, payment_count: 1 },
      })
      await expect(
        updateInvoicePayment(database.orm, {
          invoiceId: 1,
          commandId: 'update-payment-1',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 2,
          occurredAt: thirdTimestamp,
          eventIds: ['unused-update-event', 'unused-partial-event'],
          paymentId: 401,
          expectedPaymentUpdatedAt: laterTimestamp,
          amountCents: 500,
          paidAt: thirdTimestamp,
          paidDate: null,
          notes: null,
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandReuseError)

      const deleted = await deleteInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId: 'delete-payment-1',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 3,
        occurredAt: fourthTimestamp,
        eventIds: ['event-payment-deleted', 'event-invoice-unpaid'],
        paymentId: 401,
        expectedPaymentUpdatedAt: thirdTimestamp,
      })
      expect(deleted).toMatchObject({
        event_ids: ['event-payment-deleted', 'event-invoice-unpaid'],
        invoice: { version: 4, state: 'open', due_amount_cents: 1000, payment_count: 0 },
      })
      expect(
        await database.rows<{ event_type: string; event_index: number }>(
          `SELECT event_type, event_index FROM event_outbox
           WHERE aggregate_id = 1 AND command_id IN
             ('record-payment-1','update-payment-1','delete-payment-1')
           ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'payment.recorded', event_index: 0 },
        { event_type: 'invoice.paid', event_index: 1 },
        { event_type: 'payment.updated', event_index: 0 },
        { event_type: 'invoice.partially_paid', event_index: 1 },
        { event_type: 'payment.deleted', event_index: 0 },
        { event_type: 'invoice.unpaid', event_index: 1 },
      ])
      const payloadRows = await database.rows<{ command_id: string; payload_json: string }>(
        `SELECT command_id, payload_json FROM event_outbox
         WHERE aggregate_id = 1 AND event_index = 0 AND command_id IN
           ('record-payment-1','update-payment-1','delete-payment-1')
         ORDER BY aggregate_sequence`,
      )
      const payloads = payloadRows.map(({ payload_json: payloadJson }) =>
        JSON.parse(payloadJson),
      ) as Array<{
        aggregate: Record<string, unknown>
        command: Record<string, unknown>
        actor: Record<string, unknown>
        trigger: Record<string, unknown>
        invoice: { before: Record<string, unknown>; after: Record<string, unknown> }
        payment: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }
      }>
      expect(payloadRows.map(({ command_id: commandId }) => commandId)).toEqual([
        'record-payment-1',
        'update-payment-1',
        'delete-payment-1',
      ])
      for (const payload of payloads) {
        expect(Object.keys(payload).sort()).toEqual(eventPayloadKeys)
        expect(Object.keys(payload.invoice.before).sort()).toEqual(invoicePayloadKeys)
        expect(Object.keys(payload.invoice.after).sort()).toEqual(invoicePayloadKeys)
        expect(payload.actor).toEqual({ type: 'user', id: 1 })
        expect(payload.trigger).toEqual({ type: 'invoice_payment', id: 401 })
        if (payload.payment.before !== null) {
          expect(Object.keys(payload.payment.before).sort()).toEqual(paymentPayloadKeys)
        }
        if (payload.payment.after !== null) {
          expect(Object.keys(payload.payment.after).sort()).toEqual(paymentPayloadKeys)
        }
      }
      expect(payloads[0]).toMatchObject({
        aggregate: { type: 'invoice', id: 1, sequence: 2 },
        command: { id: 'record-payment-1', kind: 'payment.record', event_index: 0 },
        invoice: {
          before: { version: 1, state: 'open', due_amount_cents: 1000, payment_count: 0 },
          after: { version: 2, state: 'paid', due_amount_cents: 0, payment_count: 1 },
        },
        payment: {
          before: null,
          after: {
            id: 401,
            amount_cents: 1000,
            currency: 'USD',
            provider: 'manual',
            shape: 'manual',
            paid_at: laterTimestamp,
            paid_date: null,
          },
        },
      })
      expect(payloads[1]?.payment).toEqual({
        before: {
          id: 401,
          amount_cents: 1000,
          currency: 'USD',
          provider: 'manual',
          shape: 'manual',
          paid_at: laterTimestamp,
          paid_date: null,
        },
        after: {
          id: 401,
          amount_cents: 500,
          currency: 'USD',
          provider: 'manual',
          shape: 'manual',
          paid_at: thirdTimestamp,
          paid_date: null,
        },
      })
      expect(payloads[2]?.payment).toEqual({
        before: {
          id: 401,
          amount_cents: 500,
          currency: 'USD',
          provider: 'manual',
          shape: 'manual',
          paid_at: thirdTimestamp,
          paid_date: null,
        },
        after: null,
      })
      expect(
        payloadRows.map(({ payload_json: payloadJson }) => payloadJson).join('\n'),
      ).not.toMatch(/recipients|message_body|sent_by_email|credential|card_data/i)
    })

    it('[unit] returns an exact bank-confirmation retry after the deposit is confirmed', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (8, 1, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'bank-send',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 801,
        eventId: 'bank-send-event',
      })
      await database.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (8, 'wise', 'reconciliation', 'account-8', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (8, 8, 'deposit-8', 'USD', ?, 1000, 'suggested', 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      const input = {
        invoiceId: 1,
        commandId: 'bank-confirm',
        actor: { type: 'user' as const, id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: laterTimestamp,
        eventIds: ['bank-payment-recorded', 'bank-invoice-paid'],
        payment: {
          type: 'bank_deposit' as const,
          id: 802,
          depositId: 8,
          expectedDepositUpdatedAt: timestamp,
          expectedMatchState: 'suggested' as const,
          paidAt: timestamp,
        },
      }
      const confirmed = await recordInvoicePayment(database.orm, input)
      expect(confirmed).toMatchObject({ invoice: { state: 'paid', version: 2 } })
      const retried = await recordInvoicePayment(database.orm, {
        ...input,
        occurredAt: thirdTimestamp,
        eventIds: ['unused-bank-retry-event'],
      })
      expect(retried).toEqual(confirmed)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT match_state,
             (SELECT count(*) FROM invoice_payments WHERE bank_deposit_id = 8) AS payments,
             (SELECT count(*) FROM event_outbox WHERE command_id = 'bank-confirm') AS events
           FROM bank_deposits WHERE id = 8`,
        ),
      ).toEqual([{ match_state: 'confirmed', payments: 1, events: 2 }])
    })

    it('[unit] rejects stale mutable trigger rows without consuming ledger or outbox identity', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES
          (1501, 1, 0, 'Service', 1, 1000, 1000, ?, ?),
          (1502, 2, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()

      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'trigger-fixture-send-1',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 1501,
        eventId: 'trigger-fixture-send-event-1',
      })
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 2,
        commandId: 'trigger-fixture-send-2',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 1502,
        eventId: 'trigger-fixture-send-event-2',
      })
      await recordInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId: 'trigger-fixture-payment',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: laterTimestamp,
        eventIds: ['trigger-fixture-payment-event', 'trigger-fixture-partial-event'],
        payment: {
          type: 'manual',
          id: 1503,
          currency: 'USD',
          amountCents: 400,
          paidAt: laterTimestamp,
          paidDate: null,
        },
      })
      await database.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (15, 'wise', 'reconciliation', 'account-15', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (15, 15, 'deposit-15', 'USD', ?, 1000, 'suggested', 2, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )

      await expect(
        updateInvoicePayment(database.orm, {
          invoiceId: 1,
          commandId: 'stale-trigger-payment-update',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 2,
          occurredAt: thirdTimestamp,
          eventIds: ['stale-trigger-payment-update-event'],
          paymentId: 1503,
          expectedPaymentUpdatedAt: fifthTimestamp,
          amountCents: 300,
          paidAt: thirdTimestamp,
          paidDate: null,
        }),
      ).rejects.toBeInstanceOf(InvoiceTriggerRowConflictError)
      await expect(
        deleteInvoicePayment(database.orm, {
          invoiceId: 1,
          commandId: 'stale-trigger-payment-delete',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 2,
          occurredAt: thirdTimestamp,
          eventIds: ['stale-trigger-payment-delete-event'],
          paymentId: 1503,
          expectedPaymentUpdatedAt: fifthTimestamp,
        }),
      ).rejects.toBeInstanceOf(InvoiceTriggerRowConflictError)
      await expect(
        executeInvoiceEdit(database.orm, {
          invoiceId: 1,
          commandId: 'stale-trigger-line-update',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 2,
          occurredAt: thirdTimestamp,
          eventIds: ['stale-trigger-line-update-event'],
          edit: {
            type: 'line_update',
            lineId: 1501,
            expectedLineUpdatedAt: fifthTimestamp,
            position: 0,
            kind: 'Service',
            quantity: 1,
            unitPriceCents: 900,
            amountCents: 900,
            taxed: false,
            taxed2: false,
          },
        }),
      ).rejects.toBeInstanceOf(InvoiceTriggerRowConflictError)
      await expect(
        executeInvoiceEdit(database.orm, {
          invoiceId: 1,
          commandId: 'stale-trigger-line-delete',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 2,
          occurredAt: thirdTimestamp,
          eventIds: ['stale-trigger-line-delete-event'],
          edit: {
            type: 'line_delete',
            lineId: 1501,
            expectedLineUpdatedAt: fifthTimestamp,
          },
        }),
      ).rejects.toBeInstanceOf(InvoiceTriggerRowConflictError)
      await expect(
        recordInvoicePayment(database.orm, {
          invoiceId: 2,
          commandId: 'stale-trigger-bank-record',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 1,
          occurredAt: thirdTimestamp,
          eventIds: ['stale-trigger-bank-record-event'],
          payment: {
            type: 'bank_deposit',
            id: 1504,
            depositId: 15,
            expectedDepositUpdatedAt: fifthTimestamp,
            expectedMatchState: 'suggested',
            paidAt: thirdTimestamp,
          },
        }),
      ).rejects.toBeInstanceOf(InvoiceTriggerRowConflictError)

      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, state, version, due_amount_cents,
             (SELECT count(*) FROM invoice_payments payment
               WHERE payment.invoice_id = invoices.id) AS payment_count
           FROM invoices ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, state: 'open', version: 2, due_amount_cents: 600, payment_count: 1 },
        { id: 2, state: 'open', version: 1, due_amount_cents: 1000, payment_count: 0 },
      ])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, amount_cents, updated_at FROM invoice_payments ORDER BY id`,
        ),
      ).toEqual([{ id: 1503, amount_cents: 400, updated_at: laterTimestamp }])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, amount_cents, updated_at FROM invoice_line_items ORDER BY id`,
        ),
      ).toEqual([
        { id: 1501, amount_cents: 1000, updated_at: timestamp },
        { id: 1502, amount_cents: 1000, updated_at: timestamp },
      ])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT match_state,
             (SELECT count(*) FROM invoice_payments WHERE bank_deposit_id = 15) AS payments
           FROM bank_deposits WHERE id = 15`,
        ),
      ).toEqual([{ match_state: 'suggested', payments: 0 }])
      expect(
        await database.rows<{ ledger: number; outbox: number }>(
          `SELECT
             (SELECT count(*) FROM invoice_command_ledger
               WHERE command_id LIKE 'stale-trigger-%') AS ledger,
             (SELECT count(*) FROM event_outbox
               WHERE command_id LIKE 'stale-trigger-%') AS outbox`,
        ),
      ).toEqual([{ ledger: 0, outbox: 0 }])
    })

    it('[unit] emits invoice.updated before a line edit payment outcome', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'send-edit-invoice',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 501,
        eventId: 'event-edit-send',
      })
      await recordInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId: 'record-edit-payment',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: laterTimestamp,
        eventIds: ['event-edit-payment', 'event-edit-paid'],
        payment: {
          type: 'manual',
          id: 502,
          currency: 'USD',
          amountCents: 1000,
          paidAt: laterTimestamp,
          paidDate: null,
        },
      })
      const edited = await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'line-edit-1',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 2,
        occurredAt: thirdTimestamp,
        eventIds: ['event-invoice-updated', 'event-edit-partial'],
        edit: {
          type: 'line_update',
          lineId: 1,
          expectedLineUpdatedAt: timestamp,
          position: 0,
          kind: 'Service',
          quantity: 1,
          unitPriceCents: 2000,
          amountCents: 2000,
          taxed: false,
          taxed2: false,
        },
      })
      expect(edited).toMatchObject({
        event_ids: ['event-invoice-updated', 'event-edit-partial'],
        invoice: {
          version: 3,
          state: 'open',
          amount_cents: 2000,
          due_amount_cents: 1000,
        },
      })
      expect(
        await database.rows<{ event_type: string; event_index: number }>(
          `SELECT event_type, event_index FROM event_outbox
           WHERE aggregate_id = 1 AND command_id = 'line-edit-1'
           ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'invoice.updated', event_index: 0 },
        { event_type: 'invoice.partially_paid', event_index: 1 },
      ])
    })

    it('[unit] applies the full draft edit surface and rejects closed edits', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (2, 'Second Client', 'EUR', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO projects (id, client_id, name, created_at, updated_at)
         VALUES (2, 2, 'Second Client Project', ?, ?)`,
        timestamp,
        timestamp,
      )
      const header = await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'edit-header',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        eventIds: ['edit-header-event'],
        edit: {
          type: 'header',
          clientId: 2,
          number: 'INV-STATE-EDITED',
          subject: 'Updated subject',
          purchaseOrder: 'PO-88',
          currency: 'EUR',
          issueDate: '2026-08-02',
          dueDate: '2026-09-01',
          paymentTerms: 'net_15',
          projectId: 2,
          reminderPolicy: { first_after_days: 3, every_days: 7 },
        },
      })
      expect(header).toMatchObject({ event_count: 1, invoice: { state: 'draft', version: 1 } })

      await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'edit-options',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: laterTimestamp,
        eventIds: ['edit-options-event'],
        edit: { type: 'payment_options', paymentOptions: ['wise_transfer'] },
      })
      await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'edit-line-insert',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 2,
        occurredAt: thirdTimestamp,
        eventIds: ['edit-line-insert-event'],
        edit: {
          type: 'line_insert',
          lineId: 88,
          position: 0,
          kind: 'Service',
          quantity: 1,
          unitPriceCents: 1000,
          amountCents: 1000,
        },
      })
      await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'edit-line-delete',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 3,
        occurredAt: fourthTimestamp,
        eventIds: ['edit-line-delete-event'],
        edit: {
          type: 'line_delete',
          lineId: 88,
          expectedLineUpdatedAt: thirdTimestamp,
        },
      })
      const financials = await executeInvoiceEdit(database.orm, {
        invoiceId: 1,
        commandId: 'edit-financials',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 4,
        occurredAt: fourthTimestamp,
        eventIds: ['edit-financials-event'],
        edit: {
          type: 'financials',
          taxRatePpm: 100_000,
          tax2RatePpm: null,
          discountRatePpm: null,
        },
      })
      expect(financials).toMatchObject({ event_count: 1, invoice: { state: 'draft', version: 5 } })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT client_id, number, subject, purchase_order, currency,
             issue_date, due_date, payment_terms, project_id, reminder_policy,
             payment_options, tax_rate_ppm,
             (SELECT count(*) FROM invoice_line_items WHERE invoice_id = 1) AS lines
           FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          client_id: 2,
          number: 'INV-STATE-EDITED',
          subject: 'Updated subject',
          purchase_order: 'PO-88',
          currency: 'EUR',
          issue_date: '2026-08-02',
          due_date: '2026-09-01',
          payment_terms: 'net_15',
          project_id: 2,
          reminder_policy: '{"every_days":7,"first_after_days":3}',
          payment_options: '["wise_transfer"]',
          tax_rate_ppm: 100_000,
          lines: 0,
        },
      ])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT command_id, event_type,
             json_extract(payload_json, '$.trigger.type') AS trigger_type
           FROM event_outbox WHERE command_id LIKE 'edit-%' ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        {
          command_id: 'edit-header',
          event_type: 'invoice.updated',
          trigger_type: 'invoice_header',
        },
        {
          command_id: 'edit-options',
          event_type: 'invoice.updated',
          trigger_type: 'invoice_header',
        },
        {
          command_id: 'edit-line-insert',
          event_type: 'invoice.updated',
          trigger_type: 'invoice_line_item',
        },
        {
          command_id: 'edit-line-delete',
          event_type: 'invoice.updated',
          trigger_type: 'invoice_line_item',
        },
        {
          command_id: 'edit-financials',
          event_type: 'invoice.updated',
          trigger_type: 'invoice_financials',
        },
      ])

      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'close-after-edits',
        command: 'cancel',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 5,
        occurredAt: fourthTimestamp,
        messageId: 889,
        eventId: 'close-after-edits-event',
      })
      await expect(
        executeInvoiceEdit(database.orm, {
          invoiceId: 1,
          commandId: 'closed-header-edit',
          actor: { type: 'user', id: 1 },
          authorize,
          expectedVersion: 6,
          occurredAt: fourthTimestamp,
          eventIds: ['closed-header-edit-event'],
          edit: { type: 'header', subject: 'Rejected' },
        }),
      ).rejects.toMatchObject({ code: 'invoice_closed' })
    })

    it('[unit] rejects hostile command-kind, event, and existing-edit bypasses', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (98, 1, 0, 'Assembly line', 1, 100, 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1,
        commandId: 'guard-send-owner',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 980,
        eventId: 'guard-send-owner-event',
      })
      await expect(
        database.run(`UPDATE invoices SET subject = 'raw' WHERE id = 1`),
      ).rejects.toThrow(/pending command/)
      for (const mutation of [
        `number = 'RAW-NUMBER'`,
        `client_id = 2`,
        `project_id = 999`,
        `currency = 'EUR'`,
        `reminder_policy = '{"first_after_days":1}'`,
        `client_key = '${'a'.repeat(64)}'`,
      ]) {
        await expect(database.run(`UPDATE invoices SET ${mutation} WHERE id = 1`)).rejects.toThrow(
          /pending command/,
        )
      }
      await expect(
        database.run(`UPDATE invoices SET period_start = '2026-08-02' WHERE id = 1`),
      ).rejects.toThrow(/period is derived/)
      await expect(
        database.run(`UPDATE invoices SET updated_at = ? WHERE id = 1`, laterTimestamp),
      ).rejects.toThrow(/pending command/)
      await expect(
        database.run(`UPDATE invoices SET created_at = ? WHERE id = 1`, laterTimestamp),
      ).rejects.toThrow(/created_at is immutable/)
      await expect(
        database.run(`UPDATE invoices SET tax_rate_ppm = 1000 WHERE id = 1`),
      ).rejects.toThrow(/pending command/)
      await expect(
        database.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             created_at, updated_at)
           VALUES (99, 1, 1, 'Raw line', 1, 1, 1, ?, ?)`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/pending command/)
      await expect(
        database.run(`UPDATE invoice_line_items SET description = 'raw' WHERE id = 98`),
      ).rejects.toThrow(/pending command/)
      await expect(database.run(`DELETE FROM invoice_line_items WHERE id = 98`)).rejects.toThrow(
        /pending command/,
      )

      const fingerprint = `sha256:${'a'.repeat(64)}`
      await database.run(
        `INSERT INTO invoice_command_ledger
          (invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
           expected_invoice_version, occurred_at)
         VALUES (2, 'raw-send-cancel', 'invoice.send', ?, 'user', 1, 0, ?)`,
        fingerprint,
        laterTimestamp,
      )
      await expect(
        database.run(
          `UPDATE invoices SET state = 'closed', close_reason = 'cancelled',
             closed_at = ?, version = 1, updated_at = ? WHERE id = 2 AND version = 0`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/pending command/)

      await database.run(
        `INSERT INTO invoice_command_ledger
          (invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
           expected_invoice_version, occurred_at)
         VALUES (1, 'raw-send-event', 'invoice.send', ?, 'user', 1, 1, ?)`,
        `sha256:${'b'.repeat(64)}`,
        laterTimestamp,
      )
      await database.run(
        `UPDATE invoices SET state = 'open', version = 2, updated_at = ?
         WHERE id = 1 AND version = 1`,
        laterTimestamp,
      )
      await expect(
        database.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
             command_id, event_index, payload_json, occurred_at, available_at)
           VALUES ('raw-unrelated-event', 'invoice', 1, 2, 'invoice.cancelled',
             'raw-send-event', 0, '{}', ?, ?)`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/pending command/)
    })

    it('[unit] reconciles a closed import through an immutable event-free receipt', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, number, currency, issue_date, due_date,
           state, source_updated_at, created_at, updated_at)
         VALUES (3, 7003, 1, 'INV-IMPORT-3', 'USD', '2026-08-01', '2026-08-31',
           'open', ?, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()
      const input = {
        invoiceId: 3,
        sourceBatchComplete: true as const,
        expectedSourceUpdatedAt: timestamp,
        sourceUpdatedAt: laterTimestamp,
        sourceState: 'closed' as const,
        sourceSentAt: timestamp,
        sourcePaidAt: timestamp,
        sourcePaidDate: null,
        sourceClosedAt: null,
        sourceAmountCents: 1000,
        sourceDueAmountCents: 0,
        sourceTaxAmountCents: 0,
        sourceTax2AmountCents: 0,
        sourceDiscountAmountCents: 0,
        sourcePaymentOptions: ['ach'],
        sourceWrittenOffCents: 0,
        lines: [
          {
            id: 3,
            harvestId: 7303,
            position: 0,
            kind: 'Service',
            description: 'Imported service',
            quantity: 1,
            unitPriceCents: 1000,
            amountCents: 1000,
            createdAt: timestamp,
            updatedAt: laterTimestamp,
          },
        ],
        messages: [
          {
            id: 701,
            harvestId: 7701,
            sentBy: 'Harvest Sender',
            sentByEmail: 'sender@example.invalid',
            sentFrom: 'Harvest Company',
            sentFromEmail: 'billing@example.invalid',
            recipients: [{ name: 'Client', email: 'client@example.invalid' }],
            subject: 'Invoice',
            body: 'Source message',
            attachPdf: true,
            eventType: 'send' as const,
            createdAt: timestamp,
            updatedAt: laterTimestamp,
          },
          {
            id: 702,
            harvestId: 7702,
            recipients: [],
            subject: 'Reminder',
            createdAt: timestamp,
            updatedAt: laterTimestamp,
          },
        ],
        payments: [
          {
            id: 601,
            harvestId: 7601,
            amountCents: 600,
            sourcePaidAt: laterTimestamp,
            sourcePaidDate: '2026-08-27',
            createdAt: laterTimestamp,
            updatedAt: laterTimestamp,
          },
          {
            id: 602,
            harvestId: 7602,
            amountCents: 400,
            sourcePaidAt: laterTimestamp,
            sourcePaidDate: null,
            createdAt: laterTimestamp,
            updatedAt: laterTimestamp,
          },
        ],
      }
      const [reconciled, concurrentRetry] = await Promise.all([
        reconcileImportedInvoice(database.orm, input),
        reconcileImportedInvoice(database.orm, input),
      ])
      expect(concurrentRetry).toEqual(reconciled)
      expect(reconciled).toEqual({
        invoiceId: 3,
        sourceUpdatedAt: laterTimestamp,
        state: 'closed',
        diagnostics: [],
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.state, invoice.close_reason, invoice.version,
             invoice.paid_at, invoice.paid_date, invoice.closed_at,
             invoice.source_updated_at,
             invoice.source_amount_cents, invoice.source_due_amount_cents,
             invoice.source_payment_options,
             (SELECT count(*) FROM invoice_payments WHERE invoice_id = invoice.id) AS payments,
             (SELECT count(*) FROM invoice_messages WHERE invoice_id = invoice.id) AS messages,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_type = 'invoice' AND aggregate_id = invoice.id) AS outbox,
             receipt.completed
           FROM invoices invoice
           JOIN invoice_import_reconciliations receipt ON receipt.invoice_id = invoice.id
           WHERE invoice.id = 3`,
        ),
      ).toEqual([
        {
          state: 'closed',
          close_reason: 'source_closed',
          version: 0,
          paid_at: timestamp,
          paid_date: null,
          closed_at: null,
          source_updated_at: laterTimestamp,
          source_amount_cents: 1000,
          source_due_amount_cents: 0,
          source_payment_options: '["ach"]',
          payments: 2,
          messages: 2,
          outbox: 0,
          completed: 1,
        },
      ])
      await expect(
        database.run(
          `DELETE FROM invoice_import_reconciliations
           WHERE invoice_id = 3 AND source_updated_at = ?`,
          laterTimestamp,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(database.run(`DELETE FROM invoice_payments WHERE id = 601`)).rejects.toThrow(
        /pending command/,
      )
      expect(
        await reconcileImportedInvoice(database.orm, {
          ...input,
          sourceWrittenOffCents: 1,
        }),
      ).toEqual(reconciled)
      expect(await reconcileImportedInvoice(database.orm, input)).toEqual(reconciled)
      await expect(
        reconcileImportedInvoice(database.orm, {
          ...input,
          expectedSourceUpdatedAt: timestamp,
          sourceUpdatedAt: thirdTimestamp,
        }),
      ).rejects.toThrow(/stale/)
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 2,
        commandId: 'import-message-collision-owner',
        command: 'send',
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: 0,
        occurredAt: timestamp,
        messageId: 999,
        eventId: 'import-message-collision-owner-event',
      })
      await expect(
        reconcileImportedInvoice(database.orm, {
          ...input,
          expectedSourceUpdatedAt: laterTimestamp,
          sourceUpdatedAt: thirdTimestamp,
          sourcePaidAt: thirdTimestamp,
          sourceClosedAt: thirdTimestamp,
          messages: [{ ...input.messages[0]!, id: 999, updatedAt: thirdTimestamp }],
        }),
      ).rejects.toThrow(/identity|UNIQUE/i)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT
             (SELECT count(*) FROM invoice_import_reconciliations
               WHERE invoice_id = 3 AND source_updated_at = ?) AS receipt,
             (SELECT count(*) FROM invoice_messages
               WHERE invoice_id = 3 AND harvest_id IN (7701,7702)) AS messages,
             (SELECT source_updated_at FROM invoices WHERE id = 3) AS source_updated_at`,
          thirdTimestamp,
        ),
      ).toEqual([{ receipt: 0, messages: 2, source_updated_at: laterTimestamp }])

      const refreshed = await reconcileImportedInvoice(database.orm, {
        ...input,
        expectedSourceUpdatedAt: laterTimestamp,
        sourceUpdatedAt: thirdTimestamp,
        sourcePaidAt: thirdTimestamp,
        sourceClosedAt: thirdTimestamp,
        messages: [
          {
            ...input.messages[0]!,
            body: 'Corrected source message',
            updatedAt: thirdTimestamp,
          },
        ],
        lines: [
          {
            ...input.lines[0]!,
            description: 'Corrected imported service',
            updatedAt: thirdTimestamp,
          },
        ],
        payments: [
          {
            ...input.payments[0]!,
            amountCents: 1000,
            sourcePaidAt: thirdTimestamp,
            sourcePaidDate: null,
            updatedAt: thirdTimestamp,
          },
        ],
      })
      expect(refreshed).toMatchObject({ state: 'closed', sourceUpdatedAt: thirdTimestamp })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT
             (SELECT count(*) FROM invoice_payments WHERE invoice_id = 3) AS payments,
             (SELECT amount_cents FROM invoice_payments WHERE harvest_id = 7601) AS amount,
             (SELECT count(*) FROM invoice_messages WHERE invoice_id = 3) AS messages,
             (SELECT body FROM invoice_messages WHERE harvest_id = 7701) AS body,
             (SELECT description FROM invoice_line_items WHERE harvest_id = 7303)
               AS line_description,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_type = 'invoice' AND aggregate_id = 3) AS outbox`,
        ),
      ).toEqual([
        {
          payments: 1,
          amount: 1000,
          messages: 1,
          body: 'Corrected source message',
          line_description: 'Corrected imported service',
          outbox: 0,
        },
      ])
    })

    it('[unit] derives imported paid evidence by canonical covering-payment order', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, number, currency, issue_date, due_date,
           state, source_updated_at, created_at, updated_at)
         VALUES (4, 7004, 1, 'INV-IMPORT-4', 'USD', '2026-08-01', '2026-08-31',
           'open', ?, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      const result = await reconcileImportedInvoice(database.orm, {
        invoiceId: 4,
        sourceBatchComplete: true,
        expectedSourceUpdatedAt: timestamp,
        sourceUpdatedAt: fourthTimestamp,
        sourceState: 'open',
        sourceSentAt: timestamp,
        sourcePaidAt: null,
        sourcePaidDate: null,
        sourceClosedAt: null,
        sourceAmountCents: 1000,
        sourceDueAmountCents: 0,
        sourceTaxAmountCents: 0,
        sourceTax2AmountCents: 0,
        sourceDiscountAmountCents: 0,
        sourcePaymentOptions: [],
        sourceWrittenOffCents: 0,
        lines: [
          {
            id: 804,
            harvestId: 7804,
            position: 0,
            kind: 'Service',
            quantity: 1,
            unitPriceCents: 1000,
            amountCents: 1000,
            createdAt: timestamp,
            updatedAt: fourthTimestamp,
          },
        ],
        messages: [],
        payments: [
          {
            id: 813,
            harvestId: 7813,
            amountCents: 300,
            sourcePaidAt: null,
            sourcePaidDate: '2026-08-27',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: 811,
            harvestId: 7811,
            amountCents: 400,
            sourcePaidAt: null,
            sourcePaidDate: '2026-08-26',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: 812,
            harvestId: 7812,
            amountCents: 300,
            sourcePaidAt: '2026-08-27T00:00:00.000Z',
            sourcePaidDate: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      })
      expect(result).toEqual({
        invoiceId: 4,
        sourceUpdatedAt: fourthTimestamp,
        state: 'paid',
        diagnostics: [
          {
            invoice_id: 4,
            code: 'source_state_disagrees',
            source_state: 'open',
            derived_state: 'paid',
          },
        ],
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT state, paid_at, paid_date, updated_at, version,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_type = 'invoice' AND aggregate_id = 4) AS outbox
           FROM invoices WHERE id = 4`,
        ),
      ).toEqual([
        {
          state: 'paid',
          paid_at: null,
          paid_date: '2026-08-27',
          updated_at: fourthTimestamp,
          version: 0,
          outbox: 0,
        },
      ])

      const regressed = await reconcileImportedInvoice(database.orm, {
        invoiceId: 4,
        sourceBatchComplete: true,
        expectedSourceUpdatedAt: fourthTimestamp,
        sourceUpdatedAt: fifthTimestamp,
        sourceState: 'paid',
        sourceSentAt: timestamp,
        sourcePaidAt: null,
        sourcePaidDate: null,
        sourceClosedAt: null,
        sourceAmountCents: 1000,
        sourceDueAmountCents: 1000,
        sourceTaxAmountCents: 0,
        sourceTax2AmountCents: 0,
        sourceDiscountAmountCents: 0,
        sourcePaymentOptions: [],
        sourceWrittenOffCents: 0,
        lines: [
          {
            id: 804,
            harvestId: 7804,
            position: 0,
            kind: 'Service',
            quantity: 1,
            unitPriceCents: 1000,
            amountCents: 1000,
            createdAt: timestamp,
            updatedAt: fourthTimestamp,
          },
        ],
        messages: [],
        payments: [],
      })
      expect(regressed).toEqual({
        invoiceId: 4,
        sourceUpdatedAt: fifthTimestamp,
        state: 'open',
        diagnostics: [
          {
            invoice_id: 4,
            code: 'source_state_disagrees',
            source_state: 'paid',
            derived_state: 'open',
          },
        ],
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT state, paid_at, paid_date, updated_at,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_type = 'invoice' AND aggregate_id = 4) AS outbox
           FROM invoices WHERE id = 4`,
        ),
      ).toEqual([
        { state: 'open', paid_at: null, paid_date: null, updated_at: fifthTimestamp, outbox: 0 },
      ])
    })
  })
}

const rawFactories = [
  ['container', async () => containerDatabase(false)],
  ['D1', async () => d1Database(false)],
] as const

for (const [runtime, factory] of rawFactories) {
  describe(`invoice event upgrade history (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] preserves an actual legacy invoice event without replay or causation', async () => {
      database = await factory()
      await installThrough0005(database)
      await installFixture(database)
      await database.run(
        `INSERT INTO event_outbox
          (id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
           payload_json, occurred_at, available_at)
         VALUES ('legacy-invoice-event', 'invoice', 1, 1, 'invoice.sent', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.migrateAgain()
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, aggregate_type, aggregate_id, aggregate_sequence,
             command_id, event_index FROM event_outbox WHERE aggregate_id = 1`,
        ),
      ).toEqual([
        {
          id: 'legacy-invoice-event',
          aggregate_type: 'invoice',
          aggregate_id: 1,
          aggregate_sequence: 1,
          command_id: null,
          event_index: null,
        },
      ])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM invoice_command_ledger WHERE invoice_id = 1`,
        ),
      ).toEqual([{ count: 0 }])
      await expect(
        database.run(`DELETE FROM event_outbox WHERE id = 'legacy-invoice-event'`),
      ).rejects.toThrow(/immutable/)
    })
  })
}
