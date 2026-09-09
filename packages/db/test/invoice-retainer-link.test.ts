import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { executeInvoiceEdit, type InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { appendRetainerLedgerEntry, getRetainerBalance } from '../src/retainers.js'

/**
 * The chain that could not be completed.
 *
 * `retainer_ledger` refuses a deposit or a drawdown whose invoice is not linked
 * to the same retainer, and nothing in the product wrote `invoices.retainer_id`
 * -- so a retainer could be created, listed and opened, and never moved. The
 * schema was built for it: `invoices_retainer_client_insert` keeps the retainer
 * on the invoice's own client, and `invoices_retainer_with_ledger_immutable`
 * freezes the link once a movement names it. Only the write path was missing.
 *
 * These run the whole chain rather than the new field alone, because the field
 * on its own proves nothing: the point is that a drawdown now lands.
 */

interface TestDatabase {
  orm: InvoiceStateDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-09-09T12:00:00.000Z'
const date = '2026-09-09'

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite) as unknown as InvoiceStateDatabase,
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as T[],
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
    orm: createD1Database(d1) as unknown as InvoiceStateDatabase,
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
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, manager_grants, profile, created_at, updated_at)
     VALUES (1, 'Sanitized', 'Actor', '[]', 'administrator', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?), (2, 'Other Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO retainers
      (id, client_id, state, denomination, amount_cents, on_exhaustion, created_at, updated_at)
     VALUES (1, 1, 'ongoing', 'money', 500000, 'block', ?, ?),
            (2, 2, 'ongoing', 'money', 500000, 'block', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES (1, 1, 'INV-RET-1', 'USD', ?, ?, ?, ?)`,
    date,
    date,
    timestamp,
    timestamp,
  )
}

const linkRetainer = (
  database: TestDatabase,
  retainerId: number | null,
  expectedVersion = 0,
  commandId = `link-${String(retainerId)}`,
) =>
  executeInvoiceEdit(database.orm, {
    invoiceId: 1,
    commandId,
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion,
    occurredAt: timestamp,
    eventIds: [`evt-${commandId}`],
    edit: { type: 'header', retainerId },
  })

/**
 * A retainer's `amount_cents` is the agreed commitment, not its balance: the
 * balance is the sum of the ledger and starts at nothing. So money goes on
 * before it comes off, and both movements name the invoice they moved with.
 */
const deposit = (database: TestDatabase, id = 'ret_deposit_1') =>
  appendRetainerLedgerEntry(database.orm, {
    id,
    retainerId: 1,
    kind: 'deposit',
    invoiceId: 1,
    amountCents: 500_000,
    occurredOn: date,
    notes: null,
    createdAt: timestamp,
  })

const drawdown = (database: TestDatabase, id = 'ret_drawdown_1') =>
  appendRetainerLedgerEntry(database.orm, {
    id,
    retainerId: 1,
    kind: 'drawdown',
    invoiceId: 1,
    amountCents: -120_000,
    occurredOn: date,
    notes: null,
    createdAt: timestamp,
  })

for (const [runtime, factory] of factories) {
  describe(`invoice retainer link (${runtime})`, () => {
    let database: TestDatabase | undefined
    afterEach(async () => {
      await database?.close()
      database = undefined
    })

    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await seed(database)
      return database
    }

    it('[unit] lets a retainer be drawn down, which it could not be before', async () => {
      // The whole issue in one test. Without the link the append below is
      // refused by `retainer_ledger_invoice_client_guard`, and there was no
      // supported way to create the link.
      const active = await setup()
      const result = await linkRetainer(active, 1)
      expect(result.invoice.version).toBe(1)

      await deposit(active)
      const appended = await drawdown(active)
      expect(appended).toMatchObject({ invoiceId: 1, amount: -120_000, unit: 'cents' })
      const rows = await active.rows<{ retainer_id: number | null }>(
        'SELECT retainer_id FROM invoices WHERE id = 1',
      )
      expect(rows[0]?.retainer_id).toBe(1)
      expect(await getRetainerBalance(active.orm, 1)).toMatchObject({ balance: 380_000 })
    })

    it('[security] refuses a retainer belonging to another client', async () => {
      // The schema's own rule, reached through the new write path rather than
      // asserted about the schema in isolation. An invoice that could draw on
      // another client's retainer is the failure worth naming.
      const active = await setup()

      await expect(linkRetainer(active, 2)).rejects.toThrow()
      const rows = await active.rows<{ retainer_id: number | null }>(
        'SELECT retainer_id FROM invoices WHERE id = 1',
      )
      expect(rows[0]?.retainer_id).toBeNull()
    })

    it('[security] freezes the link once a movement names it', async () => {
      // A retainer movement points at an invoice; repointing the invoice would
      // move money between retainers with no ledger entry saying so.
      const active = await setup()
      await linkRetainer(active, 1)
      await deposit(active)

      await expect(linkRetainer(active, null, 1, 'unlink')).rejects.toThrow()
      const rows = await active.rows<{ retainer_id: number | null }>(
        'SELECT retainer_id FROM invoices WHERE id = 1',
      )
      expect(rows[0]?.retainer_id).toBe(1)
    })

    it('[unit] unlinks while the invoice has moved nothing', async () => {
      // Editable exactly while it is still a plan, which is the window the
      // schema draws and the reason the freeze above is not simply immutability.
      const active = await setup()
      await linkRetainer(active, 1)

      const result = await linkRetainer(active, null, 1, 'unlink')
      expect(result.invoice.version).toBe(2)
      const rows = await active.rows<{ retainer_id: number | null }>(
        'SELECT retainer_id FROM invoices WHERE id = 1',
      )
      expect(rows[0]?.retainer_id).toBeNull()
    })

    it('[unit] leaves the link alone when the edit does not mention it', async () => {
      // A header edit is a partial: the fields it omits keep their values. A
      // subject change that silently dropped the retainer would be a silent
      // unlink, and the ledger would then refuse the next drawdown.
      const active = await setup()
      await linkRetainer(active, 1)

      await executeInvoiceEdit(active.orm, {
        invoiceId: 1,
        commandId: 'subject-only',
        actor: { type: 'user', id: 1 },
        authorize: async () => true,
        expectedVersion: 1,
        occurredAt: timestamp,
        eventIds: ['evt-subject-only'],
        edit: { type: 'header', subject: 'September retainer draw' },
      })

      const rows = await active.rows<{ retainer_id: number | null; subject: string }>(
        'SELECT retainer_id, subject FROM invoices WHERE id = 1',
      )
      expect(rows[0]?.retainer_id).toBe(1)
      expect(rows[0]?.subject).toBe('September retainer draw')
    })
  })
}
