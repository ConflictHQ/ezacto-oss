import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * Whether a settled invoice should send a thank-you (issue 545).
 *
 * Two levels, and the precedence is the load-bearing part: an invoice's own
 * preference wins, and an invoice that has none follows the global default.
 *
 * Read at send time rather than captured when the invoice was raised. An
 * operator who turns the feature off today expects that to govern an invoice
 * raised yesterday, and a preference frozen at creation would quietly keep
 * sending from invoices already in flight.
 */
export type ThankYouDecision =
  | { readonly send: true; readonly because: 'invoice' | 'organization' }
  | { readonly send: false; readonly because: 'invoice' | 'organization' | 'unknown_invoice' }

export const resolveThankYouPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<ThankYouDecision> => {
  const rows = await database.all<{
    invoice: number | null
    organization: number | null
  }>(
    sql`SELECT invoice.auto_thank_you AS invoice,
               (SELECT organization.auto_thank_you FROM organizations organization
                ORDER BY organization.id LIMIT 1) AS organization
        FROM invoices invoice WHERE invoice.id = ${invoiceId}`,
  )
  const row = rows[0]
  if (row === undefined) return { send: false, because: 'unknown_invoice' }
  if (row.invoice !== null) {
    return row.invoice === 1
      ? { send: true, because: 'invoice' }
      : { send: false, because: 'invoice' }
  }
  // No organization row at all is treated as off. A deployment that has not
  // been configured should not begin emailing clients because this shipped.
  return row.organization === 1
    ? { send: true, because: 'organization' }
    : { send: false, because: 'organization' }
}

/**
 * Whether this payment has already had its thank-you.
 *
 * The schema already refuses a second one -- the intent table is keyed on the
 * payment -- so this exists to let a caller decide rather than to catch a
 * constraint failure and guess what it meant.
 */
export const hasThankYouIntent = async (
  database: InvoiceStateDatabase,
  invoicePaymentId: number,
): Promise<boolean> => {
  const rows = await database.all<{ present: number }>(
    sql`SELECT 1 AS present FROM invoice_auto_email_intents
        WHERE invoice_payment_id = ${invoicePaymentId}`,
  )
  return rows.length > 0
}

export interface ThankYouPolicyUpdate {
  readonly invoiceId: number
  /** `null` hands the invoice back to the global default. */
  readonly enabled: boolean | null
}

export const setInvoiceThankYouPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<ThankYouPolicyUpdate>,
): Promise<boolean> => {
  // Asked before the write rather than counted after it: the two drivers behind
  // this seam report affected rows differently, and a caller wants to know
  // whether the invoice exists, not how many rows a driver decided to name.
  const present = await database.all<{ id: number }>(
    sql`SELECT id FROM invoices WHERE id = ${input.invoiceId}`,
  )
  if (present.length === 0) return false
  const value = input.enabled === null ? null : input.enabled ? 1 : 0
  await database.run(
    sql`UPDATE invoices SET auto_thank_you = ${value} WHERE id = ${input.invoiceId}`,
  )
  return true
}

export const setOrganizationThankYouPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => {
  await database.run(
    sql`UPDATE organizations SET auto_thank_you = ${enabled ? 1 : 0}`,
  )
}
