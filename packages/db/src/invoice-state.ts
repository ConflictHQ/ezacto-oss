import {
  deriveInvoicePaymentStatus,
  reduceInvoiceCommand,
  reduceInvoiceEdit,
  reduceInvoicePaymentMutation,
  type InvoiceActorType,
  type InvoiceEventType,
  type InvoiceLifecycleCommand,
  type InvoiceLifecycleSnapshot,
  type InvoicePaidTimestamp,
  type InvoicePaymentMutationKind,
  type InvoicePaymentStatus,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { InvoicePaymentOption, InvoiceReminderPolicy } from './schema.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type InvoiceStateDatabase = ContainerDatabase | WorkerDatabase

export type InvoiceCommandKind =
  | 'invoice.create'
  | 'invoice.delete'
  | 'invoice.send'
  | 'invoice.view'
  | 'invoice.draft'
  | 'invoice.cancel'
  | 'invoice.write_off'
  | 'invoice.reopen'
  | 'invoice.source_close'
  | 'invoice.update'
  | 'invoice.line_insert'
  | 'invoice.line_update'
  | 'invoice.line_delete'
  | 'invoice.financials_update'
  | 'payment.record'
  | 'payment.update'
  | 'payment.delete'

export type InvoiceCommandOperationErrorCode =
  | 'invalid_command_input'
  | 'forbidden'
  | 'invoice_not_found'
  | 'invoice_version_conflict'
  | 'command_id_reused'
  | 'command_incomplete'
  | 'trigger_row_conflict'
  | 'command_storage_conflict'

export class InvoiceCommandOperationError extends Error {
  readonly code: InvoiceCommandOperationErrorCode

  constructor(code: InvoiceCommandOperationErrorCode, message: string) {
    super(message)
    this.name = 'InvoiceCommandOperationError'
    this.code = code
  }
}

export class InvoiceVersionConflictError extends InvoiceCommandOperationError {
  readonly invoiceId: number
  readonly expectedVersion: number
  readonly actualVersion: number | null

  constructor(invoiceId: number, expectedVersion: number, actualVersion: number | null) {
    super(
      'invoice_version_conflict',
      actualVersion === null
        ? `invoice ${invoiceId} no longer exists`
        : `invoice ${invoiceId} version ${actualVersion} does not match expected version ${expectedVersion}`,
    )
    this.name = 'InvoiceVersionConflictError'
    this.invoiceId = invoiceId
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class InvoiceCommandReuseError extends InvoiceCommandOperationError {
  readonly invoiceId: number
  readonly commandId: string

  constructor(invoiceId: number, commandId: string) {
    super(
      'command_id_reused',
      `invoice ${invoiceId} command id ${commandId} was already used for different causation`,
    )
    this.name = 'InvoiceCommandReuseError'
    this.invoiceId = invoiceId
    this.commandId = commandId
  }
}

export class InvoiceTriggerRowConflictError extends InvoiceCommandOperationError {
  readonly triggerType: 'invoice_payment' | 'invoice_line_item' | 'bank_deposit'
  readonly triggerId: number

  constructor(
    triggerType: 'invoice_payment' | 'invoice_line_item' | 'bank_deposit',
    triggerId: number,
  ) {
    super(
      'trigger_row_conflict',
      `${triggerType} ${triggerId} is missing or no longer matches the expected version`,
    )
    this.name = 'InvoiceTriggerRowConflictError'
    this.triggerType = triggerType
    this.triggerId = triggerId
  }
}

export interface InvoiceCommandActor {
  type: InvoiceActorType
  id: number | null
}

export type InvoiceCommandAuthorization = (
  actor: InvoiceCommandActor,
  invoiceId: number,
) => boolean | Promise<boolean>

export interface ExecuteInvoiceLifecycleCommand {
  invoiceId: number
  commandId: string
  command: InvoiceLifecycleCommand
  actor: InvoiceCommandActor
  /** Required for every command except the non-mutating system view. */
  expectedVersion?: number
  occurredAt: string
  messageId: number
  eventId: string
  /** Immutable delivery/document provenance captured with the command row. */
  message?: Readonly<{
    sentBy: string | null
    sentByEmail: string | null
    sentFrom: string | null
    sentFromEmail: string | null
    recipients: readonly Readonly<{ name: string; email: string }>[]
    subject: string | null
    body: string | null
    attachPdf: boolean
    sendMeACopy: boolean
    thankYou: boolean
    reminder: boolean
    sendReminderOn: string | null
  }>
  /** Present only for an explicitly confirmed, externally delivered invoice email. */
  delivery?: Readonly<{
    templateVersion: number
    senderIdentityId: number
    senderIdentityVersion: number
    senderEvidenceVersion: number
    fromName: string
    fromEmail: string
    replyToEmail: string | null
    subject: string
    textBody: string
    htmlBody: string | null
    recipients: readonly Readonly<{
      deliveryId: number
      name: string
      email: string
    }>[]
  }>
  authorize: InvoiceCommandAuthorization
}

interface InvoiceMutationCommand {
  invoiceId: number
  commandId: string
  actor: InvoiceCommandActor
  expectedVersion: number
  occurredAt: string
  eventIds: readonly string[]
  authorize: InvoiceCommandAuthorization
}

type CommandIdentity = Pick<
  InvoiceMutationCommand,
  'invoiceId' | 'commandId' | 'actor' | 'occurredAt' | 'authorize'
>

export interface ManualInvoicePaymentInput {
  type: 'manual'
  id: number
  currency: string
  amountCents: number
  paidAt: string | null
  paidDate: string | null
  notes?: string | null
  recordedByUserId?: number | null
}

export interface BankDepositInvoicePaymentInput {
  type: 'bank_deposit'
  id: number
  depositId: number
  expectedDepositUpdatedAt: string
  expectedMatchState: 'unmatched' | 'suggested'
  paidAt: string
  notes?: string | null
  recordedByUserId?: number | null
}

/**
 * A payment taken by a payment provider on an invoice we sent them (issue 595).
 *
 * `invoice_payments` has described this row since migration 0005 -- `provider`
 * admits `stripe`, `paypal`, `quickbooks` and `bill_com`, `provider_shape` has
 * a `checkout` value, and the CHECK requires an account and a transaction id
 * for any provider that is not `manual`. Nothing could write one: the manual
 * branch forbids an account id and the bank-deposit branch produces
 * `reconciliation` rows from a deposit that a checkout payment does not have.
 *
 * So the QuickBooks mirror wrote the row directly and was refused by the ledger
 * trigger, and its inbound payments have never worked. This is the shape that
 * was missing, not a new idea about what a payment is.
 *
 * `providerTransactionId` is the provider's own id for the payment and is what
 * makes recording it twice impossible at the row level -- the reconciliations
 * that produce these are polls, and a poll sees the same payment on every pass.
 */
export interface CheckoutInvoicePaymentInput {
  type: 'checkout'
  id: number
  currency: string
  amountCents: number
  paidAt: string | null
  paidDate: string | null
  provider: 'stripe' | 'paypal' | 'quickbooks' | 'bill_com'
  /** A row in `payment_provider_accounts`; the account the money was taken into. */
  providerAccountId: number
  providerTransactionId: string
  notes?: string | null
}

export interface RecordInvoicePaymentCommand extends InvoiceMutationCommand {
  payment:
    | ManualInvoicePaymentInput
    | CheckoutInvoicePaymentInput
    | BankDepositInvoicePaymentInput
}

export interface UpdateInvoicePaymentCommand extends InvoiceMutationCommand {
  paymentId: number
  expectedPaymentUpdatedAt: string
  amountCents: number
  paidAt: string | null
  paidDate: string | null
  notes?: string | null
  recordedByUserId?: number | null
}

export interface DeleteInvoicePaymentCommand extends InvoiceMutationCommand {
  paymentId: number
  expectedPaymentUpdatedAt: string
}

export type InvoiceEdit =
  | {
      type: 'header'
      clientId?: number
      number?: string
      subject?: string | null
      purchaseOrder?: string | null
      notes?: string | null
      currency?: string
      issueDate?: string
      dueDate?: string
      paymentTerms?: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
      projectId?: number | null
      /**
       * The retainer this invoice moves against.
       *
       * The schema was built for this and nothing wrote it: `retainer_ledger`
       * refuses a deposit or a drawdown whose invoice is not linked to the same
       * retainer, so with no way to set the column a retainer could be created,
       * shown, and never moved (#449).
       *
       * `invoices_retainer_client_insert` keeps the retainer on the invoice's
       * own client, and `invoices_retainer_with_ledger_immutable` freezes the
       * link once a movement names it -- so this is editable exactly while it
       * is still only a plan, which is the correct window.
       */
      retainerId?: number | null
      reminderPolicy?: Readonly<InvoiceReminderPolicy> | null
    }
  | { type: 'payment_options'; paymentOptions: readonly InvoicePaymentOption[] }
  | {
      type: 'line_insert'
      lineId: number
      position: number
      kind: string
      description?: string | null
      quantity: number
      unitPriceCents: number
      amountCents: number
      taxed?: boolean
      taxed2?: boolean
      projectId?: number | null
    }
  | {
      type: 'line_update'
      lineId: number
      expectedLineUpdatedAt: string
      position: number
      kind: string
      description?: string | null
      quantity: number
      unitPriceCents: number
      amountCents: number
      taxed: boolean
      taxed2: boolean
      projectId?: number | null
    }
  | { type: 'line_delete'; lineId: number; expectedLineUpdatedAt: string }
  | {
      type: 'financials'
      taxRatePpm: number | null
      tax2RatePpm: number | null
      discountRatePpm: number | null
    }

export interface ExecuteInvoiceEditCommand extends InvoiceMutationCommand {
  edit: InvoiceEdit
}

export interface InvoiceCommandResultSnapshot {
  id: number
  version: number
  updated_at: string
  state: string
  close_reason: string | null
  close_write_off_cents: number
  sent_at: string | null
  paid_at: string | null
  paid_date: string | null
  closed_at: string | null
  amount_cents: number
  due_amount_cents: number
  written_off_cents: number
  payment_count: number
  payment_status: InvoicePaymentStatus
}

export interface InvoiceCommandResult {
  schema_version: 1
  event_ids: string[]
  first_aggregate_sequence: number
  event_count: number
  invoice: InvoiceCommandResultSnapshot
}

interface StoredInvoiceSnapshot extends InvoiceLifecycleSnapshot {
  id: number
  currency: string
  amountCents: number
  taxRatePpm: number | null
  tax2RatePpm: number | null
  discountRatePpm: number | null
}

interface StoredPayment {
  id: number
  invoiceId: number
  harvestId: number | null
  currency: string
  amountCents: number
  paidAt: string | null
  paidDate: string | null
  notes: string | null
  recordedByUserId: number | null
  provider: string
  providerShape: string
  providerAccountId: number | null
  providerTransactionId: string | null
  bankDepositId: number | null
  updatedAt: string
}

interface StoredBankDeposit {
  id: number
  providerAccountId: number
  providerTransactionId: string
  currency: string
  amountCents: number
  matchState: 'unmatched' | 'suggested' | 'confirmed'
  suggestedInvoiceId: number | null
  updatedAt: string
  provider: string
  providerShape: string
}

interface StoredInvoiceDocument {
  clientId: number
  number: string
  subject: string | null
  purchaseOrder: string | null
  notes: string | null
  currency: string
  issueDate: string
  dueDate: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
  projectId: number | null
  retainerId: number | null
  reminderPolicy: string | null
  paymentOptions: string
}

interface StoredInvoiceLine {
  id: number
  invoiceId: number
  position: number
  kind: string
  description: string | null
  quantity: number
  unitPriceCents: number
  amountCents: number
  taxed: number
  taxed2: number
  projectId: number | null
  updatedAt: string
}

interface InvoiceFinancialBases {
  subtotalCents: number
  taxBaseCents: number
  tax2BaseCents: number
  paymentCents: number
}

interface EventPaymentSnapshot {
  id: number
  amount_cents: number
  currency: string
  provider: string
  shape: string
  paid_at: string | null
  paid_date: string | null
}

interface StoredLedger {
  commandKind: string
  inputFingerprint: string
  actorType: InvoiceActorType
  actorId: number | null
  expectedInvoiceVersion: number | null
  occurredAt: string
  completed: number
  resultJson: string | null
}

interface SqlStatement {
  text: string
  params: Array<string | number | null>
}

interface EventInvoiceSnapshot {
  version: number
  updated_at: string
  state: string
  close_reason: string | null
  close_write_off_cents: number
  sent_at: string | null
  paid_at: string | null
  paid_date: string | null
  closed_at: string | null
  amount_cents: number
  due_amount_cents: number
  written_off_cents: number
  payment_count: number
  payment_status: InvoicePaymentStatus
}

const commandKinds: Record<InvoiceLifecycleCommand, InvoiceCommandKind> = {
  send: 'invoice.send',
  view: 'invoice.view',
  draft: 'invoice.draft',
  cancel: 'invoice.cancel',
  write_off: 'invoice.write_off',
  reopen: 'invoice.reopen',
  source_close: 'invoice.source_close',
}

const messageEventTypes: Record<InvoiceLifecycleCommand, string> = {
  send: 'send',
  view: 'view',
  draft: 'draft',
  cancel: 'cancel',
  write_off: 'write_off',
  reopen: 're-open',
  source_close: 'close',
}

const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/
const eventIdPattern = /^[\x21-\x7e]{1,255}$/
const canonicalTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const invalidInput = (message: string): never => {
  throw new InvoiceCommandOperationError('invalid_command_input', message)
}

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidInput(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalTimestamp = (value: string, field = 'occurredAt'): void => {
  const match = canonicalTimestamp.exec(value)
  if (!match) return invalidInput(`${field} must be a canonical UTC timestamp with Z`)
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`
  const milliseconds = Date.parse(normalized)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    invalidInput(`${field} must be a real canonical UTC instant`)
  }
}

const validateInput = (input: ExecuteInvoiceLifecycleCommand): number | null => {
  assertPositiveSafeInteger(input.invoiceId, 'invoiceId')
  assertPositiveSafeInteger(input.messageId, 'messageId')
  if (!commandIdPattern.test(input.commandId)) {
    invalidInput('commandId must be 1-128 ASCII characters from [A-Za-z0-9._:-]')
  }
  if (!eventIdPattern.test(input.eventId)) {
    invalidInput('eventId must be 1-255 printable ASCII characters')
  }
  assertCanonicalTimestamp(input.occurredAt)
  if (input.message !== undefined) {
    const scalarFields = [
      ['sentBy', input.message.sentBy],
      ['sentByEmail', input.message.sentByEmail],
      ['sentFrom', input.message.sentFrom],
      ['sentFromEmail', input.message.sentFromEmail],
      ['subject', input.message.subject],
      ['body', input.message.body],
    ] as const
    for (const [field, value] of scalarFields) {
      if (value !== null && (typeof value !== 'string' || value.length > 100_000)) {
        invalidInput(`message.${field} must be null or a bounded string`)
      }
    }
    if (!Array.isArray(input.message.recipients) || input.message.recipients.length > 1_000) {
      invalidInput('message.recipients must be a bounded array')
    }
    for (const recipient of input.message.recipients) {
      if (
        typeof recipient !== 'object' ||
        recipient === null ||
        Object.keys(recipient).sort().join(',') !== 'email,name' ||
        typeof recipient.name !== 'string' ||
        recipient.name.length > 1_000 ||
        typeof recipient.email !== 'string' ||
        recipient.email.length < 3 ||
        recipient.email.length > 320
      ) {
        invalidInput('message.recipients must contain exact bounded name/email objects')
      }
    }
    if (input.message.sendReminderOn !== null) {
      const date = input.message.sendReminderOn
      const epoch = Date.parse(`${date}T00:00:00.000Z`)
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isSafeInteger(epoch) ||
        new Date(epoch).toISOString().slice(0, 10) !== date
      ) {
        invalidInput('message.sendReminderOn must be null or a real canonical date')
      }
    }
    for (const value of [
      input.message.attachPdf,
      input.message.sendMeACopy,
      input.message.thankYou,
      input.message.reminder,
    ]) {
      if (typeof value !== 'boolean') invalidInput('message flags must be booleans')
    }
  }
  if (input.delivery !== undefined) {
    const delivery = input.delivery
    if (
      input.command !== 'send' || input.actor.type !== 'user' || input.actor.id === null ||
      input.message === undefined || input.message.attachPdf
    ) {
      invalidInput('delivery requires a send message without a claimed PDF attachment')
    }
    for (const [field, value] of [
      ['templateVersion', delivery.templateVersion],
      ['senderIdentityId', delivery.senderIdentityId],
      ['senderEvidenceVersion', delivery.senderEvidenceVersion],
    ] as const) assertPositiveSafeInteger(value, `delivery.${field}`)
    if (!Number.isSafeInteger(delivery.senderIdentityVersion) || delivery.senderIdentityVersion < 0) {
      invalidInput('delivery.senderIdentityVersion must be a non-negative safe integer')
    }
    if (
      delivery.fromName.length < 1 || delivery.fromName.length > 200 ||
      delivery.fromEmail.length < 3 || delivery.fromEmail.length > 254 ||
      delivery.subject.trim().length < 1 || delivery.subject.length > 998 ||
      delivery.textBody.trim().length < 1 || delivery.textBody.length > 1_000_000 ||
      (delivery.htmlBody !== null &&
        (delivery.htmlBody.trim().length < 1 || delivery.htmlBody.length > 2_000_000)) ||
      (delivery.replyToEmail !== null &&
        (delivery.replyToEmail.length < 3 || delivery.replyToEmail.length > 254))
    ) invalidInput('delivery contains invalid bounded message fields')
    if (
      !Array.isArray(delivery.recipients) || delivery.recipients.length < 1 ||
      delivery.recipients.length > 1_000 ||
      new Set(delivery.recipients.map(({ deliveryId }) => deliveryId)).size !==
        delivery.recipients.length ||
      new Set(delivery.recipients.map(({ email }) => email)).size !==
        delivery.recipients.length
    ) invalidInput('delivery recipients must be a non-empty unique bounded array')
    delivery.recipients.forEach((recipient) => {
      assertPositiveSafeInteger(recipient.deliveryId, 'delivery recipient id')
      if (
        recipient.name.length > 200 || recipient.email.length < 3 ||
        recipient.email.length > 254 || recipient.email !== recipient.email.trim().toLowerCase()
      ) invalidInput('delivery recipient is invalid')
    })
  }
  if (typeof input.authorize !== 'function') invalidInput('authorize must be a function')
  if (input.actor.type === 'system') {
    if (input.actor.id !== null) invalidInput('a system actor must have a null id')
  } else if (!Number.isSafeInteger(input.actor.id) || (input.actor.id ?? 0) <= 0) {
    invalidInput('a user or contact actor must have a positive safe integer id')
  }
  if (input.command === 'view') {
    if (input.expectedVersion !== undefined) {
      invalidInput('a system view does not accept expectedVersion')
    }
    return null
  }
  if (
    input.expectedVersion === undefined ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    invalidInput('expectedVersion must be a non-negative safe integer')
  }
  return input.expectedVersion ?? invalidInput('expectedVersion is required')
}

const validateMutationCommand = (input: InvoiceMutationCommand): void => {
  assertPositiveSafeInteger(input.invoiceId, 'invoiceId')
  if (!commandIdPattern.test(input.commandId)) {
    invalidInput('commandId must be 1-128 ASCII characters from [A-Za-z0-9._:-]')
  }
  assertCanonicalTimestamp(input.occurredAt)
  if (typeof input.authorize !== 'function') invalidInput('authorize must be a function')
  if (input.actor.type === 'system') {
    if (input.actor.id !== null) invalidInput('a system actor must have a null id')
  } else if (!Number.isSafeInteger(input.actor.id) || (input.actor.id ?? 0) <= 0) {
    invalidInput('a user or contact actor must have a positive safe integer id')
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    invalidInput('expectedVersion must be a non-negative safe integer')
  }
  if (
    input.eventIds.length < 1 ||
    input.eventIds.length > 2 ||
    input.eventIds.some((eventId) => !eventIdPattern.test(eventId)) ||
    new Set(input.eventIds).size !== input.eventIds.length
  ) {
    invalidInput('eventIds must contain one or two unique printable ASCII ids')
  }
}

const assertAuthorized = async (input: CommandIdentity): Promise<void> => {
  if (!(await input.authorize(input.actor, input.invoiceId))) {
    throw new InvoiceCommandOperationError(
      'forbidden',
      `actor is not authorized for invoice ${input.invoiceId}`,
    )
  }
}

const assertPaymentTimestamp = (payment: InvoicePaidTimestamp): void => {
  if ((payment.paidAt === null) === (payment.paidDate === null)) {
    invalidInput('a payment must have exactly one of paidAt or paidDate')
  }
  if (payment.paidAt !== null) assertCanonicalTimestamp(payment.paidAt, 'paidAt')
  if (payment.paidDate !== null) {
    const milliseconds = Date.parse(`${payment.paidDate}T00:00:00.000Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(payment.paidDate) ||
      !Number.isSafeInteger(milliseconds) ||
      new Date(milliseconds).toISOString().slice(0, 10) !== payment.paidDate
    ) {
      invalidInput('paidDate must be a real canonical date')
    }
  }
}

const assertCents = (value: number, field: string, positive = false): void => {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 9_000_000_000_000 ||
    (positive && value <= 0)
  ) {
    invalidInput(`${field} must be ${positive ? 'a positive ' : ''}integer within the cents limit`)
  }
}

const assertRatePpm = (value: number | null, field: string): void => {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    invalidInput(`${field} must be null or an integer from 0 through 1000000`)
  }
}

