import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  deleteInvoicePayment,
  executeInvoiceEdit,
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  updateInvoicePayment,
  type DeleteInvoicePaymentCommand,
  type ExecuteInvoiceEditCommand,
  type ExecuteInvoiceLifecycleCommand,
  type InvoiceCommandResult,
  type RecordInvoicePaymentCommand,
  type UpdateInvoicePaymentCommand,
} from './invoice-state.js'
import {
  appendRetainerLedgerEntry,
  getRetainerBalance,
  type AppendRetainerLedgerEntryInput,
  type RetainerLedgerEntry,
} from './retainers.js'
import { assertRecurringAmountConfig, type RecurringAmountConfig } from './recurring-invoices.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type MoneyResourceDatabase = ContainerDatabase | WorkerDatabase

export interface MoneyWindow {
  afterId: number | null
  throughId: number
  take: number
}

export type MoneyCollection = 'invoices' | 'estimates' | 'retainers' | 'recurring-invoices'

export interface InvoiceLineResource {
  id: number
  invoice_id: number
  position: number
  kind: string
  description: string | null
  quantity: number
  unit_price_cents: number
  amount_cents: number
  taxed: boolean
  taxed2: boolean
  project_id: number | null
  created_at: string
  updated_at: string
}

export interface InvoiceResource {
  id: number
  client_id: number
  created_by_user_id: number | null
  number: string
  subject: string | null
  purchase_order: string | null
  notes: string | null
  currency: string
  issue_date: string
  due_date: string
  payment_terms: string
  state: string
  version: number
  close_reason: string | null
  close_write_off_cents: number
  sent_at: string | null
  paid_at: string | null
  paid_date: string | null
  closed_at: string | null
  period_start: string | null
  period_end: string | null
  project_id: number | null
  retainer_id: number | null
  recurring_invoice_id: number | null
  estimate_id: number | null
  reminder_policy: Record<string, unknown> | null
  tax_rate_ppm: number | null
  tax2_rate_ppm: number | null
  discount_rate_ppm: number | null
  amount_cents: number
  due_amount_cents: number
  tax_amount_cents: number
  tax2_amount_cents: number
  discount_amount_cents: number
  written_off_cents: number
  payment_options: string[]
  reference_token: string | null
  created_at: string
  updated_at: string
  line_items: InvoiceLineResource[]
}

export interface EstimateLineResource {
  id: number
  estimate_id: number
  position: number
  kind: string
  description: string | null
  quantity: number
  unit_price_cents: number
  amount_cents: number
  taxed: boolean
  taxed2: boolean
  created_at: string
  updated_at: string
}

export interface EstimateResource {
  id: number
  client_id: number
  created_by_user_id: number | null
  number: string
  purchase_order: string | null
  subject: string | null
  notes: string | null
  currency: string
  state: 'draft' | 'sent' | 'accepted' | 'declined'
  version: number
  issue_date: string
  sent_at: string | null
  accepted_at: string | null
  declined_at: string | null
  tax_rate_ppm: number | null
  tax2_rate_ppm: number | null
  discount_rate_ppm: number | null
  amount_cents: number
  tax_amount_cents: number
  tax2_amount_cents: number
  discount_amount_cents: number
  created_at: string
  updated_at: string
  line_items: EstimateLineResource[]
}

export interface EstimateMessageResource {
  id: number
  estimate_id: number
  sent_by: string | null
  sent_by_email: string | null
  sent_from: string | null
  sent_from_email: string | null
  recipients: Array<{ name: string; email: string }>
  subject: string | null
  body: string | null
  send_me_a_copy: boolean
  event_type: 'send' | 'accept' | 'decline' | 're-open' | 'view' | 'invoice' | null
  delivery_status: 'queued' | 'sent' | 'bounced' | 'complained' | 'failed' | null
  provider_message_id: string | null
  created_at: string
  updated_at: string
}

export interface ExecuteEstimateMessageInput {
  estimateId: number
  commandId: string
  actorUserId: number
  messageId: number
  expectedVersion: number
  eventType: 'send' | 'accept' | 'decline' | 're-open'
  sentBy: string | null
  sentByEmail: string | null
  sentFrom: string | null
  sentFromEmail: string | null
  recipients: readonly { name: string; email: string }[]
  subject: string | null
  body: string | null
  sendMeACopy: boolean
  occurredAt: string
}

export interface ConvertEstimateInput {
  estimateId: number
  commandId: string
  invoiceId: number
  messageId: number
  eventId: string
  expectedVersion: number
  createdByUserId: number
  number: string
  issueDate: string
  dueDate: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
  occurredAt: string
}

export interface EstimateConversionResult {
  invoice: InvoiceResource
  event: EstimateMessageResource
}

export interface InvoiceMessageResource {
  id: number
  invoice_id: number
  sent_by: string | null
  sent_by_email: string | null
  sent_from: string | null
  sent_from_email: string | null
  recipients: Array<{ name: string; email: string }>
  subject: string | null
  body: string | null
  attach_pdf: boolean
  send_me_a_copy: boolean
  thank_you: boolean
  reminder: boolean
  send_reminder_on: string | null
  event_type: string | null
  delivery_status: string | null
  provider_message_id: string | null
  created_at: string
  updated_at: string
}

export interface InvoicePaymentResource {
  id: number
  invoice_id: number
  currency: string
  amount_cents: number
  paid_at: string | null
  paid_date: string | null
  notes: string | null
  recorded_by_user_id: number | null
  provider: string
  provider_shape: string
  provider_account_id: number | null
  provider_transaction_id: string | null
  bank_deposit_id: number | null
  created_at: string
  updated_at: string
}

export interface RetainerResource {
  id: number
  client_id: number | null
  project_id: number | null
  state: 'ongoing' | 'closed'
  denomination: 'money' | 'hours'
  amount_cents: number | null
  seconds: number | null
  locked_rate_cents: number | null
  rate_locked_at: string | null
  period: string | null
  rollover: 'carry' | 'expire' | 'cap' | null
  expires_at: string | null
  on_exhaustion: 'block' | 'warn' | 'overflow'
  balance: number
  created_at: string
  updated_at: string
}

export interface CreateRetainerInput {
  clientId: number | null
  projectId: number | null
  denomination: 'money' | 'hours'
  amountCents: number | null
  seconds: number | null
  lockedRateCents: number | null
  rateLockedAt: string | null
  period: string | null
  rollover: 'carry' | 'expire' | 'cap' | null
  expiresAt: string | null
  onExhaustion: 'block' | 'warn' | 'overflow'
  occurredAt: string
}

export interface UpdateRetainerInput {
  state?: 'ongoing' | 'closed'
  period?: string | null
  rollover?: 'carry' | 'expire' | 'cap' | null
  expiresAt?: string | null
  onExhaustion?: 'block' | 'warn' | 'overflow'
  occurredAt: string
}

