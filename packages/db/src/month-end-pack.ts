/** One confirmed, resumable action for rendering, attaching and queueing month-end packs (#58). */
import {
  previewClientReportNotes,
  renderDetailedReportDocument,
  type ReportNoteWarning,
  type ScheduledReportPerson,
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
  readReport?(key: string): Promise<Uint8Array | null>
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
  personId: number
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
  if (found === undefined || found.target === null)
    throw new Error('month-end invoice or recipient is missing')
  return found
}

const details = async (
  database: Database,
  clientId: number,
  from: string,
  to: string,
): Promise<readonly DetailRow[]> =>
  database.all<DetailRow>(sql`
  SELECT entry.id, entry.spent_date AS "spentDate", project.name AS "projectName",
    person.id AS "personId", person.first_name || ' ' || person.last_name AS "personName",
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
  if (!/^\d{4}-\d{2}$/u.test(occurrenceKey))
    throw new Error('month-end occurrence key must be YYYY-MM')
  const from = `${occurrenceKey}-01`
  const next = new Date(`${from}T00:00:00.000Z`)
  if (!Number.isFinite(next.valueOf()))
    throw new Error('month-end occurrence key is not a calendar month')
  next.setUTCMonth(next.getUTCMonth() + 1)
  next.setUTCDate(0)
  return { from, to: next.toISOString().slice(0, 10) }
}

export interface MonthEndArtifactObjects {
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>
}
export interface MonthEndPackProposalInput {
  jobId: number
  expectedJobVersion?: number
  occurrenceKey: string
  clientIds?: readonly number[]
  proposedAt: string
  expiresAt: string
}

const createMonthEndPackRenderer = (database: Database) => {
  const render = async (
    occurrenceKey: string,
    invoiceId: number,
  ): Promise<{
    invoice: InvoiceRow
    brandName: string
    people: readonly ScheduledReportPerson[]
    name: string
    bytes: Uint8Array
    warnings: readonly ReportNoteWarning[]
  }> => {
    const range = rangeFromOccurrence(occurrenceKey)
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
    const organization = await database.all<{ name: string }>(
      sql`SELECT name FROM organizations WHERE id = 1`,
    )
    const brandName = brand?.name ?? organization[0]?.name ?? invoiceRecord.clientName
    const people = new Map<number, ScheduledReportPerson>()
    for (const row of rows) {
      const person = people.get(row.personId) ?? {
        id: row.personId,
        name: row.personName,
        seconds: 0,
      }
      person.seconds += row.roundedSeconds
      people.set(row.personId, person)
    }
    const totalSeconds = rows.reduce((total, row) => total + row.roundedSeconds, 0)
    const safeNumber = invoiceRecord.number.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const name = `work-detail-${occurrenceKey}-invoice-${safeNumber}.pdf`
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
    return {
      invoice: invoiceRecord,
      brandName,
      people: [...people.values()],
      name,
      bytes,
      warnings: notePreview.warnings,
    }
  }
  return render
}

/** Render every proposed report before materializing its immutable manifest. */
export const proposeMonthEndPack = async (
  database: Database,
  input: Readonly<MonthEndPackProposalInput>,
  objects?: MonthEndArtifactObjects,
): Promise<MonthEndPackProposal> => {
  const store = createScheduledActionStore(database)
  const render = createMonthEndPackRenderer(database)
  const range = rangeFromOccurrence(input.occurrenceKey)
  const manifest = await monthEndManifest(database, {
    periodStart: range.from,
    periodEnd: range.to,
    scope: input.clientIds === undefined ? {} : { clientIds: input.clientIds },
  })
  const existing = await database.all<{ id: number }>(sql`
              SELECT id FROM proposed_runs WHERE job_id=${input.jobId} AND occurrence_key=${input.occurrenceKey}`)
  if (existing.length > 0)
    return { outcome: { outcome: 'already_proposed' }, manifest, previews: [] }
  // Rendering is a prerequisite, not a side effect of a stored proposal.
  // A failing report must leave nothing for an operator to confirm.
  const captured = await Promise.all(
    manifest.items.map(async (item) => {
      const rendered = await render(input.occurrenceKey, item.subjectId)
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(rendered.bytes).buffer),
      )
      const contentHash = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const key = `sha256/${contentHash.slice(0, 2)}/${contentHash}`
      if (objects) await objects.put(key, new Uint8Array(rendered.bytes).buffer, 'application/pdf')
      return {
        item: {
          ...item,
          ...(objects
            ? {
                report: { key, contentHash, name: rendered.name, byteSize: rendered.bytes.length },
                reportWarnings: rendered.warnings,
                reportPeople: rendered.people,
              }
            : {}),
        },
        preview: {
          invoiceId: item.subjectId,
          brandName: rendered.brandName,
          warnings: rendered.warnings,
        },
      }
    }),
  )
  const outcome = await store.propose({
    jobId: input.jobId,
    ...(input.expectedJobVersion === undefined
      ? {}
      : { expectedJobVersion: input.expectedJobVersion }),
    occurrenceKey: input.occurrenceKey,
    items: captured.map((entry) => entry.item),
    proposedAt: input.proposedAt,
    expiresAt: input.expiresAt,
  })
  return {
    outcome,
    manifest,
    previews: outcome.outcome === 'proposed' ? captured.map((entry) => entry.preview) : [],
  }
}

export const createMonthEndPackService = (database: Database, delivery: MonthEndPackDelivery) => {
  const store = createScheduledActionStore(database)
  const render = createMonthEndPackRenderer(database)
  return {
    propose: (input: Readonly<MonthEndPackProposalInput>) => proposeMonthEndPack(database, input),

    confirmAndExecute: async (
      runId: number,
      userId: number,
      now: () => string,
    ): Promise<
      RunExecutionReport | { runId: number; completed: 0; failed: readonly []; runCompleted: true }
    > => {
      const current = await store.read(runId)
      if (current === null) throw new Error('month-end run is missing')
      if (current.state === 'completed') {
        return { runId, completed: 0, failed: [], runCompleted: true }
      }
      if (current.state === 'proposed') {
        const confirmation = await store.confirm(runId, userId, now())
        if (confirmation.outcome !== 'confirmed')
          throw new Error(`month-end confirmation refused: ${confirmation.outcome}`)
      } else if (current.state !== 'confirmed') {
        throw new Error(`month-end run is ${current.state}`)
      }
      return executeRun(runId, {
        store,
        now,
        handler: async (item) => {
          if (item.subjectType !== 'invoice') throw new Error('month-end item is not an invoice')
          if (!item.target) throw new Error('The confirmed manifest has no recipient.')
          if ((await invoice(database, item.subjectId)).target !== item.target)
            throw new Error('The invoice recipient changed after the manifest was proposed.')
          const rendered = item.report ? null : await render(current.occurrenceKey, item.subjectId)
          const bytes = item.report ? await delivery.readReport?.(item.report.key) : rendered!.bytes
          if (!bytes) throw new Error('The exact saved report is unavailable.')
          if (item.report) {
            const hash = [
              ...new Uint8Array(
                await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
              ),
            ]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
            if (bytes.length !== item.report.byteSize || hash !== item.report.contentHash)
              throw new Error('The saved report does not match its captured hash.')
          }
          const name = item.report?.name ?? rendered!.name
          const key = `month-end:${String(runId)}:${String(item.id)}`
          await delivery.attach({
            invoiceId: item.subjectId,
            name,
            contentType: 'application/pdf',
            bytes,
            idempotencyKey: `${key}:attachment`,
          })
          await delivery.queue({
            invoiceId: item.subjectId,
            to: item.target,
            attachmentName: name,
            idempotencyKey: `${key}:send`,
          })
        },
      })
    },
  }
}
