import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
} from '../src/invoice-state.js'
import { createQuickBooksMirrorSource } from '../src/quickbooks-source.js'
import { createBillMirrorSource } from '../src/bill.js'

/**
 * Issue 595. `invoice_payments` has described a checkout payment since
 * migration 0005 -- `provider` admits `quickbooks` and `bill_com`,
 * `provider_shape` has a `checkout` value, and the CHECK demands an account and
 * a transaction id for anything that is not manual. Nothing could write one, so
 * the QuickBooks mirror wrote the row directly and the ledger trigger refused
 * it. These tests are the shape that was missing.
 */

const sent = '2026-09-11T12:00:00.000Z'
const paidAt = '2026-09-11T12:00:01.000Z'
const authorize = async (): Promise<boolean> => true

let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${sent}', '${sent}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${sent}', '${sent}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${sent}', '${sent}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${sent}', '${sent}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 1, 100000, 100000, '${sent}', '${sent}');
    INSERT INTO payment_provider_accounts
      (id, provider, provider_shape, external_account_id, display_name, created_at, updated_at)
      VALUES (1, 'bill_com', 'checkout', '008EXAMPLE', 'BILL', '${sent}', '${sent}');
  `)
  sqlite = database
  const orm = createContainerDatabase(database)
  await executeInvoiceLifecycleCommand(orm, {
    invoiceId: 1,
    commandId: 'send-1315',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize,
    expectedVersion: 0,
    occurredAt: sent,
    messageId: 301,
    eventId: 'event-send-1315',
  })
  return { sqlite: database, orm }
}

const checkout = (overrides: Record<string, unknown> = {}) => {
  const { payment: paymentOverrides, ...rest } = overrides
  return {
    invoiceId: 1,
    commandId: 'record-bill-payment',
    // Nobody typed this in: a provider took the money and a poll noticed.
    actor: { type: 'system' as const, id: null },
    authorize,
    expectedVersion: 1,
    occurredAt: paidAt,
    eventIds: ['event-payment-recorded', 'event-invoice-paid'],
    ...rest,
    payment: {
      type: 'checkout' as const,
      id: 401,
      currency: 'USD',
      amountCents: 100_000,
      paidAt,
      paidDate: null,
      provider: 'bill_com' as const,
      providerAccountId: 1,
      providerTransactionId: '0rp1',
      ...((paymentOverrides as Record<string, unknown> | undefined) ?? {}),
    },
  }
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('recording a payment a provider took (#595)', () => {
  it('[money] writes the receipt and marks the invoice paid', async () => {
    const { sqlite: database, orm } = await fixture()
    const recorded = await recordInvoicePayment(orm, checkout() as never)
    expect(recorded).toMatchObject({
      invoice: { version: 2, state: 'paid', due_amount_cents: 0, payment_count: 1 },
    })
    expect(
      database
        .prepare(
          `SELECT provider, provider_shape, provider_account_id,
             provider_transaction_id, recorded_by_user_id, amount_cents
           FROM invoice_payments WHERE invoice_id = 1`,
        )
        .all(),
    ).toEqual([
      {
        provider: 'bill_com',
        provider_shape: 'checkout',
        provider_account_id: 1,
        provider_transaction_id: '0rp1',
        // Nobody recorded it. Naming a user would attribute it to somebody who
        // was not involved.
        recorded_by_user_id: null,
        amount_cents: 100_000,
      },
    ])
  })

  it('[security] goes through the command ledger, which the raw insert could not', async () => {
    // The defect this fixes: the QuickBooks mirror inserted directly and was
    // refused. The same insert is still refused; what changed is that there is
    // now a sanctioned way to do it.
    const { sqlite: database } = await fixture()
    expect(() =>
      database
        .prepare(
          `INSERT INTO invoice_payments
             (id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
              provider_account_id, provider_transaction_id, created_at, updated_at)
           VALUES (999, 1, 'USD', 100000, ?, 'bill_com', 'checkout', 1, '0rp9', ?, ?)`,
        )
        .run(paidAt, paidAt, paidAt),
    ).toThrow(/pending command/)
  })

  it('[money] refuses the same provider payment twice', async () => {
    // The reconciliations that produce these are polls: they see the same
    // payment on every pass, and the second pass must not add a second receipt.
    //
    // The guarantee is `invoice_payments_provider_transaction_unique`, not
    // anything in the command. A duplicate check written into the statement was
    // removed after a mutation that deleted it changed nothing observable --
    // the index had already refused the row.
    const { sqlite: database, orm } = await fixture()
    await recordInvoicePayment(orm, checkout() as never)
    // A genuinely different command -- new id, new events, the version the first
    // one left behind -- carrying the same BILL payment. The first draft of this
    // test passed one event id and was rejected before it reached the SQL, so it
    // proved nothing; a mutation that deleted the duplicate check survived it.
    await recordInvoicePayment(
      orm,
      checkout({
        commandId: 'record-bill-payment-again',
        expectedVersion: 2,
        eventIds: ['event-payment-recorded-2', 'event-invoice-paid-2'],
        payment: { id: 402 },
      }) as never,
    ).catch(() => undefined)
    expect(
      database
        .prepare('SELECT id, provider_transaction_id FROM invoice_payments WHERE invoice_id = 1')
        .all(),
    ).toEqual([{ id: 401, provider_transaction_id: '0rp1' }])
  })

  it('[security] refuses an account that is not the provider it claims', async () => {
    // Otherwise a BILL payment could be filed against a Stripe account and the
    // receipt would name a place the money never went.
    const { sqlite: database, orm } = await fixture()
    database
      .prepare(
        `INSERT INTO payment_provider_accounts
           (id, provider, provider_shape, external_account_id, display_name, created_at, updated_at)
         VALUES (2, 'stripe', 'checkout', 'acct_example', 'Stripe', ?, ?)`,
      )
      .run(sent, sent)
    await recordInvoicePayment(
      orm,
      checkout({ payment: { providerAccountId: 2 } }) as never,
    ).catch(() => undefined)
    const count = database
      .prepare('SELECT COUNT(*) AS n FROM invoice_payments')
      .get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('[api] refuses a checkout payment with no provider transaction id', async () => {
    // The schema demands one for any non-manual provider, and a receipt without
    // it is one no reconciliation can recognise again.
    const { orm } = await fixture()
    await expect(
      recordInvoicePayment(
        orm,
        checkout({ payment: { providerTransactionId: '  ' } }) as never,
      ),
    ).rejects.toThrow(/providerTransactionId/u)
  })

  it('[api] refuses a malformed currency and a non-positive amount', async () => {
    const { orm } = await fixture()
    await expect(
      recordInvoicePayment(orm, checkout({ payment: { currency: 'usd' } }) as never),
    ).rejects.toThrow(/currency/u)
    await expect(
      recordInvoicePayment(orm, checkout({ payment: { amountCents: 0 } }) as never),
    ).rejects.toThrow()
  })

  it('[money] leaves a manual payment recording exactly as it did', async () => {
    // The shape is additive. A person entering a payment by hand must be
    // unaffected by any of this.
    const { sqlite: database, orm } = await fixture()
    await recordInvoicePayment(orm, {
      invoiceId: 1,
      commandId: 'record-manual',
      actor: { type: 'user', id: 1 },
      authorize,
      expectedVersion: 1,
      occurredAt: paidAt,
      eventIds: ['event-manual-recorded', 'event-manual-paid'],
      payment: {
        type: 'manual',
        id: 501,
        currency: 'USD',
        amountCents: 100_000,
        paidAt,
        paidDate: null,
        recordedByUserId: 1,
      },
    } as never)
    expect(
      database
        .prepare(
          `SELECT provider, provider_shape, provider_account_id, recorded_by_user_id
           FROM invoice_payments WHERE invoice_id = 1`,
        )
        .all(),
    ).toEqual([
      {
        provider: 'manual',
        provider_shape: 'manual',
        provider_account_id: null,
        recorded_by_user_id: 1,
      },
    ])
  })
})

/**
 * The end the two mirrors actually reach. These run the real source modules
 * against a real database, which is the one thing that would have caught issue
 * 595 before it shipped -- both mirrors' only other test replaces the module
 * with a stub.
 */
describe('the mirrors that discover a payment (#595)', () => {
  const sendable = async () => {
    const { sqlite: database, orm } = await fixture()
    return { database, orm }
  }

  it('[money] QuickBooks records a payment that came back', async () => {
    const { database, orm } = await sendable()
    const source = createQuickBooksMirrorSource(orm as never, () => new Date(paidAt))
    await source.recordPayment({
      invoiceId: 1,
      amountCents: 100_000,
      paidOn: '2026-09-20',
      realmId: 'realm-a',
      quickBooksPaymentId: 'qbp-1',
    })
    expect(
      database
        .prepare(
          `SELECT provider, provider_shape, provider_transaction_id, amount_cents
           FROM invoice_payments WHERE invoice_id = 1`,
        )
        .all(),
    ).toEqual([
      {
        provider: 'quickbooks',
        provider_shape: 'checkout',
        provider_transaction_id: 'qbp-1',
        amount_cents: 100_000,
      },
    ])
  })

  it('[money] QuickBooks records it once, however many times the webhook arrives', async () => {
    const { database, orm } = await sendable()
    const source = createQuickBooksMirrorSource(orm as never, () => new Date(paidAt))
    const payment = {
      invoiceId: 1,
      amountCents: 100_000,
      paidOn: '2026-09-20',
      realmId: 'realm-a',
      quickBooksPaymentId: 'qbp-1',
    }
    await source.recordPayment(payment)
    await source.recordPayment(payment)
    await source.recordPayment(payment)
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM invoice_payments').get() as { n: number }).n,
    ).toBe(1)
  })

  it('[money] BILL records a payment and its own observation of it', async () => {
    const { database, orm } = await sendable()
    const source = createBillMirrorSource(orm as never, () => new Date(paidAt))
    await source.recordPayment({
      invoiceId: 1,
      billInvoiceId: '00e001',
      billPaymentId: '0rp1',
      amountCents: 100_000,
      paidOn: '2026-09-20',
    })
    expect(
      database
        .prepare(
          `SELECT provider, provider_shape, provider_transaction_id
           FROM invoice_payments WHERE invoice_id = 1`,
        )
        .all(),
    ).toEqual([
      { provider: 'bill_com', provider_shape: 'checkout', provider_transaction_id: '0rp1' },
    ])
    expect(
      (
        database.prepare('SELECT COUNT(*) AS n FROM bill_received_payments').get() as {
          n: number
        }
      ).n,
    ).toBe(1)
  })

  it('[money] BILL records it once, however many times the poll sees it', async () => {
    const { database, orm } = await sendable()
    const source = createBillMirrorSource(orm as never, () => new Date(paidAt))
    const payment = {
      invoiceId: 1,
      billInvoiceId: '00e001',
      billPaymentId: '0rp1',
      amountCents: 100_000,
      paidOn: '2026-09-20',
    }
    await source.recordPayment(payment)
    await source.recordPayment(payment)
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM invoice_payments').get() as { n: number }).n,
    ).toBe(1)
  })
})
