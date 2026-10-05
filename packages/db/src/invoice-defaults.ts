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
}

export type InvoiceDefaultsPatch = Partial<InvoiceDefaults>

interface Row {
  companyName: string
  companyAddress: string | null
  notes: string | null
  subject: string | null
}

export const readInvoiceDefaults = async (
  database: InvoiceStateDatabase,
): Promise<InvoiceDefaults> => {
  const rows = await database.all<Row>(
    sql`SELECT name AS companyName, address AS companyAddress,
               invoice_default_notes AS notes, invoice_default_subject AS subject
        FROM organizations ORDER BY id LIMIT 1`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error('organization must exist before reading invoice defaults')
  return row
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
  ].filter((set) => set !== null)
  if (sets.length > 0) {
    await database.run(
      sql`UPDATE organizations SET ${sql.join(sets, sql`, `)}, updated_at = ${now}
          WHERE id = (SELECT id FROM organizations ORDER BY id LIMIT 1)`,
    )
  }
  return readInvoiceDefaults(database)
}
