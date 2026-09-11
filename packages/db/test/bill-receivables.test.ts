import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'

const t = (minute: number): string =>
  `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<BetterSqlite3.Database> => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (2, 'Northpeak', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (10, 1, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (11, 1, '1316', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  return database
}

const link = (
  database: BetterSqlite3.Database,
  kind: string,
  ezactoId: number,
  billId: string,
) =>
  database
    .prepare(
      `INSERT INTO bill_links (kind, ezacto_id, bill_id, mirrored_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(kind, ezactoId, billId, t(1), t(1), t(1))

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('the per-client opt-in (#542)', () => {
  it('[db] is off for every client that existed before it', async () => {
    // Sending a client's invoice through a third party changes how that client
    // is billed. It is never something a migration turns on for them.
    const database = await fixture()
    const rows = database
      .prepare('SELECT id, bill_delivery FROM clients ORDER BY id')
      .all() as { id: number; bill_delivery: number }[]
    expect(rows).toEqual([
      { id: 1, bill_delivery: 0 },
      { id: 2, bill_delivery: 0 },
    ])
  })

  it('[db] takes only a boolean', async () => {
    const database = await fixture()
    expect(() =>
      database.prepare('UPDATE clients SET bill_delivery = 2 WHERE id = 1').run(),
    ).toThrow()
    expect(() =>
      database.prepare('UPDATE clients SET bill_delivery = 1 WHERE id = 1').run(),
    ).not.toThrow()
  })
})

describe('the BILL link ledger (#542)', () => {
  it('[db] stores a customer and an invoice link', async () => {
    const database = await fixture()
    expect(() => link(database, 'customer', 1, '0cu001')).not.toThrow()
    expect(() => link(database, 'invoice', 10, '00e001')).not.toThrow()
  })

  it('[security] refuses a BILL id whose prefix contradicts its kind', async () => {
    // A customer id filed as an invoice would make a payment land on a
    // document that is not an invoice at all.
    const database = await fixture()
    expect(() => link(database, 'invoice', 10, '0cu001')).toThrow()
    expect(() => link(database, 'customer', 1, '00e001')).toThrow()
  })

  it('[security] refuses a link to a client or invoice that does not exist', async () => {
    // What a foreign key would do, were the column not polymorphic.
    const database = await fixture()
    expect(() => link(database, 'customer', 999, '0cu001')).toThrow(
      /must name an existing client or invoice/u,
    )
    expect(() => link(database, 'invoice', 999, '00e001')).toThrow(
      /must name an existing client or invoice/u,
    )
  })

  it('[security] refuses two of our invoices pointing at one BILL invoice', async () => {
    // Otherwise a payment would be recorded against whichever was found first.
    const database = await fixture()
    link(database, 'invoice', 10, '00e001')
    expect(() => link(database, 'invoice', 11, '00e001')).toThrow()
  })

  it('[security] refuses one of our invoices pointing at two BILL invoices', async () => {
    const database = await fixture()
    link(database, 'invoice', 10, '00e001')
    expect(() => link(database, 'invoice', 10, '00e002')).toThrow()
  })

  it('[security] will not let a link be re-pointed at a different document', async () => {
    // An id that moves is how a payment lands on the wrong invoice.
    const database = await fixture()
    link(database, 'invoice', 10, '00e001')
    for (const statement of [
      `UPDATE bill_links SET bill_id = '00e999' WHERE ezacto_id = 10`,
      `UPDATE bill_links SET ezacto_id = 11 WHERE ezacto_id = 10`,
      `UPDATE bill_links SET kind = 'customer' WHERE ezacto_id = 10`,
    ]) {
      expect(() => database.prepare(statement).run()).toThrow(/identity is immutable/u)
    }
  })

  it('[db] still allows the payment link and timestamps to be updated', async () => {
    // The guard is on identity, not on the row -- a link whose payment URL
    // could never be filled in would be a link that cannot be used.
    const database = await fixture()
    link(database, 'invoice', 10, '00e001')
    expect(() =>
      database
        .prepare(
          `UPDATE bill_links SET payment_link = 'https://app.bill.com/pay/x', updated_at = ?
           WHERE kind = 'invoice' AND ezacto_id = 10`,
        )
        .run(t(5)),
    ).not.toThrow()
  })
})

describe('recording what BILL received (#542)', () => {
  const record = (
    database: BetterSqlite3.Database,
    paymentId: string,
    billInvoiceId: string,
    invoiceId: number,
    amountCents = 100_000,
  ) =>
    database
      .prepare(
        `INSERT INTO bill_received_payments
           (bill_payment_id, bill_invoice_id, invoice_id, amount_cents, paid_on, recorded_at)
         VALUES (?, ?, ?, ?, '2026-09-20', ?)`,
      )
      .run(paymentId, billInvoiceId, invoiceId, amountCents, t(2))

  it('[money] records one payment against one invoice', async () => {
    const database = await fixture()
    expect(() => record(database, '0rp1', '00e001', 10)).not.toThrow()
  })

  it('[money] lets one payment settle two invoices, each with its own share', async () => {
    // The reason the key is the pair. Keyed on the payment alone, the second
    // invoice's share would have nowhere to go and would be silently lost.
    const database = await fixture()
    record(database, '0rp1', '00e001', 10, 100_000)
    expect(() => record(database, '0rp1', '00e002', 11, 50_000)).not.toThrow()
    const total = database
      .prepare('SELECT SUM(amount_cents) AS total FROM bill_received_payments')
      .get() as { total: number }
    expect(total.total).toBe(150_000)
  })

  it('[money] refuses the same payment against the same invoice twice', async () => {
    // The reconciliation is a poll: it sees every payment again on every pass,
    // and the second pass must record nothing.
    const database = await fixture()
    record(database, '0rp1', '00e001', 10)
    expect(() => record(database, '0rp1', '00e001', 10)).toThrow()
  })

  it('[money] refuses a zero or negative amount', async () => {
    const database = await fixture()
    expect(() => record(database, '0rp1', '00e001', 10, 0)).toThrow()
    expect(() => record(database, '0rp2', '00e001', 10, -1)).toThrow()
  })

  it('[db] refuses a payment against an invoice that does not exist', async () => {
    const database = await fixture()
    expect(() => record(database, '0rp1', '00e001', 999)).toThrow()
  })

  it('[db] refuses a paid_on that is not a plain date', async () => {
    const database = await fixture()
    expect(() =>
      database
        .prepare(
          `INSERT INTO bill_received_payments
             (bill_payment_id, bill_invoice_id, invoice_id, amount_cents, paid_on, recorded_at)
           VALUES ('0rp9', '00e001', 10, 100, '2026-09-20T00:00:00Z', ?)`,
        )
        .run(t(2)),
    ).toThrow()
  })
})
