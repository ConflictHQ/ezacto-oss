/** One confirmed, resumable action for rendering, attaching and queueing month-end packs (#58). */
import {
  previewClientReportNotes,
  renderDetailedReportDocument,
  type ReportNoteWarning,
} from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { monthEndManifest, type MonthEndManifest } from './month-end-manifest.js'
import { resolveReportBrand } from './report-brands.js'
import { executeRun, type RunExecutionReport } from './run-executor.js'
import { createScheduledActionStore, type ProposeOutcome } from './scheduled-actions.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface MonthEndPackAttachment {
  readonly invoiceId: number
  readonly name: string
  readonly contentType: 'application/pdf'
  readonly bytes: Uint8Array
  readonly idempotencyKey: string
}

export interface MonthEndPackSend {
  readonly invoiceId: number
  readonly to: string
  readonly attachmentName: string
  readonly idempotencyKey: string
}

export interface MonthEndPackDelivery {
  attach(input: Readonly<MonthEndPackAttachment>): Promise<void>
  queue(input: Readonly<MonthEndPackSend>): Promise<void>
}

export interface MonthEndPackItemPreview {
  readonly invoiceId: number
  readonly brandName: string
  readonly warnings: readonly ReportNoteWarning[]
}

export interface MonthEndPackProposal {
  readonly outcome: ProposeOutcome
  readonly manifest: MonthEndManifest
  readonly previews: readonly MonthEndPackItemPreview[]
}

interface DetailRow {
  id: number
  spentDate: string
  projectName: string
  personName: string
  roundedSeconds: number
  notes: string | null
  clientVisible: number | null
  visibleDefault: number
}

interface InvoiceRow {
  invoiceId: number
  number: string
  clientId: number
  clientName: string
  target: string
}

const invoice = async (database: Database, invoiceId: number): Promise<InvoiceRow> => {
  const rows = await database.all<InvoiceRow>(sql`
    SELECT invoice.id AS "invoiceId", invoice.number, client.id AS "clientId",
      client.name AS "clientName",
      (SELECT contact.email FROM contacts contact
       WHERE contact.client_id = client.id
         AND contact.invoice_recipient_status = 'recipient'
         AND contact.email IS NOT NULL AND trim(contact.email) <> ''
       ORDER BY contact.id LIMIT 1) AS target
    FROM invoices invoice JOIN clients client ON client.id = invoice.client_id
    WHERE invoice.id = ${invoiceId}`)
  const found = rows[0]
  if (found === undefined || found.target === null) throw new Error('month-end invoice or recipient is missing')
  return found
}

const details = async (
  database: Database,
  clientId: number,
  from: string,
  to: string,
): Promise<readonly DetailRow[]> => database.all<DetailRow>(sql`
  SELECT entry.id, entry.spent_date AS "spentDate", project.name AS "projectName",
    person.first_name || ' ' || person.last_name AS "personName",
    entry.rounded_seconds AS "roundedSeconds", entry.notes,
    entry.client_visible AS "clientVisible",
    organization.report_notes_client_visible_default AS "visibleDefault"
  FROM time_entries entry
  JOIN projects project ON project.id = entry.project_id
  JOIN users person ON person.id = entry.user_id
  JOIN organizations organization ON organization.id = 1
  WHERE entry.spent_date BETWEEN ${from} AND ${to}
    AND project.client_id IN (
      SELECT descendant_id FROM client_hierarchy WHERE ancestor_id = ${clientId}
    )
  ORDER BY entry.spent_date, entry.id`)

const rangeFromOccurrence = (occurrenceKey: string): { from: string; to: string } => {
  if (!/^\d{4}-\d{2}$/u.test(occurrenceKey)) throw new Error('month-end occurrence key must be YYYY-MM')
  const from = `${occurrenceKey}-01`
  const next = new Date(`${from}T00:00:00.000Z`)
  if (!Number.isFinite(next.valueOf())) throw new Error('month-end occurrence key is not a calendar month')
  next.setUTCMonth(next.getUTCMonth() + 1)
  next.setUTCDate(0)
  return { from, to: next.toISOString().slice(0, 10) }
}

