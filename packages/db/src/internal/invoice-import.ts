import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '../schema.js'

type Database =
  | (BetterSQLite3Database<typeof schema> & { $client: BetterSqlite3.Database })
  | (DrizzleD1Database<typeof schema> & { $client: D1Database })

type SourceState = 'draft' | 'open' | 'paid' | 'closed'

type ImportedMessageEventType =
  'send' | 'view' | 'draft' | 'cancel' | 'write_off' | 're-open' | 'close'

export interface ImportedInvoiceMessage {
  id: number
  harvestId: number
  sentBy?: string | null
  sentByEmail?: string | null
  sentFrom?: string | null
  sentFromEmail?: string | null
  recipients: readonly { name: string; email: string }[]
  subject?: string | null
  body?: string | null
  attachPdf?: boolean
  sendMeACopy?: boolean
  thankYou?: boolean
  reminder?: boolean
  sendReminderOn?: string | null
  eventType?: ImportedMessageEventType | null
  createdAt: string
  updatedAt: string
}

export interface ImportedInvoicePayment {
  id: number
  harvestId: number
  amountCents: number
  sourcePaidAt: string | null
  sourcePaidDate: string | null
  sourceRecordedByName?: string | null
  sourceRecordedByEmail?: string | null
  sourceGatewayId?: number | null
  sourceGatewayName?: string | null
  notes?: string | null
  recordedByUserId?: number | null
  providerTransactionId?: string | null
  createdAt: string
  updatedAt: string
}

export interface ImportedInvoiceLine {
  id: number
  harvestId: number
  position: number
  kind: string
  description?: string | null
  quantity: number
  unitPriceCents: number
  amountCents: number
  taxed?: boolean
  taxed2?: boolean
  projectId?: number | null
  createdAt: string
  updatedAt: string
}

export interface ReconcileImportedInvoiceInput {
  invoiceId: number
  /** Evidence that the caller finished reading the complete Harvest invoice source batch. */
  sourceBatchComplete: true
  expectedSourceUpdatedAt: string | null
  sourceUpdatedAt: string
  sourceState: SourceState
  sourceSentAt: string | null
  sourcePaidAt: string | null
  sourcePaidDate: string | null
  sourceClosedAt: string | null
  sourceAmountCents: number | null
  sourceDueAmountCents: number | null
  sourceTaxAmountCents: number | null
  sourceTax2AmountCents: number | null
  sourceDiscountAmountCents: number | null
  sourcePaymentOptions: readonly string[] | null
  sourceWrittenOffCents: number
  lines: readonly ImportedInvoiceLine[]
  messages: readonly ImportedInvoiceMessage[]
  payments: readonly ImportedInvoicePayment[]
}

export interface SourceStateDisagreesDiagnostic {
  invoice_id: number
  code: 'source_state_disagrees'
  source_state: SourceState
  derived_state: SourceState
}

export interface PaymentPaidDateDisagreesDiagnostic {
  invoice_id: number
  code: 'payment_paid_date_disagrees'
  payment_id: number
  payment_harvest_id: number
  source_paid_at: string
  source_paid_date: string
}

export type ImportReconciliationDiagnostic =
  SourceStateDisagreesDiagnostic | PaymentPaidDateDisagreesDiagnostic

export interface ImportReconciliationResult {
  invoiceId: number
  sourceUpdatedAt: string
  state: SourceState
  diagnostics: ImportReconciliationDiagnostic[]
}

interface StoredInvoice {
  id: number
  harvestId: number | null
  currency: string
  amountCents: number
  writtenOffCents: number
  version: number
  state: SourceState
  sourceUpdatedAt: string | null
  taxRatePpm: number | null
  tax2RatePpm: number | null
  discountRatePpm: number | null
}

interface StoredPayment {
  id: number
  harvestId: number | null
  amountCents: number
  paidAt: string | null
  paidDate: string | null
  sourcePaidAt: string | null
  sourcePaidDate: string | null
  sourceRecordedByName: string | null
  sourceRecordedByEmail: string | null
  sourceGatewayId: number | null
  sourceGatewayName: string | null
  notes: string | null
  recordedByUserId: number | null
  providerTransactionId: string | null
  createdAt: string
  updatedAt: string
}

type CanonicalPayment = StoredPayment & { harvestId: number }

interface StoredMessage {
  id: number
  harvestId: number | null
  sentBy: string | null
  sentByEmail: string | null
  sentFrom: string | null
  sentFromEmail: string | null
  recipients: string
  subject: string | null
  body: string | null
  attachPdf: number
  sendMeACopy: number
  thankYou: number
  reminder: number
  sendReminderOn: string | null
  eventType: ImportedMessageEventType | null
  deliveryStatus: string | null
  providerMessageId: string | null
  createdAt: string
  updatedAt: string
}

interface StoredLine {
  id: number
  harvestId: number | null
  position: number
  kind: string
  description: string | null
  quantity: number
  unitPriceCents: number
  amountCents: number
  taxed: number
  taxed2: number
  projectId: number | null
  createdAt: string
  updatedAt: string
}

interface Receipt {
  inputFingerprint: string
  targetState: SourceState
  completed: number
}

export interface ImportedInvoiceManifests {
  inputFingerprint: string
  sourceManifestJson: string
  sourceManifestHash: string
  lineManifestJson: string
  lineManifestHash: string
  messageManifestJson: string
  messageManifestHash: string
  paymentManifestJson: string
  paymentManifestHash: string
}

interface NormalizedImportInput {
  lines: StoredLine[]
  messages: StoredMessage[]
  payments: CanonicalPayment[]
}

