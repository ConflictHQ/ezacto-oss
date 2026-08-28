import { eq } from 'drizzle-orm'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { recurringInvoices } from './schema.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type RecurringInvoiceDatabase = ContainerDatabase | WorkerDatabase

export interface RecurringFixedLineV1 {
  kind: string
  description: string | null
  quantity: number
  unit_price_cents: number
  taxed: boolean
  taxed2: boolean
  project_id: number | null
}

export interface RecurringFixedLinesConfigV1 {
  schema_version: 1
  type: 'fixed_lines'
  line_items: RecurringFixedLineV1[]
}

export interface RecurringTimeImportV1 {
  summary_type: 'project' | 'task' | 'people' | 'detailed'
}

export interface RecurringExpenseImportV1 {
  summary_type: 'project' | 'category' | 'people' | 'detailed'
}

export interface RecurringLineItemsImportConfigV1 {
  schema_version: 1
  type: 'line_items_import'
  project_ids: number[]
  time?: RecurringTimeImportV1
  expenses?: RecurringExpenseImportV1
}

export type RecurringAmountConfig = RecurringFixedLinesConfigV1 | RecurringLineItemsImportConfigV1

export interface CreateRecurringInvoiceDefinitionInput {
  clientId: number
  subjectTemplate: string
  notesTemplate: string
  everyNMonths: number
  dayOfMonth: number
  nextIssueOn: string
  amountConfig: RecurringAmountConfig
  canDrawFromRetainerId?: number | null
  createdAt: string
  updatedAt: string
}

export type RecurringInvoiceDefinition = typeof recurringInvoices.$inferSelect

const centsLimit = 9_000_000_000_000
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalDate = (value: string, field: string): void => {
  const match = datePattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical YYYY-MM-DD date`)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new RangeError(`${field} must be a real calendar date`)
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  field: string,
): void => {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${field} has missing or unknown fields`)
  }
}

