import { reconcileInvoiceHours, type InvoiceHoursReconciliation } from '@ezacto/core'
import { invoiceLineTimeOrigins } from './invoice-hours-provenance.js'
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
  const invoices = await database.all<{ id: number; version: number; state: string }>(
    sql`SELECT id,version,state FROM invoices WHERE id = ${invoiceId}`,
  )
  if (invoices[0] === undefined) return null
  const [entries, lines, receipts] = await Promise.all([
    database.all<{
      id: number
      userId: number
      userName: string
      spentDate: string
      projectId: number
      projectName: string
      seconds: number
    }>(
      sql`SELECT entry.id,entry.user_id AS userId,person.first_name||' '||person.last_name AS userName,entry.spent_date AS spentDate,entry.project_id AS projectId, project.name AS projectName,
                 coalesce(entry.rounded_seconds, entry.seconds) AS seconds
          FROM time_entries entry
          JOIN projects project ON project.id = entry.project_id
          JOIN users person ON person.id = entry.user_id
          WHERE entry.invoice_id = ${invoiceId} ORDER BY entry.id`,
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
    database.all<{
      requestJson: string | null
      sourceJson: string | null
      linesJson: string | null
    }>(sql`
      SELECT request_json AS requestJson,source_manifest_json AS sourceJson,line_manifest_json AS linesJson
      FROM invoice_command_ledger WHERE invoice_id=${invoiceId} AND command_kind='invoice.create' AND completed=1`),
  ])
  const origins = receipts[0] ? invoiceLineTimeOrigins(receipts[0]) : new Map<number, number[]>()
  return {
    ...reconcileInvoiceHours({
      exact: true,
      entries,
      lines: lines.map((line) => ({
        ...line,
        comparable: origins.has(line.id),
        ...(origins.has(line.id) ? { timeEntryIds: origins.get(line.id)! } : {}),
      })),
    }),
    invoiceVersion: invoices[0].version,
    invoiceState: invoices[0].state,
  }
}