export interface RecurringInvoiceResource {
  id: number
  client_id: number
  subject_template: string
  notes_template: string
  every_n_months: number
  day_of_month: number
  next_issue_on: string
  amount_config: RecurringAmountConfig
  can_draw_from_retainer_id: number | null
  created_at: string
  updated_at: string
}

export interface RecurringInvoiceInput {
  clientId: number
  subjectTemplate: string
  notesTemplate: string
  everyNMonths: number
  dayOfMonth: number
  nextIssueOn: string
  amountConfig: RecurringAmountConfig
  canDrawFromRetainerId: number | null
  occurredAt: string
}

interface SqlStatement {
  text: string
  params: readonly unknown[]
}

interface MutationResult {
  changes: number
}

export type MoneyResourceOperationErrorCode =
  | 'estimate_not_found'
  | 'estimate_version_conflict'
  | 'estimate_state_conflict'
  | 'estimate_already_converted'
  | 'command_id_reused'

export class MoneyResourceOperationError extends Error {
  constructor(
    readonly code: MoneyResourceOperationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MoneyResourceOperationError'
  }
}

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: MoneyResourceDatabase,
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

const all = async <T>(database: MoneyResourceDatabase, statement: SqlStatement): Promise<T[]> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (
      await client
        .prepare(statement.text)
        .bind(...statement.params)
        .all<T>()
    ).results
  }
  return client.prepare(statement.text).all(...statement.params) as T[]
}

const run = async (
  database: MoneyResourceDatabase,
  statement: SqlStatement,
): Promise<MutationResult> => {
  const client = database.$client
  if (isD1Client(client)) {
    const result = await client
      .prepare(statement.text)
      .bind(...statement.params)
      .run()
    return { changes: result.meta.changes }
  }
  const result = client.prepare(statement.text).run(...statement.params)
  return { changes: result.changes }
}

const runAtomic = async (
  database: MoneyResourceDatabase,
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

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  return JSON.parse(value) as T
}

