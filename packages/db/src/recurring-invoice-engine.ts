import { calculateInvoiceLineAmountCents } from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  assertRecurringAmountConfig,
  type RecurringAmountConfig,
  type RecurringFixedLinesConfigV1,
} from './recurring-invoices.js'
import { assertStaticRecurringAttachmentPolicy } from './attachments.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type RecurringEngineDatabase = ContainerDatabase | WorkerDatabase

export type RecurringEngineErrorCode =
  | 'invalid_definition'
  | 'not_due'
  | 'already_generated'
  | 'retainer_overdraw'
  | 'forbidden'
  | 'definition_not_found'

export class RecurringEngineError extends Error {
  readonly code: RecurringEngineErrorCode

  constructor(code: RecurringEngineErrorCode, message: string) {
    super(message)
    this.name = 'RecurringEngineError'
    this.code = code
  }
}

export interface RecurringGenerationPrincipal {
  userId: number
  profile: string
}

export interface RecurringGenerationResult {
  invoiceId: number
  definitionId: number
  period: string
  nextIssueOn: string
  retainerDrawdownCents: number | null
}

interface SqlStatement {
  text: string
  params: Array<string | number | null>
}

interface StoredDefinition {
  id: number
  clientId: number
  definitionStatus: string
  subjectTemplate: string | null
  notesTemplate: string | null
  everyNMonths: number | null
  dayOfMonth: number | null
  nextIssueOn: string | null
  amountConfig: string | null
  attachmentPolicy: string | null
  canDrawFromRetainerId: number | null
}

interface ClientDefaults {
  id: number
  currency: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
}

const centsLimit = 9_000_000_000_000
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const moneyProfiles = new Set(['accounting', 'executive_manager', 'administrator'])

const assertTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  if (match === null) throw new RecurringEngineError('invalid_definition', 'clock must return a canonical UTC timestamp')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(
    match[7] ?? ''
  ).padEnd(3, '0')}Z`
  const instant = Date.parse(normalized)
  if (!Number.isSafeInteger(instant) || new Date(instant).toISOString() !== normalized) {
    throw new RecurringEngineError('invalid_definition', 'clock must return a real canonical UTC timestamp')
  }
}

export const anchoredDate = (dayOfMonth: number, year: number, month: number): string => {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(dayOfMonth, lastDay)
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

export const advanceIssueDate = (
  nextIssueOn: string,
  everyNMonths: number,
  dayOfMonth: number,
): string => {
  const [yearStr, monthStr] = nextIssueOn.split('-')
  let year = Number(yearStr)
  let month = Number(monthStr) + everyNMonths
  while (month > 12) {
    month -= 12
    year += 1
  }
  return anchoredDate(dayOfMonth, year, month)
}

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const stableId = async (namespace: string, key: string, suffix = ''): Promise<number> =>
  Number.parseInt((await digest(`${namespace}${key}${suffix}`)).slice(0, 13), 16) + 1

const idempotencyKey = (definitionId: number, period: string): string =>
  `recurring:${definitionId}:${period}`

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: RecurringEngineDatabase,
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
  database: RecurringEngineDatabase,
  statements: readonly SqlStatement[],
): Promise<void> => {
  const client = database.$client
  if (isD1Client(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return
  }
  client
    .transaction(() => {
      for (const statement of statements) client.prepare(statement.text).run(...statement.params)
    })
    .immediate()
}

const templateSubject = (template: string, issueDate: string): string => {
  const date = new Date(`${issueDate}T00:00:00.000Z`)
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return template
    .replace(/%invoice_issue_month_name%/g, monthNames[date.getUTCMonth()]!)
    .replace(/%invoice_issue_year%/g, String(date.getUTCFullYear()))
    .replace(/%invoice_issue_date%/g, issueDate)
}

const dueDate = (issueDate: string, terms: ClientDefaults['paymentTerms']): string => {
  const days =
    terms === 'net_15'
      ? 15
      : terms === 'net_30'
        ? 30
        : terms === 'net_45'
          ? 45
          : terms === 'net_60'
            ? 60
            : 0
  const value = new Date(`${issueDate}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const checkedSum = (values: readonly number[]): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < 0n || sum > BigInt(centsLimit)) {
    throw new RecurringEngineError('invalid_definition', 'generated line amounts exceed the invoice cents limit')
  }
  return Number(sum)
}

