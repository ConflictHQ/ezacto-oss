import type BetterSqlite3 from 'better-sqlite3'
import type { RecurringAmountConfig, RecurringInvoiceDatabase } from '../recurring-invoices.js'

export interface EnsureHarvestRecurringInvoiceStubInput {
  invoiceId: number
  harvestInvoiceId: number
  harvestRecurringInvoiceId: number
  createdAt: string
  updatedAt: string
}

export interface HarvestRecurringInvoiceDefinition {
  id: number
  harvestId: number
  clientId: number
  definitionStatus: 'complete' | 'incomplete'
  subjectTemplate: string | null
  notesTemplate: string | null
  everyNMonths: number | null
  dayOfMonth: number | null
  nextIssueOn: string | null
  amountConfig: RecurringAmountConfig | null
  canDrawFromRetainerId: number | null
}

type HarvestRecurringInvoiceDefinitionRow = Omit<
  HarvestRecurringInvoiceDefinition,
  'amountConfig'
> & { amountConfig: string | null }

interface SqlStatement {
  text: string
  params: readonly unknown[]
}

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const match = timestampPattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(value)
  const date = new Date(milliseconds)
  if (
    !Number.isFinite(milliseconds) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== Number((match[7] ?? '').padEnd(3, '0') || 0)
  ) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: RecurringInvoiceDatabase,
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
  database: RecurringInvoiceDatabase,
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

/** Import authority: materialize a missing stub or reuse the source definition already completed. */
export const ensureHarvestRecurringInvoiceStub = async (
  database: RecurringInvoiceDatabase,
  input: EnsureHarvestRecurringInvoiceStubInput,
): Promise<HarvestRecurringInvoiceDefinition> => {
  assertPositiveSafeInteger(input.invoiceId, 'invoiceId')
  assertPositiveSafeInteger(input.harvestInvoiceId, 'harvestInvoiceId')
  assertPositiveSafeInteger(input.harvestRecurringInvoiceId, 'harvestRecurringInvoiceId')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')

  const recurringIdLookup = `(SELECT recurring.id FROM recurring_invoices recurring
    JOIN invoices source_invoice ON source_invoice.client_id = recurring.client_id
    WHERE recurring.harvest_id = ? AND source_invoice.id = ?
      AND source_invoice.harvest_id = ?)`
  await runAtomic(database, [
    {
      text: `INSERT INTO recurring_invoices (
          harvest_id, client_id, definition_status, subject_template, notes_template,
          every_n_months, day_of_month, next_issue_on, amount_config,
          can_draw_from_retainer_id, created_at, updated_at
        )
        SELECT ?, invoice.client_id, 'incomplete', NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, ?, ?
        FROM invoices invoice
        WHERE invoice.id = ? AND invoice.harvest_id = ?
          AND invoice.version = 0
          AND NOT EXISTS (
            SELECT 1 FROM invoice_command_ledger command WHERE command.invoice_id = invoice.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM recurring_invoices WHERE harvest_id = ?
          )`,
      params: [
        input.harvestRecurringInvoiceId,
        input.createdAt,
        input.updatedAt,
        input.invoiceId,
        input.harvestInvoiceId,
        input.harvestRecurringInvoiceId,
      ],
    },
    {
      text: `UPDATE invoices
        SET recurring_invoice_id = CASE
          WHEN recurring_invoice_id IS NULL OR recurring_invoice_id = ${recurringIdLookup}
            THEN ${recurringIdLookup}
          ELSE 'recurring-invoice-link-conflict'
        END
        WHERE id = ? AND harvest_id = ? AND version = 0
          AND NOT EXISTS (
            SELECT 1 FROM invoice_command_ledger command WHERE command.invoice_id = invoices.id
          )`,
      params: [
        input.harvestRecurringInvoiceId,
        input.invoiceId,
        input.harvestInvoiceId,
        input.harvestRecurringInvoiceId,
        input.invoiceId,
        input.harvestInvoiceId,
        input.invoiceId,
        input.harvestInvoiceId,
      ],
    },
  ])

  const definition = await first<HarvestRecurringInvoiceDefinitionRow>(database, {
    text: `SELECT recurring.id, recurring.harvest_id AS "harvestId",
        recurring.client_id AS "clientId",
        recurring.definition_status AS "definitionStatus",
        recurring.subject_template AS "subjectTemplate",
        recurring.notes_template AS "notesTemplate",
        recurring.every_n_months AS "everyNMonths",
        recurring.day_of_month AS "dayOfMonth",
        recurring.next_issue_on AS "nextIssueOn",
        recurring.amount_config AS "amountConfig",
        recurring.can_draw_from_retainer_id AS "canDrawFromRetainerId"
      FROM invoices invoice
      JOIN recurring_invoices recurring ON recurring.id = invoice.recurring_invoice_id
      WHERE invoice.id = ? AND invoice.harvest_id = ?
        AND recurring.harvest_id = ?`,
    params: [input.invoiceId, input.harvestInvoiceId, input.harvestRecurringInvoiceId],
  })
  if (definition === null) {
    throw new Error(
      `imported invoice ${input.invoiceId} could not link Harvest recurring invoice ${input.harvestRecurringInvoiceId}`,
    )
  }
  return {
    ...definition,
    amountConfig:
      definition.amountConfig === null
        ? null
        : (JSON.parse(definition.amountConfig) as RecurringAmountConfig),
  }
}
