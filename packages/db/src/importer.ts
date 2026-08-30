/**
 * Deliberately narrow migration-only facade. Application code imports @ezacto/db;
 * the Harvest loader imports @ezacto/db/importer so the authority to reconcile
 * source-owned invoice children is not part of the ordinary repository surface.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { createAttachmentStore, type AttachmentRecord } from './attachments.js'
import {
  reconcileImportedInvoice,
  validateImportedInvoiceReconciliation,
  type ImportedInvoiceLine,
  type ImportedInvoiceMessage,
  type ImportedInvoicePayment,
  type ImportedInvoiceSourceHeader,
  type ImportReconciliationResult,
  type ReconcileImportedInvoiceInput,
} from './internal/invoice-import.js'
export {
  ensureHarvestRecurringInvoiceStub,
  type EnsureHarvestRecurringInvoiceStubInput,
} from './internal/recurring-invoice-import.js'
export {
  ensureHarvestRetainerStub,
  type EnsureHarvestRetainerStubInput,
} from './internal/retainer-import.js'

export type ImportDatabase =
  | (BetterSQLite3Database<typeof schema> & { $client: BetterSqlite3.Database })
  | (DrizzleD1Database<typeof schema> & { $client: D1Database })

export interface ImportedInvoiceHeader extends ImportedInvoiceSourceHeader {
  harvestId: number
  initialState?: 'draft' | 'open'
}

export interface EnsuredImportedInvoice {
  id: number
  harvestId: number
  clientKey: string
  sourceUpdatedAt: string | null
}

type SourceChild<T extends { id: number; harvestId: number }> = Omit<T, 'id'>

export type HarvestInvoiceReconciliation = Omit<
  ReconcileImportedInvoiceInput,
  'invoiceId' | 'lines' | 'messages' | 'payments'
> & {
  invoiceId: number
  lines: readonly SourceChild<ImportedInvoiceLine>[]
  messages: readonly SourceChild<ImportedInvoiceMessage>[]
  payments: readonly SourceChild<ImportedInvoicePayment>[]
}

const isD1 = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: ImportDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<T | null> => {
  const client = database.$client
  if (isD1(client))
    return (
      (await client
        .prepare(sql)
        .bind(...params)
        .first<T>()) ?? null
    )
  return (client.prepare(sql).get(...params) as T | undefined) ?? null
}

const run = async (
  database: ImportDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<void> => {
  const client = database.$client
  if (isD1(client)) {
    await client
      .prepare(sql)
      .bind(...params)
      .run()
    return
  }
  client.prepare(sql).run(...params)
}

const atomic = async (
  database: ImportDatabase,
  statements: readonly { sql: string; params: readonly unknown[] }[],
): Promise<void> => {
  const client = database.$client
  if (isD1(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.sql).bind(...statement.params)),
    )
    return
  }
  client.transaction(() => {
    for (const statement of statements) client.prepare(statement.sql).run(...statement.params)
  })()
}

interface StoredHeader extends EnsuredImportedInvoice {
  clientId: number
  createdByUserId: number | null
  sourceCreatorId: number | null
  sourceCreatorName: string | null
  number: string
  subject: string | null
  purchaseOrder: string | null
  notes: string | null
  currency: string
  issueDate: string
  dueDate: string
  paymentTerms: string
  periodStart: string | null
  periodEnd: string | null
  projectId: number | null
  estimateId: number | null
  taxRatePpm: number | null
  tax2RatePpm: number | null
  discountRatePpm: number | null
  createdAt: string
  updatedAt: string
}

const header = async (database: ImportDatabase, harvestId: number): Promise<StoredHeader | null> =>
  first<StoredHeader>(
    database,
    `SELECT id, harvest_id AS harvestId, client_key AS clientKey,
      source_updated_at AS sourceUpdatedAt, client_id AS clientId,
      created_by_user_id AS createdByUserId,
      source_creator_id AS sourceCreatorId, source_creator_name AS sourceCreatorName,
      number, subject, purchase_order AS purchaseOrder, notes, currency,
      issue_date AS issueDate, due_date AS dueDate, payment_terms AS paymentTerms,
      period_start AS periodStart, period_end AS periodEnd, project_id AS projectId,
      estimate_id AS estimateId,
      tax_rate_ppm AS taxRatePpm, tax2_rate_ppm AS tax2RatePpm,
      discount_rate_ppm AS discountRatePpm, created_at AS createdAt, updated_at AS updatedAt
    FROM invoices WHERE harvest_id = ?`,
    [harvestId],
  )

const sourceHeaderShape = (
  value: ImportedInvoiceHeader,
): Omit<StoredHeader, keyof EnsuredImportedInvoice> => ({
  clientId: value.clientId,
  createdByUserId: value.createdByUserId,
  sourceCreatorId: value.sourceCreatorId,
  sourceCreatorName: value.sourceCreatorName,
  number: value.number,
  subject: value.subject,
  purchaseOrder: value.purchaseOrder,
  notes: value.notes,
  currency: value.currency,
  issueDate: value.issueDate,
  dueDate: value.dueDate,
  paymentTerms: value.paymentTerms,
  periodStart: value.periodStart,
  periodEnd: value.periodEnd,
  projectId: value.projectId,
  estimateId: value.estimateId ?? null,
  taxRatePpm: value.taxRatePpm,
  tax2RatePpm: value.tax2RatePpm,
  discountRatePpm: value.discountRatePpm,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
})

/** Insert once, omit the native id/client_key, and make retries observational. */
export const ensureImportedInvoiceHeader = async (
  database: ImportDatabase,
  input: ImportedInvoiceHeader,
): Promise<EnsuredImportedInvoice> => {
  let existing = await header(database, input.harvestId)
  if (existing === null) {
    const convergenceValues = [
      input.clientId,
      input.createdByUserId,
      input.sourceCreatorId,
      input.sourceCreatorName,
      input.number,
      input.subject,
      input.purchaseOrder,
      input.notes,
      input.currency,
      input.issueDate,
      input.dueDate,
      input.paymentTerms,
      input.projectId,
      input.estimateId ?? null,
      input.createdAt,
      input.updatedAt,
    ]
    await atomic(database, [
      {
        sql: `UPDATE invoices SET client_id = ?, created_by_user_id = ?, source_creator_id = ?,
          source_creator_name = ?, number = ?, subject = ?, purchase_order = ?, notes = ?,
          currency = ?, issue_date = ?, due_date = ?, payment_terms = ?, project_id = ?,
          estimate_id = ?, created_at = ?, updated_at = ?
        WHERE harvest_id = ?
          AND client_id IS ? AND created_by_user_id IS ? AND source_creator_id IS ?
          AND source_creator_name IS ? AND number IS ? AND subject IS ? AND purchase_order IS ?
          AND notes IS ? AND currency IS ? AND issue_date IS ? AND due_date IS ?
          AND payment_terms IS ? AND project_id IS ? AND estimate_id IS ?
          AND created_at IS ? AND updated_at IS ?`,
        params: [...convergenceValues, input.harvestId, ...convergenceValues],
      },
      {
        sql: `INSERT INTO invoices (
        harvest_id, client_id, created_by_user_id, source_creator_id, source_creator_name,
        number, subject, purchase_order, notes, currency, issue_date, due_date,
        payment_terms, state, period_start, period_end, project_id, estimate_id,
        tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE harvest_id = ?)`,
        params: [
          input.harvestId,
          input.clientId,
          input.createdByUserId,
          input.sourceCreatorId,
          input.sourceCreatorName,
          input.number,
          input.subject,
          input.purchaseOrder,
          input.notes,
          input.currency,
          input.issueDate,
          input.dueDate,
          input.paymentTerms,
          input.initialState ?? 'draft',
          input.periodStart,
          input.periodEnd,
          input.projectId,
          input.estimateId ?? null,
          input.taxRatePpm,
          input.tax2RatePpm,
          input.discountRatePpm,
          input.createdAt,
          input.updatedAt,
          input.harvestId,
        ],
      },
    ])
    existing = await header(database, input.harvestId)
  }
  if (existing === null) throw new Error('imported invoice header was not created')
  const expected = sourceHeaderShape(input)
  const compareEntireHeader =
    existing.sourceUpdatedAt === null || existing.sourceUpdatedAt === input.updatedAt
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (existing[key] !== expected[key]) {
      const provenance = key === 'sourceCreatorId' || key === 'sourceCreatorName'
      if (!provenance && !compareEntireHeader) continue
      throw new Error(
        provenance
          ? `invoice ${input.harvestId} immutable creator provenance drifted at ${key}`
          : `invoice ${input.harvestId} header differs at ${key}; a newer-source import authority is required`,
      )
    }
  }
  return {
    id: existing.id,
    harvestId: existing.harvestId,
    clientKey: existing.clientKey,
    sourceUpdatedAt: existing.sourceUpdatedAt,
  }
}