const assertFixedLine = (value: unknown, index: number): void => {
  const field = `amountConfig.line_items[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(
    value,
    ['kind', 'description', 'quantity', 'unit_price_cents', 'taxed', 'taxed2', 'project_id'],
    [],
    field,
  )
  if (typeof value.kind !== 'string' || value.kind.trim().length === 0) {
    throw new TypeError(`${field}.kind must be a non-empty string`)
  }
  if (value.description !== null && typeof value.description !== 'string') {
    throw new TypeError(`${field}.description must be a string or null`)
  }
  if (
    typeof value.quantity !== 'number' ||
    !Number.isFinite(value.quantity) ||
    value.quantity <= 0 ||
    value.quantity > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(`${field}.quantity must be positive and bounded`)
  }
  if (
    typeof value.unit_price_cents !== 'number' ||
    !Number.isSafeInteger(value.unit_price_cents) ||
    Math.abs(value.unit_price_cents) > centsLimit
  ) {
    throw new RangeError(`${field}.unit_price_cents must be bounded integer cents`)
  }
  if (typeof value.taxed !== 'boolean' || typeof value.taxed2 !== 'boolean') {
    throw new TypeError(`${field} tax flags must be booleans`)
  }
  if (value.project_id !== null) {
    assertPositiveSafeInteger(value.project_id as number, `${field}.project_id`)
  }
}

const timeSummaryTypes = new Set(['project', 'task', 'people', 'detailed'])
const expenseSummaryTypes = new Set(['project', 'category', 'people', 'detailed'])

export const assertRecurringAmountConfig: (
  value: unknown,
) => asserts value is RecurringAmountConfig = (value) => {
  if (!isRecord(value)) throw new TypeError('amountConfig must be an object')
  if (value.schema_version !== 1) {
    throw new RangeError('amountConfig.schema_version must be 1')
  }
  if (value.type === 'fixed_lines') {
    assertExactKeys(value, ['schema_version', 'type', 'line_items'], [], 'amountConfig')
    if (!Array.isArray(value.line_items) || value.line_items.length === 0) {
      throw new TypeError('fixed_lines amountConfig requires at least one line item')
    }
    value.line_items.forEach(assertFixedLine)
    return
  }
  if (value.type !== 'line_items_import') {
    throw new TypeError('amountConfig.type must be fixed_lines or line_items_import')
  }
  assertExactKeys(
    value,
    ['schema_version', 'type', 'project_ids'],
    ['time', 'expenses'],
    'amountConfig',
  )
  if (!Array.isArray(value.project_ids) || value.project_ids.length === 0) {
    throw new TypeError('line_items_import requires at least one project id')
  }
  const projectIds = value.project_ids as unknown[]
  projectIds.forEach((projectId, index) =>
    assertPositiveSafeInteger(projectId as number, `amountConfig.project_ids[${index}]`),
  )
  if (new Set(projectIds).size !== projectIds.length) {
    throw new TypeError('line_items_import project ids must be unique')
  }
  if (value.time === undefined && value.expenses === undefined) {
    throw new TypeError('line_items_import requires time or expenses config')
  }
  if (value.time !== undefined) {
    if (!isRecord(value.time)) throw new TypeError('amountConfig.time must be an object')
    assertExactKeys(value.time, ['summary_type'], [], 'amountConfig.time')
    if (!timeSummaryTypes.has(value.time.summary_type as string)) {
      throw new TypeError('amountConfig.time.summary_type is invalid')
    }
  }
  if (value.expenses !== undefined) {
    if (!isRecord(value.expenses)) {
      throw new TypeError('amountConfig.expenses must be an object')
    }
    assertExactKeys(value.expenses, ['summary_type'], [], 'amountConfig.expenses')
    if (!expenseSummaryTypes.has(value.expenses.summary_type as string)) {
      throw new TypeError('amountConfig.expenses.summary_type is invalid')
    }
  }
}

/** Store one complete native definition. Generation and sending are separate stories. */
export const createRecurringInvoiceDefinition = async (
  database: RecurringInvoiceDatabase,
  input: CreateRecurringInvoiceDefinitionInput,
): Promise<RecurringInvoiceDefinition> => {
  assertPositiveSafeInteger(input.clientId, 'clientId')
  if (typeof input.subjectTemplate !== 'string' || input.subjectTemplate.trim().length === 0) {
    throw new TypeError('subjectTemplate must be a non-empty string')
  }
  if (typeof input.notesTemplate !== 'string') {
    throw new TypeError('notesTemplate must be a string')
  }
  assertPositiveSafeInteger(input.everyNMonths, 'everyNMonths')
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    throw new RangeError('dayOfMonth must be an integer from 1 through 31')
  }
  assertCanonicalDate(input.nextIssueOn, 'nextIssueOn')
  assertRecurringAmountConfig(input.amountConfig)
  if (input.canDrawFromRetainerId !== undefined && input.canDrawFromRetainerId !== null) {
    assertPositiveSafeInteger(input.canDrawFromRetainerId, 'canDrawFromRetainerId')
  }
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')

  const [created] = await database
    .insert(recurringInvoices)
    .values({
      clientId: input.clientId,
      definitionStatus: 'complete',
      subjectTemplate: input.subjectTemplate,
      notesTemplate: input.notesTemplate,
      everyNMonths: input.everyNMonths,
      dayOfMonth: input.dayOfMonth,
      nextIssueOn: input.nextIssueOn,
      amountConfig: input.amountConfig,
      canDrawFromRetainerId: input.canDrawFromRetainerId ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .returning()
  if (!created) throw new Error('recurring invoice creation did not return a row')

  const [stored] = await database
    .select()
    .from(recurringInvoices)
    .where(eq(recurringInvoices.id, created.id))
    .limit(1)
  if (!stored) throw new Error('recurring invoice creation did not persist')
  return stored
}
