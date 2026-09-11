/**
 * Reading what the mirror needs out of the database, and writing a payment back
 * into it.
 *
 * Kept apart from the runtime assembly because this is the only part that knows
 * SQL. The mirror wants an invoice, an ancestry, and somewhere to put a
 * receipt; it does not want a money repository.
 */

import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./schema.js";
import type {
  MirrorClient,
  MirrorInvoice,
  QuickBooksMirrorSource,
} from "@ezacto/integrations";

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>;

interface InvoiceRow {
  id: number;
  number: string;
  client_id: number;
  currency: string;
  issue_date: string;
  due_date: string | null;
  subject: string | null;
  notes: string | null;
}

interface LineRow {
  description: string | null;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}

interface ClientRow {
  id: number;
  name: string;
  parent_client_id: number | null;
  currency: string | null;
}

/**
 * How deep a client tree is walked before we decide it is a cycle.
 *
 * QuickBooks refuses more than five levels anyway, and the mapper says so with
 * a better message; this is only here so a corrupt parent chain cannot spin.
 */
const MAXIMUM_ANCESTRY = 16;

export const createQuickBooksMirrorSource = (
  database: Database,
  now: () => Date,
): QuickBooksMirrorSource => ({
  readInvoice: async (invoiceId) => {
    const rows = await database.all<InvoiceRow>(sql`
      SELECT id, number, client_id, currency, issue_date, due_date, subject, notes
      FROM invoices WHERE id = ${invoiceId}`);
    const invoice = rows[0];
    if (invoice === undefined) return null;
    const lines = await database.all<LineRow>(sql`
      SELECT description, quantity, unit_price_cents, amount_cents
      FROM invoice_line_items WHERE invoice_id = ${invoiceId}
      ORDER BY position`);
    return {
      id: invoice.id,
      number: invoice.number,
      clientId: invoice.client_id,
      currency: invoice.currency,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      subject: invoice.subject,
      notes: invoice.notes,
      lines: lines.map((line) => ({
        // QuickBooks shows the description and nothing else on a line, so an
        // empty one would be a blank row on a client's invoice.
        description: line.description ?? "Services",
        amountCents: line.amount_cents,
        quantity: line.quantity,
        unitPriceCents: line.unit_price_cents,
      })),
    } satisfies MirrorInvoice;
  },

  readClients: async (clientId) => {
    // Walked one row at a time rather than by recursive CTE: D1 supports them,
    // but a tree this shallow is at most five reads and the loop is the thing
    // anybody debugging this will be able to follow.
    const clients = new Map<number, MirrorClient>();
    let current: number | null = clientId;
    for (let depth = 0; current !== null && depth < MAXIMUM_ANCESTRY; depth += 1) {
      if (clients.has(current)) break;
      const rows: ClientRow[] = await database.all<ClientRow>(sql`
        SELECT id, name, parent_client_id, currency FROM clients WHERE id = ${current}`);
      const row = rows[0];
      if (row === undefined) break;
      clients.set(row.id, {
        id: row.id,
        name: row.name,
        parentClientId: row.parent_client_id,
        currency: row.currency,
      });
      current = row.parent_client_id;
    }
    return clients;
  },

  ezactoInvoiceFor: async (realmId, quickBooksInvoiceId) => {
    const rows = await database.all<{ ezacto_id: number }>(sql`
      SELECT ezacto_id FROM quickbooks_links
      WHERE realm_id = ${realmId} AND kind = 'invoice'
        AND quickbooks_id = ${quickBooksInvoiceId}`);
    return rows[0]?.ezacto_id ?? null;
  },

  recordPayment: async (input) => {
    const stamp = now().toISOString();
    const invoices = await database.all<{ currency: string }>(sql`
      SELECT currency FROM invoices WHERE id = ${input.invoiceId}`);
    const currency = invoices[0]?.currency;
    if (currency === undefined) return;

    // A checkout payment arrives through an account, and the schema says so:
    // `provider_account_id` is required for a QuickBooks payment. The realm is
    // the account -- it is the company the money was taken into.
    await database.run(sql`
      INSERT INTO payment_provider_accounts
        (provider, provider_shape, external_account_id, display_name, created_at, updated_at)
      VALUES ('quickbooks', 'checkout', ${input.realmId}, 'QuickBooks Online', ${stamp}, ${stamp})
      ON CONFLICT(provider, provider_shape, external_account_id) DO NOTHING`);
    const accounts = await database.all<{ id: number }>(sql`
      SELECT id FROM payment_provider_accounts
      WHERE provider = 'quickbooks' AND provider_shape = 'checkout'
        AND external_account_id = ${input.realmId}`);
    const accountId = accounts[0]?.id;
    if (accountId === undefined) return;

    // `provider_transaction_id` is the QuickBooks payment id, which makes this
    // idempotent at the row level as well as at the delivery level: a payment
    // already recorded is not recorded twice even if a delivery is somehow
    // claimed twice.
    await database.run(sql`
      INSERT INTO invoice_payments
        (invoice_id, currency, amount_cents, paid_date, notes, provider,
         provider_shape, provider_account_id, provider_transaction_id,
         created_at, updated_at)
      SELECT ${input.invoiceId}, ${currency}, ${input.amountCents},
        ${input.paidOn}, ${`QuickBooks payment ${input.quickBooksPaymentId}`},
        'quickbooks', 'checkout', ${accountId}, ${input.quickBooksPaymentId},
        ${stamp}, ${stamp}
      WHERE NOT EXISTS (
        SELECT 1 FROM invoice_payments
        WHERE provider = 'quickbooks'
          AND provider_transaction_id = ${input.quickBooksPaymentId}
      )`);
  },
});