const roundedRateShare = (baseCents: bigint, ratePpm: number | null): bigint => {
  const product = baseCents * BigInt(ratePpm ?? 0)
  return (product + (product >= 0n ? 500_000n : -500_000n)) / 1_000_000n
}

const calculateInvoiceAmount = (
  bases: Pick<InvoiceFinancialBases, 'subtotalCents' | 'taxBaseCents' | 'tax2BaseCents'>,
  rates: Pick<StoredInvoiceSnapshot, 'taxRatePpm' | 'tax2RatePpm' | 'discountRatePpm'>,
): number => {
  const subtotal = BigInt(bases.subtotalCents)
  const taxBase = BigInt(bases.taxBaseCents)
  const tax2Base = BigInt(bases.tax2BaseCents)
  const discount = roundedRateShare(subtotal, rates.discountRatePpm)
  const discountedTaxBase = taxBase - roundedRateShare(taxBase, rates.discountRatePpm)
  const discountedTax2Base = tax2Base - roundedRateShare(tax2Base, rates.discountRatePpm)
  const amount =
    subtotal -
    discount +
    roundedRateShare(discountedTaxBase, rates.taxRatePpm) +
    roundedRateShare(discountedTax2Base, rates.tax2RatePpm)
  if (amount < -9_000_000_000_000n || amount > 9_000_000_000_000n) {
    invalidInput('invoice edit would exceed the aggregate cents limit')
  }
  return Number(amount)
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidInput('command fingerprint input must be finite JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    return `{${entries.join(',')}}`
  }
  return invalidInput('command fingerprint input must be JSON')
}

