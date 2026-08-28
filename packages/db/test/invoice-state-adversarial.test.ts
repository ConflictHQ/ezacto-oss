import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  executeInvoiceLifecycleCommand,
  InvoiceCommandOperationError,
  InvoiceCommandReuseError,
  recordInvoicePayment,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import * as dbPackage from '../src/index.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import * as publicSchema from '../src/schema.js'

interface TestDatabase {
  orm: InvoiceStateDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-08-27T12:00:00.000Z'
const laterTimestamp = '2026-08-27T12:00:01.000Z'
const thirdTimestamp = '2026-08-27T12:00:02.000Z'
const fourthTimestamp = '2026-08-27T12:00:03.000Z'
const fingerprint = `sha256:${'0'.repeat(64)}`
const authorize = async (): Promise<boolean> => true

it('[unit] keeps import reconciliation authority off public package surfaces', () => {
  expect(publicSchema).not.toHaveProperty('invoiceImportReconciliations')
  expect(dbPackage).not.toHaveProperty('invoiceImportReconciliations')
})

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
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

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
     VALUES
      (1, 'First', 'Actor', '[]', ?, ?),
      (2, 'Second', 'Actor', '[]', ?, ?)`,
    timestamp,
    timestamp,
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
      (1, 1, 'INV-ADV-1', 'USD', '2026-08-01', '2026-08-31', ?, ?),
      (2, 1, 'INV-ADV-2', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const sendInvoice = async (database: TestDatabase, invoiceId = 1) =>
  executeInvoiceLifecycleCommand(database.orm, {
    invoiceId,
    commandId: `send-${invoiceId}`,
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: laterTimestamp,
    messageId: 100 + invoiceId,
    eventId: `event-send-${invoiceId}`,
  })

const insertPendingCommand = async (
  database: TestDatabase,
  commandKind: 'invoice.send' | 'payment.record',
): Promise<void> => {
  await database.run(
    `INSERT INTO invoice_command_ledger (
      invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
      expected_invoice_version, occurred_at
    ) VALUES (1, 'raw-command', ?, ?, 'user', 1, 0, ?)`,
    commandKind,
    fingerprint,
    laterTimestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`invoice state adversarial contract (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] rejects a pending send used to authorize an unrelated cancelled delta', async () => {
      database = await factory()
      await installFixture(database)
      await insertPendingCommand(database, 'invoice.send')

