/**
 * Carry the invoices one ezacto database is missing into another.
 *
 * `load` builds a database from a snapshot and nothing else: it wants a virgin
 * target, and it refuses one already admitted under a different snapshot. That
 * is right for a cutover and useless for the situation the cutover leaves
 * behind -- a live instance that has moved on, and a fresh load that knows
 * about invoices the live one has never seen. Reloading would take the live
 * instance's own work with it.
 *
 * So this carries invoices across instead, and it does not write the rows
 * itself. `invoices` is defended by forty-five triggers, and an imported line
 * is admitted only while a matching `invoice_import_operations` row is open --
 * the header at version 0, then the reconciliation, then the operations, then
 * the content, then the completions. That protocol lives in
 * `ensureImportedInvoiceHeader` and `reconcileHarvestInvoice`, which is what
 * the loader calls, and it is what this calls. Copying finished rows verbatim
 * is refused, correctly: by then nothing is pending.
 *
 * Every reference is resolved by `harvest_id` against the target, never by the
 * source's own row id. The two databases agree today because both came from the
 * same loader, and nothing here depends on them continuing to.
 */
import type BetterSqlite3 from 'better-sqlite3'
import {
  ensureImportedInvoiceHeader,
  reconcileHarvestInvoice,
  validateHarvestInvoiceReconciliation,
  type HarvestInvoiceReconciliation,
  type ImportDatabase,
  type ImportedInvoiceHeader,
} from '@ezacto/db/importer'

export interface InvoiceDeltaOptions {
  /** A loaded snapshot database: the one that knows about the invoices. */
  readonly sourcePath: string
  /** The database missing them. Written to unless `dryRun`. */
  readonly targetPath: string
  /** Invoice numbers to carry. Omit for every invoice the target lacks. */
  readonly only?: readonly string[]
  readonly dryRun?: boolean
}

export interface CarriedInvoice {
  readonly number: string
  readonly harvestId: number
  readonly invoiceId: number
  readonly state: string
  readonly amountCents: number
  readonly lines: number
  readonly messages: number
  readonly payments: number
}

export interface InvoiceDeltaResult {
  readonly missing: readonly { readonly number: string; readonly harvestId: number }[]
  readonly carried: readonly CarriedInvoice[]
  readonly skipped: readonly { readonly number: string; readonly reason: string }[]
}

interface SourceInvoice {
  id: number
  harvest_id: number
  number: string
  subject: string | null
  purchase_order: string | null
  notes: string | null
  currency: string
  issue_date: string
  due_date: string
  payment_terms: string
  period_start: string | null
  period_end: string | null
  source_creator_id: number | null
  source_creator_name: string | null
  tax_rate_ppm: number | null
  tax2_rate_ppm: number | null
  discount_rate_ppm: number | null
  created_at: string
  updated_at: string
  state: string
  amount_cents: number
  source_updated_at: string | null
  /* The state Harvest reported is kept on the reconciliation receipt, not on
     the invoice: the invoice carries what ezacto derived from the payments. */
  source_state: string | null
  sent_at: string | null
  paid_at: string | null
  paid_date: string | null
  closed_at: string | null
  source_amount_cents: number | null
  source_due_amount_cents: number | null
  source_tax_amount_cents: number | null
  source_tax2_amount_cents: number | null
  source_discount_amount_cents: number | null
  source_payment_options: string | null
  written_off_cents: number
  client_harvest_id: number | null
  project_harvest_id: number | null
  creator_harvest_id: number | null
}

const SOURCE_INVOICE_COLUMNS = `invoice.id, invoice.harvest_id, invoice.number, invoice.subject,
  invoice.purchase_order, invoice.notes, invoice.currency, invoice.issue_date, invoice.due_date,
  invoice.payment_terms, invoice.period_start, invoice.period_end, invoice.source_creator_id,
  invoice.source_creator_name, invoice.tax_rate_ppm, invoice.tax2_rate_ppm,
  invoice.discount_rate_ppm, invoice.created_at, invoice.updated_at, invoice.state,
  invoice.amount_cents, invoice.source_updated_at, invoice.sent_at, invoice.paid_at,
  invoice.paid_date, invoice.closed_at, reconciliation.source_state,
  invoice.source_amount_cents, invoice.source_due_amount_cents, invoice.source_tax_amount_cents,
  invoice.source_tax2_amount_cents, invoice.source_discount_amount_cents,
  invoice.source_payment_options, invoice.written_off_cents,
  client.harvest_id AS client_harvest_id,
  project.harvest_id AS project_harvest_id,
  creator.harvest_id AS creator_harvest_id`