/** DB-owned native child allocation; source callers supply Harvest identity only. */
export const reconcileHarvestInvoice = async (
  database: ImportDatabase,
  input: HarvestInvoiceReconciliation,
): Promise<ImportReconciliationResult> =>
  reconcileImportedInvoice(database, {
    ...input,
    allocateNativeChildIds: true,
    lines: input.lines.map((row) => ({ ...row, id: 0 })),
    messages: input.messages.map((row) => ({ ...row, id: 0 })),
    payments: input.payments.map((row) => ({ ...row, id: 0 })),
  })

export const validateHarvestInvoiceReconciliation = (input: HarvestInvoiceReconciliation): void =>
  validateImportedInvoiceReconciliation({
    ...input,
    allocateNativeChildIds: true,
    lines: input.lines.map((row) => ({ ...row, id: 0 })),
    messages: input.messages.map((row) => ({ ...row, id: 0 })),
    payments: input.payments.map((row) => ({ ...row, id: 0 })),
  })

export interface HarvestExpenseReceiptInput {
  harvestExpenseId: number
  contentHash: string
  fileKey: string
  byteSize: number
  contentType: string
  name: string
  createdAt: string
  updatedAt: string
}

/** Source-expense identity is the idempotency key for its one Harvest receipt. */
export const ensureHarvestExpenseReceipt = async (
  database: ImportDatabase,
  input: HarvestExpenseReceiptInput,
): Promise<AttachmentRecord> => {
  let existing = await first<{
    id: number
    fileObjectId: number
    contentHash: string
    fileKey: string
    byteSize: number
    contentType: string
    name: string
    uploadedByUserId: number | null
    createdAt: string
    updatedAt: string
  }>(
    database,
    `SELECT attachment.id, attachment.file_object_id AS fileObjectId,
      file.content_hash AS contentHash, file.file_key AS fileKey,
      file.byte_size AS byteSize, file.content_type AS contentType,
      attachment.name, attachment.uploaded_by_user_id AS uploadedByUserId,
      attachment.created_at AS createdAt, attachment.updated_at AS updatedAt
    FROM harvest_expense_receipts receipt
    JOIN expenses expense ON expense.id = receipt.expense_id
    JOIN attachments attachment ON attachment.id = receipt.attachment_id
    JOIN file_objects file ON file.id = attachment.file_object_id
    WHERE receipt.source_expense_id = ? AND expense.harvest_id = ?`,
    [input.harvestExpenseId, input.harvestExpenseId],
  )
  // Recovery for a process killed after the attachment transaction committed
  // but before the source marker was acknowledged. Unrelated native attachments
  // are ignored unless every immutable receipt field matches.
  const matching =
    existing ??
    (await first<{
      id: number
      fileObjectId: number
      contentHash: string
      fileKey: string
      byteSize: number
      contentType: string
      name: string
      uploadedByUserId: number | null
      createdAt: string
      updatedAt: string
    }>(
      database,
      `SELECT attachment.id, attachment.file_object_id AS fileObjectId,
      file.content_hash AS contentHash, file.file_key AS fileKey,
      file.byte_size AS byteSize, file.content_type AS contentType,
      attachment.name, attachment.uploaded_by_user_id AS uploadedByUserId,
      attachment.created_at AS createdAt, attachment.updated_at AS updatedAt
    FROM expenses expense
    JOIN expense_attachments owned ON owned.expense_id = expense.id
    JOIN attachments attachment ON attachment.id = owned.attachment_id
    JOIN file_objects file ON file.id = attachment.file_object_id
    WHERE expense.harvest_id = ? AND file.content_hash = ? AND file.file_key = ?
      AND file.byte_size = ? AND file.content_type = ? AND attachment.name = ?
    ORDER BY attachment.id LIMIT 1`,
      [
        input.harvestExpenseId,
        input.contentHash,
        input.fileKey,
        input.byteSize,
        input.contentType,
        input.name,
      ],
    ))
  if (matching !== null) {
    const expense = await first<{ id: number }>(
      database,
      'SELECT id FROM expenses WHERE harvest_id = ?',
      [input.harvestExpenseId],
    )
    if (expense === null) throw new Error(`Harvest expense ${input.harvestExpenseId} is not loaded`)
    await run(
      database,
      `INSERT INTO harvest_expense_receipts
        (source_expense_id, expense_id, attachment_id, created_at)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM harvest_expense_receipts WHERE source_expense_id = ?
      )`,
      [input.harvestExpenseId, expense.id, matching.id, input.createdAt, input.harvestExpenseId],
    )
    existing = matching
  }
  if (existing !== null) {
    for (const key of ['contentHash', 'fileKey', 'byteSize', 'contentType', 'name'] as const) {
      if (existing[key] !== input[key]) {
        throw new Error(
          `Harvest expense ${input.harvestExpenseId} receipt identity drifted at ${key}`,
        )
      }
    }
    return existing
  }
  const expense = await first<{ id: number }>(
    database,
    `SELECT id FROM expenses WHERE harvest_id = ?`,
    [input.harvestExpenseId],
  )
  if (expense === null) throw new Error(`Harvest expense ${input.harvestExpenseId} is not loaded`)
  const attachment = await createAttachmentStore(database).createExpenseAttachment({
    expenseId: expense.id,
    contentHash: input.contentHash,
    fileKey: input.fileKey,
    byteSize: input.byteSize,
    contentType: input.contentType,
    name: input.name,
    uploadedByUserId: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  })
  await run(
    database,
    `INSERT INTO harvest_expense_receipts
      (source_expense_id, expense_id, attachment_id, created_at)
    VALUES (?, ?, ?, ?)`,
    [input.harvestExpenseId, expense.id, attachment.id, input.createdAt],
  )
  return attachment
}