export interface RecurringEngineOptions {
  clock?: () => string
}

export interface RecurringInvoiceEngine {
  generate(
    definitionId: number,
    asOfDate: string,
    principal: RecurringGenerationPrincipal,
  ): Promise<RecurringGenerationResult>
}

export const createRecurringInvoiceEngine = (
  database: RecurringEngineDatabase,
  options: RecurringEngineOptions = {},
): RecurringInvoiceEngine => ({
  async generate(definitionId, asOfDate, principal) {
    const actor = await first<{ profile: string }>(database, {
      text: 'SELECT profile FROM users WHERE id = ? AND is_active = 1',
      params: [principal.userId],
    })
    if (
      actor === null ||
      actor.profile !== principal.profile ||
      !moneyProfiles.has(actor.profile)
    ) {
      throw new RecurringEngineError('forbidden', 'the acting user cannot generate recurring invoices')
    }

    const definition = await first<StoredDefinition>(database, {
      text: `SELECT id, client_id AS "clientId", definition_status AS "definitionStatus",
          subject_template AS "subjectTemplate", notes_template AS "notesTemplate",
          every_n_months AS "everyNMonths", day_of_month AS "dayOfMonth",
          next_issue_on AS "nextIssueOn", amount_config AS "amountConfig",
          attachment_policy AS "attachmentPolicy",
          can_draw_from_retainer_id AS "canDrawFromRetainerId"
        FROM recurring_invoices WHERE id = ?`,
      params: [definitionId],
    })
    if (definition === null) {
      throw new RecurringEngineError('definition_not_found', `recurring invoice definition ${definitionId} does not exist`)
    }
    if (definition.definitionStatus !== 'complete') {
      throw new RecurringEngineError('invalid_definition', 'definition is incomplete')
    }
    if (
      definition.subjectTemplate === null ||
      definition.everyNMonths === null ||
      definition.dayOfMonth === null ||
      definition.nextIssueOn === null ||
      definition.amountConfig === null
    ) {
      throw new RecurringEngineError('invalid_definition', 'complete definition has null required fields')
    }

    let parsedConfig: unknown
    try {
      parsedConfig = JSON.parse(definition.amountConfig)
    } catch {
      throw new RecurringEngineError('invalid_definition', 'amountConfig is not valid JSON')
    }
    assertRecurringAmountConfig(parsedConfig)

    if (definition.attachmentPolicy !== null) {
      let parsedPolicy: unknown
      try {
        parsedPolicy = JSON.parse(definition.attachmentPolicy)
      } catch {
        throw new RecurringEngineError('invalid_definition', 'attachmentPolicy is not valid JSON')
      }
      assertStaticRecurringAttachmentPolicy(parsedPolicy)
    }

    if (definition.nextIssueOn > asOfDate) {
      throw new RecurringEngineError('not_due', `definition ${definitionId} is not due until ${definition.nextIssueOn}`)
    }

    const period = definition.nextIssueOn
    const commandId = idempotencyKey(definitionId, period)
    const invoiceId = await stableId('recurring-generation', commandId)

    const existing = await first<{ completed: number | boolean; invoiceId: number }>(database, {
      text: `SELECT completed, invoice_id AS "invoiceId"
        FROM invoice_command_ledger WHERE command_id = ?`,
      params: [commandId],
    })
    if (existing !== null) {
      if (existing.completed) {
        const nextIssueOn = advanceIssueDate(period, definition.everyNMonths, definition.dayOfMonth)
        return {
          invoiceId: existing.invoiceId,
          definitionId,
          period,
          nextIssueOn,
          retainerDrawdownCents: null,
        }
      }
      throw new RecurringEngineError('already_generated', 'recurring generation command is in progress')
    }

    const client = await first<ClientDefaults>(database, {
      text: `SELECT id, upper(currency) AS currency, payment_terms AS "paymentTerms"
        FROM clients WHERE id = ?`,
      params: [definition.clientId],
    })
    if (client === null) {
      throw new RecurringEngineError('invalid_definition', 'the definition client does not exist')
    }

    const amountConfig = parsedConfig as RecurringAmountConfig
    if (amountConfig.type !== 'fixed_lines') {
      throw new RecurringEngineError(
        'invalid_definition',
        'only fixed_lines recurring invoices can be generated in this release',
      )
    }

    const fixedConfig = amountConfig as RecurringFixedLinesConfigV1
    const issueDate = period
    const subject = templateSubject(definition.subjectTemplate, issueDate)
    const notes = definition.notesTemplate ?? ''

    const lines = fixedConfig.line_items.map((item, position) => {
      const amountCents = calculateInvoiceLineAmountCents(item.quantity, item.unit_price_cents)
      return { ...item, position, amountCents }
    })
    const totalAmountCents = checkedSum(lines.map((l) => l.amountCents))

    const occurredAt = (options.clock ?? (() => new Date().toISOString()))()
    assertTimestamp(occurredAt)

    const fingerprint = `sha256:${await digest(
      JSON.stringify({
        command_id: commandId,
        definition_id: definitionId,
        period,
        amount_config_type: amountConfig.type,
      }),
    )}`

    const eventId = `evt_${await digest(`recurring-generation-event${commandId}`)}`
    const nextIssueOn = advanceIssueDate(period, definition.everyNMonths, definition.dayOfMonth)

    let retainerDrawdownCents: number | null = null
    const statements: SqlStatement[] = []

    statements.push({
      text: `INSERT INTO invoice_command_ledger (
          invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
          expected_invoice_version, occurred_at, request_json
        ) VALUES (?, ?, 'recurring.generate', ?, 'user', ?, 0, ?, ?)`,
      params: [
        invoiceId,
        commandId,
        fingerprint,
        principal.userId,
        occurredAt,
        JSON.stringify({
          schema_version: 1,
          definition_id: definitionId,
          period,
          day_of_month: definition.dayOfMonth,
          every_n_months: definition.everyNMonths,
        }),
      ],
    })

    const projectId = lines.length === 1 && lines[0]!.project_id !== null ? lines[0]!.project_id : null

    statements.push({
      text: `INSERT INTO invoices (
          id, client_id, created_by_user_id, number, subject, notes, currency,
          issue_date, due_date, payment_terms, recurring_invoice_id, project_id,
          created_at, updated_at
        ) SELECT ?, ?, ?, CAST(sequence.next_number AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM invoice_number_sequence sequence
        WHERE sequence.singleton = 1
          AND EXISTS (
            SELECT 1 FROM users WHERE id = ? AND is_active = 1
              AND profile IN ('accounting','executive_manager','administrator')
          )
          AND EXISTS (SELECT 1 FROM clients WHERE id = ?)
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'recurring.generate'
              AND command.completed = 0
          )`,
      params: [
        invoiceId,
        definition.clientId,
        principal.userId,
        subject,
        notes,
        client.currency,
        issueDate,
        dueDate(issueDate, client.paymentTerms),
        client.paymentTerms,
        definitionId,
        projectId,
        occurredAt,
        occurredAt,
        principal.userId,
        definition.clientId,
        invoiceId,
        commandId,
      ],
    })

    for (const [index, line] of lines.entries()) {
      const lineId = await stableId('recurring-generation-line', commandId, String(index))
      statements.push({
        text: `INSERT INTO invoice_line_items (
            id, invoice_id, position, kind, description, quantity, unit_price_cents,
            amount_cents, taxed, taxed2, project_id, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'recurring.generate' AND command.completed = 0
          )`,
        params: [
          lineId,
          invoiceId,
          line.position,
          line.kind,
          line.description,
          line.quantity,
          line.unit_price_cents,
          line.amountCents,
          line.taxed ? 1 : 0,
          line.taxed2 ? 1 : 0,
          line.project_id,
          occurredAt,
          occurredAt,
          invoiceId,
          commandId,
        ],
      })
    }

    if (definition.canDrawFromRetainerId !== null) {
      const balance = await first<{ balance: number; denomination: string }>(database, {
        text: `SELECT balance, denomination FROM retainer_balances WHERE retainer_id = ?`,
        params: [definition.canDrawFromRetainerId],
      })
      if (balance !== null && balance.denomination === 'money' && balance.balance > 0) {
        retainerDrawdownCents = Math.min(totalAmountCents, balance.balance)
        if (retainerDrawdownCents > 0) {
          const ledgerId = `recurring:${definitionId}:${period}:drawdown`
          statements.push({
            text: `INSERT INTO retainer_ledger (
                id, retainer_id, kind, unit, amount, invoice_id, occurred_on, notes, created_at
              ) SELECT ?, ?, 'drawdown', 'cents', ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM invoice_command_ledger command
                WHERE command.invoice_id = ? AND command.command_id = ?
                  AND command.command_kind = 'recurring.generate' AND command.completed = 0
              )`,
            params: [
              ledgerId,
              definition.canDrawFromRetainerId,
              -retainerDrawdownCents,
              invoiceId,
              issueDate,
              `Recurring invoice generation for period ${period}`,
              occurredAt,
              invoiceId,
              commandId,
            ],
          })
        }
      }
    }

    const eventPayload = JSON.stringify({
      schema_version: 1,
      event_id: eventId,
      event_type: 'invoice.created',
      occurred_at: occurredAt,
      aggregate: { type: 'invoice', id: invoiceId, sequence: 0 },
      command: { id: commandId, kind: 'recurring.generate', event_index: 0 },
      actor: { type: 'user', id: principal.userId },
      trigger: { type: 'recurring_invoice', id: definitionId },
      invoice: {
        before: null,
        after: {
          version: 0,
          updated_at: occurredAt,
          state: 'draft',
          amount_cents: totalAmountCents,
          due_amount_cents: totalAmountCents,
        },
      },
    })

    statements.push({
      text: `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          command_id, event_index, payload_json, occurred_at, available_at
        ) SELECT ?, 'invoice', ?, sequence.next_sequence, 'invoice.created', ?, 0,
          json_set(?, '$.aggregate.sequence', sequence.next_sequence), ?, ?
        FROM (
          SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
          FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?
        ) sequence
        WHERE EXISTS (
          SELECT 1 FROM invoice_command_ledger command
          WHERE command.invoice_id = ? AND command.command_id = ?
            AND command.command_kind = 'recurring.generate' AND command.completed = 0
        )`,
      params: [
        eventId,
        invoiceId,
        commandId,
        eventPayload,
        occurredAt,
        occurredAt,
        invoiceId,
        invoiceId,
        commandId,
      ],
    })

    statements.push({
      text: `UPDATE invoice_command_ledger SET
          completed_at = occurred_at,
          completed = 1,
          event_count = 1,
          first_aggregate_sequence = (
            SELECT min(aggregate_sequence) FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = ?
              AND event.command_id = ?
          ),
          result_json = json_object(
            'schema_version', 1,
            'definition_id', ?,
            'period', ?,
            'invoice_id', ?,
            'amount_cents', ?
          )
        WHERE invoice_id = ? AND command_id = ? AND completed = 0`,
      params: [
        invoiceId,
        commandId,
        definitionId,
        period,
        invoiceId,
        totalAmountCents,
        invoiceId,
        commandId,
      ],
    })

    statements.push({
      text: `UPDATE recurring_invoices SET next_issue_on = ?, updated_at = ?
        WHERE id = ? AND next_issue_on = ?`,
      params: [nextIssueOn, occurredAt, definitionId, period],
    })

    await runAtomic(database, statements)

    return {
      invoiceId,
      definitionId,
      period,
      nextIssueOn,
      retainerDrawdownCents,
    }
  },
})