export const createMonthEndPackService = (
  database: Database,
  delivery: MonthEndPackDelivery,
) => {
  const store = createScheduledActionStore(database)

  const render = async (runId: number, invoiceId: number): Promise<{
    invoice: InvoiceRow
    name: string
    bytes: Uint8Array
    warnings: readonly ReportNoteWarning[]
  }> => {
    const run = await store.read(runId)
    if (run === null) throw new Error('month-end run is missing')
    const range = rangeFromOccurrence(run.occurrenceKey)
    const invoiceRecord = await invoice(database, invoiceId)
    const rows = await details(database, invoiceRecord.clientId, range.from, range.to)
    const visibleDefault = rows[0]?.visibleDefault !== 0
    const notePreview = previewClientReportNotes(
      rows.map((row) => ({
        id: row.id,
        notes: row.notes,
        clientVisible: row.clientVisible === null ? null : row.clientVisible === 1,
      })),
      visibleDefault,
    )
    const visibleIds = new Set(notePreview.entries.map(({ id }) => id))
    const brand = await resolveReportBrand(database, invoiceRecord.clientId)
    const organization = await database.all<{ name: string }>(sql`SELECT name FROM organizations WHERE id = 1`)
    const brandName = brand?.name ?? organization[0]?.name ?? invoiceRecord.clientName
    const totalSeconds = rows.reduce((total, row) => total + row.roundedSeconds, 0)
    const name = `work-detail-${run.occurrenceKey}-invoice-${invoiceRecord.number}.pdf`
    const bytes = renderDetailedReportDocument({
      title: 'Detailed time',
      period: `${range.from} through ${range.to}`,
      brandName,
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'project', label: 'Project' },
        { key: 'person', label: 'Person' },
        { key: 'hours', label: 'Hours' },
      ],
      rows: rows.map((row) => ({
        id: row.id,
        values: {
          date: row.spentDate,
          project: row.projectName,
          person: row.personName,
          hours: (row.roundedSeconds / 3_600).toFixed(2),
        },
        notes: visibleIds.has(row.id) ? row.notes : null,
      })),
      runningTotals: [`Hours ${(totalSeconds / 3_600).toFixed(2)}`],
    })
    return { invoice: invoiceRecord, name, bytes, warnings: notePreview.warnings }
  }

  return {
    propose: async (input: Readonly<{
      jobId: number
      occurrenceKey: string
      clientIds?: readonly number[]
      proposedAt: string
      expiresAt: string
    }>): Promise<MonthEndPackProposal> => {
      const range = rangeFromOccurrence(input.occurrenceKey)
      const manifest = await monthEndManifest(database, {
        periodStart: range.from,
        periodEnd: range.to,
        scope: input.clientIds === undefined ? {} : { clientIds: input.clientIds },
      })
      const outcome = await store.propose({
        jobId: input.jobId,
        occurrenceKey: input.occurrenceKey,
        items: manifest.items,
        proposedAt: input.proposedAt,
        expiresAt: input.expiresAt,
      })
      const runId = outcome.outcome === 'proposed' ? outcome.run.id : 0
      const previews = runId === 0
        ? []
        : await Promise.all(manifest.items.map(async (item, index) => {
            void index
            const rendered = await render(runId, item.subjectId)
            const brand = await resolveReportBrand(database, rendered.invoice.clientId)
            return {
              invoiceId: item.subjectId,
              brandName: brand?.name ?? rendered.invoice.clientName,
              warnings: rendered.warnings,
            }
          }))
      return { outcome, manifest, previews }
    },

    confirmAndExecute: async (
      runId: number,
      userId: number,
      now: () => string,
    ): Promise<RunExecutionReport | { runId: number; completed: 0; failed: readonly []; runCompleted: true }> => {
      const current = await store.read(runId)
      if (current === null) throw new Error('month-end run is missing')
      if (current.state === 'completed') {
        return { runId, completed: 0, failed: [], runCompleted: true }
      }
      if (current.state === 'proposed') {
        const confirmation = await store.confirm(runId, userId, now())
        if (confirmation.outcome !== 'confirmed') throw new Error(`month-end confirmation refused: ${confirmation.outcome}`)
      } else if (current.state !== 'confirmed') {
        throw new Error(`month-end run is ${current.state}`)
      }
      return executeRun(runId, {
        store,
        now,
        handler: async (item) => {
          if (item.subjectType !== 'invoice') throw new Error('month-end item is not an invoice')
          const rendered = await render(runId, item.subjectId)
          const key = `month-end:${String(runId)}:${String(item.id)}`
          await delivery.attach({
            invoiceId: item.subjectId,
            name: rendered.name,
            contentType: 'application/pdf',
            bytes: rendered.bytes,
            idempotencyKey: `${key}:attachment`,
          })
          await delivery.queue({
            invoiceId: item.subjectId,
            to: rendered.invoice.target,
            attachmentName: rendered.name,
            idempotencyKey: `${key}:send`,
          })
        },
      })
    },
  }
}