const assertPositiveId = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be positive`)
}

const assertTimestamp = (value: string, field: string): void => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  if (match === null) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
  const epoch = Date.parse(value)
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== normalized) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const invoiceSelect = `SELECT id, client_id, created_by_user_id, number, subject,
  purchase_order, notes, currency, issue_date, due_date, payment_terms, state, version,
  close_reason, close_write_off_cents, sent_at, paid_at, paid_date, closed_at,
  period_start, period_end, project_id, retainer_id, recurring_invoice_id, estimate_id,
  reminder_policy, tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, amount_cents,
  due_amount_cents, tax_amount_cents, tax2_amount_cents, discount_amount_cents,
  written_off_cents, payment_options, reference_token, created_at, updated_at
  FROM invoices`

type RawInvoice = Omit<InvoiceResource, 'line_items' | 'payment_options' | 'reminder_policy'> & {
  payment_options: unknown
  reminder_policy: unknown
}

type RawInvoiceLine = Omit<InvoiceLineResource, 'taxed' | 'taxed2'> & {
  taxed: number | boolean
  taxed2: number | boolean
}

const linesFor = async (
  database: MoneyResourceDatabase,
  invoiceId: number,
): Promise<InvoiceLineResource[]> =>
  (
    await all<RawInvoiceLine>(database, {
      text: `SELECT id, invoice_id, position, kind, description, quantity,
      unit_price_cents, amount_cents, taxed, taxed2, project_id, created_at, updated_at
      FROM invoice_line_items WHERE invoice_id = ? ORDER BY position, id`,
      params: [invoiceId],
    })
  ).map((line) => ({ ...line, taxed: Boolean(line.taxed), taxed2: Boolean(line.taxed2) }))

const hydrateInvoice = async (
  database: MoneyResourceDatabase,
  row: RawInvoice,
): Promise<InvoiceResource> => ({
  ...row,
  reminder_policy: parseJson<Record<string, unknown> | null>(row.reminder_policy, null),
  payment_options: parseJson<string[]>(row.payment_options, []),
  line_items: await linesFor(database, row.id),
})

const estimateSelect = `SELECT id, client_id, created_by_user_id, number,
  purchase_order, subject, notes, currency, state, version, issue_date, sent_at,
  accepted_at, declined_at, tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm,
  amount_cents, tax_amount_cents, tax2_amount_cents, discount_amount_cents,
  created_at, updated_at FROM estimates`

type RawEstimateLine = Omit<EstimateLineResource, 'taxed' | 'taxed2'> & {
  taxed: number | boolean
  taxed2: number | boolean
}

const estimateLinesFor = async (
  database: MoneyResourceDatabase,
  estimateId: number,
): Promise<EstimateLineResource[]> =>
  (
    await all<RawEstimateLine>(database, {
      text: `SELECT id, estimate_id, position, kind, description, quantity,
        unit_price_cents, amount_cents, taxed, taxed2, created_at, updated_at
        FROM estimate_line_items WHERE estimate_id = ? ORDER BY position, id`,
      params: [estimateId],
    })
  ).map((line) => ({ ...line, taxed: Boolean(line.taxed), taxed2: Boolean(line.taxed2) }))

const hydrateEstimate = async (
  database: MoneyResourceDatabase,
  row: Omit<EstimateResource, 'line_items'>,
): Promise<EstimateResource> => ({
  ...row,
  line_items: await estimateLinesFor(database, row.id),
})

type RawEstimateMessage = Omit<EstimateMessageResource, 'recipients' | 'send_me_a_copy'> & {
  recipients: unknown
  send_me_a_copy: number | boolean
}

const hydrateEstimateMessage = (row: RawEstimateMessage): EstimateMessageResource => ({
  ...row,
  recipients: parseJson<Array<{ name: string; email: string }>>(row.recipients, []),
  send_me_a_copy: Boolean(row.send_me_a_copy),
})

const estimateMessageSelect = `SELECT id, estimate_id, sent_by, sent_by_email,
  sent_from, sent_from_email, recipients, subject, body, send_me_a_copy, event_type,
  delivery_status, provider_message_id, created_at, updated_at FROM estimate_messages`

type EstimateCommandKind =
  | 'estimate.send'
  | 'estimate.accept'
  | 'estimate.decline'
  | 'estimate.re-open'
  | 'estimate.convert'

interface StoredEstimateCommand {
  estimateId: number
  commandId: string
  commandKind: EstimateCommandKind
  inputFingerprint: string
  actorUserId: number
  expectedEstimateVersion: number
  messageId: number
  invoiceId: number | null
  eventId: string | null
  occurredAt: string
  completed: number | boolean
  resultJson: unknown
}

const estimateCommandSelect = `SELECT estimate_id AS "estimateId", command_id AS "commandId",
  command_kind AS "commandKind", input_fingerprint AS "inputFingerprint",
  actor_user_id AS "actorUserId", expected_estimate_version AS "expectedEstimateVersion",
  message_id AS "messageId", invoice_id AS "invoiceId", event_id AS "eventId",
  occurred_at AS "occurredAt", completed, result_json AS "resultJson"
  FROM estimate_command_ledger`

const fingerprint = async (value: unknown): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  )
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const assertEstimateCommandReceipt = (
  receipt: StoredEstimateCommand,
  expected: {
    commandKind: EstimateCommandKind
    inputFingerprint: string
    actorUserId: number
    expectedVersion: number
    messageId: number
    invoiceId: number | null
    eventId: string | null
  },
): void => {
  if (
    receipt.commandKind !== expected.commandKind ||
    receipt.inputFingerprint !== expected.inputFingerprint ||
    receipt.actorUserId !== expected.actorUserId ||
    receipt.expectedEstimateVersion !== expected.expectedVersion ||
    receipt.messageId !== expected.messageId ||
    receipt.invoiceId !== expected.invoiceId ||
    receipt.eventId !== expected.eventId
  ) {
    throw new MoneyResourceOperationError(
      'command_id_reused',
      'estimate command id was reused with different causation input',
    )
  }
  if (!receipt.completed) {
    throw new MoneyResourceOperationError(
      'command_id_reused',
      'estimate command receipt is incomplete',
    )
  }
}

type RawMessage = Omit<
  InvoiceMessageResource,
  'recipients' | 'attach_pdf' | 'send_me_a_copy' | 'thank_you' | 'reminder'
> & {
  recipients: unknown
  attach_pdf: number | boolean
  send_me_a_copy: number | boolean
  thank_you: number | boolean
  reminder: number | boolean
}

const hydrateMessage = (row: RawMessage): InvoiceMessageResource => ({
  ...row,
  recipients: parseJson<Array<{ name: string; email: string }>>(row.recipients, []),
  attach_pdf: Boolean(row.attach_pdf),
  send_me_a_copy: Boolean(row.send_me_a_copy),
  thank_you: Boolean(row.thank_you),
  reminder: Boolean(row.reminder),
})

type RawRetainer = Omit<RetainerResource, 'balance'> & { balance: number | null }

const retainerSelect = `SELECT retainer.id, retainer.client_id, retainer.project_id,
  retainer.state, retainer.denomination, retainer.amount_cents, retainer.seconds,
  retainer.locked_rate_cents, retainer.rate_locked_at, retainer.period,
  retainer.rollover, retainer.expires_at, retainer.on_exhaustion,
  COALESCE(balance.balance, 0) AS balance, retainer.created_at, retainer.updated_at
  FROM retainers retainer
  LEFT JOIN retainer_balances balance ON balance.retainer_id = retainer.id`

type RawRecurring = Omit<RecurringInvoiceResource, 'amount_config'> & { amount_config: unknown }

const recurringSelect = `SELECT id, client_id, subject_template, notes_template,
  every_n_months, day_of_month, next_issue_on, amount_config,
  can_draw_from_retainer_id, created_at, updated_at FROM recurring_invoices
  WHERE definition_status = 'complete'`

const hydrateRecurring = (row: RawRecurring): RecurringInvoiceResource => ({
  ...row,
  amount_config: parseJson<RecurringAmountConfig>(row.amount_config, {
    schema_version: 1,
    type: 'fixed_lines',
    line_items: [],
  }),
})

export class MoneyResourceRepository {
  constructor(private readonly database: MoneyResourceDatabase) {}

  async highWatermark(kind: MoneyCollection): Promise<number> {
    const table = kind === 'recurring-invoices' ? 'recurring_invoices' : kind
    const row = await first<{ highWaterId: number }>(this.database, {
      text: `SELECT COALESCE(MAX(id), 0) AS "highWaterId" FROM ${table}`,
      params: [],
    })
    return row?.highWaterId ?? 0
  }

  async listInvoices(window: MoneyWindow): Promise<InvoiceResource[]> {
    const rows = await all<RawInvoice>(this.database, {
      text: `${invoiceSelect} WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`,
      params: [window.afterId ?? 0, window.throughId, window.take],
    })
    return Promise.all(rows.map((row) => hydrateInvoice(this.database, row)))
  }

  async getInvoice(id: number): Promise<InvoiceResource | null> {
    assertPositiveId(id, 'invoice id')
    const row = await first<RawInvoice>(this.database, {
      text: `${invoiceSelect} WHERE id = ?`,
      params: [id],
    })
    return row === null ? null : hydrateInvoice(this.database, row)
  }

  async listEstimates(window: MoneyWindow): Promise<EstimateResource[]> {
    const rows = await all<Omit<EstimateResource, 'line_items'>>(this.database, {
      text: `${estimateSelect} WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`,
      params: [window.afterId ?? 0, window.throughId, window.take],
    })
    return Promise.all(rows.map((row) => hydrateEstimate(this.database, row)))
  }

  async getEstimate(id: number): Promise<EstimateResource | null> {
    assertPositiveId(id, 'estimate id')
    const row = await first<Omit<EstimateResource, 'line_items'>>(this.database, {
      text: `${estimateSelect} WHERE id = ?`,
      params: [id],
    })
    return row === null ? null : hydrateEstimate(this.database, row)
  }

  async listEstimateMessages(estimateId: number): Promise<EstimateMessageResource[] | null> {
    if ((await this.getEstimate(estimateId)) === null) return null
    return (
      await all<RawEstimateMessage>(this.database, {
        text: `${estimateMessageSelect} WHERE estimate_id = ? ORDER BY created_at, id`,
        params: [estimateId],
      })
    ).map(hydrateEstimateMessage)
  }

  async executeEstimateMessage(input: ExecuteEstimateMessageInput): Promise<{
    estimate: EstimateResource
    message: EstimateMessageResource
  }> {
    assertPositiveId(input.estimateId, 'estimateId')
    assertPositiveId(input.actorUserId, 'actorUserId')
    assertPositiveId(input.messageId, 'messageId')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('expectedVersion must be a non-negative safe integer')
    }
    assertTimestamp(input.occurredAt, 'occurredAt')
    if (input.eventType === 'send' && input.recipients.length === 0) {
      throw new TypeError('estimate send requires at least one recipient')
    }
    const commandKind = `estimate.${input.eventType}` as EstimateCommandKind
    const recipients = JSON.stringify(input.recipients)
    const inputFingerprint = await fingerprint({
      schema_version: 1,
      command_kind: commandKind,
      estimate_id: input.estimateId,
      expected_version: input.expectedVersion,
      actor: { type: 'user', id: input.actorUserId },
      message: {
        event_type: input.eventType,
        recipients: input.recipients,
        subject: input.subject,
        body: input.body,
        send_me_a_copy: input.sendMeACopy,
      },
    })
    const expectedReceipt = {
      commandKind,
      inputFingerprint,
      actorUserId: input.actorUserId,
      expectedVersion: input.expectedVersion,
      messageId: input.messageId,
      invoiceId: null,
      eventId: null,
    } as const
    const priorReceipt = await first<StoredEstimateCommand>(this.database, {
      text: `${estimateCommandSelect} WHERE estimate_id = ? AND command_id = ?`,
      params: [input.estimateId, input.commandId],
    })
    if (priorReceipt !== null) {
      assertEstimateCommandReceipt(priorReceipt, expectedReceipt)
      const [estimate, messageRow] = await Promise.all([
        this.getEstimate(input.estimateId),
        first<RawEstimateMessage>(this.database, {
          text: `${estimateMessageSelect} WHERE id = ? AND estimate_id = ?`,
          params: [input.messageId, input.estimateId],
        }),
      ])
      if (estimate === null || messageRow === null) {
        throw new MoneyResourceOperationError('command_id_reused', 'estimate receipt result is missing')
      }
      return { estimate, message: hydrateEstimateMessage(messageRow) }
    }
    if (
      (await first<{ id: number }>(this.database, {
        text: `SELECT id FROM estimate_messages WHERE id = ?`,
        params: [input.messageId],
      })) !== null
    ) {
      throw new MoneyResourceOperationError(
        'command_id_reused',
        'estimate message command identity is already occupied',
      )
    }

    await runAtomic(this.database, [
      {
        text: `INSERT INTO estimate_command_ledger (
          estimate_id, command_id, command_kind, input_fingerprint, actor_user_id,
          expected_estimate_version, message_id, occurred_at
        ) SELECT id, ?, ?, ?, ?, ?, ?, ? FROM estimates
          WHERE id = ? AND version = ? AND (
            (? = 'send' AND state IN ('draft', 'sent')) OR
            (? IN ('accept', 'decline') AND state = 'sent') OR
            (? = 're-open' AND state IN ('accepted', 'declined'))
          ) AND NOT EXISTS (
            SELECT 1 FROM estimate_command_ledger
            WHERE estimate_id = ? AND command_id = ?
          )`,
        params: [
          input.commandId,
          commandKind,
          inputFingerprint,
          input.actorUserId,
          input.expectedVersion,
          input.messageId,
          input.occurredAt,
          input.estimateId,
          input.expectedVersion,
          input.eventType,
          input.eventType,
          input.eventType,
          input.estimateId,
          input.commandId,
        ],
      },
      {
        text: `INSERT INTO estimate_messages (
          id, estimate_id, sent_by, sent_by_email, sent_from, sent_from_email,
          recipients, subject, body, send_me_a_copy, event_type, delivery_status,
          provider_message_id, created_at, updated_at
        ) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN ? = 'send' THEN 'queued' ELSE NULL END, NULL, ?, ?
          FROM estimates estimate WHERE id = ? AND version = ? AND (
            (? = 'send' AND state IN ('draft', 'sent')) OR
            (? IN ('accept', 'decline') AND state = 'sent') OR
            (? = 're-open' AND state IN ('accepted', 'declined'))
          ) AND EXISTS (
            SELECT 1 FROM estimate_command_ledger command
            WHERE command.estimate_id = estimate.id AND command.command_id = ?
              AND command.command_kind = ? AND command.input_fingerprint = ?
              AND command.actor_user_id = ? AND command.expected_estimate_version = ?
              AND command.message_id = ? AND command.completed = 0
          )`,
        params: [
          input.messageId,
          input.sentBy,
          input.sentByEmail,
          input.sentFrom,
          input.sentFromEmail,
          recipients,
          input.subject,
          input.body,
          input.sendMeACopy ? 1 : 0,
          input.eventType,
          input.eventType,
          input.occurredAt,
          input.occurredAt,
          input.estimateId,
          input.expectedVersion,
          input.eventType,
          input.eventType,
          input.eventType,
          input.commandId,
          commandKind,
          inputFingerprint,
          input.actorUserId,
          input.expectedVersion,
          input.messageId,
        ],
      },
      {
        text: `UPDATE estimates SET
          state = CASE ?
            WHEN 'send' THEN 'sent'
            WHEN 'accept' THEN 'accepted'
            WHEN 'decline' THEN 'declined'
            WHEN 're-open' THEN 'sent'
          END,
          version = version + 1,
          sent_at = CASE WHEN ? = 'send' THEN COALESCE(sent_at, ?) ELSE sent_at END,
          accepted_at = CASE WHEN ? = 'accept' THEN ? WHEN ? = 're-open' THEN NULL ELSE accepted_at END,
          declined_at = CASE WHEN ? = 'decline' THEN ? WHEN ? = 're-open' THEN NULL ELSE declined_at END,
          updated_at = ?
          WHERE id = ? AND version = ? AND (
            (? = 'send' AND state IN ('draft', 'sent')) OR
            (? IN ('accept', 'decline') AND state = 'sent') OR
            (? = 're-open' AND state IN ('accepted', 'declined'))
          ) AND EXISTS (
            SELECT 1 FROM estimate_messages message
            JOIN estimate_command_ledger command
              ON command.estimate_id = message.estimate_id
              AND command.message_id = message.id
            WHERE message.id = ? AND message.estimate_id = estimates.id
              AND command.command_id = ? AND command.input_fingerprint = ?
              AND command.completed = 0
          )`,
        params: [
          input.eventType,
          input.eventType,
          input.occurredAt,
          input.eventType,
          input.occurredAt,
          input.eventType,
          input.eventType,
          input.occurredAt,
          input.eventType,
          input.occurredAt,
          input.estimateId,
          input.expectedVersion,
          input.eventType,
          input.eventType,
          input.eventType,
          input.messageId,
          input.commandId,
          inputFingerprint,
        ],
      },
      {
        text: `UPDATE estimate_command_ledger SET
          completed = 1,
          result_json = json_object(
            'schema_version', 1,
            'estimate_id', estimate_id,
            'message_id', message_id
          ),
          completed_at = ?
          WHERE estimate_id = ? AND command_id = ? AND input_fingerprint = ?
            AND completed = 0
            AND EXISTS (
              SELECT 1 FROM estimates estimate
              WHERE estimate.id = estimate_command_ledger.estimate_id AND estimate.version = ?
            )
            AND EXISTS (
              SELECT 1 FROM estimate_messages message
              WHERE message.id = estimate_command_ledger.message_id
                AND message.estimate_id = estimate_command_ledger.estimate_id
            )`,
        params: [
          input.occurredAt,
          input.estimateId,
          input.commandId,
          inputFingerprint,
          input.expectedVersion + 1,
        ],
      },
    ])

    const [estimate, messageRow, receipt] = await Promise.all([
      this.getEstimate(input.estimateId),
      first<RawEstimateMessage>(this.database, {
        text: `${estimateMessageSelect} WHERE id = ? AND estimate_id = ?`,
        params: [input.messageId, input.estimateId],
      }),
      first<StoredEstimateCommand>(this.database, {
        text: `${estimateCommandSelect} WHERE estimate_id = ? AND command_id = ?`,
        params: [input.estimateId, input.commandId],
      }),
    ])
    if (estimate === null) {
      throw new MoneyResourceOperationError('estimate_not_found', 'estimate does not exist')
    }
    if (receipt !== null) assertEstimateCommandReceipt(receipt, expectedReceipt)
    if (messageRow === null || receipt === null) {
      if (estimate.version !== input.expectedVersion) {
        throw new MoneyResourceOperationError(
          'estimate_version_conflict',
          'estimate version no longer matches',
        )
      }
      throw new MoneyResourceOperationError(
        'estimate_state_conflict',
        'estimate event is not legal in the current state',
      )
    }
    return { estimate, message: hydrateEstimateMessage(messageRow) }
  }

  async convertEstimate(input: ConvertEstimateInput): Promise<EstimateConversionResult> {
    assertPositiveId(input.estimateId, 'estimateId')
    assertPositiveId(input.invoiceId, 'invoiceId')
    assertPositiveId(input.messageId, 'messageId')
    assertPositiveId(input.createdByUserId, 'createdByUserId')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('expectedVersion must be a non-negative safe integer')
    }
    assertTimestamp(input.occurredAt, 'occurredAt')
    const inputFingerprint = await fingerprint({
      schema_version: 1,
      command_kind: 'estimate.convert',
      estimate_id: input.estimateId,
      expected_version: input.expectedVersion,
      actor: { type: 'user', id: input.createdByUserId },
      invoice: {
        number: input.number,
        issue_date: input.issueDate,
        due_date: input.dueDate,
        payment_terms: input.paymentTerms,
      },
    })
    const expectedReceipt = {
      commandKind: 'estimate.convert',
      inputFingerprint,
      actorUserId: input.createdByUserId,
      expectedVersion: input.expectedVersion,
      messageId: input.messageId,
      invoiceId: input.invoiceId,
      eventId: input.eventId,
    } as const
    const readReceipt = () =>
      first<StoredEstimateCommand>(this.database, {
        text: `${estimateCommandSelect} WHERE estimate_id = ? AND command_id = ?`,
        params: [input.estimateId, input.commandId],
      })
    const replayReceipt = async (
      receipt: StoredEstimateCommand,
    ): Promise<EstimateConversionResult> => {
      assertEstimateCommandReceipt(receipt, expectedReceipt)
      const [invoiceRow, eventRow] = await Promise.all([
        first<RawInvoice>(this.database, {
          text: `${invoiceSelect} WHERE id = ? AND estimate_id = ?`,
          params: [input.invoiceId, input.estimateId],
        }),
        first<RawEstimateMessage>(this.database, {
          text: `${estimateMessageSelect} WHERE id = ? AND estimate_id = ? AND event_type = 'invoice'`,
          params: [input.messageId, input.estimateId],
        }),
      ])
      if (invoiceRow === null || eventRow === null) {
        throw new MoneyResourceOperationError('command_id_reused', 'conversion receipt result is missing')
      }
      return {
        invoice: await hydrateInvoice(this.database, invoiceRow),
        event: hydrateEstimateMessage(eventRow),
      }
    }
    const replayCurrentReceipt = async (): Promise<EstimateConversionResult | null> => {
      const receipt = await readReceipt()
      return receipt === null ? null : replayReceipt(receipt)
    }
    const priorResult = await replayCurrentReceipt()
    if (priorResult !== null) return priorResult

    if (
      (await first<{ id: number }>(this.database, {
        text: `SELECT id FROM invoices WHERE estimate_id = ? ORDER BY id LIMIT 1`,
        params: [input.estimateId],
      })) !== null ||
      (await first<{ id: number }>(this.database, {
        text: `SELECT id FROM estimate_messages
          WHERE estimate_id = ? AND event_type = 'invoice' ORDER BY id LIMIT 1`,
        params: [input.estimateId],
      })) !== null
    ) {
      const racedResult = await replayCurrentReceipt()
      if (racedResult !== null) return racedResult
      throw new MoneyResourceOperationError(
        'estimate_already_converted',
        'estimate already has conversion provenance',
      )
    }
    if (
      (await first<{ value: number }>(this.database, {
        text: `SELECT 1 AS value WHERE
          EXISTS (SELECT 1 FROM estimate_messages WHERE id = ?)
          OR EXISTS (SELECT 1 FROM invoices WHERE id = ?)
          OR EXISTS (SELECT 1 FROM event_outbox WHERE id = ?)
          OR EXISTS (SELECT 1 FROM estimate_command_ledger
            WHERE message_id = ? OR invoice_id = ? OR event_id = ?)`,
        params: [
          input.messageId,
          input.invoiceId,
          input.eventId,
          input.messageId,
          input.invoiceId,
          input.eventId,
        ],
      })) !== null
    ) {
      const racedResult = await replayCurrentReceipt()
      if (racedResult !== null) return racedResult
      throw new MoneyResourceOperationError(
        'command_id_reused',
        'estimate conversion identity is already occupied',
      )
    }

    const conversionStatements: readonly SqlStatement[] = [
      {
        text: `INSERT INTO estimate_command_ledger (
          estimate_id, command_id, command_kind, input_fingerprint, actor_user_id,
          expected_estimate_version, message_id, invoice_id, event_id, occurred_at
        ) SELECT id, ?, 'estimate.convert', ?, ?, ?, ?, ?, ?, ? FROM estimates
          WHERE id = ? AND state = 'accepted' AND version = ?
            AND NOT EXISTS (SELECT 1 FROM invoices WHERE estimate_id = estimates.id)
            AND NOT EXISTS (
              SELECT 1 FROM estimate_messages
              WHERE estimate_id = estimates.id AND event_type = 'invoice'
            )
            AND NOT EXISTS (
              SELECT 1 FROM estimate_command_ledger
              WHERE estimate_id = estimates.id AND command_id = ?
            )`,
        params: [
          input.commandId,
          inputFingerprint,
          input.createdByUserId,
          input.expectedVersion,
          input.messageId,
          input.invoiceId,
          input.eventId,
          input.occurredAt,
          input.estimateId,
          input.expectedVersion,
          input.commandId,
        ],
      },
      {
        text: `INSERT INTO invoices (
          id, client_id, created_by_user_id, number, subject, purchase_order, notes,
          currency, issue_date, due_date, payment_terms, state, version,
          estimate_id, tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm,
          amount_cents, due_amount_cents, tax_amount_cents, tax2_amount_cents,
          discount_amount_cents, written_off_cents, payment_options, created_at, updated_at
        ) SELECT ?, estimate.client_id, ?, ?, estimate.subject, estimate.purchase_order,
          estimate.notes, estimate.currency, ?, ?, ?, 'draft', 0, estimate.id,
          estimate.tax_rate_ppm, estimate.tax2_rate_ppm, estimate.discount_rate_ppm,
          0, 0, 0, 0, 0, 0, '[]', ?, ?
          FROM estimates estimate
          WHERE estimate.id = ? AND estimate.state = 'accepted' AND estimate.version = ?
            AND NOT EXISTS (SELECT 1 FROM invoices WHERE estimate_id = estimate.id)
            AND EXISTS (
              SELECT 1 FROM estimate_command_ledger command
              WHERE command.estimate_id = estimate.id AND command.command_id = ?
                AND command.input_fingerprint = ? AND command.invoice_id = ?
                AND command.completed = 0
            )`,
        params: [
          input.invoiceId,
          input.createdByUserId,
          input.number,
          input.issueDate,
          input.dueDate,
          input.paymentTerms,
          input.occurredAt,
          input.occurredAt,
          input.estimateId,
          input.expectedVersion,
          input.commandId,
          inputFingerprint,
          input.invoiceId,
        ],
      },
      {
        text: `INSERT INTO invoice_line_items (
          invoice_id, position, kind, description, quantity, unit_price_cents,
          amount_cents, taxed, taxed2, project_id, created_at, updated_at
        ) SELECT ?, line.position, line.kind, line.description, line.quantity,
          line.unit_price_cents, line.amount_cents, line.taxed, line.taxed2, NULL, ?, ?
          FROM estimate_line_items line
          WHERE line.estimate_id = ?
            AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND estimate_id = ?)
            AND NOT EXISTS (SELECT 1 FROM invoice_line_items WHERE invoice_id = ?)`,
        params: [
          input.invoiceId,
          input.occurredAt,
          input.occurredAt,
          input.estimateId,
          input.invoiceId,
          input.estimateId,
          input.invoiceId,
        ],
      },
      {
        text: `INSERT INTO estimate_messages (
          id, estimate_id, recipients, send_me_a_copy, event_type, created_at, updated_at
        ) SELECT ?, ?, '[]', 0, 'invoice', ?, ?
          WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ? AND estimate_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM estimate_messages
              WHERE estimate_id = ? AND event_type = 'invoice'
            )
            AND EXISTS (
              SELECT 1 FROM estimate_command_ledger
              WHERE estimate_id = ? AND command_id = ? AND input_fingerprint = ?
                AND message_id = ? AND completed = 0
            )`,
        params: [
          input.messageId,
          input.estimateId,
          input.occurredAt,
          input.occurredAt,
          input.invoiceId,
          input.estimateId,
          input.estimateId,
          input.estimateId,
          input.commandId,
          inputFingerprint,
          input.messageId,
        ],
      },
      {
        text: `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          command_id, event_index, payload_json, occurred_at, available_at
        ) SELECT command.event_id, 'invoice', invoice.id, sequence.next_sequence,
          'invoice.created', command.command_id, 0,
          json_object(
            'schema_version', 1,
            'event_id', command.event_id,
            'event_type', 'invoice.created',
            'occurred_at', command.occurred_at,
            'aggregate', json_object(
              'type', 'invoice', 'id', invoice.id, 'sequence', sequence.next_sequence
            ),
            'command', json_object(
              'id', command.command_id, 'kind', command.command_kind, 'event_index', 0
            ),
            'actor', json_object('type', 'user', 'id', command.actor_user_id),
            'trigger', json_object('type', 'estimate_message', 'id', command.message_id),
            'invoice', json_object(
              'before', NULL,
              'after', json_object(
                'version', invoice.version, 'updated_at', invoice.updated_at,
                'state', invoice.state, 'close_reason', invoice.close_reason,
                'close_write_off_cents', invoice.close_write_off_cents,
                'sent_at', invoice.sent_at, 'paid_at', invoice.paid_at,
                'paid_date', invoice.paid_date, 'closed_at', invoice.closed_at,
                'amount_cents', invoice.amount_cents,
                'due_amount_cents', invoice.due_amount_cents,
                'written_off_cents', invoice.written_off_cents,
                'payment_count', 0, 'payment_status', 'unpaid'
              )
            ),
            'payment', json_object('before', NULL, 'after', NULL)
          ), command.occurred_at, command.occurred_at
          FROM estimate_command_ledger command
          JOIN invoices invoice ON invoice.id = command.invoice_id
          CROSS JOIN (
            SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
            FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?
          ) sequence
          WHERE command.estimate_id = ? AND command.command_id = ?
            AND command.input_fingerprint = ? AND command.completed = 0
            AND EXISTS (
              SELECT 1 FROM estimate_messages message
              WHERE message.id = command.message_id AND message.estimate_id = command.estimate_id
                AND message.event_type = 'invoice'
            )`,
        params: [input.invoiceId, input.estimateId, input.commandId, inputFingerprint],
      },
      {
        text: `UPDATE estimate_command_ledger SET
          completed = 1,
          result_json = json_object(
            'schema_version', 1, 'estimate_id', estimate_id,
            'invoice_id', invoice_id, 'message_id', message_id, 'event_id', event_id
          ),
          completed_at = ?
          WHERE estimate_id = ? AND command_id = ? AND input_fingerprint = ?
            AND completed = 0
            AND EXISTS (
              SELECT 1 FROM invoices invoice
              WHERE invoice.id = estimate_command_ledger.invoice_id
                AND invoice.estimate_id = estimate_command_ledger.estimate_id
            )
            AND EXISTS (
              SELECT 1 FROM estimate_messages message
              WHERE message.id = estimate_command_ledger.message_id
                AND message.estimate_id = estimate_command_ledger.estimate_id
                AND message.event_type = 'invoice'
            )
            AND EXISTS (
              SELECT 1 FROM event_outbox event
              WHERE event.id = estimate_command_ledger.event_id
                AND event.aggregate_type = 'invoice'
                AND event.aggregate_id = estimate_command_ledger.invoice_id
                AND event.command_id = estimate_command_ledger.command_id
                AND event.event_index = 0
            )`,
        params: [input.occurredAt, input.estimateId, input.commandId, inputFingerprint],
      },
    ]
    try {
      await runAtomic(this.database, conversionStatements)
    } catch (error) {
      // Another request can commit after the read preflight but before this
      // batch obtains the write lock. Resolve that race through the durable
      // receipt; unrelated database failures retain their original error.
      const racedResult = await replayCurrentReceipt()
      if (racedResult !== null) return racedResult
      if (
        (await first<{ id: number }>(this.database, {
          text: `SELECT id FROM invoices WHERE estimate_id = ? ORDER BY id LIMIT 1`,
          params: [input.estimateId],
        })) !== null ||
        (await first<{ id: number }>(this.database, {
          text: `SELECT id FROM estimate_messages
            WHERE estimate_id = ? AND event_type = 'invoice' ORDER BY id LIMIT 1`,
          params: [input.estimateId],
        })) !== null
      ) {
        throw new MoneyResourceOperationError(
          'estimate_already_converted',
          'estimate already has conversion provenance',
        )
      }
      if (
        (await first<{ value: number }>(this.database, {
          text: `SELECT 1 AS value WHERE
            EXISTS (SELECT 1 FROM estimate_messages WHERE id = ?)
            OR EXISTS (SELECT 1 FROM invoices WHERE id = ?)
            OR EXISTS (SELECT 1 FROM event_outbox WHERE id = ?)
            OR EXISTS (SELECT 1 FROM estimate_command_ledger
              WHERE message_id = ? OR invoice_id = ? OR event_id = ?)`,
          params: [
            input.messageId,
            input.invoiceId,
            input.eventId,
            input.messageId,
            input.invoiceId,
            input.eventId,
          ],
        })) !== null
      ) {
        throw new MoneyResourceOperationError(
          'command_id_reused',
          'estimate conversion identity is already occupied',
        )
      }
      throw error
    }

    const [invoiceRow, eventRow, estimate, receipt] = await Promise.all([
      first<RawInvoice>(this.database, {
        text: `${invoiceSelect} WHERE id = ? AND estimate_id = ?`,
        params: [input.invoiceId, input.estimateId],
      }),
      first<RawEstimateMessage>(this.database, {
        text: `${estimateMessageSelect} WHERE id = ? AND estimate_id = ? AND event_type = 'invoice'`,
        params: [input.messageId, input.estimateId],
      }),
      this.getEstimate(input.estimateId),
      readReceipt(),
    ])
    if (receipt !== null) assertEstimateCommandReceipt(receipt, expectedReceipt)
    if (invoiceRow !== null && eventRow !== null && receipt !== null) {
      return {
        invoice: await hydrateInvoice(this.database, invoiceRow),
        event: hydrateEstimateMessage(eventRow),
      }
    }
    if (estimate === null) {
      throw new MoneyResourceOperationError('estimate_not_found', 'estimate does not exist')
    }
    if (
      (await first<{ id: number }>(this.database, {
        text: `SELECT id FROM invoices WHERE estimate_id = ? ORDER BY id LIMIT 1`,
        params: [input.estimateId],
      })) !== null ||
      (await first<{ id: number }>(this.database, {
        text: `SELECT id FROM estimate_messages
          WHERE estimate_id = ? AND event_type = 'invoice' ORDER BY id LIMIT 1`,
        params: [input.estimateId],
      })) !== null
    ) {
      const racedResult = await replayCurrentReceipt()
      if (racedResult !== null) return racedResult
      throw new MoneyResourceOperationError(
        'estimate_already_converted',
        'estimate already has conversion provenance',
      )
    }
    if (estimate.version !== input.expectedVersion) {
      throw new MoneyResourceOperationError(
        'estimate_version_conflict',
        'estimate version no longer matches',
      )
    }
    throw new MoneyResourceOperationError(
      'estimate_state_conflict',
      'only an accepted estimate can be converted',
    )
  }

  async listMessages(invoiceId: number): Promise<InvoiceMessageResource[] | null> {
    if ((await this.getInvoice(invoiceId)) === null) return null
    return (
      await all<RawMessage>(this.database, {
        text: `SELECT id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
          recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
          send_reminder_on, event_type, delivery_status, provider_message_id,
          created_at, updated_at FROM invoice_messages
          WHERE invoice_id = ? ORDER BY created_at, id`,
        params: [invoiceId],
      })
    ).map(hydrateMessage)
  }

  async listPayments(invoiceId: number): Promise<InvoicePaymentResource[] | null> {
    if ((await this.getInvoice(invoiceId)) === null) return null
    return all(this.database, {
      text: `SELECT id, invoice_id, currency, amount_cents, paid_at, paid_date, notes,
        recorded_by_user_id, provider, provider_shape, provider_account_id,
        provider_transaction_id, bank_deposit_id, created_at, updated_at
        FROM invoice_payments WHERE invoice_id = ? ORDER BY id`,
      params: [invoiceId],
    })
  }

  async senderSnapshot(userId: number): Promise<{
    name: string
    email: string | null
  } | null> {
    assertPositiveId(userId, 'user id')
    return first(this.database, {
      text: `SELECT trim(user.first_name || ' ' || user.last_name) AS name,
        email.address AS email FROM users user
        LEFT JOIN user_emails email ON email.user_id = user.id
          AND email.is_primary = 1 AND email.invalidated_at IS NULL
        WHERE user.id = ?`,
      params: [userId],
    })
  }

  executeLifecycle(input: ExecuteInvoiceLifecycleCommand): Promise<InvoiceCommandResult> {
    return executeInvoiceLifecycleCommand(this.database, input)
  }

  executeEdit(input: ExecuteInvoiceEditCommand): Promise<InvoiceCommandResult> {
    return executeInvoiceEdit(this.database, input)
  }

  recordPayment(input: RecordInvoicePaymentCommand): Promise<InvoiceCommandResult> {
    return recordInvoicePayment(this.database, input)
  }

  updatePayment(input: UpdateInvoicePaymentCommand): Promise<InvoiceCommandResult> {
    return updateInvoicePayment(this.database, input)
  }

  deletePayment(input: DeleteInvoicePaymentCommand): Promise<InvoiceCommandResult> {
    return deleteInvoicePayment(this.database, input)
  }

  async listRetainers(window: MoneyWindow): Promise<RetainerResource[]> {
    const rows = await all<RawRetainer>(this.database, {
      text: `${retainerSelect} WHERE retainer.id > ? AND retainer.id <= ?
        ORDER BY retainer.id LIMIT ?`,
      params: [window.afterId ?? 0, window.throughId, window.take],
    })
    return rows.map((row) => ({ ...row, balance: row.balance ?? 0 }))
  }

  async getRetainer(id: number): Promise<RetainerResource | null> {
    assertPositiveId(id, 'retainer id')
    const row = await first<RawRetainer>(this.database, {
      text: `${retainerSelect} WHERE retainer.id = ?`,
      params: [id],
    })
    return row === null ? null : { ...row, balance: row.balance ?? 0 }
  }

  async createRetainer(input: CreateRetainerInput): Promise<RetainerResource> {
    assertTimestamp(input.occurredAt, 'occurredAt')
    if (input.clientId !== null) assertPositiveId(input.clientId, 'clientId')
    if (input.projectId !== null) assertPositiveId(input.projectId, 'projectId')
    const created = await first<{ id: number }>(this.database, {
      text: `INSERT INTO retainers (
        client_id, project_id, denomination, amount_cents, seconds,
        locked_rate_cents, rate_locked_at, period, rollover, expires_at,
        on_exhaustion, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      params: [
        input.clientId,
        input.projectId,
        input.denomination,
        input.amountCents,
        input.seconds,
        input.lockedRateCents,
        input.rateLockedAt,
        input.period,
        input.rollover,
        input.expiresAt,
        input.onExhaustion,
        input.occurredAt,
        input.occurredAt,
      ],
    })
    if (created === null) throw new Error('retainer creation did not return an id')
    return (
      (await this.getRetainer(created.id)) ??
      (() => {
        throw new Error('retainer missing')
      })()
    )
  }

  async updateRetainer(id: number, input: UpdateRetainerInput): Promise<RetainerResource | null> {
    assertPositiveId(id, 'retainer id')
    assertTimestamp(input.occurredAt, 'occurredAt')
    const current = await this.getRetainer(id)
    if (current === null) return null
    await run(this.database, {
      text: `UPDATE retainers SET state = ?, period = ?, rollover = ?, expires_at = ?,
        on_exhaustion = ?, updated_at = ? WHERE id = ?`,
      params: [
        input.state ?? current.state,
        input.period === undefined ? current.period : input.period,
        input.rollover === undefined ? current.rollover : input.rollover,
        input.expiresAt === undefined ? current.expires_at : input.expiresAt,
        input.onExhaustion ?? current.on_exhaustion,
        input.occurredAt,
        id,
      ],
    })
    return this.getRetainer(id)
  }

  async listRetainerLedger(retainerId: number): Promise<RetainerLedgerEntry[] | null> {
    if ((await this.getRetainer(retainerId)) === null) return null
    return all(this.database, {
      text: `SELECT id, retainer_id AS "retainerId", kind, unit, amount,
        invoice_id AS "invoiceId", occurred_on AS "occurredOn", notes,
        created_at AS "createdAt" FROM retainer_ledger
        WHERE retainer_id = ? ORDER BY occurred_on, id`,
      params: [retainerId],
    })
  }

  async appendRetainerLedger(input: AppendRetainerLedgerEntryInput): Promise<{
    entry: RetainerLedgerEntry
    balance: number
    denomination: 'money' | 'hours'
  }> {
    const entry = await appendRetainerLedgerEntry(this.database, input)
    const balance = await getRetainerBalance(this.database, input.retainerId)
    return { entry, balance: balance.balance, denomination: balance.denomination }
  }

  async listRecurring(window: MoneyWindow): Promise<RecurringInvoiceResource[]> {
    return (
      await all<RawRecurring>(this.database, {
        text: `${recurringSelect} AND id > ? AND id <= ? ORDER BY id LIMIT ?`,
        params: [window.afterId ?? 0, window.throughId, window.take],
      })
    ).map(hydrateRecurring)
  }

  async getRecurring(id: number): Promise<RecurringInvoiceResource | null> {
    assertPositiveId(id, 'recurring invoice id')
    const row = await first<RawRecurring>(this.database, {
      text: `${recurringSelect} AND id = ?`,
      params: [id],
    })
    return row === null ? null : hydrateRecurring(row)
  }

  async createRecurring(input: RecurringInvoiceInput): Promise<RecurringInvoiceResource> {
    this.validateRecurringInput(input)
    const created = await first<{ id: number }>(this.database, {
      text: `INSERT INTO recurring_invoices (
        client_id, definition_status, subject_template, notes_template,
        every_n_months, day_of_month, next_issue_on, amount_config,
        can_draw_from_retainer_id, created_at, updated_at
      ) VALUES (?, 'complete', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      params: [
        input.clientId,
        input.subjectTemplate,
        input.notesTemplate,
        input.everyNMonths,
        input.dayOfMonth,
        input.nextIssueOn,
        JSON.stringify(input.amountConfig),
        input.canDrawFromRetainerId,
        input.occurredAt,
        input.occurredAt,
      ],
    })
    if (created === null) throw new Error('recurring invoice creation did not return an id')
    return (
      (await this.getRecurring(created.id)) ??
      (() => {
        throw new Error('definition missing')
      })()
    )
  }

  async updateRecurring(
    id: number,
    input: RecurringInvoiceInput,
  ): Promise<RecurringInvoiceResource | null> {
    assertPositiveId(id, 'recurring invoice id')
    this.validateRecurringInput(input)
    const result = await run(this.database, {
      text: `UPDATE recurring_invoices SET client_id = ?, subject_template = ?,
        notes_template = ?, every_n_months = ?, day_of_month = ?, next_issue_on = ?,
        amount_config = ?, can_draw_from_retainer_id = ?, updated_at = ?
        WHERE id = ? AND definition_status = 'complete'`,
      params: [
        input.clientId,
        input.subjectTemplate,
        input.notesTemplate,
        input.everyNMonths,
        input.dayOfMonth,
        input.nextIssueOn,
        JSON.stringify(input.amountConfig),
        input.canDrawFromRetainerId,
        input.occurredAt,
        id,
      ],
    })
    return result.changes === 0 ? null : this.getRecurring(id)
  }

  async deleteRecurring(id: number): Promise<boolean> {
    assertPositiveId(id, 'recurring invoice id')
    return (
      (
        await run(this.database, {
          text: `DELETE FROM recurring_invoices WHERE id = ? AND definition_status = 'complete'`,
          params: [id],
        })
      ).changes === 1
    )
  }

  private validateRecurringInput(input: RecurringInvoiceInput): void {
    assertPositiveId(input.clientId, 'clientId')
    if (input.canDrawFromRetainerId !== null) {
      assertPositiveId(input.canDrawFromRetainerId, 'canDrawFromRetainerId')
    }
    if (input.subjectTemplate.trim().length === 0) {
      throw new TypeError('subjectTemplate must be non-empty')
    }
    if (!Number.isSafeInteger(input.everyNMonths) || input.everyNMonths < 1) {
      throw new RangeError('everyNMonths must be positive')
    }
    if (!Number.isSafeInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      throw new RangeError('dayOfMonth must be 1 through 31')
    }
    assertRecurringAmountConfig(input.amountConfig)
    assertTimestamp(input.occurredAt, 'occurredAt')
  }
}

export const createMoneyResourceRepository = (
  database: MoneyResourceDatabase,
): MoneyResourceRepository => new MoneyResourceRepository(database)
