/**
 * Reading what the BILL mirror needs out of the database, and writing a payment
 * back into it.
 *
 * Kept apart from the runtime assembly because this is the only part that knows
 * SQL. The mirror wants an invoice, a client, somewhere to put the ids BILL
 * gave back, and somewhere to put a receipt.
 *
 * There is no connection store here, and its absence is the design: BILL has no
 * OAuth, so the credential is deployment configuration rather than something
 * this system obtains, holds or rotates. See migration 0050.
 */

import { sql } from 'drizzle-orm'
import { recordCheckoutPayment } from './checkout-payments.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import type {
  BillLink,
  BillLinkKind,
  BillLinkStore,
  BillMirrorClient,
  BillMirrorInvoice,
  BillMirrorSource,
} from '@ezacto/integrations'

// The command path's own database type: writing a receipt is a command, and
// `recordCheckoutPayment` needs the transaction seam that carries.
type Database = InvoiceStateDatabase

interface InvoiceRow {
  id: number
  number: string
  client_id: number
  currency: string
  issue_date: string
  due_date: string | null
  subject: string | null
}

interface LineRow {
  description: string | null
  quantity: number
  unit_price_cents: number
  amount_cents: number
}

export const createBillLinkStore = (
  database: Database,
  now: () => Date,
): BillLinkStore => ({
  readLink: async (kind: BillLinkKind, ezactoId: number): Promise<BillLink | null> => {
    const rows = await database.all<{ bill_id: string; payment_link: string | null }>(sql`
      SELECT bill_id, payment_link FROM bill_links
      WHERE kind = ${kind} AND ezacto_id = ${ezactoId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : { billId: row.bill_id, paymentLink: row.payment_link }
  },

  /**
   * An upsert, but only over the payment link.
   *
   * The schema refuses a change to `bill_id`, `kind` or `ezacto_id` outright,
   * so this cannot re-point a link even by accident -- the one thing a second
   * save legitimately does is fill in the payment URL once it has been
   * fetched.
   */
  saveLink: async (kind, ezactoId, link) => {
    const stamp = now().toISOString()
    await database.run(sql`
      INSERT INTO bill_links
        (kind, ezacto_id, bill_id, payment_link, mirrored_at, created_at, updated_at)
      VALUES (${kind}, ${ezactoId}, ${link.billId}, ${link.paymentLink},
        ${stamp}, ${stamp}, ${stamp})
      ON CONFLICT(kind, ezacto_id) DO UPDATE SET
        payment_link = excluded.payment_link,
        updated_at = excluded.updated_at`)
  },
})

/**
 * Names the one `payment_provider_accounts` row BILL payments are filed
 * against. An instance connects to a single BILL organisation, so this is
 * stable; it is a constant rather than a value so that two writes cannot
 * disagree about which account a receipt belongs to.
 */
const BILL_ACCOUNT_KEY = 'bill'

export const createBillMirrorSource = (
  database: Database,
  now: () => Date,
): BillMirrorSource => ({
  readInvoice: async (invoiceId: number): Promise<BillMirrorInvoice | null> => {
    const rows = await database.all<InvoiceRow>(sql`
      SELECT id, number, client_id, currency, issue_date, due_date, subject
      FROM invoices WHERE id = ${invoiceId}`)
    const invoice = rows[0]
    if (invoice === undefined) return null
    const lines = await database.all<LineRow>(sql`
      SELECT description, quantity, unit_price_cents, amount_cents
      FROM invoice_line_items WHERE invoice_id = ${invoiceId}
      ORDER BY position`)
    return {
      id: invoice.id,
      number: invoice.number,
      clientId: invoice.client_id,
      currency: invoice.currency,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      subject: invoice.subject,
      lines: lines.map((line) => ({
        // BILL shows the description and nothing else on a line, so an empty
        // one would be a blank row on a client's invoice.
        description: line.description ?? 'Services',
        amountCents: line.amount_cents,
        quantity: line.quantity,
        unitPriceCents: line.unit_price_cents,
      })),
    }
  },

  readClient: async (clientId: number): Promise<BillMirrorClient | null> => {
    // The address the invoice already goes to: the contact marked as this
    // client's invoice recipient. Taken from there rather than from anywhere
    // else so that turning BILL on does not quietly change who gets billed.
    const rows = await database.all<{ id: number; name: string; email: string | null }>(sql`
      SELECT c.id, c.name,
        (SELECT ct.email FROM contacts ct
          WHERE ct.client_id = c.id
            AND ct.invoice_recipient_status = 'recipient'
            AND ct.email IS NOT NULL
          ORDER BY ct.id ASC LIMIT 1) AS email
      FROM clients c WHERE c.id = ${clientId}`)
    const row = rows[0]
    return row === undefined
      ? null
      : { id: row.id, name: row.name, email: row.email }
  },

  isOptedIn: async (clientId: number): Promise<boolean> => {
    const rows = await database.all<{ bill_delivery: number }>(sql`
      SELECT bill_delivery FROM clients WHERE id = ${clientId}`)
    return rows[0]?.bill_delivery === 1
  },

  mirroredInvoices: async (): Promise<ReadonlyMap<string, number>> => {
    const rows = await database.all<{ bill_id: string; ezacto_id: number }>(sql`
      SELECT bill_id, ezacto_id FROM bill_links WHERE kind = 'invoice'`)
    return new Map(rows.map((row) => [row.bill_id, row.ezacto_id]))
  },

  /**
   * Records a payment BILL reported against one of our invoices.
   *
   * Two writes, and both matter. `bill_received_payments` is our own record of
   * what BILL said -- keyed on the payment and the invoice, so a poll that sees
   * it again writes nothing -- and `recordCheckoutPayment` turns it into a
   * receipt on the invoice through the command ledger.
   *
   * This stopped at the first write until issue 595: `invoice_payments` is
   * guarded by a trigger requiring a pending `payment.record` command, and a
   * receipt is a state transition rather than a row, so there was no sanctioned
   * way to write one. There is now, and both mirrors use it.
   */
  recordPayment: async (input) => {
    const stamp = now().toISOString()
    const invoices = await database.all<{ id: number }>(sql`
      SELECT id FROM invoices WHERE id = ${input.invoiceId}`)
    if (invoices.length === 0) return

    await database.run(sql`
      INSERT INTO bill_received_payments
        (bill_payment_id, bill_invoice_id, invoice_id, amount_cents, paid_on, recorded_at)
      VALUES (${input.billPaymentId}, ${input.billInvoiceId}, ${input.invoiceId},
        ${input.amountCents}, ${input.paidOn}, ${stamp})
      ON CONFLICT(bill_payment_id, bill_invoice_id) DO NOTHING`)

    await recordCheckoutPayment(database, {
      invoiceId: input.invoiceId,
      provider: 'bill_com',
      // An ezacto instance connects to one BILL organisation, so there is one
      // account and a constant names it. The company id would be more
      // descriptive, but it lives in the deployment's configuration and this
      // module is the database half -- threading a credential in here to make
      // a label read better is not a trade worth taking.
      externalAccountId: BILL_ACCOUNT_KEY,
      accountDisplayName: 'BILL',
      providerTransactionId: input.billPaymentId,
      amountCents: input.amountCents,
      paidOn: input.paidOn,
      now: stamp,
    })
  },
})

/** Turning the per-client opt-in on or off. */
export const setBillDelivery = async (
  database: Database,
  clientId: number,
  enabled: boolean,
): Promise<boolean> => {
  const rows = await database.all<{ id: number }>(sql`
    UPDATE clients SET bill_delivery = ${enabled ? 1 : 0}
    WHERE id = ${clientId} RETURNING id`)
  return rows.length > 0
}
