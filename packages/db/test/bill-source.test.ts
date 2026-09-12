import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  createBillLinkStore,
  createBillMirrorSource,
  setBillDelivery,
} from '../src/bill.js'

const t = (minute: number): string =>
  `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`

const clock = () => new Date(t(5))

let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO contacts (id, client_id, first_name, last_name, email, invoice_recipient_status, created_at, updated_at)
      VALUES (1, 1, 'Ops', 'Desk', 'ops@kestrel.example', 'none', '${t(0)}', '${t(0)}');
    INSERT INTO contacts (id, client_id, first_name, last_name, email, invoice_recipient_status, created_at, updated_at)
      VALUES (2, 1, 'Accounts', 'Payable', 'ap@kestrel.example', 'recipient', '${t(0)}', '${t(0)}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (10, 1, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (10, 1, 'Service', 'Advisory', 3, 20000, 60000, '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  const orm = createContainerDatabase(database)
  return {
    sqlite: database,
    orm,
    links: createBillLinkStore(orm, clock),
    source: createBillMirrorSource(orm, clock),
  }
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('reading an invoice for BILL', () => {
  it('[db] carries the number, dates and lines', async () => {
    const { source } = await fixture()
    expect(await source.readInvoice(10)).toEqual({
      id: 10,
      number: '1315',
      clientId: 1,
      currency: 'USD',
      issueDate: '2026-09-11',
      dueDate: '2026-10-11',
      subject: null,
      lines: [
        {
          description: 'Advisory',
          amountCents: 60_000,
          quantity: 3,
          unitPriceCents: 20_000,
        },
      ],
    })
  })

  it('[db] answers null for an invoice that is not there', async () => {
    const { source } = await fixture()
    expect(await source.readInvoice(999)).toBeNull()
  })
})

describe('reading the client BILL will bill', () => {
  it('[db] takes the address the invoice already goes to', async () => {
    // Not just any contact with an email: turning BILL on must not quietly
    // change who receives the invoice.
    const { source } = await fixture()
    expect(await source.readClient(1)).toEqual({
      id: 1,
      name: 'Kestrel Environmental',
      email: 'ap@kestrel.example',
    })
  })

  it('[db] reports no email when no contact is marked as the recipient', async () => {
    const { sqlite: database, source } = await fixture()
    database
      .prepare(`UPDATE contacts SET invoice_recipient_status = 'none' WHERE id = 2`)
      .run()
    expect((await source.readClient(1))?.email).toBeNull()
  })
})

describe('the per-client opt-in', () => {
  it('[db] is off until it is turned on', async () => {
    const { orm, source } = await fixture()
    expect(await source.isOptedIn(1)).toBe(false)
    expect(await setBillDelivery(orm, 1, true)).toBe(true)
    expect(await source.isOptedIn(1)).toBe(true)
    await setBillDelivery(orm, 1, false)
    expect(await source.isOptedIn(1)).toBe(false)
  })

  it('[db] says so when the client does not exist', async () => {
    const { orm } = await fixture()
    expect(await setBillDelivery(orm, 999, true)).toBe(false)
  })
})

describe('the link store', () => {
  it('[db] writes a link and reads it back', async () => {
    const { links } = await fixture()
    await links.saveLink('invoice', 10, { billId: '00e001', paymentLink: null })
    expect(await links.readLink('invoice', 10)).toEqual({
      billId: '00e001',
      paymentLink: null,
    })
  })

  it('[db] fills in the payment link on a second save', async () => {
    // The one thing a second save legitimately does. The schema refuses a
    // change to the identity outright.
    const { links } = await fixture()
    await links.saveLink('invoice', 10, { billId: '00e001', paymentLink: null })
    await links.saveLink('invoice', 10, {
      billId: '00e001',
      paymentLink: 'https://app.bill.com/pay/example',
    })
    expect((await links.readLink('invoice', 10))?.paymentLink).toBe(
      'https://app.bill.com/pay/example',
    )
  })

  it('[db] answers null for a link that was never written', async () => {
    const { links } = await fixture()
    expect(await links.readLink('invoice', 10)).toBeNull()
  })

  it('[db] lists what has been mirrored, for payments coming back', async () => {
    const { links, source } = await fixture()
    await links.saveLink('customer', 1, { billId: '0cu001', paymentLink: null })
    await links.saveLink('invoice', 10, { billId: '00e001', paymentLink: null })
    // Customers are not invoices: a payment must never resolve to one.
    expect([...(await source.mirroredInvoices()).entries()]).toEqual([['00e001', 10]])
  })
})

describe('recording a BILL payment', () => {
  const payment = {
    invoiceId: 10,
    billInvoiceId: '00e001',
    billPaymentId: '0rp1',
    amountCents: 60_000,
    paidOn: '2026-09-20',
    organizationId: '008EXAMPLE',
  }

  it('[money] remembers what BILL reported against the invoice', async () => {
    const { sqlite: database, source } = await fixture()
    await source.recordPayment(payment)
    expect(
      database
        .prepare(
          `SELECT bill_payment_id, invoice_id, amount_cents, paid_on
           FROM bill_received_payments`,
        )
        .all(),
    ).toEqual([
      {
        bill_payment_id: '0rp1',
        invoice_id: 10,
        amount_cents: 60_000,
        paid_on: '2026-09-20',
      },
    ])
  })

  it('[money] records the same payment once, however many times it is polled', async () => {
    // The reconciliation is a poll: it sees every payment again on every pass.
    const { sqlite: database, source } = await fixture()
    await source.recordPayment(payment)
    await source.recordPayment(payment)
    await source.recordPayment(payment)
    const count = database
      .prepare('SELECT COUNT(*) AS n FROM bill_received_payments')
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('[money] lets one BILL payment settle two invoices, each with its own share', async () => {
    const { sqlite: database, source } = await fixture()
    database
      .prepare(
        `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
         VALUES (11, 1, '1316', 'USD', '2026-09-11', '2026-10-11', 'draft', ?, ?)`,
      )
      .run(t(0), t(0))
    await source.recordPayment(payment)
    await source.recordPayment({
      ...payment,
      invoiceId: 11,
      billInvoiceId: '00e002',
      amountCents: 10_000,
    })
    expect(
      database
        .prepare(
          'SELECT invoice_id, amount_cents FROM bill_received_payments ORDER BY invoice_id',
        )
        .all(),
    ).toEqual([
      { invoice_id: 10, amount_cents: 60_000 },
      { invoice_id: 11, amount_cents: 10_000 },
    ])
  })

  it('[money] does nothing for an invoice that is not there', async () => {
    const { sqlite: database, source } = await fixture()
    await source.recordPayment({ ...payment, invoiceId: 999 })
    const count = database
      .prepare('SELECT COUNT(*) AS n FROM bill_received_payments')
      .get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('[security] does not forge a receipt the invoice ledger would refuse', async () => {
    // `invoice_payments` is guarded by a trigger requiring a pending
    // `payment.record` command and an invoice already open or paid. A receipt
    // is a state transition, not a row, and this integration is not entitled
    // to forge one -- so it writes what it observed and nothing else.
    const { sqlite: database, source } = await fixture()
    await source.recordPayment(payment)
    const count = database
      .prepare('SELECT COUNT(*) AS n FROM invoice_payments')
      .get() as { n: number }
    expect(count.n).toBe(0)
  })
})