const fingerprintCommand = async (
  input: CommandIdentity,
  commandKind: InvoiceCommandKind,
  semanticInput: Record<string, unknown>,
): Promise<string> => {
  const fingerprintInput = canonicalJson({
    invoice_id: input.invoiceId,
    command_kind: commandKind,
    actor: { type: input.actor.type, id: input.actor.id },
    input: semanticInput,
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprintInput))
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`
}

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: InvoiceStateDatabase,
  statement: SqlStatement,
): Promise<T | null> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (
      (await client
        .prepare(statement.text)
        .bind(...statement.params)
        .first<T>()) ?? null
    )
  }
  return (client.prepare(statement.text).get(...statement.params) as T | undefined) ?? null
}

const runAtomic = async (
  database: InvoiceStateDatabase,
  statements: readonly SqlStatement[],
): Promise<void> => {
  const client = database.$client
  if (isD1Client(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return
  }
  client.transaction(() => {
    for (const statement of statements) client.prepare(statement.text).run(...statement.params)
  })()
}

const ledgerStatement = (invoiceId: number, commandId: string): SqlStatement => ({
  text: `SELECT command_kind AS "commandKind", input_fingerprint AS "inputFingerprint",
      actor_type AS "actorType", actor_id AS "actorId",
      expected_invoice_version AS "expectedInvoiceVersion", occurred_at AS "occurredAt",
      completed, result_json AS "resultJson"
    FROM invoice_command_ledger WHERE invoice_id = ? AND command_id = ?`,
  params: [invoiceId, commandId],
})

const readLedger = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  commandId: string,
): Promise<StoredLedger | null> => first(database, ledgerStatement(invoiceId, commandId))

const readInvoice = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<StoredInvoiceSnapshot | null> =>
  first(database, {
    text: `SELECT invoice.id, invoice.currency, invoice.version, invoice.updated_at AS "updatedAt",
        invoice.state, invoice.close_reason AS "closeReason",
        invoice.close_write_off_cents AS "closeWriteOffCents",
        invoice.sent_at AS "sentAt", invoice.paid_at AS "paidAt",
        invoice.paid_date AS "paidDate", invoice.closed_at AS "closedAt",
        invoice.amount_cents AS "amountCents", invoice.due_amount_cents AS "dueAmountCents",
        invoice.tax_rate_ppm AS "taxRatePpm", invoice.tax2_rate_ppm AS "tax2RatePpm",
        invoice.discount_rate_ppm AS "discountRatePpm",
        invoice.written_off_cents AS "writtenOffCents",
        (SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id)
          AS "paymentCount"
      FROM invoices invoice WHERE invoice.id = ?`,
    params: [invoiceId],
  })

const readPayment = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  paymentId: number,
): Promise<StoredPayment | null> =>
  first(database, {
    text: `SELECT id, invoice_id AS "invoiceId", harvest_id AS "harvestId", currency,
        amount_cents AS "amountCents", paid_at AS "paidAt", paid_date AS "paidDate",
        notes, recorded_by_user_id AS "recordedByUserId", provider,
        provider_shape AS "providerShape", provider_account_id AS "providerAccountId",
        provider_transaction_id AS "providerTransactionId",
        bank_deposit_id AS "bankDepositId", updated_at AS "updatedAt"
      FROM invoice_payments WHERE id = ? AND invoice_id = ?`,
    params: [paymentId, invoiceId],
  })

const readBankDeposit = async (
  database: InvoiceStateDatabase,
  depositId: number,
): Promise<StoredBankDeposit | null> =>
  first(database, {
    text: `SELECT deposit.id, deposit.provider_account_id AS "providerAccountId",
        deposit.provider_transaction_id AS "providerTransactionId", deposit.currency,
        deposit.amount_cents AS "amountCents", deposit.match_state AS "matchState",
        deposit.suggested_invoice_id AS "suggestedInvoiceId",
        deposit.updated_at AS "updatedAt", account.provider,
        account.provider_shape AS "providerShape"
      FROM bank_deposits deposit
      JOIN payment_provider_accounts account ON account.id = deposit.provider_account_id
      WHERE deposit.id = ?`,
    params: [depositId],
  })

const readInvoiceDocument = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<StoredInvoiceDocument | null> =>
  first(database, {
    text: `SELECT client_id AS "clientId", number, subject,
        purchase_order AS "purchaseOrder", notes, currency,
        issue_date AS "issueDate", due_date AS "dueDate", payment_terms AS "paymentTerms",
        project_id AS "projectId", retainer_id AS "retainerId",
        reminder_policy AS "reminderPolicy",
        payment_options AS "paymentOptions"
      FROM invoices WHERE id = ?`,
    params: [invoiceId],
  })

const readInvoiceLine = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  lineId: number,
): Promise<StoredInvoiceLine | null> =>
  first(database, {
    text: `SELECT id, invoice_id AS "invoiceId", position, kind, description, quantity,
        unit_price_cents AS "unitPriceCents", amount_cents AS "amountCents", taxed, taxed2,
        project_id AS "projectId", updated_at AS "updatedAt"
      FROM invoice_line_items WHERE id = ? AND invoice_id = ?`,
    params: [lineId, invoiceId],
  })

const readFinancialBases = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<InvoiceFinancialBases | null> =>
  first(database, {
    text: `SELECT
        COALESCE(SUM(line.amount_cents), 0) AS "subtotalCents",
        COALESCE(SUM(CASE WHEN line.taxed = 1 THEN line.amount_cents ELSE 0 END), 0)
          AS "taxBaseCents",
        COALESCE(SUM(CASE WHEN line.taxed2 = 1 THEN line.amount_cents ELSE 0 END), 0)
          AS "tax2BaseCents",
        (SELECT COALESCE(SUM(payment.amount_cents), 0)
          FROM invoice_payments payment WHERE payment.invoice_id = invoice.id) AS "paymentCents"
      FROM invoices invoice
      LEFT JOIN invoice_line_items line ON line.invoice_id = invoice.id
      WHERE invoice.id = ? GROUP BY invoice.id`,
    params: [invoiceId],
  })

const parseResult = (
  ledger: StoredLedger,
  invoiceId: number,
  commandId: string,
): InvoiceCommandResult => {
  if (ledger.completed !== 1 || ledger.resultJson === null) {
    throw new InvoiceCommandOperationError(
      'command_incomplete',
      `invoice ${invoiceId} command ${commandId} is incomplete`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(ledger.resultJson)
  } catch {
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${invoiceId} command ${commandId} has an invalid stored result`,
    )
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schema_version' in value) ||
    value.schema_version !== 1
  ) {
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${invoiceId} command ${commandId} has an unsupported stored result`,
    )
  }
  return value as InvoiceCommandResult
}

const matchingRetryResult = (
  ledger: StoredLedger,
  input: CommandIdentity,
  commandKind: InvoiceCommandKind,
  expectedVersion: number | null,
  fingerprint: string,
): InvoiceCommandResult => {
  if (
    ledger.commandKind !== commandKind ||
    ledger.inputFingerprint !== fingerprint ||
    ledger.actorType !== input.actor.type ||
    ledger.actorId !== input.actor.id ||
    ledger.expectedInvoiceVersion !== expectedVersion
  ) {
    throw new InvoiceCommandReuseError(input.invoiceId, input.commandId)
  }
  return parseResult(ledger, input.invoiceId, input.commandId)
}

const eventInvoiceSnapshot = (
  invoice: InvoiceLifecycleSnapshot,
  amountCents: number,
): EventInvoiceSnapshot => ({
  version: invoice.version,
  updated_at: invoice.updatedAt,
  state: invoice.state,
  close_reason: invoice.closeReason,
  close_write_off_cents: invoice.closeWriteOffCents,
  sent_at: invoice.sentAt,
  paid_at: invoice.paidAt,
  paid_date: invoice.paidDate,
  closed_at: invoice.closedAt,
  amount_cents: amountCents,
  due_amount_cents: invoice.dueAmountCents,
  written_off_cents: invoice.writtenOffCents,
  payment_count: invoice.paymentCount,
  payment_status: deriveInvoicePaymentStatus(invoice),
})

const eventPaymentSnapshot = (
  payment: Pick<
    StoredPayment,
    'id' | 'amountCents' | 'currency' | 'provider' | 'providerShape' | 'paidAt' | 'paidDate'
  >,
): EventPaymentSnapshot => ({
  id: payment.id,
  amount_cents: payment.amountCents,
  currency: payment.currency,
  provider: payment.provider,
  shape: payment.providerShape,
  paid_at: payment.paidAt,
  paid_date: payment.paidDate,
})

const eventPayload = (
  input: CommandIdentity,
  eventId: string,
  commandKind: InvoiceCommandKind,
  eventType: InvoiceEventType,
  eventIndex: number,
  trigger: {
    type:
      | 'invoice_message'
      | 'invoice_payment'
      | 'invoice_line_item'
      | 'invoice_header'
      | 'invoice_financials'
    id: number
  },
  before: EventInvoiceSnapshot,
  after: EventInvoiceSnapshot,
  payment: { before: EventPaymentSnapshot | null; after: EventPaymentSnapshot | null },
): string =>
  JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    occurred_at: input.occurredAt,
    aggregate: { type: 'invoice', id: input.invoiceId, sequence: 0 },
    command: { id: input.commandId, kind: commandKind, event_index: eventIndex },
    actor: input.actor,
    trigger,
    invoice: { before, after },
    payment,
  })

const outboxStatement = (
  input: CommandIdentity,
  eventId: string,
  commandKind: InvoiceCommandKind,
  eventType: InvoiceEventType,
  eventIndex: number,
  payloadJson: string,
): SqlStatement => ({
  text: `INSERT INTO event_outbox (
      id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
      command_id, event_index, payload_json, occurred_at, available_at
    )
    SELECT ?, 'invoice', ?, next_sequence, ?, ?, ?,
      json_set(?, '$.aggregate.sequence', next_sequence), ?, ?
    FROM (
      SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
      FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?
    )
    WHERE changes() = 1 AND EXISTS (
      SELECT 1 FROM invoice_command_ledger
      WHERE invoice_id = ? AND command_id = ? AND completed = 0
    )`,
  params: [
    eventId,
    input.invoiceId,
    eventType,
    input.commandId,
    eventIndex,
    payloadJson,
    input.occurredAt,
    input.occurredAt,
    input.invoiceId,
    input.invoiceId,
    input.commandId,
  ],
})

const viewOutboxStatement = (input: ExecuteInvoiceLifecycleCommand): SqlStatement => ({
  text: `INSERT INTO event_outbox (
      id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
      command_id, event_index, payload_json, occurred_at, available_at
    )
    SELECT ?, 'invoice', invoice.id, sequence.next_sequence, 'invoice.viewed', ?, 0,
      json_object(
        'schema_version', 1,
        'event_id', ?,
        'event_type', 'invoice.viewed',
        'occurred_at', ?,
        'aggregate', json_object(
          'type', 'invoice', 'id', invoice.id, 'sequence', sequence.next_sequence
        ),
        'command', json_object('id', ?, 'kind', 'invoice.view', 'event_index', 0),
        'actor', json_object('type', ?, 'id', ?),
        'trigger', json_object('type', 'invoice_message', 'id', ?),
        'invoice', json_object(
          'before', json_object(
            'version', invoice.version, 'updated_at', invoice.updated_at,
            'state', invoice.state, 'close_reason', invoice.close_reason,
            'close_write_off_cents', invoice.close_write_off_cents,
            'sent_at', invoice.sent_at, 'paid_at', invoice.paid_at,
            'paid_date', invoice.paid_date, 'closed_at', invoice.closed_at,
            'amount_cents', invoice.amount_cents, 'due_amount_cents', invoice.due_amount_cents,
            'written_off_cents', invoice.written_off_cents,
            'payment_count', (
              SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
            ),
            'payment_status', CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
              ) THEN 'unpaid'
              WHEN invoice.due_amount_cents <= 0 THEN 'paid'
              ELSE 'partial'
            END
          ),
          'after', json_object(
            'version', invoice.version, 'updated_at', invoice.updated_at,
            'state', invoice.state, 'close_reason', invoice.close_reason,
            'close_write_off_cents', invoice.close_write_off_cents,
            'sent_at', invoice.sent_at, 'paid_at', invoice.paid_at,
            'paid_date', invoice.paid_date, 'closed_at', invoice.closed_at,
            'amount_cents', invoice.amount_cents, 'due_amount_cents', invoice.due_amount_cents,
            'written_off_cents', invoice.written_off_cents,
            'payment_count', (
              SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
            ),
            'payment_status', CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
              ) THEN 'unpaid'
              WHEN invoice.due_amount_cents <= 0 THEN 'paid'
              ELSE 'partial'
            END
          )
        ),
        'payment', json_object('before', NULL, 'after', NULL)
      ), ?, ?
    FROM invoices invoice
    CROSS JOIN (
      SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
      FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?
    ) sequence
    WHERE invoice.id = ? AND invoice.state IN ('open','paid','closed')
      AND changes() = 1 AND EXISTS (
        SELECT 1 FROM invoice_command_ledger
        WHERE invoice_id = invoice.id AND command_id = ? AND completed = 0
          AND command_kind = 'invoice.view'
      )`,
  params: [
    input.eventId,
    input.commandId,
    input.eventId,
    input.occurredAt,
    input.commandId,
    input.actor.type,
    input.actor.id,
    input.messageId,
    input.occurredAt,
    input.occurredAt,
    input.invoiceId,
    input.invoiceId,
    input.commandId,
  ],
})

const completionStatement = (input: CommandIdentity, expectedEventCount: number): SqlStatement => ({
  text: `UPDATE invoice_command_ledger
    SET event_count = CASE WHEN ? = (
        SELECT count(*) FROM event_outbox
        WHERE aggregate_type = 'invoice' AND aggregate_id = ? AND command_id = ?
      ) THEN ? ELSE 0 END,
      first_aggregate_sequence = (
        SELECT min(aggregate_sequence) FROM event_outbox
        WHERE aggregate_type = 'invoice' AND aggregate_id = ? AND command_id = ?
      ),
      result_json = (
        SELECT json_object(
          'schema_version', 1,
          'event_ids', json(COALESCE((
            SELECT json_group_array(id) FROM (
              SELECT id FROM event_outbox
              WHERE aggregate_type = 'invoice' AND aggregate_id = ? AND command_id = ?
              ORDER BY event_index
            )
          ), '[]')),
          'first_aggregate_sequence', (
            SELECT min(aggregate_sequence) FROM event_outbox
            WHERE aggregate_type = 'invoice' AND aggregate_id = ? AND command_id = ?
          ),
          'event_count', (
            SELECT count(*) FROM event_outbox
            WHERE aggregate_type = 'invoice' AND aggregate_id = ? AND command_id = ?
          ),
          'invoice', json_object(
            'id', invoice.id, 'version', invoice.version, 'updated_at', invoice.updated_at,
            'state', invoice.state, 'close_reason', invoice.close_reason,
            'close_write_off_cents', invoice.close_write_off_cents,
            'sent_at', invoice.sent_at, 'paid_at', invoice.paid_at,
            'paid_date', invoice.paid_date, 'closed_at', invoice.closed_at,
            'amount_cents', invoice.amount_cents, 'due_amount_cents', invoice.due_amount_cents,
            'written_off_cents', invoice.written_off_cents,
            'payment_count', (
              SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
            ),
            'payment_status', CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
              ) THEN 'unpaid'
              WHEN invoice.due_amount_cents <= 0 THEN 'paid'
              ELSE 'partial'
            END
          )
        ) FROM invoices invoice WHERE invoice.id = ?
      ),
      completed_at = occurred_at,
      completed = 1
    WHERE invoice_id = ? AND command_id = ? AND completed = 0`,
  params: [
    expectedEventCount,
    input.invoiceId,
    input.commandId,
    expectedEventCount,
    input.invoiceId,
    input.commandId,
    input.invoiceId,
    input.commandId,
    input.invoiceId,
    input.commandId,
    input.invoiceId,
    input.commandId,
    input.invoiceId,
    input.invoiceId,
    input.commandId,
  ],
})

const pendingLedgerInsert = (
  input: CommandIdentity,
  commandKind: InvoiceCommandKind,
  expectedVersion: number | null,
  fingerprint: string,
): SqlStatement => ({
  text: `INSERT INTO invoice_command_ledger (
      invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
      expected_invoice_version, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [
    input.invoiceId,
    input.commandId,
    commandKind,
    fingerprint,
    input.actor.type,
    input.actor.id,
    expectedVersion,
    input.occurredAt,
  ],
})

