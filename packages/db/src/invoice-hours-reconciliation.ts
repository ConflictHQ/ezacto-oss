import {
  reconcileInvoiceHours,
  type InvoiceHoursReconciliation,
  type ReconciliationEntry,
  type ReconciliationLine,
} from '@ezacto/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { invoiceLineTimeOrigins } from './invoice-hours-provenance.js'
import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/** Internal SQL references only; invoice IDs remain bound parameters. The same
 * ordered JSON is used by the read snapshot and the atomic release guard. */
export const invoiceHoursEntriesSnapshotSql = (
  invoice: string,
): string => `(SELECT json_group_array(json_object(
  'id',id,'userId',userId,'userName',userName,'spentDate',spentDate,'projectId',projectId,'projectName',projectName,'seconds',seconds,
  'updatedAt',updatedAt,'running',running)) FROM (
    SELECT entry.id,entry.user_id AS userId,person.first_name||' '||person.last_name AS userName,entry.spent_date AS spentDate,
      entry.project_id AS projectId,project.name AS projectName,coalesce(entry.rounded_seconds,entry.seconds) AS seconds,entry.updated_at AS updatedAt,
      CASE WHEN entry.timer_started_at IS NOT NULL OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL) THEN 1 ELSE 0 END AS running
    FROM time_entries entry JOIN projects project ON project.id=entry.project_id JOIN users person ON person.id=entry.user_id
    WHERE entry.invoice_id=${invoice} ORDER BY entry.id))`
interface SnapshotRow {
  version: number
  state: string
  entriesJson: string
  linesJson: string
  requestJson: string | null
  sourceJson: string | null
  originalLinesJson: string | null
}
export interface InvoiceHoursSnapshot {
  review: InvoiceHoursReconciliation
  entriesJson: string
  entries: (ReconciliationEntry & { id: number; running: number })[]
}
/** One SQL statement captures invoice, entries and quantities coherently. The
 * immutable generation receipt supplies identities, never guessed descriptions. */
export const readInvoiceHoursSnapshot = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<InvoiceHoursSnapshot | null> => {
  const [row] = await database.all<SnapshotRow>(
    sql`${sql.raw(`SELECT i.version,i.state,
    ${invoiceHoursEntriesSnapshotSql('i.id')} AS entriesJson,
    (SELECT json_group_array(json_object('id',id,'position',position,'description',description,'projectId',projectId,'projectName',projectName,'quantity',quantity)) FROM (
      SELECT line.id,line.position,line.description,line.project_id AS projectId,project.name AS projectName,line.quantity
      FROM invoice_line_items line LEFT JOIN projects project ON project.id=line.project_id WHERE line.invoice_id=i.id ORDER BY line.position,line.id)) AS linesJson,
    receipt.request_json AS requestJson,receipt.source_manifest_json AS sourceJson,receipt.line_manifest_json AS originalLinesJson
    FROM invoices i LEFT JOIN invoice_command_ledger receipt ON receipt.invoice_id=i.id AND receipt.command_kind='invoice.create' AND receipt.completed=1
    WHERE i.id=`)}${Number.isSafeInteger(invoiceId) && invoiceId > 0 ? invoiceId : -1}`,
  )
  if (!row) return null
  const entries = JSON.parse(row.entriesJson) as InvoiceHoursSnapshot['entries']
  const lines = JSON.parse(row.linesJson) as ReconciliationLine[]
  const origins = invoiceLineTimeOrigins({
    requestJson: row.requestJson,
    sourceJson: row.sourceJson,
    linesJson: row.originalLinesJson,
  })
  const hoursVersion = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([row.version, row.state, row.entriesJson, row.linesJson]),
      ),
    ),
  )
  return {
    entriesJson: row.entriesJson,
    entries,
    review: {
      ...reconcileInvoiceHours({
        exact: true,
        entries,
        lines: lines.map((line) => ({
          ...line,
          comparable: origins.has(line.id),
          ...(origins.has(line.id) ? { timeEntryIds: origins.get(line.id)! } : {}),
        })),
      }),
      invoiceVersion: row.version,
      invoiceState: row.state,
      hoursVersion,
    },
  }
}
export const readInvoiceHoursReconciliation = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<InvoiceHoursReconciliation | null> =>
  (await readInvoiceHoursSnapshot(database, invoiceId))?.review ?? null
