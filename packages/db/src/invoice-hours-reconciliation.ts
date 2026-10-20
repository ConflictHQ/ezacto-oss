import { reconcileInvoiceHours, type InvoiceHoursReconciliation } from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * An invoice's billed hours against the entries it claims (issue 924).
 *
 * The entries are the ones the hours report is rendered from -- linked by
 * `time_entries.invoice_id`, at `coalesce(rounded_seconds, seconds)` -- so this
 * total and the report's are the same number. `null` for an invoice that does
 * not exist; an invoice with no linked time and no lines is an empty, matched
 * result rather than an error.
 */
export const readInvoiceHoursReconciliation = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<InvoiceHoursReconciliation | null> => {
  const invoices = await database.all<{ id: number }>(
    sql`SELECT id FROM invoices WHERE id = ${invoiceId}`,
  )
  if (invoices[0] === undefined) return null
  const [entries, lines] = await Promise.all([
    database.all<{ projectId: number; projectName: string; seconds: number }>(
      sql`SELECT entry.project_id AS projectId, project.name AS projectName,
                 coalesce(entry.rounded_seconds, entry.seconds) AS seconds
          FROM time_entries entry
          JOIN projects project ON project.id = entry.project_id
          WHERE entry.invoice_id = ${invoiceId}`,
    ),
    database.all<{
      id: number
      position: number
      description: string | null
      projectId: number | null
      projectName: string | null
      quantity: number
    }>(
      sql`SELECT line.id AS id, line.position AS position, line.description AS description,
                 line.project_id AS projectId, project.name AS projectName,
                 line.quantity AS quantity
          FROM invoice_line_items line
          LEFT JOIN projects project ON project.id = line.project_id
          WHERE line.invoice_id = ${invoiceId}
          ORDER BY line.position`,
    ),
  ])
  return reconcileInvoiceHours({ entries, lines })
}