const invoiceStateUpdate = (
  input: CommandIdentity,
  expectedVersion: number,
  after: InvoiceLifecycleSnapshot,
  requirePriorMutation: boolean,
): SqlStatement => ({
  text: `UPDATE invoices SET state = ?, close_reason = ?, close_write_off_cents = ?,
      written_off_cents = ?, sent_at = ?, paid_at = ?, paid_date = ?, closed_at = ?,
      version = ?, updated_at = ?
    WHERE id = ? AND version = ?
      ${requirePriorMutation ? 'AND changes() = 1' : ''}
      AND EXISTS (
        SELECT 1 FROM invoice_command_ledger
        WHERE invoice_id = ? AND command_id = ? AND completed = 0
      )`,
  params: [
    after.state,
    after.closeReason,
    after.closeWriteOffCents,
    after.writtenOffCents,
    after.sentAt,
    after.paidAt,
    after.paidDate,
    after.closedAt,
    after.version,
    after.updatedAt,
    input.invoiceId,
    expectedVersion,
    input.invoiceId,
    input.commandId,
  ],
})

const appendEvents = (
  statements: SqlStatement[],
  input: InvoiceMutationCommand,
  commandKind: InvoiceCommandKind,
  trigger: {
    type: 'invoice_payment' | 'invoice_line_item' | 'invoice_header' | 'invoice_financials'
    id: number
  },
  before: EventInvoiceSnapshot,
  after: EventInvoiceSnapshot,
  events: readonly InvoiceEventType[],
  payment: { before: EventPaymentSnapshot | null; after: EventPaymentSnapshot | null },
): void => {
  if (input.eventIds.length < events.length) {
    invalidInput(`the command requires at least ${events.length} candidate event id(s)`)
  }
  events.forEach((eventType, eventIndex) => {
    const eventId = input.eventIds[eventIndex] ?? invalidInput('an event id is missing')
    statements.push(
      outboxStatement(
        input,
        eventId,
        commandKind,
        eventType,
        eventIndex,
        eventPayload(
          input,
          eventId,
          commandKind,
          eventType,
          eventIndex,
          trigger,
          before,
          after,
          payment,
        ),
      ),
    )
  })
  statements.push(completionStatement(input, events.length))
}

