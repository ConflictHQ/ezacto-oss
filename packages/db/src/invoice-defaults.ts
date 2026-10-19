import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * The invoice's letterhead and starting text (Harvest's Invoices › Configure:
 * Company information and Default values).
 *
 * The name and address are the organization's own and print on every invoice,
 * existing ones included, because the document is rendered when it is sent. The
 * notes and subject are copied onto a draft when it is created, and from then on
 * belong to that invoice: changing the default does not rewrite what was billed.
 */
export interface InvoiceDefaults {
  readonly companyName: string
  readonly companyAddress: string | null
  readonly notes: string | null
  readonly subject: string | null
  /** Days an estimate stays answerable from the day it is first sent; null means no default expiry (issue 1010). */
  readonly estimateValidityDays: number | null
  /**
   * Whether the invoice email links the invoice online and records when it is
   * first opened (issue 936). Off until somebody turns it on.
   */
  readonly viewReceipts: boolean
}

export type InvoiceDefaultsPatch = Partial<InvoiceDefaults>

interface Row {
  companyName: string
  companyAddress: string | null
  notes: string | null
  subject: string | null
  estimateValidityDays: number | null
  viewReceipts: number
}

export const readInvoiceDefaults = async (
  database: InvoiceStateDatabase,
): Promise<InvoiceDefaults> => {
  const rows = await database.all<Row>(
    sql`SELECT name AS companyName, address AS companyAddress,
               invoice_default_notes AS notes, invoice_default_subject AS subject,
               estimate_validity_days AS estimateValidityDays,
               invoice_view_receipts AS viewReceipts
        FROM organizations ORDER BY id LIMIT 1`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error('organization must exist before reading invoice defaults')
  return { ...row, viewReceipts: row.viewReceipts === 1 }
}

/** Blank text is stored as no default, so "none" has one spelling. */
const nullable = (value: string | null): string | null =>
  value === null || value.trim() === '' ? null : value

export const updateInvoiceDefaults = async (
  database: InvoiceStateDatabase,
  patch: InvoiceDefaultsPatch,
  now: string,
): Promise<InvoiceDefaults> => {
  const sets = [
    patch.companyName === undefined ? null : sql`name = ${patch.companyName.trim()}`,
    patch.companyAddress === undefined ? null : sql`address = ${nullable(patch.companyAddress)}`,
    patch.notes === undefined ? null : sql`invoice_default_notes = ${nullable(patch.notes)}`,
    patch.subject === undefined ? null : sql`invoice_default_subject = ${nullable(patch.subject)}`,
    patch.estimateValidityDays === undefined
      ? null
      : sql`estimate_validity_days = ${patch.estimateValidityDays}`,
    patch.viewReceipts === undefined
      ? null
      : sql`invoice_view_receipts = ${patch.viewReceipts ? 1 : 0}`,
  ].filter((set) => set !== null)
  if (sets.length > 0) {
    await database.run(
      sql`UPDATE organizations SET ${sql.join(sets, sql`, `)}, updated_at = ${now}
          WHERE id = (SELECT id FROM organizations ORDER BY id LIMIT 1)`,
    )
  }
  return readInvoiceDefaults(database)
}
