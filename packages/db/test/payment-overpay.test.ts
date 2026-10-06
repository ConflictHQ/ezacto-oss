import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { recordCheckoutPayment, type CheckoutPaymentInput } from '../src/checkout-payments.js'
import {
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  updateInvoicePayment,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

/**
 * A payment may not take an invoice's balance below zero.
 *
 * The QuickBooks webhook recorded a payment an operator had already marked
 * paid, and the invoice read as overpaid by its whole amount. The echo itself
 * is caught where it arrives (see quickbooks-runtime.test.ts); this is the
 * rule underneath it, for every way a payment is recorded here -- by hand, and
 * by any provider's report -- so the next duplicate a provider sends cannot
 * overpay either. Run against the real schema on both runtimes, because the
 * balance it is decided against is the one the triggers compute.
 */

interface TestDatabase {
  orm: InvoiceStateDatabase
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  run(sql: string, ...params: unknown[]): Promise<void>
  close(): Promise<void>
}

const sentAt = '2026-09-11T12:00:00.000Z'
const paidAt = '2026-09-12T09:00:00.000Z'
const correctedAt = '2026-09-13T09:00:00.000Z'
const authorize = async (): Promise<boolean> => true

const containerDatabase = async (): Promise<TestDatabase> => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  return {
    orm: createContainerDatabase(client) as InvoiceStateDatabase,
    rows: async <T>(sql: string, ...params: unknown[]) => client.prepare(sql).all(...params) as T[],
    run: async (sql, ...params) => {
      client.prepare(sql).run(...params)
    },
    close: async () => {
      client.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  await migrateD1(client)
  return {
    orm: createD1Database(client) as InvoiceStateDatabase,
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await client
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    run: async (sql, ...params) => {
      await client
        .prepare(sql)
        .bind(...params)
        .run()
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

let open: TestDatabase | null = null

afterEach(async () => {
  await open?.close()
  open = null
  vi.restoreAllMocks()
})

/** One sent invoice owing $1,000.00. */
const fixture = async (factory: () => Promise<TestDatabase>): Promise<TestDatabase> => {
  const database = await factory()
  open = database
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Fixture', '{"invoices":true}', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Operator', 'One', 'administrator', '[]', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Kestrel Environmental', 'USD', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       created_at, updated_at)
     VALUES (1, 1, '4015', 'USD', '2026-09-11', '2026-10-11', 'draft', ?, ?)`,
    sentAt,
    sentAt,
  )
  await database.run(
    `INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
       unit_price_cents, amount_cents, created_at, updated_at)
     VALUES (1, 0, 'Service', 'Advisory', 1, 100000, 100000, ?, ?)`,
    sentAt,
    sentAt,
  )
  await executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: 'send-4015',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 301,
    eventId: 'event-send-4015',
  })
  return database
}

const invoice = async (database: TestDatabase) =>
  (
    await database.rows<{ version: number; state: string; due_amount_cents: number }>(
      'SELECT version, state, due_amount_cents FROM invoices WHERE id = 1',
    )
  )[0]!

const payments = (database: TestDatabase) =>
  database.rows<{ id: number; provider: string; amount_cents: number }>(
    'SELECT id, provider, amount_cents FROM invoice_payments WHERE invoice_id = 1 ORDER BY id',
  )

/** Record payment, as the API's POST does it: whatever amount was typed. */
const recordByHand = async (
  database: TestDatabase,
  paymentId: number,
  amountCents: number,
  orm: InvoiceStateDatabase = database.orm,
) =>
  recordInvoicePayment(orm, {
    invoiceId: 1,
    commandId: `record-${String(paymentId)}`,
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: (await invoice(database)).version,
    occurredAt: paidAt,
    eventIds: [`record-${String(paymentId)}-a`, `record-${String(paymentId)}-b`],
    payment: {
      type: 'manual',
      id: paymentId,
      currency: 'USD',
      amountCents,
      paidAt: null,
      paidDate: '2026-09-12',
      notes: null,
      recordedByUserId: 1,
    },
  })

const providerPayment = (
  overrides: Partial<CheckoutPaymentInput> = {},
): CheckoutPaymentInput => ({
  invoiceId: 1,
  provider: 'bill_com',
  externalAccountId: 'bill',
  accountDisplayName: 'BILL',
  providerTransactionId: '0rp1',
  amountCents: 100_000,
  paidOn: '2026-09-12',
  now: paidAt,
  ...overrides,
})

describe.each(factories)('a payment may not overpay (%s)', (_runtime, factory) => {
  it('[money] accepts a payment of exactly what is owed', async () => {
    const database = await fixture(factory)
    await recordByHand(database, 9, 100_000)
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
  })

  it('[money] refuses a payment typed in for more than the invoice owes, and writes nothing', async () => {
    const database = await fixture(factory)
    const before = await invoice(database)
    await expect(recordByHand(database, 9, 100_001)).rejects.toMatchObject({
      code: 'payment_exceeds_balance',
      amountCents: 100_001,
      maximumCents: 100_000,
    })
    expect(await payments(database)).toEqual([])
    expect(await invoice(database)).toEqual(before)
  })

  it('[money] refuses Mark paid on an invoice with nothing left to pay', async () => {
    // The order the webhook can produce: the invoice is settled by the time
    // somebody presses the button on a page that still showed a balance.
    const database = await fixture(factory)
    await recordByHand(database, 9, 100_000)
    await expect(recordByHand(database, 10, 100_000)).rejects.toMatchObject({
      code: 'payment_exceeds_balance',
      maximumCents: 0,
    })
    expect(await payments(database)).toEqual([{ id: 9, provider: 'manual', amount_cents: 100_000 }])
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
  })

  it('[money] refuses raising a payment past the balance, but not lowering it or correcting its date', async () => {
    const database = await fixture(factory)
    await recordByHand(database, 9, 60_000)
    const update = async (amountCents: number, paidDate: string, commandId: string) => {
      const [current] = await database.rows<{ updated_at: string }>(
        'SELECT updated_at FROM invoice_payments WHERE id = 9',
      )
      return updateInvoicePayment(database.orm, {
        invoiceId: 1,
        commandId,
        actor: { type: 'user', id: 1 },
        authorize,
        expectedVersion: (await invoice(database)).version,
        occurredAt: correctedAt,
        eventIds: [`${commandId}-a`, `${commandId}-b`],
        paymentId: 9,
        expectedPaymentUpdatedAt: current!.updated_at,
        amountCents,
        paidAt: null,
        paidDate,
        notes: null,
        recordedByUserId: 1,
      })
    }
    // Up to what the invoice owes without this payment is a correction.
    await update(100_000, '2026-09-12', 'raise-to-balance')
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
    // A cent past it is an overpayment.
    await expect(update(100_001, '2026-09-12', 'raise-past-balance')).rejects.toMatchObject({
      code: 'payment_exceeds_balance',
      maximumCents: 100_000,
    })
    // The same amount on a corrected date changes no balance and is allowed.
    await update(100_000, '2026-09-11', 'correct-date')
    await update(40_000, '2026-09-11', 'lower')
    expect(await invoice(database)).toMatchObject({ state: 'open', due_amount_cents: 60_000 })
  })

  it('[money] leaves a provider payment larger than the balance unrecorded, and says so', async () => {
    // Marked paid by hand, then the provider reports the same money: the
    // duplicate that overpaid the invoice, from any provider that reconciles.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = await fixture(factory)
    await recordByHand(database, 9, 100_000)
    for (const provider of ['bill_com', 'stripe', 'quickbooks'] as const) {
      expect(
        await recordCheckoutPayment(
          database.orm,
          providerPayment({ provider, externalAccountId: provider, providerTransactionId: `${provider}-1` }),
        ),
      ).toBe('exceeds_balance')
      expect(warn).toHaveBeenLastCalledWith(
        '[payments] provider payment not recorded: more than the invoice still owes',
        {
          provider,
          providerTransactionId: `${provider}-1`,
          invoiceId: 1,
          amountCents: 100_000,
          dueAmountCents: 0,
          paidOn: '2026-09-12',
        },
      )
    }
    expect(await payments(database)).toEqual([{ id: 9, provider: 'manual', amount_cents: 100_000 }])
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
    // Asked again, as a poll asks on every pass: the same answer, still nothing written.
    expect(
      await recordCheckoutPayment(
        database.orm,
        providerPayment({ provider: 'bill_com', externalAccountId: 'bill_com', providerTransactionId: 'bill_com-1' }),
      ),
    ).toBe('exceeds_balance')
    expect(await payments(database)).toHaveLength(1)
  })

  it('[money] records a provider payment that fits, and refuses the next one that does not', async () => {
    const database = await fixture(factory)
    expect(await recordCheckoutPayment(database.orm, providerPayment({ amountCents: 70_000 }))).toBe(
      'recorded',
    )
    expect(await invoice(database)).toMatchObject({ state: 'open', due_amount_cents: 30_000 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(
      await recordCheckoutPayment(
        database.orm,
        providerPayment({ amountCents: 30_001, providerTransactionId: '0rp2' }),
      ),
    ).toBe('exceeds_balance')
    expect(
      await recordCheckoutPayment(
        database.orm,
        providerPayment({ amountCents: 30_000, providerTransactionId: '0rp3' }),
      ),
    ).toBe('recorded')
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
  })

  it('[money] re-decides a provider payment that loses a race to Mark paid, rather than overpaying', async () => {
    // Read, then somebody else writes: the operator marks the invoice paid
    // between the provider path reading the invoice and recording against it.
    // The command is held to the version it read, so it conflicts; read again,
    // the balance is gone and the payment is left for review.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = await fixture(factory)
    let raced = false
    const racing = new Proxy(database.orm, {
      get(target, property) {
        if (property === 'all') {
          return async (...args: unknown[]) => {
            const result = await (target.all as (...a: unknown[]) => Promise<unknown>)(...args)
            if (!raced) {
              raced = true
              await recordByHand(database, 9, 100_000)
            }
            return result
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as InvoiceStateDatabase

    expect(await recordCheckoutPayment(racing, providerPayment())).toBe('exceeds_balance')
    expect(raced).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await payments(database)).toEqual([{ id: 9, provider: 'manual', amount_cents: 100_000 }])
    expect(await invoice(database)).toMatchObject({ state: 'paid', due_amount_cents: 0 })
  })
})