const mutationStatements = (
  input: ExecuteInvoiceLifecycleCommand,
  commandKind: InvoiceCommandKind,
  expectedVersion: number | null,
  fingerprint: string,
  before: StoredInvoiceSnapshot,
  after: InvoiceLifecycleSnapshot,
  events: readonly InvoiceEventType[],
): SqlStatement[] => {
  const message = input.message ?? {
    sentBy: null,
    sentByEmail: null,
    sentFrom: null,
    sentFromEmail: null,
    recipients: [],
    subject: null,
    body: null,
    attachPdf: false,
    sendMeACopy: false,
    thankYou: false,
    reminder: false,
    sendReminderOn: null,
  }
  const statements: SqlStatement[] = [
    {
      text: `INSERT INTO invoice_command_ledger (
          invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
          expected_invoice_version, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.invoiceId,
        input.commandId,
        commandKind,
        fingerprint,
        input.actor.type,
        input.actor.id,
        expectedVersion,
        input.occurredAt,
      ],
    },
    {
      text: `INSERT INTO invoice_messages (
          id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
          recipients, subject, body, attach_pdf, send_me_a_copy, thank_you,
          reminder, send_reminder_on, event_type, created_at, updated_at
        )
        SELECT ?, invoice.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM invoices invoice
        WHERE invoice.id = ?
          AND (? <> 'invoice.view' OR invoice.state IN ('open','paid','closed'))
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = invoice.id AND command_id = ? AND completed = 0
              AND command_kind = ?
          )`,
      params: [
        input.messageId,
        message.sentBy,
        message.sentByEmail,
        message.sentFrom,
        message.sentFromEmail,
        JSON.stringify(message.recipients),
        message.subject,
        message.body,
        message.attachPdf ? 1 : 0,
        message.sendMeACopy ? 1 : 0,
        message.thankYou ? 1 : 0,
        message.reminder ? 1 : 0,
        message.sendReminderOn,
        messageEventTypes[input.command],
        input.occurredAt,
        input.occurredAt,
        input.invoiceId,
        commandKind,
        input.commandId,
        commandKind,
      ],
    },
  ]

  if (expectedVersion !== null) {
    statements.push({
      text: `UPDATE invoices SET state = ?, close_reason = ?, close_write_off_cents = ?,
          written_off_cents = ?, sent_at = ?, paid_at = ?, paid_date = ?, closed_at = ?,
          version = ?, updated_at = ?
        WHERE id = ? AND version = ? AND EXISTS (
          SELECT 1 FROM invoice_command_ledger
          WHERE invoice_id = ? AND command_id = ? AND completed = 0
        )`,
      params: [
        after.state,
        after.closeReason,
        after.closeWriteOffCents,
        after.writtenOffCents,
        after.sentAt,
        after.paidAt,
        after.paidDate,
        after.closedAt,
        after.version,
        after.updatedAt,
        input.invoiceId,
        expectedVersion,
        input.invoiceId,
        input.commandId,
      ],
    })
  }

  if (expectedVersion === null) {
    statements.push(viewOutboxStatement(input))
  } else {
    const beforePayload = eventInvoiceSnapshot(before, before.amountCents)
    const afterPayload = eventInvoiceSnapshot(after, before.amountCents)
    events.forEach((eventType, eventIndex) => {
      statements.push(
        outboxStatement(
          input,
          input.eventId,
          commandKind,
          eventType,
          eventIndex,
          eventPayload(
            input,
            input.eventId,
            commandKind,
            eventType,
            eventIndex,
            { type: 'invoice_message', id: input.messageId },
            beforePayload,
            afterPayload,
            { before: null, after: null },
          ),
        ),
      )
    })
  }
  if (input.delivery !== undefined) {
    const delivery = input.delivery
    statements.push({
      text: `INSERT INTO invoice_email_intents (
          invoice_message_id, event_id, template_kind, template_version,
          sender_identity_id, sender_identity_version, sender_evidence_version,
          from_name, from_email, reply_to_email, subject, text_body, html_body,
          confirmed_by_user_id, confirmed_at
        )
        SELECT message.id, ?, 'invoice', ?, identity.id, identity.version, evidence.evidence_version,
          ?, ?, ?, ?, ?, ?, ?, ?
        FROM invoice_messages message
        JOIN sender_identities identity ON identity.id = ?
        JOIN sender_identity_evidence evidence
          ON evidence.sender_identity_id = identity.id AND evidence.evidence_version = ?
        JOIN email_template_versions template
          ON template.template_kind = 'invoice' AND template.version = ?
        WHERE message.id = ? AND message.invoice_id = ? AND message.event_type = 'send'
          AND identity.version = ? AND identity.archived_at IS NULL
          AND (
            (
              identity.provider IN ('smtp','mailgun')
              AND evidence.source = 'deployment_config'
              AND evidence.verification_status = 'operator_configured'
              AND evidence.identity_kind = 'email_address'
              AND evidence.dkim_status = 'not_applicable'
              AND evidence.mail_from_domain IS NULL
              AND evidence.mail_from_status = 'not_configured'
              AND lower(trim(identity.provider_identity)) = identity.email
            )
            OR (
              identity.provider = 'ses'
              AND evidence.source = 'provider_api'
              AND evidence.verification_status = 'verified'
              AND (
                (
                  evidence.identity_kind = 'email_address'
                  AND lower(trim(identity.provider_identity)) = identity.email
                )
                OR (
                  evidence.identity_kind = 'domain'
                  AND lower(trim(identity.provider_identity)) =
                    substr(identity.email, instr(identity.email, '@') + 1)
                )
              )
              AND (
                evidence.dkim_status = 'verified'
                OR (
                  evidence.mail_from_status = 'verified'
                  AND (
                    evidence.mail_from_domain =
                      substr(identity.email, instr(identity.email, '@') + 1)
                    OR evidence.mail_from_domain LIKE
                      '%.' || substr(identity.email, instr(identity.email, '@') + 1)
                  )
                )
              )
            )
          )`,
      params: [
        input.eventId,
        delivery.templateVersion,
        delivery.fromName,
        delivery.fromEmail,
        delivery.replyToEmail,
        delivery.subject,
        delivery.textBody,
        delivery.htmlBody,
        input.actor.id,
        input.occurredAt,
        delivery.senderIdentityId,
        delivery.senderEvidenceVersion,
        delivery.templateVersion,
        input.messageId,
        input.invoiceId,
        delivery.senderIdentityVersion,
      ],
    })
    delivery.recipients.forEach((recipient, recipientIndex) => {
      const toJson = JSON.stringify([
        recipient.name === ''
          ? { email: recipient.email }
          : { email: recipient.email, name: recipient.name },
      ])
      statements.push(
        {
          text: `INSERT INTO email_log (
              id, from_json, reply_to_json, to_json, template, subject,
              related_type, related_id, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'invoice_message', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM invoice_email_intents WHERE invoice_message_id = ?
            )`,
          params: [
            recipient.deliveryId,
            JSON.stringify({ email: delivery.fromEmail, name: delivery.fromName }),
            delivery.replyToEmail === null
              ? null
              : JSON.stringify([{ email: delivery.replyToEmail }]),
            toJson,
            `invoice:${delivery.templateVersion}`,
            delivery.subject,
            input.messageId,
            input.occurredAt,
            input.occurredAt,
            input.messageId,
          ],
        },
        {
          text: `INSERT INTO invoice_email_recipients (
              invoice_message_id, recipient_index, delivery_id, name, email, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            input.messageId,
            recipientIndex,
            recipient.deliveryId,
            recipient.name,
            recipient.email,
            input.occurredAt,
          ],
        },
      )
    })
  }
  statements.push(completionStatement(input, events.length))
  return statements
}

const actualVersion = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<number | null> => {
  const row = await first<{ version: number }>(database, {
    text: 'SELECT version FROM invoices WHERE id = ?',
    params: [invoiceId],
  })
  return row?.version ?? null
}

/**
 * Persists one D22 lifecycle command, trigger row, invoice transition, and outbox
 * event as a single local transaction or predetermined D1 batch.
 */
export const executeInvoiceLifecycleCommand = async (
  database: InvoiceStateDatabase,
  input: ExecuteInvoiceLifecycleCommand,
): Promise<InvoiceCommandResult> => {
  const expectedVersion = validateInput(input)
  await assertAuthorized(input)
  const commandKind = commandKinds[input.command]
  const fingerprint = await fingerprintCommand(input, commandKind, {
    message_id: input.messageId,
    ...(input.message === undefined
      ? {}
      : {
          message: {
            // Sender fields are server-derived immutable enrichment, not
            // caller causation. Excluding them keeps the same HTTP command a
            // valid retry after the acting user's name or email changes; the
            // first successful command still persists the complete snapshot.
            recipients: input.message.recipients,
            subject: input.message.subject,
            body: input.message.body,
            attach_pdf: input.message.attachPdf,
            send_me_a_copy: input.message.sendMeACopy,
            thank_you: input.message.thankYou,
            reminder: input.message.reminder,
            send_reminder_on: input.message.sendReminderOn,
          },
        }),
    ...(expectedVersion === null ? {} : { expected_version: expectedVersion }),
    ...(input.delivery === undefined
      ? {}
      : {
          delivery: {
            template_version: input.delivery.templateVersion,
            sender_identity_id: input.delivery.senderIdentityId,
            sender_identity_version: input.delivery.senderIdentityVersion,
            sender_evidence_version: input.delivery.senderEvidenceVersion,
            recipients: input.delivery.recipients.map(({ name, email }) => ({ name, email })),
          },
        }),
  })

  const existing = await readLedger(database, input.invoiceId, input.commandId)
  if (existing !== null) {
    await assertAuthorized(input)
    return matchingRetryResult(existing, input, commandKind, expectedVersion, fingerprint)
  }

  const before = await readInvoice(database, input.invoiceId)
  if (before === null) {
    throw new InvoiceCommandOperationError(
      'invoice_not_found',
      `invoice ${input.invoiceId} does not exist`,
    )
  }
  if (expectedVersion !== null && before.version !== expectedVersion) {
    throw new InvoiceVersionConflictError(input.invoiceId, expectedVersion, before.version)
  }

  const reduction = reduceInvoiceCommand(before, {
    command: input.command,
    actorType: input.actor.type,
    occurredAt: input.occurredAt,
  })
  const statements = mutationStatements(
    input,
    commandKind,
    expectedVersion,
    fingerprint,
    before,
    reduction.invoice,
    reduction.events,
  )

  try {
    await runAtomic(database, statements)
  } catch {
    const completed = await readLedger(database, input.invoiceId, input.commandId)
    if (completed !== null) {
      await assertAuthorized(input)
      return matchingRetryResult(completed, input, commandKind, expectedVersion, fingerprint)
    }
    if (expectedVersion !== null) {
      const version = await actualVersion(database, input.invoiceId)
      if (version !== expectedVersion) {
        throw new InvoiceVersionConflictError(input.invoiceId, expectedVersion, version)
      }
    } else {
      const current = await readInvoice(database, input.invoiceId)
      if (current === null) {
        throw new InvoiceCommandOperationError(
          'invoice_not_found',
          `invoice ${input.invoiceId} does not exist`,
        )
      }
      reduceInvoiceCommand(current, {
        command: input.command,
        actorType: input.actor.type,
        occurredAt: input.occurredAt,
      })
    }
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} could not commit`,
    )
  }

  const completed = await readLedger(database, input.invoiceId, input.commandId)
  if (completed === null) {
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} committed without a ledger result`,
    )
  }
  await assertAuthorized(input)
  return matchingRetryResult(completed, input, commandKind, expectedVersion, fingerprint)
}

const paymentCommandKind: Record<InvoicePaymentMutationKind, InvoiceCommandKind> = {
  record: 'payment.record',
  update: 'payment.update',
  delete: 'payment.delete',
}