      await expect(
        database.run(
          `UPDATE invoices SET state = 'closed', close_reason = 'cancelled', closed_at = ?,
             version = 1, updated_at = ? WHERE id = 1 AND version = 0`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/command|transition|lifecycle/)
    })

    it('[unit] rejects an invoice outcome as the first event of payment.record', async () => {
      database = await factory()
      await installFixture(database)
      await insertPendingCommand(database, 'payment.record')

      await expect(
        database.run(
          `INSERT INTO event_outbox (
            id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
            command_id, event_index, payload_json, occurred_at, available_at
          ) VALUES (
            'raw-wrong-event', 'invoice', 1, 1, 'invoice.paid',
            'raw-command', 0, '{}', ?, ?
          )`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/command|event|order|causation/)
    })

    it('[unit] rejects payment.record event index one before index zero', async () => {
      database = await factory()
      await installFixture(database)
      await insertPendingCommand(database, 'payment.record')

      await expect(
        database.run(
          `INSERT INTO event_outbox (
            id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
            command_id, event_index, payload_json, occurred_at, available_at
          ) VALUES (
            'raw-wrong-order', 'invoice', 1, 1, 'payment.recorded',
            'raw-command', 1, '{}', ?, ?
          )`,
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/command|event|order|causation/)
    })

    it('[unit] rejects reuse of a completed command by a changed actor', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)

      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'send-1',
          command: 'send',
          actor: { type: 'user', id: 2 },
          authorize,
          expectedVersion: 0,
          occurredAt: thirdTimestamp,
          messageId: 101,
          eventId: 'unused-changed-actor-event',
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandReuseError)
    })

    it('[unit] rejects authorization before touching the database', async () => {
      database = await factory()
      await installFixture(database)
      let databaseTouched = false
      const guardedDatabase = new Proxy(database.orm, {
        get(target, property, receiver) {
          if (property === '$client') {
            databaseTouched = true
            throw new Error('database was touched before authorization')
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      })

      await expect(
        executeInvoiceLifecycleCommand(guardedDatabase, {
          invoiceId: 1,
          commandId: 'denied-before-read',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize: async () => false,
          expectedVersion: 0,
          occurredAt: laterTimestamp,
          messageId: 201,
          eventId: 'event-denied-before-read',
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandOperationError)
      expect(databaseTouched).toBe(false)
    })

    it('[unit] rechecks revoked authorization before returning a stored retry', async () => {
      database = await factory()
      await installFixture(database)
      const first = await sendInvoice(database)
      let authorizationChecks = 0

      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'send-1',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize: async () => {
            authorizationChecks += 1
            return authorizationChecks === 1
          },
          expectedVersion: 0,
          occurredAt: thirdTimestamp,
          messageId: 101,
          eventId: 'unused-revoked-event',
        }),
      ).rejects.toBeInstanceOf(InvoiceCommandOperationError)
      expect(authorizationChecks).toBe(2)
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE aggregate_id = 1`,
        ),
      ).toEqual([{ count: first.event_count }])
    })

    it('[unit] returns the exact stored result when retrying a confirmed bank deposit', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (1, 'wise', 'reconciliation', 'acct-adversarial', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (1, 1, 'deposit-adversarial', 'USD', ?, 1000, 'suggested', 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await sendInvoice(database)

      const command = {
        invoiceId: 1,
        commandId: 'confirm-bank-deposit',
        actor: { type: 'user' as const, id: 1 },
        authorize,
        expectedVersion: 1,
        occurredAt: thirdTimestamp,
        eventIds: ['event-bank-payment', 'event-bank-paid'],
        payment: {
          type: 'bank_deposit' as const,
          id: 301,
          depositId: 1,
          expectedDepositUpdatedAt: timestamp,
          expectedMatchState: 'suggested' as const,
          paidAt: thirdTimestamp,
        },
      }
      const first = await recordInvoicePayment(database.orm, command)
      expect(
        await database.rows<{ match_state: string }>(
          `SELECT match_state FROM bank_deposits WHERE id = 1`,
        ),
      ).toEqual([{ match_state: 'confirmed' }])

      const retry = await recordInvoicePayment(database.orm, {
        ...command,
        occurredAt: fourthTimestamp,
        eventIds: ['unused-bank-payment', 'unused-bank-paid'],
      })
      expect(retry).toEqual(first)
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE aggregate_id = 1`,
        ),
      ).toEqual([{ count: 3 }])
    })

    it('[unit] makes command, import-receipt, and invoice-outbox deletion immutable', async () => {
      database = await factory()
      await installFixture(database)
      await sendInvoice(database)
      await database.run(
        `INSERT INTO invoices (
          id, harvest_id, client_id, number, currency, issue_date, due_date,
          state, source_updated_at, created_at, updated_at
        ) VALUES (
          3, 7003, 1, 'INV-ADV-3', 'USD', '2026-08-01', '2026-08-31',
          'open', ?, ?, ?
        )`,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_import_reconciliations (
          invoice_id, source_updated_at, expected_source_updated_at, input_fingerprint,
          source_manifest_json, source_manifest_hash,
          line_manifest_json, line_manifest_hash,
          message_manifest_json, message_manifest_hash,
          payment_manifest_json, payment_manifest_hash,
          source_state, target_state, target_version, target_updated_at,
          target_close_reason, target_close_write_off_cents, target_written_off_cents,
          target_sent_at, target_paid_at, target_paid_date, target_closed_at,
          outbox_count_before
        ) VALUES (
          3, ?, ?, ?, ?, ?, '[]', ?, '[]', ?, '[]', ?,
          'open', 'open', 0, ?, NULL, 0, 0,
          NULL, NULL, NULL, NULL, 0
        )`,
        laterTimestamp,
        timestamp,
        fingerprint,
        JSON.stringify({ invoice_id: 3, source_updated_at: laterTimestamp }),
        `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
        `sha256:${'3'.repeat(64)}`,
        `sha256:${'4'.repeat(64)}`,
        laterTimestamp,
      )

      await expect(
        database.run(
          `DELETE FROM invoice_command_ledger WHERE invoice_id = 1 AND command_id = 'send-1'`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        database.run(
          `DELETE FROM invoice_import_reconciliations
           WHERE invoice_id = 3 AND source_updated_at = ?`,
          laterTimestamp,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        database.run(`DELETE FROM event_outbox WHERE id = 'event-send-1'`),
      ).rejects.toThrow(/immutable/)
    })
  })
}