interface Statement {
  text: string
  params: Array<string | number | null>
}

const d1StatementLimit = 1000
const d1ReconciliationQueryOverhead = 6
const d1AtomicStatementLimit = d1StatementLimit - d1ReconciliationQueryOverhead

export class InvoiceImportBatchLimitError extends Error {
  readonly code = 'invoice_import_batch_limit'

  constructor(
    readonly plannedBatchStatements: number,
    readonly maximumBatchStatements: number,
  ) {
    super(
      `invoice import requires ${plannedBatchStatements} atomic statements; D1 allows at most ${maximumBatchStatements} after reconciliation query overhead`,
    )
    this.name = 'InvoiceImportBatchLimitError'
  }
}

const canonicalTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertTimestamp = (value: string, field: string): void => {
  const match = canonicalTimestamp.exec(value)
  if (!match) throw new Error(`${field} must be a canonical UTC timestamp with Z`)
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`
  const milliseconds = Date.parse(normalized)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new Error(`${field} must be a real canonical UTC instant`)
  }
}

const assertDate = (value: string, field: string): void => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a real canonical date`)
  }
}

const assertNullableCents = (value: number | null, field: string): void => {
  if (value !== null && (!Number.isSafeInteger(value) || Math.abs(value) > 9_000_000_000_000)) {
    throw new Error(`${field} is outside the cents limit`)
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('import fingerprint input must be finite JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  throw new Error('import fingerprint input must be JSON')
}

const hashCanonical = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`
}

const isD1 = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(database: Database, statement: Statement): Promise<T | null> => {
  const client = database.$client
  if (isD1(client)) {
    return (
      (await client
        .prepare(statement.text)
        .bind(...statement.params)
        .first<T>()) ?? null
    )
  }
  return (client.prepare(statement.text).get(...statement.params) as T | undefined) ?? null
}

const all = async <T>(database: Database, statement: Statement): Promise<T[]> => {
  const client = database.$client
  if (isD1(client)) {
    return (
      await client
        .prepare(statement.text)
        .bind(...statement.params)
        .all<T>()
    ).results
  }
  return client.prepare(statement.text).all(...statement.params) as T[]
}

const atomic = async (database: Database, statements: readonly Statement[]): Promise<void> => {
  const client = database.$client
  if (isD1(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return
  }
  client.transaction(() => {
    for (const statement of statements) client.prepare(statement.text).run(...statement.params)
  })()
}

const canonicalPayment = (payment: ImportedInvoicePayment): CanonicalPayment => {
  if (payment.sourcePaidAt === null && payment.sourcePaidDate === null) {
    throw new Error('an imported payment requires source paid evidence')
  }
  if (payment.sourcePaidAt !== null) assertTimestamp(payment.sourcePaidAt, 'sourcePaidAt')
  if (payment.sourcePaidDate !== null) assertDate(payment.sourcePaidDate, 'sourcePaidDate')
  assertTimestamp(payment.createdAt, 'payment.createdAt')
  assertTimestamp(payment.updatedAt, 'payment.updatedAt')
  return {
    id: payment.id,
    harvestId: payment.harvestId,
    amountCents: payment.amountCents,
    paidAt: payment.sourcePaidAt,
    paidDate: payment.sourcePaidAt === null ? payment.sourcePaidDate : null,
    sourcePaidAt: payment.sourcePaidAt,
    sourcePaidDate: payment.sourcePaidDate,
    sourceRecordedByName: payment.sourceRecordedByName ?? null,
    sourceRecordedByEmail: payment.sourceRecordedByEmail ?? null,
    sourceGatewayId: payment.sourceGatewayId ?? null,
    sourceGatewayName: payment.sourceGatewayName ?? null,
    notes: payment.notes ?? null,
    recordedByUserId: payment.recordedByUserId ?? null,
    providerTransactionId: payment.providerTransactionId ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  }
}

const samePayment = (left: StoredPayment, right: StoredPayment): boolean =>
  Object.keys(left).every(
    (key) => left[key as keyof StoredPayment] === right[key as keyof StoredPayment],
  )

const canonicalMessage = (message: ImportedInvoiceMessage): StoredMessage => {
  assertTimestamp(message.createdAt, 'message.createdAt')
  assertTimestamp(message.updatedAt, 'message.updatedAt')
  if (message.sendReminderOn !== undefined && message.sendReminderOn !== null) {
    assertDate(message.sendReminderOn, 'message.sendReminderOn')
  }
  if (
    !Array.isArray(message.recipients) ||
    message.recipients.some(
      (recipient) => typeof recipient.name !== 'string' || typeof recipient.email !== 'string',
    )
  ) {
    throw new Error('message recipients must be source name/email records')
  }
  return {
    id: message.id,
    harvestId: message.harvestId,
    sentBy: message.sentBy ?? null,
    sentByEmail: message.sentByEmail ?? null,
    sentFrom: message.sentFrom ?? null,
    sentFromEmail: message.sentFromEmail ?? null,
    recipients: JSON.stringify(
      message.recipients.map((recipient) => ({ name: recipient.name, email: recipient.email })),
    ),
    subject: message.subject ?? null,
    body: message.body ?? null,
    attachPdf: message.attachPdf ? 1 : 0,
    sendMeACopy: message.sendMeACopy ? 1 : 0,
    thankYou: message.thankYou ? 1 : 0,
    reminder: message.reminder ? 1 : 0,
    sendReminderOn: message.sendReminderOn ?? null,
    eventType: message.eventType ?? null,
    deliveryStatus: null,
    providerMessageId: null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }
}

const sameSourceMessage = (left: StoredMessage, right: StoredMessage): boolean =>
  left.id === right.id &&
  left.harvestId === right.harvestId &&
  left.sentBy === right.sentBy &&
  left.sentByEmail === right.sentByEmail &&
  left.sentFrom === right.sentFrom &&
  left.sentFromEmail === right.sentFromEmail &&
  left.recipients === right.recipients &&
  left.subject === right.subject &&
  left.body === right.body &&
  left.attachPdf === right.attachPdf &&
  left.sendMeACopy === right.sendMeACopy &&
  left.thankYou === right.thankYou &&
  left.reminder === right.reminder &&
  left.sendReminderOn === right.sendReminderOn &&
  left.eventType === right.eventType &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt

const sameMessageIdentityAndSender = (left: StoredMessage, right: StoredMessage): boolean =>
  left.id === right.id &&
  left.harvestId === right.harvestId &&
  left.sentBy === right.sentBy &&
  left.sentByEmail === right.sentByEmail &&
  left.sentFrom === right.sentFrom &&
  left.sentFromEmail === right.sentFromEmail

const canonicalLine = (line: ImportedInvoiceLine): StoredLine => {
  assertTimestamp(line.createdAt, 'line.createdAt')
  assertTimestamp(line.updatedAt, 'line.updatedAt')
  if (
    !Number.isSafeInteger(line.id) ||
    !Number.isSafeInteger(line.harvestId) ||
    !Number.isSafeInteger(line.position) ||
    !Number.isFinite(line.quantity) ||
    !Number.isSafeInteger(line.unitPriceCents) ||
    !Number.isSafeInteger(line.amountCents) ||
    line.id <= 0 ||
    line.harvestId <= 0 ||
    line.position < 0 ||
    Math.abs(line.unitPriceCents) > 9_000_000_000_000 ||
    Math.abs(line.amountCents) > 9_000_000_000_000
  ) {
    throw new Error('imported line identity or financial value is invalid')
  }
  return {
    id: line.id,
    harvestId: line.harvestId,
    position: line.position,
    kind: line.kind,
    description: line.description ?? null,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    amountCents: line.amountCents,
    taxed: line.taxed ? 1 : 0,
    taxed2: line.taxed2 ? 1 : 0,
    projectId: line.projectId ?? null,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  }
}

const sameLine = (left: StoredLine, right: StoredLine): boolean =>
  Object.keys(left).every((key) => left[key as keyof StoredLine] === right[key as keyof StoredLine])

const byHarvestIdentity = <T extends { harvestId: number | null; id: number }>(
  left: T,
  right: T,
): number => (left.harvestId ?? 0) - (right.harvestId ?? 0) || left.id - right.id

const normalizeImportInput = (input: ReconcileImportedInvoiceInput): NormalizedImportInput => ({
  lines: input.lines.map(canonicalLine).sort(byHarvestIdentity),
  messages: input.messages.map(canonicalMessage).sort(byHarvestIdentity),
  payments: input.payments.map(canonicalPayment).sort(byHarvestIdentity),
})

const fullSourceManifest = (input: ReconcileImportedInvoiceInput): Record<string, unknown> => ({
  invoice_id: input.invoiceId,
  source_batch_complete: input.sourceBatchComplete,
  expected_source_updated_at: input.expectedSourceUpdatedAt,
  source_updated_at: input.sourceUpdatedAt,
  source_state: input.sourceState,
  source_sent_at: input.sourceSentAt,
  source_paid_at: input.sourcePaidAt,
  source_paid_date: input.sourcePaidDate,
  source_closed_at: input.sourceClosedAt,
  source_amount_cents: input.sourceAmountCents,
  source_due_amount_cents: input.sourceDueAmountCents,
  source_tax_amount_cents: input.sourceTaxAmountCents,
  source_tax2_amount_cents: input.sourceTax2AmountCents,
  source_discount_amount_cents: input.sourceDiscountAmountCents,
  // D21 requires the source payment-options array to remain verbatim provenance.
  source_payment_options:
    input.sourcePaymentOptions === null ? null : [...input.sourcePaymentOptions],
  source_written_off_cents: input.sourceWrittenOffCents,
})

const fullLineManifest = (lines: readonly StoredLine[]): Record<string, unknown>[] =>
  lines.map((line) => ({
    id: line.id,
    harvest_id: line.harvestId,
    position: line.position,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unit_price_cents: line.unitPriceCents,
    amount_cents: line.amountCents,
    taxed: line.taxed,
    taxed2: line.taxed2,
    project_id: line.projectId,
    created_at: line.createdAt,
    updated_at: line.updatedAt,
  }))

const fullMessageManifest = (messages: readonly StoredMessage[]): Record<string, unknown>[] =>
  messages.map((message) => ({
    id: message.id,
    harvest_id: message.harvestId,
    sent_by: message.sentBy,
    sent_by_email: message.sentByEmail,
    sent_from: message.sentFrom,
    sent_from_email: message.sentFromEmail,
    recipients: message.recipients,
    subject: message.subject,
    body: message.body,
    attach_pdf: message.attachPdf,
    send_me_a_copy: message.sendMeACopy,
    thank_you: message.thankYou,
    reminder: message.reminder,
    send_reminder_on: message.sendReminderOn,
    event_type: message.eventType,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  }))

const fullPaymentManifest = (payments: readonly CanonicalPayment[]): Record<string, unknown>[] =>
  payments.map((payment) => ({
    id: payment.id,
    harvest_id: payment.harvestId,
    amount_cents: payment.amountCents,
    paid_at: payment.paidAt,
    paid_date: payment.paidDate,
    source_paid_at: payment.sourcePaidAt,
    source_paid_date: payment.sourcePaidDate,
    source_recorded_by_name: payment.sourceRecordedByName,
    source_recorded_by_email: payment.sourceRecordedByEmail,
    source_gateway_id: payment.sourceGatewayId,
    source_gateway_name: payment.sourceGatewayName,
    notes: payment.notes,
    recorded_by_user_id: payment.recordedByUserId,
    provider_transaction_id: payment.providerTransactionId,
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
  }))

const membershipManifest = <T extends { harvestId: number | null; id: number; updatedAt: string }>(
  rows: readonly T[],
): { harvest_id: number | null; id: number; updated_at: string }[] =>
  rows.map((row) => ({ harvest_id: row.harvestId, id: row.id, updated_at: row.updatedAt }))

const buildManifests = async (
  input: ReconcileImportedInvoiceInput,
  normalized: NormalizedImportInput,
): Promise<ImportedInvoiceManifests> => {
  const fullSource = fullSourceManifest(input)
  const fullLines = fullLineManifest(normalized.lines)
  const fullMessages = fullMessageManifest(normalized.messages)
  const fullPayments = fullPaymentManifest(normalized.payments)
  const [sourceManifestHash, lineManifestHash, messageManifestHash, paymentManifestHash] =
    await Promise.all([
      hashCanonical(fullSource),
      hashCanonical(fullLines),
      hashCanonical(fullMessages),
      hashCanonical(fullPayments),
    ])
  const inputFingerprint = await hashCanonical({
    source: fullSource,
    lines: fullLines,
    messages: fullMessages,
    payments: fullPayments,
  })
  return {
    inputFingerprint,
    sourceManifestJson: canonicalJson({
      invoice_id: input.invoiceId,
      source_updated_at: input.sourceUpdatedAt,
    }),
    sourceManifestHash,
    lineManifestJson: canonicalJson(membershipManifest(normalized.lines)),
    lineManifestHash,
    messageManifestJson: canonicalJson(membershipManifest(normalized.messages)),
    messageManifestHash,
    paymentManifestJson: canonicalJson(membershipManifest(normalized.payments)),
    paymentManifestHash,
  }
}

export const buildImportedInvoiceManifests = async (
  input: ReconcileImportedInvoiceInput,
): Promise<ImportedInvoiceManifests> => buildManifests(input, normalizeImportInput(input))

const paymentDateDiagnostics = (
  invoiceId: number,
  payments: readonly CanonicalPayment[],
): PaymentPaidDateDisagreesDiagnostic[] =>
  payments.flatMap((payment) =>
    payment.sourcePaidAt !== null &&
    payment.sourcePaidDate !== null &&
    payment.sourcePaidAt.slice(0, 10) !== payment.sourcePaidDate
      ? [
          {
            invoice_id: invoiceId,
            code: 'payment_paid_date_disagrees' as const,
            payment_id: payment.id,
            payment_harvest_id: payment.harvestId,
            source_paid_at: payment.sourcePaidAt,
            source_paid_date: payment.sourcePaidDate,
          },
        ]
      : [],
  )

const sourceStateDiagnostics = (
  invoiceId: number,
  sourceState: SourceState,
  derivedState: SourceState,
): SourceStateDisagreesDiagnostic[] =>
  sourceState === derivedState
    ? []
    : [
        {
          invoice_id: invoiceId,
          code: 'source_state_disagrees',
          source_state: sourceState,
          derived_state: derivedState,
        },
      ]

const roundedRateShare = (baseCents: bigint, ratePpm: number | null): bigint => {
  const product = baseCents * BigInt(ratePpm ?? 0)
  return (product + (product >= 0n ? 500_000n : -500_000n)) / 1_000_000n
}

const lineAmount = (
  lines: readonly StoredLine[],
  invoice: Pick<StoredInvoice, 'taxRatePpm' | 'tax2RatePpm' | 'discountRatePpm'>,
): number => {
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n)
  const taxBase = lines.reduce(
    (sum, line) => sum + (line.taxed === 1 ? BigInt(line.amountCents) : 0n),
    0n,
  )
  const tax2Base = lines.reduce(
    (sum, line) => sum + (line.taxed2 === 1 ? BigInt(line.amountCents) : 0n),
    0n,
  )
  const discount = roundedRateShare(subtotal, invoice.discountRatePpm)
  const amount =
    subtotal -
    discount +
    roundedRateShare(
      taxBase - roundedRateShare(taxBase, invoice.discountRatePpm),
      invoice.taxRatePpm,
    ) +
    roundedRateShare(
      tax2Base - roundedRateShare(tax2Base, invoice.discountRatePpm),
      invoice.tax2RatePpm,
    )
  if (amount < -9_000_000_000_000n || amount > 9_000_000_000_000n) {
    throw new Error('imported lines exceed the aggregate cents limit')
  }
  return Number(amount)
}

const effectiveMilliseconds = (payment: StoredPayment): number =>
  Date.parse(payment.paidAt ?? `${payment.paidDate}T00:00:00.000Z`)

const coveringEvidence = (
  payments: readonly StoredPayment[],
  thresholdCents: number,
): { paidAt: string | null; paidDate: string | null } | null => {
  let cumulative = 0
  for (const payment of [...payments].sort(
    (left, right) =>
      effectiveMilliseconds(left) - effectiveMilliseconds(right) || left.id - right.id,
  )) {
    cumulative += payment.amountCents
    if (cumulative >= thresholdCents) {
      return { paidAt: payment.paidAt, paidDate: payment.paidDate }
    }
  }
  return null
}

/**
 * Package-internal Harvest reconciliation seam. The importer must supply the complete
 * source-owned message/payment sets only after its invoice source batch is complete.
 * The operation then reconciles those sets and lifecycle state atomically,
 * without native command events. This module is deliberately absent from package-root
 * exports so ordinary application callers cannot reach the authority seam.
 */
export const reconcileImportedInvoice = async (
  database: Database,
  input: ReconcileImportedInvoiceInput,
): Promise<ImportReconciliationResult> => {
  if (input.sourceBatchComplete !== true) {
    throw new Error('import reconciliation requires a complete invoice source batch')
  }
  assertTimestamp(input.sourceUpdatedAt, 'sourceUpdatedAt')
  if (input.expectedSourceUpdatedAt !== null) {
    assertTimestamp(input.expectedSourceUpdatedAt, 'expectedSourceUpdatedAt')
  }
  if (input.sourceSentAt !== null) assertTimestamp(input.sourceSentAt, 'sourceSentAt')
  if (input.sourcePaidAt !== null) assertTimestamp(input.sourcePaidAt, 'sourcePaidAt')
  if (input.sourcePaidDate !== null) assertDate(input.sourcePaidDate, 'sourcePaidDate')
  if (input.sourceClosedAt !== null) assertTimestamp(input.sourceClosedAt, 'sourceClosedAt')
  assertNullableCents(input.sourceAmountCents, 'sourceAmountCents')
  assertNullableCents(input.sourceDueAmountCents, 'sourceDueAmountCents')
  assertNullableCents(input.sourceTaxAmountCents, 'sourceTaxAmountCents')
  assertNullableCents(input.sourceTax2AmountCents, 'sourceTax2AmountCents')
  assertNullableCents(input.sourceDiscountAmountCents, 'sourceDiscountAmountCents')
  if (
    input.sourcePaymentOptions !== null &&
    (!Array.isArray(input.sourcePaymentOptions) ||
      input.sourcePaymentOptions.some((option) => typeof option !== 'string'))
  ) {
    throw new Error('sourcePaymentOptions must be a source string array or null')
  }
  if (
    !Number.isSafeInteger(input.sourceWrittenOffCents) ||
    input.sourceWrittenOffCents < 0 ||
    input.sourceWrittenOffCents > 9_000_000_000_000
  ) {
    throw new Error('sourceWrittenOffCents is outside the cents limit')
  }
  const normalized = normalizeImportInput(input)
  const manifests = await buildManifests(input, normalized)
  const { inputFingerprint } = manifests
  const paidDateDiagnostics = paymentDateDiagnostics(input.invoiceId, normalized.payments)
  const invoice = await first<StoredInvoice>(database, {
    text: `SELECT id, harvest_id AS "harvestId", currency, amount_cents AS "amountCents",
        written_off_cents AS "writtenOffCents", version, state,
        source_updated_at AS "sourceUpdatedAt", tax_rate_ppm AS "taxRatePpm",
        tax2_rate_ppm AS "tax2RatePpm", discount_rate_ppm AS "discountRatePpm"
      FROM invoices WHERE id = ?`,
    params: [input.invoiceId],
  })
  if (invoice === null || invoice.harvestId === null) {
    throw new Error('import reconciliation requires an imported invoice')
  }
  if (
    invoice.sourceUpdatedAt !== null &&
    Date.parse(input.sourceUpdatedAt) <= Date.parse(invoice.sourceUpdatedAt)
  ) {
    return {
      invoiceId: input.invoiceId,
      sourceUpdatedAt: invoice.sourceUpdatedAt,
      state: invoice.state,
      diagnostics: [
        ...sourceStateDiagnostics(input.invoiceId, input.sourceState, invoice.state),
        ...paidDateDiagnostics,
      ],
    }
  }
  const priorReceipt = await first<Receipt>(database, {
    text: `SELECT input_fingerprint AS "inputFingerprint", target_state AS "targetState", completed
      FROM invoice_import_reconciliations WHERE invoice_id = ? AND source_updated_at = ?`,
    params: [input.invoiceId, input.sourceUpdatedAt],
  })
  if (priorReceipt !== null) {
    if (priorReceipt.inputFingerprint !== inputFingerprint || priorReceipt.completed !== 1) {
      throw new Error(
        'import reconciliation identity was reused with different or incomplete input',
      )
    }
    const diagnostics: ImportReconciliationDiagnostic[] = [
      ...sourceStateDiagnostics(input.invoiceId, input.sourceState, priorReceipt.targetState),
      ...paidDateDiagnostics,
    ]
    return {
      invoiceId: input.invoiceId,
      sourceUpdatedAt: input.sourceUpdatedAt,
      state: priorReceipt.targetState,
      diagnostics,
    }
  }

  if (invoice.sourceUpdatedAt !== input.expectedSourceUpdatedAt) {
    const racedReceipt = await first<Receipt>(database, {
      text: `SELECT input_fingerprint AS "inputFingerprint", target_state AS "targetState", completed
        FROM invoice_import_reconciliations WHERE invoice_id = ? AND source_updated_at = ?`,
      params: [input.invoiceId, input.sourceUpdatedAt],
    })
    if (
      racedReceipt !== null &&
      racedReceipt.completed === 1 &&
      racedReceipt.inputFingerprint === inputFingerprint
    ) {
      return {
        invoiceId: input.invoiceId,
        sourceUpdatedAt: input.sourceUpdatedAt,
        state: racedReceipt.targetState,
        diagnostics: [
          ...sourceStateDiagnostics(input.invoiceId, input.sourceState, racedReceipt.targetState),
          ...paidDateDiagnostics,
        ],
      }
    }
    throw new Error('import reconciliation expected source timestamp is stale')
  }
  if (
    !Number.isSafeInteger(invoice.version) ||
    invoice.version < 0 ||
    invoice.version >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('invoice version cannot be incremented safely')
  }

  const existingLines = await all<StoredLine>(database, {
    text: `SELECT id, harvest_id AS "harvestId", position, kind, description, quantity,
        unit_price_cents AS "unitPriceCents", amount_cents AS "amountCents", taxed, taxed2,
        project_id AS "projectId", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM invoice_line_items WHERE invoice_id = ?`,
    params: [input.invoiceId],
  })
  const importedLines = existingLines.filter(
    (line): line is StoredLine & { harvestId: number } => line.harvestId !== null,
  )
  const nativeLines = existingLines.filter((line) => line.harvestId === null)
  const linesByHarvestId = new Map<number, StoredLine>(
    importedLines.map((line) => [line.harvestId, line]),
  )
  const incomingLines = normalized.lines
  const seenLineHarvestIds = new Set<number>()
  const seenLinePositions = new Set<number>(nativeLines.map((line) => line.position))
  const lineInserts: StoredLine[] = []
  const lineDeletes: StoredLine[] = []
  for (const line of incomingLines) {
    const harvestId = line.harvestId ?? 0
    if (seenLineHarvestIds.has(harvestId) || seenLinePositions.has(line.position)) {
      throw new Error('imported line identity or position is duplicated')
    }
    seenLineHarvestIds.add(harvestId)
    seenLinePositions.add(line.position)
    const existing = linesByHarvestId.get(harvestId)
    if (existing === undefined) lineInserts.push(line)
    else if (!sameLine(existing, line)) {
      lineDeletes.push(existing)
      lineInserts.push(line)
    }
  }
  for (const line of importedLines) {
    if (!seenLineHarvestIds.has(line.harvestId)) lineDeletes.push(line)
  }
  const targetAmountCents = lineAmount([...nativeLines, ...incomingLines], invoice)

  const allExistingPayments = await all<StoredPayment>(database, {
    text: `SELECT id, harvest_id AS "harvestId", amount_cents AS "amountCents",
        paid_at AS "paidAt", paid_date AS "paidDate", source_paid_at AS "sourcePaidAt",
        source_paid_date AS "sourcePaidDate", source_recorded_by_name AS "sourceRecordedByName",
        source_recorded_by_email AS "sourceRecordedByEmail", source_gateway_id AS "sourceGatewayId",
        source_gateway_name AS "sourceGatewayName", notes,
        recorded_by_user_id AS "recordedByUserId",
        provider_transaction_id AS "providerTransactionId", created_at AS "createdAt",
        updated_at AS "updatedAt" FROM invoice_payments WHERE invoice_id = ?`,
    params: [input.invoiceId],
  })
  const existingPayments = allExistingPayments.filter(
    (payment): payment is StoredPayment & { harvestId: number } => payment.harvestId !== null,
  )
  const nativePayments = allExistingPayments.filter((payment) => payment.harvestId === null)
  const byHarvestId = new Map<number, StoredPayment>(
    existingPayments.map((payment) => [payment.harvestId, payment]),
  )
  const incoming = normalized.payments
  const seenHarvestIds = new Set<number>()
  const inserts: StoredPayment[] = []
  const deletes: StoredPayment[] = []
  for (const payment of incoming) {
    if (
      !Number.isSafeInteger(payment.id) ||
      !Number.isSafeInteger(payment.harvestId) ||
      !Number.isSafeInteger(payment.amountCents) ||
      payment.id <= 0 ||
      payment.harvestId <= 0 ||
      payment.amountCents <= 0 ||
      payment.amountCents > 9_000_000_000_000 ||
      seenHarvestIds.has(payment.harvestId)
    ) {
      throw new Error('imported payment identity or amount is invalid')
    }
    seenHarvestIds.add(payment.harvestId)
    const existing = byHarvestId.get(payment.harvestId)
    if (existing === undefined) inserts.push(payment)
    else if (!samePayment(existing, payment)) {
      deletes.push(existing)
      inserts.push(payment)
    }
  }
  for (const payment of existingPayments) {
    if (!seenHarvestIds.has(payment.harvestId)) deletes.push(payment)
  }
  if (input.sourceState === 'draft' && incoming.length > 0) {
    throw new Error('a draft source invoice cannot contain payments')
  }

  const existingMessages = await all<StoredMessage>(database, {
    text: `SELECT id, harvest_id AS "harvestId", sent_by AS "sentBy",
        sent_by_email AS "sentByEmail", sent_from AS "sentFrom",
        sent_from_email AS "sentFromEmail", recipients, subject, body,
        attach_pdf AS "attachPdf", send_me_a_copy AS "sendMeACopy",
        thank_you AS "thankYou", reminder, send_reminder_on AS "sendReminderOn",
        event_type AS "eventType", delivery_status AS "deliveryStatus",
        provider_message_id AS "providerMessageId", created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM invoice_messages WHERE invoice_id = ? AND harvest_id IS NOT NULL`,
    params: [input.invoiceId],
  })
  const messagesByHarvestId = new Map<number, StoredMessage>(
    existingMessages.flatMap((message) =>
      message.harvestId === null ? [] : [[message.harvestId, message] as const],
    ),
  )
  const incomingMessages = normalized.messages
  const seenMessageHarvestIds = new Set<number>()
  const messageInserts: StoredMessage[] = []
  const messageUpdates: StoredMessage[] = []
  const messageDeletes: StoredMessage[] = []
  for (const message of incomingMessages) {
    if (
      !Number.isSafeInteger(message.id) ||
      !Number.isSafeInteger(message.harvestId) ||
      message.id <= 0 ||
      (message.harvestId ?? 0) <= 0 ||
      seenMessageHarvestIds.has(message.harvestId ?? 0)
    ) {
      throw new Error('imported message identity is invalid')
    }
    const harvestId = message.harvestId ?? 0
    seenMessageHarvestIds.add(harvestId)
    const existing = messagesByHarvestId.get(harvestId)
    if (existing === undefined) messageInserts.push(message)
    else if (!sameSourceMessage(existing, message)) {
      if (!sameMessageIdentityAndSender(existing, message)) {
        throw new Error('imported message identity or sender provenance drifted')
      }
      messageUpdates.push(message)
    }
  }
  for (const message of existingMessages) {
    if (message.harvestId !== null && !seenMessageHarvestIds.has(message.harvestId)) {
      messageDeletes.push(message)
    }
  }

  const paymentCents = [...nativePayments, ...incoming].reduce(
    (sum, payment) => sum + payment.amountCents,
    0,
  )
  const dueAmountCents =
    input.sourceState === 'draft'
      ? targetAmountCents - input.sourceWrittenOffCents
      : targetAmountCents - paymentCents - input.sourceWrittenOffCents
  const paymentStatusPaid = nativePayments.length + incoming.length > 0 && dueAmountCents <= 0
  const targetState: SourceState =
    input.sourceState === 'closed'
      ? 'closed'
      : input.sourceState === 'draft'
        ? 'draft'
        : paymentStatusPaid
          ? 'paid'
          : 'open'
  let paidAt: string | null = null
  let paidDate: string | null = null
  if (targetState === 'closed' && input.sourcePaidAt !== null) {
    paidAt = input.sourcePaidAt
  } else if (targetState === 'closed' && input.sourcePaidDate !== null) {
    paidDate = input.sourcePaidDate
  } else if (targetState === 'paid' || (targetState === 'closed' && paymentStatusPaid)) {
    if (input.sourcePaidAt !== null) paidAt = input.sourcePaidAt
    else if (input.sourcePaidDate !== null) paidDate = input.sourcePaidDate
    else {
      const evidence = coveringEvidence(
        [...nativePayments, ...incoming],
        targetAmountCents - input.sourceWrittenOffCents,
      )
      if (evidence === null)
        throw new Error('paid import lacks source or covering-payment evidence')
      paidAt = evidence.paidAt
      paidDate = evidence.paidDate
    }
  }
  const closeReason = targetState === 'closed' ? 'source_closed' : null
  const closedAt = targetState === 'closed' ? input.sourceClosedAt : null
  const diagnostics: ImportReconciliationDiagnostic[] = [
    ...sourceStateDiagnostics(input.invoiceId, input.sourceState, targetState),
    ...paidDateDiagnostics,
  ]

  const statements: Statement[] = [
    {
      text: `INSERT INTO invoice_import_reconciliations (
          invoice_id, source_updated_at, expected_source_updated_at, input_fingerprint,
          source_manifest_json, source_manifest_hash, line_manifest_json, line_manifest_hash,
          message_manifest_json, message_manifest_hash, payment_manifest_json,
          payment_manifest_hash,
          source_state, target_state, target_version, target_updated_at, target_close_reason,
          target_close_write_off_cents, target_written_off_cents, target_sent_at,
          target_paid_at, target_paid_date, target_closed_at, outbox_count_before
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, invoice.version + 1, ?, ?, 0, ?, ?, ?, ?, ?,
          (SELECT count(*) FROM event_outbox event
           WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id)
        FROM invoices invoice WHERE invoice.id = ?`,
      params: [
        input.invoiceId,
        input.sourceUpdatedAt,
        input.expectedSourceUpdatedAt,
        inputFingerprint,
        manifests.sourceManifestJson,
        manifests.sourceManifestHash,
        manifests.lineManifestJson,
        manifests.lineManifestHash,
        manifests.messageManifestJson,
        manifests.messageManifestHash,
        manifests.paymentManifestJson,
        manifests.paymentManifestHash,
        input.sourceState,
        targetState,
        input.sourceUpdatedAt,
        closeReason,
        input.sourceWrittenOffCents,
        input.sourceSentAt,
        paidAt,
        paidDate,
        closedAt,
        input.invoiceId,
      ],
    },
  ]
  for (const line of lineDeletes) {
    statements.push({
      text: `DELETE FROM invoice_line_items
        WHERE invoice_id = ? AND harvest_id = ? AND id = ?`,
      params: [input.invoiceId, line.harvestId, line.id],
    })
  }
  for (const line of lineInserts) {
    statements.push({
      text: `INSERT INTO invoice_line_items (
          id, harvest_id, invoice_id, position, kind, description, quantity,
          unit_price_cents, amount_cents, taxed, taxed2, project_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        line.id,
        line.harvestId,
        input.invoiceId,
        line.position,
        line.kind,
        line.description,
        line.quantity,
        line.unitPriceCents,
        line.amountCents,
        line.taxed,
        line.taxed2,
        line.projectId,
        line.createdAt,
        line.updatedAt,
      ],
    })
  }
  for (const payment of deletes) {
    statements.push({
      text: `DELETE FROM invoice_payments
        WHERE invoice_id = ? AND harvest_id = ? AND id = ?`,
      params: [input.invoiceId, payment.harvestId, payment.id],
    })
  }
  for (const payment of inserts) {
    statements.push({
      text: `INSERT INTO invoice_payments (
          id, harvest_id, invoice_id, currency, amount_cents, paid_at, paid_date,
          source_paid_at, source_paid_date, source_recorded_by_name,
          source_recorded_by_email, source_gateway_id, source_gateway_name, notes,
          recorded_by_user_id, provider, provider_shape, provider_transaction_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?, ?)`,
      params: [
        payment.id,
        payment.harvestId,
        input.invoiceId,
        invoice.currency,
        payment.amountCents,
        payment.paidAt,
        payment.paidDate,
        payment.sourcePaidAt,
        payment.sourcePaidDate,
        payment.sourceRecordedByName,
        payment.sourceRecordedByEmail,
        payment.sourceGatewayId,
        payment.sourceGatewayName,
        payment.notes,
        payment.recordedByUserId,
        payment.providerTransactionId,
        payment.createdAt,
        payment.updatedAt,
      ],
    })
  }
  for (const message of messageDeletes) {
    statements.push({
      text: `DELETE FROM invoice_messages
        WHERE invoice_id = ? AND harvest_id = ? AND id = ?`,
      params: [input.invoiceId, message.harvestId, message.id],
    })
  }
  for (const message of messageUpdates) {
    statements.push({
      text: `UPDATE invoice_messages SET
          sent_by = ?, sent_by_email = ?, sent_from = ?, sent_from_email = ?,
          recipients = ?, subject = ?, body = ?, attach_pdf = ?, send_me_a_copy = ?,
          thank_you = ?, reminder = ?, send_reminder_on = ?, event_type = ?,
          created_at = ?, updated_at = ?
        WHERE invoice_id = ? AND harvest_id = ? AND id = ?`,
      params: [
        message.sentBy,
        message.sentByEmail,
        message.sentFrom,
        message.sentFromEmail,
        message.recipients,
        message.subject,
        message.body,
        message.attachPdf,
        message.sendMeACopy,
        message.thankYou,
        message.reminder,
        message.sendReminderOn,
        message.eventType,
        message.createdAt,
        message.updatedAt,
        input.invoiceId,
        message.harvestId,
        message.id,
      ],
    })
  }
  for (const message of messageInserts) {
    statements.push({
      text: `INSERT INTO invoice_messages (
          id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
          recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
          send_reminder_on, event_type, delivery_status, provider_message_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        message.id,
        message.harvestId,
        input.invoiceId,
        message.sentBy,
        message.sentByEmail,
        message.sentFrom,
        message.sentFromEmail,
        message.recipients,
        message.subject,
        message.body,
        message.attachPdf,
        message.sendMeACopy,
        message.thankYou,
        message.reminder,
        message.sendReminderOn,
        message.eventType,
        message.deliveryStatus,
        message.providerMessageId,
        message.createdAt,
        message.updatedAt,
      ],
    })
  }
  statements.push(
    {
      text: `UPDATE invoices SET source_amount_cents = ?, source_due_amount_cents = ?,
          source_tax_amount_cents = ?, source_tax2_amount_cents = ?,
          source_discount_amount_cents = ?, source_payment_options = ?,
          source_updated_at = ?, updated_at = ?, state = ?,
          close_reason = ?, close_write_off_cents = 0, written_off_cents = ?,
          sent_at = ?, paid_at = ?, paid_date = ?, closed_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND source_updated_at IS ?`,
      params: [
        input.sourceAmountCents,
        input.sourceDueAmountCents,
        input.sourceTaxAmountCents,
        input.sourceTax2AmountCents,
        input.sourceDiscountAmountCents,
        input.sourcePaymentOptions === null ? null : JSON.stringify(input.sourcePaymentOptions),
        input.sourceUpdatedAt,
        input.sourceUpdatedAt,
        targetState,
        closeReason,
        input.sourceWrittenOffCents,
        input.sourceSentAt,
        paidAt,
        paidDate,
        closedAt,
        input.invoiceId,
        invoice.version,
        input.expectedSourceUpdatedAt,
      ],
    },
    {
      text: `UPDATE invoice_import_reconciliations SET completed = 1
        WHERE invoice_id = ? AND source_updated_at = ? AND completed = 0`,
      params: [input.invoiceId, input.sourceUpdatedAt],
    },
  )
  if (isD1(database.$client) && statements.length > d1AtomicStatementLimit) {
    throw new InvoiceImportBatchLimitError(statements.length, d1AtomicStatementLimit)
  }
  try {
    await atomic(database, statements)
  } catch (error) {
    // A concurrent identical first attempt can win after our initial receipt read.
    // Re-read only after the entire atomic batch failed; exact completed identity is
    // the sole condition that turns the collision into the same successful result.
    const completed = await first<Receipt>(database, {
      text: `SELECT input_fingerprint AS "inputFingerprint", target_state AS "targetState", completed
        FROM invoice_import_reconciliations WHERE invoice_id = ? AND source_updated_at = ?`,
      params: [input.invoiceId, input.sourceUpdatedAt],
    })
    if (
      completed === null ||
      completed.completed !== 1 ||
      completed.inputFingerprint !== inputFingerprint
    ) {
      throw error
    }
    const completedDiagnostics: ImportReconciliationDiagnostic[] = [
      ...sourceStateDiagnostics(input.invoiceId, input.sourceState, completed.targetState),
      ...paidDateDiagnostics,
    ]
    return {
      invoiceId: input.invoiceId,
      sourceUpdatedAt: input.sourceUpdatedAt,
      state: completed.targetState,
      diagnostics: completedDiagnostics,
    }
  }
  return {
    invoiceId: input.invoiceId,
    sourceUpdatedAt: input.sourceUpdatedAt,
    state: targetState,
    diagnostics,
  }
}