const committedResult = async (
  database: InvoiceStateDatabase,
  input: CommandIdentity,
  commandKind: InvoiceCommandKind,
  expectedVersion: number,
  fingerprint: string,
): Promise<InvoiceCommandResult> => {
  const completed = await readLedger(database, input.invoiceId, input.commandId)
  if (completed === null) {
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} committed without a ledger result`,
    )
  }
  return matchingRetryResult(completed, input, commandKind, expectedVersion, fingerprint)
}

/** Records a native manual payment or confirms one bank deposit in the D22 batch. */
export const recordInvoicePayment = async (
  database: InvoiceStateDatabase,
  input: RecordInvoicePaymentCommand,
): Promise<InvoiceCommandResult> => {
  validateMutationCommand(input)
  await assertAuthorized(input)
  assertPositiveSafeInteger(input.payment.id, 'payment.id')
  const commandKind = paymentCommandKind.record
  const semanticPayment =
    input.payment.type === 'manual'
      ? {
          type: 'manual',
          id: input.payment.id,
          currency: input.payment.currency,
          amount_cents: input.payment.amountCents,
          paid_at: input.payment.paidAt,
          paid_date: input.payment.paidDate,
          notes: input.payment.notes,
          recorded_by_user_id: input.payment.recordedByUserId,
        }
      : input.payment.type === 'checkout'
      ? {
          type: 'checkout',
          id: input.payment.id,
          currency: input.payment.currency,
          amount_cents: input.payment.amountCents,
          paid_at: input.payment.paidAt,
          paid_date: input.payment.paidDate,
          provider: input.payment.provider,
          provider_account_id: input.payment.providerAccountId,
          provider_transaction_id: input.payment.providerTransactionId,
          notes: input.payment.notes,
        }
      : {
          type: 'bank_deposit',
          id: input.payment.id,
          deposit_id: input.payment.depositId,
          expected_deposit_updated_at: input.payment.expectedDepositUpdatedAt,
          expected_match_state: input.payment.expectedMatchState,
          paid_at: input.payment.paidAt,
          notes: input.payment.notes,
          recorded_by_user_id: input.payment.recordedByUserId,
        }
  const fingerprint = await fingerprintCommand(input, commandKind, {
    expected_version: input.expectedVersion,
    payment: semanticPayment,
  })
  const existing = await readLedger(database, input.invoiceId, input.commandId)
  if (existing !== null) {
    await assertAuthorized(input)
    return matchingRetryResult(existing, input, commandKind, input.expectedVersion, fingerprint)
  }
  let payment: StoredPayment
  let paymentInsert: SqlStatement

  if (input.payment.type === 'manual') {
    assertCents(input.payment.amountCents, 'payment.amountCents', true)
    assertPaymentTimestamp(input.payment)
    if (!/^[A-Z]{3}$/.test(input.payment.currency)) {
      invalidInput('payment.currency must be a three-letter uppercase code')
    }
    payment = {
      id: input.payment.id,
      invoiceId: input.invoiceId,
      harvestId: null,
      currency: input.payment.currency,
      amountCents: input.payment.amountCents,
      paidAt: input.payment.paidAt,
      paidDate: input.payment.paidDate,
      notes: input.payment.notes ?? null,
      recordedByUserId: input.payment.recordedByUserId ?? null,
      provider: 'manual',
      providerShape: 'manual',
      providerAccountId: null,
      providerTransactionId: null,
      bankDepositId: null,
      updatedAt: input.occurredAt,
    }
    paymentInsert = {
      text: `INSERT INTO invoice_payments (
          id, invoice_id, currency, amount_cents, paid_at, paid_date, notes,
          recorded_by_user_id, provider, provider_shape, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM invoice_command_ledger
          WHERE invoice_id = ? AND command_id = ? AND completed = 0
        )`,
      params: [
        payment.id,
        input.invoiceId,
        payment.currency,
        payment.amountCents,
        payment.paidAt,
        payment.paidDate,
        payment.notes,
        payment.recordedByUserId,
        input.occurredAt,
        input.occurredAt,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else if (input.payment.type === 'checkout') {
    assertCents(input.payment.amountCents, 'payment.amountCents', true)
    assertPaymentTimestamp(input.payment)
    if (!/^[A-Z]{3}$/.test(input.payment.currency)) {
      invalidInput('payment.currency must be a three-letter uppercase code')
    }
    assertPositiveSafeInteger(input.payment.providerAccountId, 'payment.providerAccountId')
    // The schema requires both for any provider that is not `manual`, and a
    // receipt without the provider's own id is one no reconciliation can
    // recognise again -- which is how the same payment is recorded twice.
    //
    // There is deliberately no duplicate check in the statement below.
    // `invoice_payments_provider_transaction_unique` already makes a second
    // receipt for one provider payment impossible, and it holds against a
    // concurrent writer where a NOT EXISTS of our own only looks like it does.
    // A first draft had one; a mutation that deleted it changed nothing
    // observable, which is what an unreachable guard looks like.
    if (input.payment.providerTransactionId.trim() === '') {
      invalidInput('payment.providerTransactionId is required for a checkout payment')
    }
    payment = {
      id: input.payment.id,
      invoiceId: input.invoiceId,
      harvestId: null,
      currency: input.payment.currency,
      amountCents: input.payment.amountCents,
      paidAt: input.payment.paidAt,
      paidDate: input.payment.paidDate,
      notes: input.payment.notes ?? null,
      // Nobody recorded it. A provider took the money and a reconciliation
      // noticed, so naming a user here would attribute it to somebody who was
      // not involved.
      recordedByUserId: null,
      provider: input.payment.provider,
      providerShape: 'checkout',
      providerAccountId: input.payment.providerAccountId,
      providerTransactionId: input.payment.providerTransactionId,
      bankDepositId: null,
      updatedAt: input.occurredAt,
    }
    paymentInsert = {
      text: `INSERT INTO invoice_payments (
          id, invoice_id, currency, amount_cents, paid_at, paid_date, notes,
          recorded_by_user_id, provider, provider_shape, provider_account_id,
          provider_transaction_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, NULL, account.provider, 'checkout',
          account.id, ?, ?, ?
        FROM payment_provider_accounts account
        WHERE account.id = ? AND account.provider = ? AND account.provider_shape = 'checkout'
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
      params: [
        payment.id,
        input.invoiceId,
        payment.currency,
        payment.amountCents,
        payment.paidAt,
        payment.paidDate,
        payment.notes,
        payment.providerTransactionId,
        input.occurredAt,
        input.occurredAt,
        input.payment.providerAccountId,
        input.payment.provider,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else {
    assertPositiveSafeInteger(input.payment.depositId, 'payment.depositId')
    assertCanonicalTimestamp(input.payment.expectedDepositUpdatedAt, 'expectedDepositUpdatedAt')
    assertCanonicalTimestamp(input.payment.paidAt, 'payment.paidAt')
    const deposit = await readBankDeposit(database, input.payment.depositId)
    if (
      deposit === null ||
      deposit.updatedAt !== input.payment.expectedDepositUpdatedAt ||
      deposit.matchState !== input.payment.expectedMatchState
    ) {
      throw new InvoiceTriggerRowConflictError('bank_deposit', input.payment.depositId)
    }
    payment = {
      id: input.payment.id,
      invoiceId: input.invoiceId,
      harvestId: null,
      currency: deposit.currency,
      amountCents: deposit.amountCents,
      paidAt: input.payment.paidAt,
      paidDate: null,
      notes: input.payment.notes ?? null,
      recordedByUserId: input.payment.recordedByUserId ?? null,
      provider: deposit.provider,
      providerShape: deposit.providerShape,
      providerAccountId: deposit.providerAccountId,
      providerTransactionId: deposit.providerTransactionId,
      bankDepositId: deposit.id,
      updatedAt: input.occurredAt,
    }
    paymentInsert = {
      text: `INSERT INTO invoice_payments (
          id, invoice_id, currency, amount_cents, paid_at, paid_date, notes,
          recorded_by_user_id, provider, provider_shape, provider_account_id,
          provider_transaction_id, bank_deposit_id, created_at, updated_at
        )
        SELECT ?, invoice.id, deposit.currency, deposit.amount_cents, ?, NULL, ?, ?,
          account.provider, account.provider_shape, account.id,
          deposit.provider_transaction_id, deposit.id, ?, ?
        FROM bank_deposits deposit
        JOIN payment_provider_accounts account ON account.id = deposit.provider_account_id
        JOIN invoices invoice ON invoice.id = ?
        WHERE deposit.id = ? AND deposit.updated_at = ? AND deposit.match_state = ?
          AND deposit.match_state IN ('unmatched','suggested')
          AND (deposit.suggested_invoice_id IS NULL OR deposit.suggested_invoice_id = invoice.id)
          AND deposit.currency = invoice.currency AND account.provider <> 'bill_com'
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = invoice.id AND command_id = ? AND completed = 0
          )`,
      params: [
        payment.id,
        payment.paidAt,
        payment.notes,
        payment.recordedByUserId,
        input.occurredAt,
        input.occurredAt,
        input.invoiceId,
        deposit.id,
        input.payment.expectedDepositUpdatedAt,
        input.payment.expectedMatchState,
        input.commandId,
      ],
    }
  }

  const before = await readInvoice(database, input.invoiceId)
  if (before === null) {
    throw new InvoiceCommandOperationError(
      'invoice_not_found',
      `invoice ${input.invoiceId} does not exist`,
    )
  }

  if (before.version !== input.expectedVersion) {
    throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, before.version)
  }
  if (payment.currency !== before.currency) invalidInput('payment currency must match invoice')

  const reduction = reduceInvoicePaymentMutation(before, {
    kind: 'record',
    occurredAt: input.occurredAt,
    afterDueAmountCents: before.dueAmountCents - payment.amountCents,
    afterPaymentCount: before.paymentCount + 1,
    paymentTimestamp: { paidAt: payment.paidAt, paidDate: payment.paidDate },
  })
  const statements = [
    pendingLedgerInsert(input, commandKind, input.expectedVersion, fingerprint),
    paymentInsert,
    invoiceStateUpdate(input, input.expectedVersion, reduction.invoice, true),
  ]
  appendEvents(
    statements,
    input,
    commandKind,
    { type: 'invoice_payment', id: payment.id },
    eventInvoiceSnapshot(before, before.amountCents),
    eventInvoiceSnapshot(reduction.invoice, before.amountCents),
    reduction.events,
    { before: null, after: eventPaymentSnapshot(payment) },
  )

  try {
    await runAtomic(database, statements)
  } catch {
    const completed = await readLedger(database, input.invoiceId, input.commandId)
    if (completed !== null) {
      await assertAuthorized(input)
      return matchingRetryResult(completed, input, commandKind, input.expectedVersion, fingerprint)
    }
    const version = await actualVersion(database, input.invoiceId)
    if (version !== input.expectedVersion) {
      throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, version)
    }
    if (input.payment.type === 'bank_deposit') {
      const deposit = await readBankDeposit(database, input.payment.depositId)
      if (
        deposit === null ||
        deposit.updatedAt !== input.payment.expectedDepositUpdatedAt ||
        deposit.matchState !== input.payment.expectedMatchState
      ) {
        throw new InvoiceTriggerRowConflictError('bank_deposit', input.payment.depositId)
      }
    }
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} could not commit`,
    )
  }
  await assertAuthorized(input)
  return committedResult(database, input, commandKind, input.expectedVersion, fingerprint)
}

const mutateExistingInvoicePayment = async (
  database: InvoiceStateDatabase,
  input: UpdateInvoicePaymentCommand | DeleteInvoicePaymentCommand,
  kind: 'update' | 'delete',
): Promise<InvoiceCommandResult> => {
  validateMutationCommand(input)
  await assertAuthorized(input)
  assertPositiveSafeInteger(input.paymentId, 'paymentId')
  assertCanonicalTimestamp(input.expectedPaymentUpdatedAt, 'expectedPaymentUpdatedAt')
  const commandKind = paymentCommandKind[kind]
  const isUpdate = kind === 'update'
  if (isUpdate) {
    const update = input as UpdateInvoicePaymentCommand
    assertCents(update.amountCents, 'amountCents', true)
    assertPaymentTimestamp(update)
  }
  const semanticInput = isUpdate
    ? {
        expected_version: input.expectedVersion,
        payment_id: input.paymentId,
        expected_payment_updated_at: input.expectedPaymentUpdatedAt,
        amount_cents: (input as UpdateInvoicePaymentCommand).amountCents,
        paid_at: (input as UpdateInvoicePaymentCommand).paidAt,
        paid_date: (input as UpdateInvoicePaymentCommand).paidDate,
        notes: (input as UpdateInvoicePaymentCommand).notes,
        recorded_by_user_id: (input as UpdateInvoicePaymentCommand).recordedByUserId,
      }
    : {
        expected_version: input.expectedVersion,
        payment_id: input.paymentId,
        expected_payment_updated_at: input.expectedPaymentUpdatedAt,
      }
  const fingerprint = await fingerprintCommand(input, commandKind, semanticInput)
  const existing = await readLedger(database, input.invoiceId, input.commandId)
  if (existing !== null) {
    await assertAuthorized(input)
    return matchingRetryResult(existing, input, commandKind, input.expectedVersion, fingerprint)
  }
  const [before, payment] = await Promise.all([
    readInvoice(database, input.invoiceId),
    readPayment(database, input.invoiceId, input.paymentId),
  ])
  if (before === null) {
    throw new InvoiceCommandOperationError(
      'invoice_not_found',
      `invoice ${input.invoiceId} does not exist`,
    )
  }
  if (before.version !== input.expectedVersion) {
    throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, before.version)
  }
  if (payment === null || payment.updatedAt !== input.expectedPaymentUpdatedAt) {
    throw new InvoiceTriggerRowConflictError('invoice_payment', input.paymentId)
  }
  if (kind === 'delete' && payment.harvestId !== null) {
    invalidInput('an imported payment can only be reconciled by the internal import operation')
  }

  let afterPayment: StoredPayment | null
  let triggerMutation: SqlStatement
  let afterDueAmountCents: number
  let paymentTimestamp: InvoicePaidTimestamp | null
  if (isUpdate) {
    if (
      payment.harvestId !== null ||
      payment.provider !== 'manual' ||
      payment.providerShape !== 'manual'
    ) {
      invalidInput('only a native manual payment can be updated')
    }
    const update = input as UpdateInvoicePaymentCommand
    afterPayment = {
      ...payment,
      amountCents: update.amountCents,
      paidAt: update.paidAt,
      paidDate: update.paidDate,
      notes: update.notes ?? null,
      recordedByUserId: update.recordedByUserId ?? null,
      updatedAt: input.occurredAt,
    }
    afterDueAmountCents = before.dueAmountCents + payment.amountCents - update.amountCents
    paymentTimestamp = { paidAt: update.paidAt, paidDate: update.paidDate }
    triggerMutation = {
      text: `UPDATE invoice_payments
        SET amount_cents = ?, paid_at = ?, paid_date = ?, notes = ?,
          recorded_by_user_id = ?, updated_at = ?
        WHERE id = ? AND invoice_id = ? AND updated_at = ? AND harvest_id IS NULL
          AND provider = 'manual' AND provider_shape = 'manual'
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
      params: [
        update.amountCents,
        update.paidAt,
        update.paidDate,
        update.notes ?? null,
        update.recordedByUserId ?? null,
        input.occurredAt,
        input.paymentId,
        input.invoiceId,
        input.expectedPaymentUpdatedAt,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else {
    afterPayment = null
    afterDueAmountCents = before.dueAmountCents + payment.amountCents
    paymentTimestamp = null
    triggerMutation = {
      text: `DELETE FROM invoice_payments
        WHERE id = ? AND invoice_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
      params: [
        input.paymentId,
        input.invoiceId,
        input.expectedPaymentUpdatedAt,
        input.invoiceId,
        input.commandId,
      ],
    }
  }

  const reduction = reduceInvoicePaymentMutation(before, {
    kind,
    occurredAt: input.occurredAt,
    afterDueAmountCents,
    afterPaymentCount: before.paymentCount + (kind === 'delete' ? -1 : 0),
    paymentTimestamp,
  })
  const statements = [
    pendingLedgerInsert(input, commandKind, input.expectedVersion, fingerprint),
    triggerMutation,
    invoiceStateUpdate(input, input.expectedVersion, reduction.invoice, true),
  ]
  appendEvents(
    statements,
    input,
    commandKind,
    { type: 'invoice_payment', id: payment.id },
    eventInvoiceSnapshot(before, before.amountCents),
    eventInvoiceSnapshot(reduction.invoice, before.amountCents),
    reduction.events,
    {
      before: eventPaymentSnapshot(payment),
      after: afterPayment === null ? null : eventPaymentSnapshot(afterPayment),
    },
  )

  try {
    await runAtomic(database, statements)
  } catch {
    const completed = await readLedger(database, input.invoiceId, input.commandId)
    if (completed !== null) {
      await assertAuthorized(input)
      return matchingRetryResult(completed, input, commandKind, input.expectedVersion, fingerprint)
    }
    const version = await actualVersion(database, input.invoiceId)
    if (version !== input.expectedVersion) {
      throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, version)
    }
    const current = await readPayment(database, input.invoiceId, input.paymentId)
    if (current === null || current.updatedAt !== input.expectedPaymentUpdatedAt) {
      throw new InvoiceTriggerRowConflictError('invoice_payment', input.paymentId)
    }
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} could not commit`,
    )
  }
  await assertAuthorized(input)
  return committedResult(database, input, commandKind, input.expectedVersion, fingerprint)
}

export const updateInvoicePayment = (
  database: InvoiceStateDatabase,
  input: UpdateInvoicePaymentCommand,
): Promise<InvoiceCommandResult> => mutateExistingInvoicePayment(database, input, 'update')

export const deleteInvoicePayment = (
  database: InvoiceStateDatabase,
  input: DeleteInvoicePaymentCommand,
): Promise<InvoiceCommandResult> => mutateExistingInvoicePayment(database, input, 'delete')

const enabledPaymentOptions = new Set<InvoicePaymentOption>([
  'stripe_checkout',
  'paypal_checkout',
  'quickbooks_checkout',
  'mercury_transfer',
  'wise_transfer',
])

const assertCanonicalDate = (value: string, field: string): void => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    invalidInput(`${field} must be a real canonical date`)
  }
}