const SOURCE_INVOICE_FROM = `FROM invoices invoice
  LEFT JOIN clients client ON client.id = invoice.client_id
  LEFT JOIN projects project ON project.id = invoice.project_id
  LEFT JOIN users creator ON creator.id = invoice.created_by_user_id
  LEFT JOIN invoice_import_reconciliations reconciliation
    ON reconciliation.invoice_id = invoice.id
    AND reconciliation.source_updated_at = invoice.source_updated_at`

/**
 * One read that works against either driver, because the target is a local file
 * during a rehearsal and hosted D1 in earnest, and the point of rehearsing is
 * that both take the same path.
 */
const targetRows = async <T>(
  database: ImportDatabase,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> => {
  const client = database.$client
  if ('batch' in client) {
    const { results } = await client
      .prepare(sql)
      .bind(...params)
      .all<T>()
    return results
  }
  return client.prepare(sql).all(...params) as T[]
}

/** A reference the target does not have is a reference this cannot invent. */
const nativeId = async (
  database: ImportDatabase,
  table: string,
  harvestId: number | null,
): Promise<number | null> => {
  if (harvestId === null) return null
  const rows = await targetRows<{ id: number }>(
    database,
    `SELECT id FROM ${table} WHERE harvest_id = ?`,
    [harvestId],
  )
  if (rows.length === 0)
    throw new Error(`target has no ${table} row for harvest_id ${harvestId}`)
  return rows[0]!.id
}

type SourceLine = HarvestInvoiceReconciliation['lines'][number]
type SourceMessage = HarvestInvoiceReconciliation['messages'][number]
type SourcePayment = HarvestInvoiceReconciliation['payments'][number]

/** SQLite hands booleans back as 0/1. */
const flag = (value: unknown): boolean => value === 1 || value === true

type LineRow = Omit<SourceLine, 'taxed' | 'taxed2' | 'projectId'> & {
  taxed: unknown
  taxed2: unknown
  projectHarvestId: number | null
}
type MessageRow = Omit<
  SourceMessage,
  'recipients' | 'attachPdf' | 'sendMeACopy' | 'thankYou' | 'reminder'
> & {
  recipients: string
  attachPdf: unknown
  sendMeACopy: unknown
  thankYou: unknown
  reminder: unknown
}
type PaymentRow = Omit<SourcePayment, 'recordedByUserId'> & {
  recorderHarvestId: number | null
}

const parsePaymentOptions = (value: string | null): readonly string[] | null => {
  if (value === null) return null
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string'))
    throw new Error('source_payment_options is not an array of strings')
  return parsed
}

/**
 * The core, over an already-open target. Split out because the target is a
 * local file when this is rehearsed and hosted D1 when it is meant, and a
 * rehearsal that takes a different path than the real thing proves nothing.
 */
export const carryInvoices = async (
  source: BetterSqlite3.Database,
  database: ImportDatabase,
  options: Pick<InvoiceDeltaOptions, 'only' | 'dryRun'> = {},
): Promise<InvoiceDeltaResult> => {
  {
    const present = new Set(
      (
        await targetRows<{ harvest_id: number }>(
          database,
          'SELECT harvest_id FROM invoices WHERE harvest_id IS NOT NULL',
        )
      ).map((row) => row.harvest_id),
    )
    const wanted = options.only === undefined ? null : new Set(options.only)
    const candidates = (
      source
        .prepare(
          `SELECT ${SOURCE_INVOICE_COLUMNS} ${SOURCE_INVOICE_FROM}
           WHERE invoice.harvest_id IS NOT NULL ORDER BY CAST(invoice.number AS INTEGER), invoice.id`,
        )
        .all() as SourceInvoice[]
    ).filter((row) => !present.has(row.harvest_id))
    const missing = candidates.map((row) => ({ number: row.number, harvestId: row.harvest_id }))
    const selected =
      wanted === null ? candidates : candidates.filter((row) => wanted.has(row.number))
    const skipped: { number: string; reason: string }[] = []
    if (wanted !== null) {
      const found = new Set(selected.map((row) => row.number))
      for (const number of wanted) {
        if (found.has(number))
          continue
        skipped.push({
          number,
          reason: present.size > 0 && candidates.every((row) => row.number !== number)
            ? 'already in the target, or not in the source'
            : 'not among the invoices the target is missing',
        })
      }
    }
    if (options.dryRun === true) return { missing, carried: [], skipped }

    const carried: CarriedInvoice[] = []
    for (const row of selected) {
      const lines = await Promise.all((
        source
          .prepare(
            `SELECT line.harvest_id AS harvestId, line.position, line.kind, line.description,
               line.quantity, line.unit_price_cents AS unitPriceCents,
               line.amount_cents AS amountCents, line.taxed, line.taxed2,
               project.harvest_id AS projectHarvestId,
               line.created_at AS createdAt, line.updated_at AS updatedAt
             FROM invoice_line_items line
             LEFT JOIN projects project ON project.id = line.project_id
             WHERE line.invoice_id = ? AND line.harvest_id IS NOT NULL
             ORDER BY line.position`,
          )
          .all(row.id) as LineRow[]
      ).map(
        async (line): Promise<SourceLine> => ({
          harvestId: line.harvestId,
          position: line.position,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          amountCents: line.amountCents,
          taxed: flag(line.taxed),
          taxed2: flag(line.taxed2),
          projectId: await nativeId(database, 'projects', line.projectHarvestId),
          createdAt: line.createdAt,
          updatedAt: line.updatedAt,
        }),
      ))

      const messages = (
        source
          .prepare(
            `SELECT harvest_id AS harvestId, sent_by AS sentBy, sent_by_email AS sentByEmail,
               sent_from AS sentFrom, sent_from_email AS sentFromEmail, recipients, subject, body,
               attach_pdf AS attachPdf, send_me_a_copy AS sendMeACopy, thank_you AS thankYou,
               reminder, send_reminder_on AS sendReminderOn, event_type AS eventType,
               created_at AS createdAt, updated_at AS updatedAt
             FROM invoice_messages WHERE invoice_id = ? AND harvest_id IS NOT NULL
             ORDER BY harvest_id`,
          )
          .all(row.id) as MessageRow[]
      ).map(
        (message): SourceMessage => ({
          harvestId: message.harvestId,
          sentBy: message.sentBy,
          sentByEmail: message.sentByEmail,
          sentFrom: message.sentFrom,
          sentFromEmail: message.sentFromEmail,
          recipients: JSON.parse(message.recipients) as SourceMessage['recipients'],
          subject: message.subject,
          body: message.body,
          attachPdf: flag(message.attachPdf),
          sendMeACopy: flag(message.sendMeACopy),
          thankYou: flag(message.thankYou),
          reminder: flag(message.reminder),
          sendReminderOn: message.sendReminderOn,
          eventType: message.eventType,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        }),
      )

      const importedPayments = await Promise.all((
        source
          .prepare(
            `SELECT payment.harvest_id AS harvestId, payment.amount_cents AS amountCents,
               payment.source_paid_at AS sourcePaidAt, payment.source_paid_date AS sourcePaidDate,
               payment.source_recorded_by_name AS sourceRecordedByName,
               payment.source_recorded_by_email AS sourceRecordedByEmail,
               payment.source_gateway_id AS sourceGatewayId,
               payment.source_gateway_name AS sourceGatewayName, payment.notes,
               recorder.harvest_id AS recorderHarvestId,
               payment.provider_transaction_id AS providerTransactionId,
               payment.created_at AS createdAt, payment.updated_at AS updatedAt
             FROM invoice_payments payment
             LEFT JOIN users recorder ON recorder.id = payment.recorded_by_user_id
             WHERE payment.invoice_id = ? AND payment.harvest_id IS NOT NULL
             ORDER BY payment.harvest_id`,
          )
          .all(row.id) as PaymentRow[]
      ).map(
        async (payment): Promise<SourcePayment> => ({
          harvestId: payment.harvestId,
          amountCents: payment.amountCents,
          sourcePaidAt: payment.sourcePaidAt,
          sourcePaidDate: payment.sourcePaidDate,
          sourceRecordedByName: payment.sourceRecordedByName,
          sourceRecordedByEmail: payment.sourceRecordedByEmail,
          sourceGatewayId: payment.sourceGatewayId,
          sourceGatewayName: payment.sourceGatewayName,
          notes: payment.notes,
          recordedByUserId: await nativeId(database, 'users', payment.recorderHarvestId),
          providerTransactionId: payment.providerTransactionId,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
        }),
      ))

      const clientId = await nativeId(database, 'clients', row.client_harvest_id)
      if (clientId === null) throw new Error(`invoice ${row.number} has no client`)
      const header: ImportedInvoiceHeader = {
        harvestId: row.harvest_id,
        clientId,
        createdByUserId: await nativeId(database, 'users', row.creator_harvest_id),
        sourceCreatorId: row.source_creator_id,
        sourceCreatorName: row.source_creator_name,
        number: row.number,
        subject: row.subject,
        purchaseOrder: row.purchase_order,
        notes: row.notes,
        currency: row.currency,
        issueDate: row.issue_date,
        dueDate: row.due_date,
        paymentTerms: row.payment_terms as ImportedInvoiceHeader['paymentTerms'],
        periodStart: row.period_start,
        periodEnd: row.period_end,
        projectId: await nativeId(database, 'projects', row.project_harvest_id),
        estimateId: null,
        taxRatePpm: row.tax_rate_ppm,
        tax2RatePpm: row.tax2_rate_ppm,
        discountRatePpm: row.discount_rate_ppm,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        initialState: importedPayments.length > 0 ? 'open' : 'draft',
      }
      if (row.source_updated_at === null || row.source_state === null)
        throw new Error(`invoice ${row.number} in the source was never reconciled`)

      const reconciliation: HarvestInvoiceReconciliation = {
        invoiceId: 0,
        sourceBatchComplete: true,
        expectedSourceUpdatedAt: null,
        sourceUpdatedAt: row.source_updated_at,
        sourceState: row.source_state as HarvestInvoiceReconciliation['sourceState'],
        sourceSentAt: row.sent_at,
        sourcePaidAt: row.paid_at,
        sourcePaidDate: row.paid_date,
        sourceClosedAt: row.closed_at,
        sourceAmountCents: row.source_amount_cents,
        sourceDueAmountCents: row.source_due_amount_cents,
        sourceTaxAmountCents: row.source_tax_amount_cents,
        sourceTax2AmountCents: row.source_tax2_amount_cents,
        sourceDiscountAmountCents: row.source_discount_amount_cents,
        sourcePaymentOptions: parsePaymentOptions(row.source_payment_options),
        sourceWrittenOffCents: row.written_off_cents,
        sourceHeader: header,
        lines,
        messages,
        payments: importedPayments,
      }
      validateHarvestInvoiceReconciliation(reconciliation)
      const ensured = await ensureImportedInvoiceHeader(database, header)
      const result = await reconcileHarvestInvoice(database, {
        ...reconciliation,
        invoiceId: ensured.id,
        expectedSourceUpdatedAt: ensured.sourceUpdatedAt,
      })
      carried.push({
        number: row.number,
        harvestId: row.harvest_id,
        invoiceId: ensured.id,
        state: result.state,
        amountCents: row.amount_cents,
        lines: lines.length,
        messages: messages.length,
        payments: importedPayments.length,
      })
    }
    return { missing, carried, skipped }
  }
}

export const runInvoiceDelta = async (
  options: InvoiceDeltaOptions,
): Promise<InvoiceDeltaResult> => {
  const [{ default: BetterSqlite3Ctor }, databaseModule] = await Promise.all([
    import('better-sqlite3'),
    import('@ezacto/db'),
  ])
  const source = new BetterSqlite3Ctor(options.sourcePath, {
    readonly: true,
    fileMustExist: true,
  })
  const target = new BetterSqlite3Ctor(options.targetPath, {
    readonly: options.dryRun === true,
    fileMustExist: true,
  })
  try {
    return await carryInvoices(
      source,
      databaseModule.createContainerDatabase(target) as ImportDatabase,
      options,
    )
  } finally {
    source.close()
    target.close()
  }
}
