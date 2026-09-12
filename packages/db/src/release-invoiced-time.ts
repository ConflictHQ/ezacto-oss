import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * Releasing time entries from an invoice (issue 496).
 *
 * The first of the two operations that together let a billed entry be removed.
 * An entry claimed by an invoice is not free to delete -- its hours are what the
 * invoice bills -- so it is released first, and released only once the invoice
 * no longer stands.
 *
 * The schema refuses the rest: a trigger rejects both clearing the column and
 * deleting the row while the invoice is open or paid. What this adds is an
 * answer instead of a constraint failure, and a count of what moved.
 */

export type ReleaseOutcome =
  | { readonly released: number }
  | { readonly refused: 'invoice_not_found' | 'invoice_still_stands' }

export const releaseInvoicedTimeEntries = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<ReleaseOutcome> => {
  const invoices = await database.all<{ state: string }>(
    sql`SELECT state FROM invoices WHERE id = ${invoiceId}`,
  )
  const invoice = invoices[0]
  if (invoice === undefined) return { refused: 'invoice_not_found' }
  // Asked here as well as enforced by the trigger, so a caller learns why
  // rather than catching an abort and guessing which rule it broke.
  if (invoice.state === 'open' || invoice.state === 'paid') {
    return { refused: 'invoice_still_stands' }
  }

  const claimed = await database.all<{ count: number }>(
    sql`SELECT count(*) AS count FROM time_entries WHERE invoice_id = ${invoiceId}`,
  )
  const released = claimed[0]?.count ?? 0
  if (released === 0) return { released: 0 }

  await database.run(
    sql`UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ${invoiceId}`,
  )
  return { released }
}

/**
 * Whether this entry is currently claimed, and by an invoice that still stands.
 *
 * A screen offering "delete" on an entry it cannot delete is worse than one that
 * explains why, so the answer is available before the attempt.
 */
export interface TimeEntryClaim {
  readonly invoiceId: number | null
  readonly invoiceState: string | null
  readonly deletable: boolean
}

export const readTimeEntryClaim = async (
  database: InvoiceStateDatabase,
  timeEntryId: number,
): Promise<TimeEntryClaim | null> => {
  const rows = await database.all<{ invoiceId: number | null; invoiceState: string | null }>(
    sql`SELECT entry.invoice_id AS invoiceId, invoice.state AS invoiceState
        FROM time_entries entry
        LEFT JOIN invoices invoice ON invoice.id = entry.invoice_id
        WHERE entry.id = ${timeEntryId}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  const standing = row.invoiceState === 'open' || row.invoiceState === 'paid'
  return {
    invoiceId: row.invoiceId,
    invoiceState: row.invoiceState,
    deletable: !standing,
  }
}