const assertReminderPolicy: (value: unknown) => asserts value is InvoiceReminderPolicy = (
  value,
) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidInput('reminderPolicy must contain first_after_days and every_days')
  }
  const policy = value as Record<string, unknown>
  if (
    Object.keys(policy).sort().join(',') !== 'every_days,first_after_days' ||
    !Number.isSafeInteger(policy.first_after_days) ||
    (policy.first_after_days as number) < 0 ||
    !Number.isSafeInteger(policy.every_days) ||
    (policy.every_days as number) <= 0
  ) {
    invalidInput(
      'reminderPolicy requires non-negative integer first_after_days and positive integer every_days',
    )
  }
}

const editCommandKind = (edit: InvoiceEdit): InvoiceCommandKind => {
  switch (edit.type) {
    case 'line_insert':
      return 'invoice.line_insert'
    case 'line_update':
      return 'invoice.line_update'
    case 'line_delete':
      return 'invoice.line_delete'
    case 'financials':
      return 'invoice.financials_update'
    case 'header':
    case 'payment_options':
      return 'invoice.update'
  }
}

/** Applies one existing-invoice document, option, line, or financial edit with D22 events. */
export const executeInvoiceEdit = async (
  database: InvoiceStateDatabase,
  input: ExecuteInvoiceEditCommand,
): Promise<InvoiceCommandResult> => {
  validateMutationCommand(input)
  await assertAuthorized(input)
  const commandKind = editCommandKind(input.edit)
  const fingerprint = await fingerprintCommand(input, commandKind, {
    expected_version: input.expectedVersion,
    edit: input.edit as unknown as Record<string, unknown>,
  })
  const existing = await readLedger(database, input.invoiceId, input.commandId)
  if (existing !== null) {
    await assertAuthorized(input)
    return matchingRetryResult(existing, input, commandKind, input.expectedVersion, fingerprint)
  }

  const [before, document, bases] = await Promise.all([
    readInvoice(database, input.invoiceId),
    readInvoiceDocument(database, input.invoiceId),
    readFinancialBases(database, input.invoiceId),
  ])
  if (before === null || document === null || bases === null) {
    throw new InvoiceCommandOperationError(
      'invoice_not_found',
      `invoice ${input.invoiceId} does not exist`,
    )
  }
  if (before.version !== input.expectedVersion) {
    throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, before.version)
  }

  let triggerMutation: SqlStatement
  let trigger: {
    type: 'invoice_line_item' | 'invoice_header' | 'invoice_financials'
    id: number
  }
  let afterAmountCents = before.amountCents
  let afterDueAmountCents = before.dueAmountCents
  let triggerConflict: { lineId: number; expectedUpdatedAt: string } | null = null

  if (input.edit.type === 'header') {
    if (
      input.edit.clientId === undefined &&
      input.edit.number === undefined &&
      input.edit.subject === undefined &&
      input.edit.purchaseOrder === undefined &&
      input.edit.notes === undefined &&
      input.edit.currency === undefined &&
      input.edit.issueDate === undefined &&
      input.edit.dueDate === undefined &&
      input.edit.paymentTerms === undefined &&
      input.edit.projectId === undefined &&
      input.edit.retainerId === undefined &&
      input.edit.reminderPolicy === undefined
    ) {
      invalidInput('an invoice header edit must change at least one field')
    }
    if (input.edit.clientId !== undefined) {
      assertPositiveSafeInteger(input.edit.clientId, 'clientId')
    }
    if (input.edit.number !== undefined && !input.edit.number.trim()) {
      invalidInput('invoice number must not be empty')
    }
    if (input.edit.currency !== undefined && !/^[A-Z]{3}$/.test(input.edit.currency)) {
      invalidInput('invoice currency must be a three-letter uppercase code')
    }
    if (input.edit.issueDate !== undefined) assertCanonicalDate(input.edit.issueDate, 'issueDate')
    if (input.edit.dueDate !== undefined) assertCanonicalDate(input.edit.dueDate, 'dueDate')
    const resultingIssueDate = input.edit.issueDate ?? document.issueDate
    const resultingDueDate = input.edit.dueDate ?? document.dueDate
    if (resultingDueDate < resultingIssueDate) {
      invalidInput('invoice dueDate must not precede issueDate')
    }
    if (input.edit.projectId !== undefined && input.edit.projectId !== null) {
      assertPositiveSafeInteger(input.edit.projectId, 'projectId')
    }
    if (input.edit.retainerId !== undefined && input.edit.retainerId !== null) {
      assertPositiveSafeInteger(input.edit.retainerId, 'retainerId')
    }
    if (input.edit.reminderPolicy !== undefined && input.edit.reminderPolicy !== null) {
      assertReminderPolicy(input.edit.reminderPolicy)
    }
    const reminderPolicy =
      input.edit.reminderPolicy === undefined
        ? document.reminderPolicy
        : input.edit.reminderPolicy === null
          ? null
          : canonicalJson(input.edit.reminderPolicy)
    trigger = { type: 'invoice_header', id: input.invoiceId }
    triggerMutation = {
      text: `UPDATE invoices SET client_id = ?, number = ?, subject = ?,
          purchase_order = ?, notes = ?, currency = ?, issue_date = ?, due_date = ?,
          payment_terms = ?, project_id = ?, retainer_id = ?, reminder_policy = ?
        WHERE id = ? AND version = ? AND EXISTS (
          SELECT 1 FROM invoice_command_ledger
          WHERE invoice_id = ? AND command_id = ? AND completed = 0
        )`,
      params: [
        input.edit.clientId ?? document.clientId,
        input.edit.number ?? document.number,
        input.edit.subject === undefined ? document.subject : input.edit.subject,
        input.edit.purchaseOrder === undefined ? document.purchaseOrder : input.edit.purchaseOrder,
        input.edit.notes === undefined ? document.notes : input.edit.notes,
        input.edit.currency ?? document.currency,
        input.edit.issueDate ?? document.issueDate,
        input.edit.dueDate ?? document.dueDate,
        input.edit.paymentTerms ?? document.paymentTerms,
        input.edit.projectId === undefined ? document.projectId : input.edit.projectId,
        input.edit.retainerId === undefined ? document.retainerId : input.edit.retainerId,
        reminderPolicy,
        input.invoiceId,
        input.expectedVersion,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else if (input.edit.type === 'payment_options') {
    if (
      new Set(input.edit.paymentOptions).size !== input.edit.paymentOptions.length ||
      input.edit.paymentOptions.some((option) => !enabledPaymentOptions.has(option))
    ) {
      invalidInput('invoice payment options must be unique and currently supported')
    }
    trigger = { type: 'invoice_header', id: input.invoiceId }
    triggerMutation = {
      text: `UPDATE invoices SET payment_options = ?
        WHERE id = ? AND version = ? AND EXISTS (
          SELECT 1 FROM invoice_command_ledger
          WHERE invoice_id = ? AND command_id = ? AND completed = 0
        )`,
      params: [
        JSON.stringify(input.edit.paymentOptions),
        input.invoiceId,
        input.expectedVersion,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else if (input.edit.type === 'financials') {
    assertRatePpm(input.edit.taxRatePpm, 'taxRatePpm')
    assertRatePpm(input.edit.tax2RatePpm, 'tax2RatePpm')
    assertRatePpm(input.edit.discountRatePpm, 'discountRatePpm')
    const rates = {
      taxRatePpm: input.edit.taxRatePpm,
      tax2RatePpm: input.edit.tax2RatePpm,
      discountRatePpm: input.edit.discountRatePpm,
    }
    afterAmountCents = calculateInvoiceAmount(bases, rates)
    afterDueAmountCents = afterAmountCents - bases.paymentCents - before.writtenOffCents
    trigger = { type: 'invoice_financials', id: input.invoiceId }
    triggerMutation = {
      text: `UPDATE invoices
        SET tax_rate_ppm = ?, tax2_rate_ppm = ?, discount_rate_ppm = ?
        WHERE id = ? AND version = ? AND EXISTS (
          SELECT 1 FROM invoice_command_ledger
          WHERE invoice_id = ? AND command_id = ? AND completed = 0
        )`,
      params: [
        input.edit.taxRatePpm,
        input.edit.tax2RatePpm,
        input.edit.discountRatePpm,
        input.invoiceId,
        input.expectedVersion,
        input.invoiceId,
        input.commandId,
      ],
    }
  } else {
    assertPositiveSafeInteger(input.edit.lineId, 'lineId')
    const currentLine =
      input.edit.type === 'line_insert'
        ? null
        : await readInvoiceLine(database, input.invoiceId, input.edit.lineId)
    if (input.edit.type !== 'line_insert') {
      assertCanonicalTimestamp(input.edit.expectedLineUpdatedAt, 'expectedLineUpdatedAt')
      if (currentLine === null || currentLine.updatedAt !== input.edit.expectedLineUpdatedAt) {
        throw new InvoiceTriggerRowConflictError('invoice_line_item', input.edit.lineId)
      }
      triggerConflict = {
        lineId: input.edit.lineId,
        expectedUpdatedAt: input.edit.expectedLineUpdatedAt,
      }
    }

    let subtotalCents = bases.subtotalCents
    let taxBaseCents = bases.taxBaseCents
    let tax2BaseCents = bases.tax2BaseCents
    if (currentLine !== null) {
      subtotalCents -= currentLine.amountCents
      if (currentLine.taxed === 1) taxBaseCents -= currentLine.amountCents
      if (currentLine.taxed2 === 1) tax2BaseCents -= currentLine.amountCents
    }
    if (input.edit.type !== 'line_delete') {
      if (!Number.isSafeInteger(input.edit.position) || input.edit.position < 0) {
        invalidInput('line position must be a non-negative safe integer')
      }
      assertCents(input.edit.unitPriceCents, 'line unitPriceCents')
      assertCents(input.edit.amountCents, 'line amountCents')
      if (!Number.isFinite(input.edit.quantity)) invalidInput('line quantity must be finite')
      subtotalCents += input.edit.amountCents
      if (input.edit.taxed ?? false) taxBaseCents += input.edit.amountCents
      if (input.edit.taxed2 ?? false) tax2BaseCents += input.edit.amountCents
    }
    const adjustedBases = { subtotalCents, taxBaseCents, tax2BaseCents }
    afterAmountCents = calculateInvoiceAmount(adjustedBases, before)
    afterDueAmountCents = afterAmountCents - bases.paymentCents - before.writtenOffCents
    trigger = { type: 'invoice_line_item', id: input.edit.lineId }

    if (input.edit.type === 'line_insert') {
      triggerMutation = {
        text: `INSERT INTO invoice_line_items (
            id, invoice_id, position, kind, description, quantity, unit_price_cents,
            amount_cents, taxed, taxed2, project_id, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
        params: [
          input.edit.lineId,
          input.invoiceId,
          input.edit.position,
          input.edit.kind,
          input.edit.description ?? null,
          input.edit.quantity,
          input.edit.unitPriceCents,
          input.edit.amountCents,
          input.edit.taxed ? 1 : 0,
          input.edit.taxed2 ? 1 : 0,
          input.edit.projectId ?? null,
          input.occurredAt,
          input.occurredAt,
          input.invoiceId,
          input.commandId,
        ],
      }
    } else if (input.edit.type === 'line_update') {
      triggerMutation = {
        text: `UPDATE invoice_line_items SET position = ?, kind = ?, description = ?,
            quantity = ?, unit_price_cents = ?, amount_cents = ?, taxed = ?, taxed2 = ?,
            project_id = ?, updated_at = ?
          WHERE id = ? AND invoice_id = ? AND updated_at = ? AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
        params: [
          input.edit.position,
          input.edit.kind,
          input.edit.description ?? null,
          input.edit.quantity,
          input.edit.unitPriceCents,
          input.edit.amountCents,
          input.edit.taxed ? 1 : 0,
          input.edit.taxed2 ? 1 : 0,
          input.edit.projectId ?? null,
          input.occurredAt,
          input.edit.lineId,
          input.invoiceId,
          input.edit.expectedLineUpdatedAt,
          input.invoiceId,
          input.commandId,
        ],
      }
    } else {
      triggerMutation = {
        text: `DELETE FROM invoice_line_items
          WHERE id = ? AND invoice_id = ? AND updated_at = ? AND EXISTS (
            SELECT 1 FROM invoice_command_ledger
            WHERE invoice_id = ? AND command_id = ? AND completed = 0
          )`,
        params: [
          input.edit.lineId,
          input.invoiceId,
          input.edit.expectedLineUpdatedAt,
          input.invoiceId,
          input.commandId,
        ],
      }
    }
  }

  const reduction = reduceInvoiceEdit(before, {
    occurredAt: input.occurredAt,
    afterDueAmountCents,
  })
  const statements = [
    pendingLedgerInsert(input, commandKind, input.expectedVersion, fingerprint),
    triggerMutation,
    invoiceStateUpdate(input, input.expectedVersion, reduction.invoice, true),
  ]
  appendEvents(
    statements,
    input,
    commandKind,
    trigger,
    eventInvoiceSnapshot(before, before.amountCents),
    eventInvoiceSnapshot(reduction.invoice, afterAmountCents),
    reduction.events,
    { before: null, after: null },
  )

  try {
    await runAtomic(database, statements)
  } catch {
    const completed = await readLedger(database, input.invoiceId, input.commandId)
    if (completed !== null) {
      await assertAuthorized(input)
      return matchingRetryResult(completed, input, commandKind, input.expectedVersion, fingerprint)
    }
    const version = await actualVersion(database, input.invoiceId)
    if (version !== input.expectedVersion) {
      throw new InvoiceVersionConflictError(input.invoiceId, input.expectedVersion, version)
    }
    if (triggerConflict !== null) {
      const line = await readInvoiceLine(database, input.invoiceId, triggerConflict.lineId)
      if (line === null || line.updatedAt !== triggerConflict.expectedUpdatedAt) {
        throw new InvoiceTriggerRowConflictError('invoice_line_item', triggerConflict.lineId)
      }
    }
    throw new InvoiceCommandOperationError(
      'command_storage_conflict',
      `invoice ${input.invoiceId} command ${input.commandId} could not commit`,
    )
  }
  await assertAuthorized(input)
  return committedResult(database, input, commandKind, input.expectedVersion, fingerprint)
}
