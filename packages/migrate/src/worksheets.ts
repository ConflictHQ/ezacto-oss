import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import BetterSqlite3 from 'better-sqlite3'
import {
  assertRecurringAmountConfig,
  createContainerDatabase,
  migrateContainer,
  type RecurringAmountConfig,
} from '@ezacto/db'
import {
  completeHarvestRecurringInvoice,
  completeHarvestRetainerBalance,
  type ImportDatabase,
} from '@ezacto/db/importer'
import { assertLoadComplete } from './load.js'
import { readManifest } from './manifest.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import { checksumReportDigest, snapshotDigest, type ChecksumReport } from './verify.js'

const SHA256 = /^[0-9a-f]{64}$/
const CURRENCY = /^[A-Z]{3}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CENTS_LIMIT = 9_000_000_000_000

interface WorksheetHeader {
  version: 1
  snapshot_sha256: string
  manifest_sha256: string
  load_options_sha256: string
  context_sha256: string
  status: WorksheetStatus
}

export interface WorksheetStatus {
  total: number
  completed: number
  pending: number
}

export interface WorksheetInvoiceReference {
  harvest_invoice_id: number
  number: string
  currency: string
}

export interface RetainerWorksheetRow {
  harvest_retainer_id: number
  harvest_client_id: number
  client_name: string
  currency: string
  linked_invoices: WorksheetInvoiceReference[]
  status: 'pending' | 'completed'
  balance_cents: number | null
  occurred_on: string | null
  notes: string | null
}

export interface RetainerWorksheet extends WorksheetHeader {
  kind: 'retainer_balance'
  rows: RetainerWorksheetRow[]
}

export interface WorksheetFixedLine {
  kind: string
  description: string | null
  quantity: number
  unit_price_cents: number
  taxed: boolean
  taxed2: boolean
  harvest_project_id: number | null
}

export interface WorksheetFixedLinesConfig {
  schema_version: 1
  type: 'fixed_lines'
  line_items: WorksheetFixedLine[]
}

export interface WorksheetLineItemsImportConfig {
  schema_version: 1
  type: 'line_items_import'
  harvest_project_ids: number[]
  time?: { summary_type: 'project' | 'task' | 'people' | 'detailed' }
  expenses?: { summary_type: 'project' | 'category' | 'people' | 'detailed' }
}

export type WorksheetRecurringAmountConfig =
  WorksheetFixedLinesConfig | WorksheetLineItemsImportConfig

export interface RecurringInvoiceWorksheetRow {
  harvest_recurring_invoice_id: number
  harvest_client_id: number
  client_name: string
  currency: string
  linked_invoices: WorksheetInvoiceReference[]
  status: 'pending' | 'completed'
  subject_template: string | null
  notes_template: string | null
  every_n_months: number | null
  day_of_month: number | null
  next_issue_on: string | null
  amount_config: WorksheetRecurringAmountConfig | null
  can_draw_from_harvest_retainer_id: number | null
}

export interface RecurringInvoiceWorksheet extends WorksheetHeader {
  kind: 'recurring_invoice_definition'
  rows: RecurringInvoiceWorksheetRow[]
}

export interface WorksheetOptions {
  snapshotDir: string
  databasePath: string
}

export interface WorksheetApplyOptions extends WorksheetOptions {
  inputPath: string
}

export interface WorksheetApplyResult {
  total: number
  completed: number
  replayed: number
  pending: number
  snapshotSha256: string
}

interface Admission {
  snapshotSha256: string
  manifestSha256: string
  loadOptionsJson: string
}

interface Progress {
  snapshotSha256: string
  loadOptionsJson: string
}

interface FlatContextRow {
  harvestId: number
  clientId: number
  harvestClientId: number | null
  clientName: string | null
  currency: string
  invoiceId: number | null
  harvestInvoiceId: number | null
  invoiceNumber: string | null
  invoiceClientId: number | null
  invoiceCurrency: string | null
}

interface ContextRow {
  harvest_id: number
  harvest_client_id: number
  client_name: string
  currency: string
  linked_invoices: WorksheetInvoiceReference[]
}

interface Evidence {
  snapshotSha256: string
  manifestSha256: string
  loadOptionsSha256: string
}

interface CompletionRow {
  kind: string
  harvestId: number
  resourceId: number
  snapshotSha256: string
  contextSha256: string
  inputSha256: string
  inputJson: string
}

interface RetainerTarget {
  id: number
  harvestId: number
  clientId: number | null
  denomination: string
  balance: number | null
  ledgerCount: number
}

interface RecurringTarget {
  id: number
  harvestId: number
  clientId: number
  definitionStatus: string
  subjectTemplate: string | null
  notesTemplate: string | null
  everyNMonths: number | null
  dayOfMonth: number | null
  nextIssueOn: string | null
  amountConfig: string | null
  canDrawFromRetainerId: number | null
}

interface ProjectTarget {
  id: number
  harvestId: number
  clientId: number
}

interface RetainerReference {
  id: number
  harvestId: number
  clientId: number | null
  denomination: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('worksheet contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isRecord(value)) throw new TypeError('worksheet is not JSON serializable')
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

/**
 * Native JSON.parse has already discarded all but the last duplicate member
 * before a reviver sees an object. Worksheets contain financial and identity
 * inputs, so reject that ambiguous source text before parsing it into values.
 * The scanner runs only after JSON.parse has proved the syntax valid; it can
 * therefore stay a small structural walk while JSON.parse remains the source
 * of truth for strings, numbers, escapes, and returned values.
 */
const parseWorksheetJson = (source: string): unknown => {
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new SyntaxError('worksheet input is not valid JSON')
  }

  let offset = 0
  const whitespace = new Set([' ', '\t', '\r', '\n'])
  const skipWhitespace = (): void => {
    while (whitespace.has(source[offset] ?? '')) offset++
  }
  const readString = (): string => {
    const start = offset++
    while (offset < source.length) {
      const character = source[offset++]!
      if (character === '\\') {
        offset++
      } else if (character === '"') {
        return JSON.parse(source.slice(start, offset)) as string
      }
    }
    throw new SyntaxError('worksheet input is not valid JSON')
  }
  const readScalar = (): void => {
    while (
      offset < source.length &&
      !whitespace.has(source[offset]!) &&
      ![',', ']', '}'].includes(source[offset]!)
    ) {
      offset++
    }
  }
  const readValue = (path: string): void => {
    skipWhitespace()
    const character = source[offset]
    if (character === '"') {
      readString()
      return
    }
    if (character === '[') {
      offset++
      skipWhitespace()
      let index = 0
      while (source[offset] !== ']') {
        readValue(`${path}[${index}]`)
        index++
        skipWhitespace()
        if (source[offset] === ',') {
          offset++
          skipWhitespace()
        }
      }
      offset++
      return
    }
    if (character === '{') {
      offset++
      skipWhitespace()
      const keys = new Set<string>()
      while (source[offset] !== '}') {
        const key = readString()
        if (keys.has(key)) {
          throw new SyntaxError(
            `worksheet JSON contains duplicate key ${JSON.stringify(key)} at ${path}`,
          )
        }
        keys.add(key)
        skipWhitespace()
        offset++ // colon; JSON.parse already proved it is present
        readValue(`${path}.${key}`)
        skipWhitespace()
        if (source[offset] === ',') {
          offset++
          skipWhitespace()
        }
      }
      offset++
      return
    }
    readScalar()
  }
  readValue('$')
  return parsed
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  field = 'worksheet',
): void => {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${field} has missing or unknown fields`)
  }
}

const positiveId = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value as number
}

const digest = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new RangeError(`${field} must be a lowercase SHA-256`)
  }
  return value
}

const currency = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !CURRENCY.test(value)) {
    throw new RangeError(`${field} must be an uppercase ISO currency code`)
  }
  return value
}

const canonicalDate = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a date`)
  const match = DATE.exec(value)
  if (match === null) throw new RangeError(`${field} must be a canonical YYYY-MM-DD date`)
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a real calendar date`)
  }
  return value
}

const credentialKeyPattern =
  /(?:^|[^\p{L}\p{N}\p{M}_])["']?(?:authorization|harvest_pat|client_key|statement_key|reference_token)["']?\s*[=:]/iu
const bearerCandidatePattern = /(?:^|[^\p{L}\p{N}\p{M}_])bearer\s+([a-z0-9._~+/=-]+)/giu
const jwtPattern = /^[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}$/i
const opaqueTokenPattern = /^[a-z0-9._~+/=-]{16,}$/i
const secretPattern = {
  test(value: string): boolean {
    if (credentialKeyPattern.test(value)) return true
    bearerCandidatePattern.lastIndex = 0
    for (const match of value.matchAll(bearerCandidatePattern)) {
      const token = match[1]!
      if (
        jwtPattern.test(token) ||
        (opaqueTokenPattern.test(token) &&
          ((/[0-9]/.test(token) && /[._~+/=-]/.test(token)) ||
            (token.length >= 24 &&
              /[a-z]/.test(token) &&
              /[A-Z]/.test(token) &&
              /[0-9]/.test(token))))
      ) {
        return true
      }
    }
    return false
  },
}

const safeText = (
  value: unknown,
  field: string,
  options: { nonBlank?: boolean; nullable?: boolean } = {},
): string | null => {
  if (value === null && options.nullable) return null
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  if (value.length > 100_000) throw new RangeError(`${field} is too long`)
  if (options.nonBlank && value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank`)
  }
  if (secretPattern.test(value)) {
    throw new Error(
      `${field} contains credential-shaped text; worksheet values must be secret-free`,
    )
  }
  return value
}

const displayText = (value: unknown, field: string): string => {
  const source = sourceLabel(value, field)
  return secretPattern.test(source) ? '[redacted]' : source
}

const sourceLabel = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

const sortedIds = (value: unknown, field: string, allowEmpty = false): number[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`)
  }
  const ids = value.map((item, index) => positiveId(item, `${field}[${index}]`))
  for (let index = 1; index < ids.length; index++) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new TypeError(`${field} must contain unique ascending Harvest ids`)
    }
  }
  return ids
}

const invoiceReferences = (value: unknown, field: string): WorksheetInvoiceReference[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`)
  }
  const references = value.map((candidate, index): WorksheetInvoiceReference => {
    if (!isRecord(candidate)) throw new TypeError(`${field}[${index}] must be an object`)
    exactKeys(candidate, ['harvest_invoice_id', 'number', 'currency'], [], `${field}[${index}]`)
    return {
      harvest_invoice_id: positiveId(
        candidate.harvest_invoice_id,
        `${field}[${index}].harvest_invoice_id`,
      ),
      number: displayText(candidate.number, `${field}[${index}].number`),
      currency: currency(candidate.currency, `${field}[${index}].currency`),
    }
  })
  assertUniqueOrdered(
    references.map((reference) => reference.harvest_invoice_id),
    field,
  )
  return references
}

const parseStatus = (value: unknown, rowStatuses?: readonly string[]): WorksheetStatus => {
  if (!isRecord(value)) throw new TypeError('worksheet.status must be an object')
  exactKeys(value, ['total', 'completed', 'pending'], [], 'worksheet.status')
  for (const field of ['total', 'completed', 'pending'] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new RangeError(`worksheet.status.${field} must be a non-negative safe integer`)
    }
  }
  const status = value as unknown as WorksheetStatus
  if (status.total !== status.completed + status.pending) {
    throw new Error('worksheet status counts do not add up')
  }
  if (
    rowStatuses !== undefined &&
    (status.total !== rowStatuses.length ||
      status.completed !== rowStatuses.filter((row) => row === 'completed').length ||
      status.pending !== rowStatuses.filter((row) => row === 'pending').length)
  ) {
    throw new Error('worksheet status counts do not match its rows')
  }
  return status
}

const parseHeader = (value: Record<string, unknown>): WorksheetHeader => ({
  version:
    value.version === 1
      ? 1
      : (() => {
          throw new RangeError('worksheet.version must be 1')
        })(),
  snapshot_sha256: digest(value.snapshot_sha256, 'worksheet.snapshot_sha256'),
  manifest_sha256: digest(value.manifest_sha256, 'worksheet.manifest_sha256'),
  load_options_sha256: digest(value.load_options_sha256, 'worksheet.load_options_sha256'),
  context_sha256: digest(value.context_sha256, 'worksheet.context_sha256'),
  status: parseStatus(value.status),
})

const parseRetainerWorksheet = (value: unknown): RetainerWorksheet => {
  if (!isRecord(value)) throw new TypeError('retainer worksheet must be an object')
  exactKeys(value, [
    'version',
    'kind',
    'snapshot_sha256',
    'manifest_sha256',
    'load_options_sha256',
    'context_sha256',
    'status',
    'rows',
  ])
  if (value.kind !== 'retainer_balance') throw new TypeError('retainer worksheet kind is invalid')
  if (!Array.isArray(value.rows)) throw new TypeError('retainer worksheet rows must be an array')
  const rows = value.rows.map((candidate, index): RetainerWorksheetRow => {
    if (!isRecord(candidate)) throw new TypeError(`rows[${index}] must be an object`)
    exactKeys(
      candidate,
      [
        'harvest_retainer_id',
        'harvest_client_id',
        'client_name',
        'currency',
        'linked_invoices',
        'status',
        'balance_cents',
        'occurred_on',
        'notes',
      ],
      [],
      `rows[${index}]`,
    )
    const balance = candidate.balance_cents
    if (
      balance !== null &&
      (typeof balance !== 'number' ||
        !Number.isSafeInteger(balance) ||
        balance < 0 ||
        balance > CENTS_LIMIT)
    ) {
      throw new RangeError(
        `rows[${index}].balance_cents must be null or bounded non-negative integer cents`,
      )
    }
    const occurred =
      candidate.occurred_on === null
        ? null
        : canonicalDate(candidate.occurred_on, `rows[${index}].occurred_on`)
    const notes = safeText(candidate.notes, `rows[${index}].notes`, {
      nonBlank: true,
      nullable: true,
    })
    return {
      harvest_retainer_id: positiveId(
        candidate.harvest_retainer_id,
        `rows[${index}].harvest_retainer_id`,
      ),
      harvest_client_id: positiveId(
        candidate.harvest_client_id,
        `rows[${index}].harvest_client_id`,
      ),
      client_name: displayText(candidate.client_name, `rows[${index}].client_name`),
      currency: currency(candidate.currency, `rows[${index}].currency`),
      linked_invoices: invoiceReferences(
        candidate.linked_invoices,
        `rows[${index}].linked_invoices`,
      ),
      status:
        candidate.status === 'pending' || candidate.status === 'completed'
          ? candidate.status
          : (() => {
              throw new TypeError(`rows[${index}].status is invalid`)
            })(),
      balance_cents: balance as number | null,
      occurred_on: occurred,
      notes,
    }
  })
  assertUniqueOrdered(
    rows.map((row) => row.harvest_retainer_id),
    'retainer worksheet rows',
  )
  const parsed = { ...parseHeader(value), kind: 'retainer_balance' as const, rows }
  parseStatus(
    value.status,
    rows.map((row) => row.status),
  )
  return parsed
}

const parseSummary = (
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): { summary_type: 'project' | 'task' | 'people' | 'category' | 'detailed' } => {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  exactKeys(value, ['summary_type'], [], field)
  if (typeof value.summary_type !== 'string' || !allowed.has(value.summary_type)) {
    throw new TypeError(`${field}.summary_type is invalid`)
  }
  return {
    summary_type: value.summary_type as 'project' | 'task' | 'people' | 'category' | 'detailed',
  }
}

const parseWorksheetAmountConfig = (
  value: unknown,
  field: string,
): WorksheetRecurringAmountConfig => {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  if (value.schema_version !== 1) throw new RangeError(`${field}.schema_version must be 1`)
  if (value.type === 'fixed_lines') {
    exactKeys(value, ['schema_version', 'type', 'line_items'], [], field)
    if (!Array.isArray(value.line_items) || value.line_items.length === 0) {
      throw new TypeError(`${field}.line_items must be a non-empty array`)
    }
    return {
      schema_version: 1,
      type: 'fixed_lines',
      line_items: value.line_items.map((candidate, index): WorksheetFixedLine => {
        const item = `${field}.line_items[${index}]`
        if (!isRecord(candidate)) throw new TypeError(`${item} must be an object`)
        exactKeys(
          candidate,
          [
            'kind',
            'description',
            'quantity',
            'unit_price_cents',
            'taxed',
            'taxed2',
            'harvest_project_id',
          ],
          [],
          item,
        )
        const kind = safeText(candidate.kind, `${item}.kind`, { nonBlank: true })!
        const description = safeText(candidate.description, `${item}.description`, {
          nullable: true,
        })
        if (
          typeof candidate.quantity !== 'number' ||
          !Number.isFinite(candidate.quantity) ||
          candidate.quantity <= 0 ||
          candidate.quantity > Number.MAX_SAFE_INTEGER
        ) {
          throw new RangeError(`${item}.quantity must be positive and bounded`)
        }
        if (
          !Number.isSafeInteger(candidate.unit_price_cents) ||
          Math.abs(candidate.unit_price_cents as number) > CENTS_LIMIT
        ) {
          throw new RangeError(`${item}.unit_price_cents must be bounded integer cents`)
        }
        if (typeof candidate.taxed !== 'boolean' || typeof candidate.taxed2 !== 'boolean') {
          throw new TypeError(`${item} tax flags must be booleans`)
        }
        return {
          kind,
          description,
          quantity: candidate.quantity,
          unit_price_cents: candidate.unit_price_cents as number,
          taxed: candidate.taxed,
          taxed2: candidate.taxed2,
          harvest_project_id:
            candidate.harvest_project_id === null
              ? null
              : positiveId(candidate.harvest_project_id, `${item}.harvest_project_id`),
        }
      }),
    }
  }
  if (value.type !== 'line_items_import') {
    throw new TypeError(`${field}.type must be fixed_lines or line_items_import`)
  }
  exactKeys(value, ['schema_version', 'type', 'harvest_project_ids'], ['time', 'expenses'], field)
  if (value.time === undefined && value.expenses === undefined) {
    throw new TypeError(`${field} requires time or expenses`)
  }
  const time =
    value.time === undefined
      ? undefined
      : parseSummary(
          value.time,
          `${field}.time`,
          new Set(['project', 'task', 'people', 'detailed']),
        )
  const expenses =
    value.expenses === undefined
      ? undefined
      : parseSummary(
          value.expenses,
          `${field}.expenses`,
          new Set(['project', 'category', 'people', 'detailed']),
        )
  return {
    schema_version: 1,
    type: 'line_items_import',
    harvest_project_ids: sortedIds(value.harvest_project_ids, `${field}.harvest_project_ids`),
    ...(time === undefined ? {} : { time: time as WorksheetLineItemsImportConfig['time'] }),
    ...(expenses === undefined
      ? {}
      : { expenses: expenses as WorksheetLineItemsImportConfig['expenses'] }),
  }
}

const parseRecurringWorksheet = (value: unknown): RecurringInvoiceWorksheet => {
  if (!isRecord(value)) throw new TypeError('recurring worksheet must be an object')
  exactKeys(value, [
    'version',
    'kind',
    'snapshot_sha256',
    'manifest_sha256',
    'load_options_sha256',
    'context_sha256',
    'status',
    'rows',
  ])
  if (value.kind !== 'recurring_invoice_definition') {
    throw new TypeError('recurring worksheet kind is invalid')
  }
  if (!Array.isArray(value.rows)) throw new TypeError('recurring worksheet rows must be an array')
  const rows = value.rows.map((candidate, index): RecurringInvoiceWorksheetRow => {
    if (!isRecord(candidate)) throw new TypeError(`rows[${index}] must be an object`)
    exactKeys(
      candidate,
      [
        'harvest_recurring_invoice_id',
        'harvest_client_id',
        'client_name',
        'currency',
        'linked_invoices',
        'status',
        'subject_template',
        'notes_template',
        'every_n_months',
        'day_of_month',
        'next_issue_on',
        'amount_config',
        'can_draw_from_harvest_retainer_id',
      ],
      [],
      `rows[${index}]`,
    )
    const every = candidate.every_n_months
    if (every !== null) positiveId(every, `rows[${index}].every_n_months`)
    const day = candidate.day_of_month
    if (
      day !== null &&
      (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 31)
    ) {
      throw new RangeError(
        `rows[${index}].day_of_month must be null or an integer from 1 through 31`,
      )
    }
    return {
      harvest_recurring_invoice_id: positiveId(
        candidate.harvest_recurring_invoice_id,
        `rows[${index}].harvest_recurring_invoice_id`,
      ),
      harvest_client_id: positiveId(
        candidate.harvest_client_id,
        `rows[${index}].harvest_client_id`,
      ),
      client_name: displayText(candidate.client_name, `rows[${index}].client_name`),
      currency: currency(candidate.currency, `rows[${index}].currency`),
      linked_invoices: invoiceReferences(
        candidate.linked_invoices,
        `rows[${index}].linked_invoices`,
      ),
      status:
        candidate.status === 'pending' || candidate.status === 'completed'
          ? candidate.status
          : (() => {
              throw new TypeError(`rows[${index}].status is invalid`)
            })(),
      subject_template: safeText(candidate.subject_template, `rows[${index}].subject_template`, {
        nonBlank: true,
        nullable: true,
      }),
      notes_template: safeText(candidate.notes_template, `rows[${index}].notes_template`, {
        nullable: true,
      }),
      every_n_months: every as number | null,
      day_of_month: day as number | null,
      next_issue_on:
        candidate.next_issue_on === null
          ? null
          : canonicalDate(candidate.next_issue_on, `rows[${index}].next_issue_on`),
      amount_config:
        candidate.amount_config === null
          ? null
          : parseWorksheetAmountConfig(candidate.amount_config, `rows[${index}].amount_config`),
      can_draw_from_harvest_retainer_id:
        candidate.can_draw_from_harvest_retainer_id === null
          ? null
          : positiveId(
              candidate.can_draw_from_harvest_retainer_id,
              `rows[${index}].can_draw_from_harvest_retainer_id`,
            ),
    }
  })
  assertUniqueOrdered(
    rows.map((row) => row.harvest_recurring_invoice_id),
    'recurring worksheet rows',
  )
  const parsed = { ...parseHeader(value), kind: 'recurring_invoice_definition' as const, rows }
  parseStatus(
    value.status,
    rows.map((row) => row.status),
  )
  return parsed
}

const assertUniqueOrdered = (ids: readonly number[], field: string): void => {
  for (let index = 1; index < ids.length; index++) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new TypeError(`${field} must contain one row per ascending Harvest id`)
    }
  }
}

const all = <T>(
  sqlite: BetterSqlite3.Database,
  sql: string,
  params: readonly unknown[] = [],
): T[] => sqlite.prepare(sql).all(...params) as T[]

const first = <T>(
  sqlite: BetterSqlite3.Database,
  sql: string,
  params: readonly unknown[] = [],
): T | null => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null

const evidence = async (
  snapshotDir: string,
  sqlite: BetterSqlite3.Database,
  database: ImportDatabase,
): Promise<Evidence> => {
  const checksumValue = JSON.parse(
    await readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
  ) as unknown
  if (!isRecord(checksumValue)) throw new Error('checksums.json must be an object')
  const { report_sha256: reportSha256, ...payload } = checksumValue
  if (
    typeof reportSha256 !== 'string' ||
    checksumReportDigest(payload as Omit<ChecksumReport, 'report_sha256'>) !== reportSha256
  ) {
    throw new Error('checksums.json report evidence failed its content digest')
  }
  const snapshotSha256 = digest(checksumValue.snapshot_sha256, 'checksums.json snapshot_sha256')
  const manifestBytes = await readFile(join(snapshotDir, 'manifest.json'))
  const manifestSha256 = sha256(manifestBytes)
  const manifest = await readManifest(snapshotDir)
  if ((await snapshotDigest(snapshotDir, manifest)) !== snapshotSha256) {
    throw new Error('snapshot bytes changed after verification')
  }
  const admission = first<Admission>(
    sqlite,
    `SELECT snapshot_sha256 AS snapshotSha256,
      manifest_sha256 AS manifestSha256, load_options_json AS loadOptionsJson
    FROM _ezacto_load_admission WHERE singleton = 1`,
  )
  if (
    admission === null ||
    admission.snapshotSha256 !== snapshotSha256 ||
    admission.manifestSha256 !== manifestSha256
  ) {
    throw new Error('database load admission does not match the verified snapshot')
  }
  const loadReport = await assertLoadComplete(database, snapshotSha256)
  for (const progress of loadReport.resources as Array<Progress & { resource: string }>) {
    if (
      progress.snapshotSha256 !== snapshotSha256 ||
      progress.loadOptionsJson !== admission.loadOptionsJson
    ) {
      throw new Error(`database load progress for ${progress.resource} has inconsistent provenance`)
    }
  }
  return {
    snapshotSha256,
    manifestSha256,
    loadOptionsSha256: sha256(admission.loadOptionsJson),
  }
}

const contextRows = (
  sqlite: BetterSqlite3.Database,
  kind: 'retainer' | 'recurring',
): ContextRow[] => {
  const targetTable = kind === 'retainer' ? 'retainers' : 'recurring_invoices'
  const invoiceColumn = kind === 'retainer' ? 'retainer_id' : 'recurring_invoice_id'
  const rows = all<FlatContextRow>(
    sqlite,
    `SELECT target.harvest_id AS harvestId,
      target.client_id AS clientId, client.harvest_id AS harvestClientId,
      client.name AS clientName, upper(client.currency) AS currency, invoice.id AS invoiceId,
      invoice.harvest_id AS harvestInvoiceId, invoice.number AS invoiceNumber,
      invoice.client_id AS invoiceClientId,
      upper(invoice.currency) AS invoiceCurrency
    FROM ${targetTable} target
    LEFT JOIN clients client ON client.id = target.client_id
    LEFT JOIN invoices invoice ON invoice.${invoiceColumn} = target.id
    WHERE target.harvest_id IS NOT NULL
    ORDER BY target.harvest_id, invoice.harvest_id`,
  )
  const grouped = new Map<number, ContextRow>()
  for (const row of rows) {
    positiveId(row.harvestId, `${kind} Harvest id`)
    if (row.clientId === null || row.harvestClientId === null || row.clientName === null) {
      throw new Error(`Harvest ${kind} ${row.harvestId} has no source-identified client`)
    }
    positiveId(row.harvestClientId, `${kind} client Harvest id`)
    sourceLabel(row.clientName, `${kind} client name`)
    currency(row.currency, `${kind} client currency`)
    let target = grouped.get(row.harvestId)
    if (target === undefined) {
      target = {
        harvest_id: row.harvestId,
        harvest_client_id: row.harvestClientId,
        client_name: row.clientName,
        currency: row.currency,
        linked_invoices: [],
      }
      grouped.set(row.harvestId, target)
    } else if (
      target.harvest_client_id !== row.harvestClientId ||
      target.client_name !== row.clientName ||
      target.currency !== row.currency
    ) {
      throw new Error(`Harvest ${kind} ${row.harvestId} has inconsistent client context`)
    }
    if (row.invoiceId !== null) {
      if (row.harvestInvoiceId === null || row.invoiceNumber === null) {
        throw new Error(`Harvest ${kind} ${row.harvestId} links an invoice without source identity`)
      }
      if (row.invoiceClientId !== row.clientId) {
        throw new Error(`Harvest ${kind} ${row.harvestId} links an invoice outside its client`)
      }
      if (row.invoiceCurrency === null) {
        throw new Error(`Harvest ${kind} ${row.harvestId} links an invoice without currency`)
      }
      positiveId(row.harvestInvoiceId, `${kind} linked invoice Harvest id`)
      sourceLabel(row.invoiceNumber, `${kind} linked invoice number`)
      if (target.linked_invoices.at(-1)?.harvest_invoice_id === row.harvestInvoiceId) {
        throw new Error(
          `Harvest ${kind} ${row.harvestId} links invoice ${row.harvestInvoiceId} more than once`,
        )
      }
      target.linked_invoices.push({
        harvest_invoice_id: row.harvestInvoiceId,
        number: row.invoiceNumber,
        currency: currency(row.invoiceCurrency, `${kind} linked invoice currency`),
      })
    }
  }
  const result = [...grouped.values()]
  for (const row of result) {
    if (row.linked_invoices.length === 0) {
      throw new Error(`Harvest ${kind} ${row.harvest_id} has no source invoice witness`)
    }
  }
  return result
}

interface SourceClient {
  name: string
  currency: string
}

const sourceClients = async (snapshotDir: string): Promise<Map<number, SourceClient>> => {
  const path = join(snapshotDir, 'raw', 'clients.jsonl')
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  const clients = new Map<number, SourceClient>()
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber++
      if (line.trim().length === 0) continue
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) throw new Error(`${path}:${lineNumber} must be a JSON object`)
      const id = positiveId(parsed.id, `${path}:${lineNumber} id`)
      const name = sourceLabel(parsed.name, `${path}:${lineNumber} name`)
      const sourceCurrency = currency(
        typeof parsed.currency === 'string' ? parsed.currency.toUpperCase() : parsed.currency,
        `${path}:${lineNumber} currency`,
      )
      if (clients.has(id)) throw new Error(`${path}:${lineNumber} repeats Harvest client ${id}`)
      clients.set(id, { name, currency: sourceCurrency })
    }
  } finally {
    lines.close()
  }
  return clients
}

const sourceContextRows = async (
  snapshotDir: string,
  kind: 'retainer' | 'recurring',
): Promise<ContextRow[]> => {
  const path = join(snapshotDir, 'raw', 'invoices.jsonl')
  const clients = await sourceClients(snapshotDir)
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  const grouped = new Map<number, ContextRow>()
  const seenInvoices = new Set<number>()
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber++
      if (line.trim().length === 0) continue
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) throw new Error(`${path}:${lineNumber} must be a JSON object`)
      const relation = kind === 'retainer' ? parsed.retainer : parsed.recurring_invoice_id
      if (relation === null || relation === undefined) continue
      const harvestId =
        kind === 'retainer'
          ? isRecord(relation)
            ? positiveId(relation.id, `${path}:${lineNumber} retainer.id`)
            : (() => {
                throw new TypeError(`${path}:${lineNumber} retainer must be an object`)
              })()
          : positiveId(relation, `${path}:${lineNumber} recurring_invoice_id`)
      if (!isRecord(parsed.client)) {
        throw new TypeError(`${path}:${lineNumber} client must be an object`)
      }
      const clientId = positiveId(parsed.client.id, `${path}:${lineNumber} client.id`)
      const client = clients.get(clientId)
      if (client === undefined) {
        throw new Error(`${path}:${lineNumber} client ${clientId} has no source row`)
      }
      const invoiceId = positiveId(parsed.id, `${path}:${lineNumber} invoice.id`)
      const invoiceNumber = sourceLabel(parsed.number, `${path}:${lineNumber} number`)
      const invoiceCurrency = currency(
        typeof parsed.currency === 'string' ? parsed.currency.toUpperCase() : parsed.currency,
        `${path}:${lineNumber} currency`,
      )
      if (seenInvoices.has(invoiceId)) {
        throw new Error(`${path}:${lineNumber} repeats Harvest invoice ${invoiceId}`)
      }
      seenInvoices.add(invoiceId)
      const existing = grouped.get(harvestId)
      if (existing === undefined) {
        grouped.set(harvestId, {
          harvest_id: harvestId,
          harvest_client_id: clientId,
          client_name: client.name,
          currency: client.currency,
          linked_invoices: [
            { harvest_invoice_id: invoiceId, number: invoiceNumber, currency: invoiceCurrency },
          ],
        })
      } else {
        if (
          existing.harvest_client_id !== clientId ||
          existing.client_name !== client.name ||
          existing.currency !== client.currency
        ) {
          throw new Error(`Harvest ${kind} ${harvestId} has inconsistent source client context`)
        }
        existing.linked_invoices.push({
          harvest_invoice_id: invoiceId,
          number: invoiceNumber,
          currency: invoiceCurrency,
        })
      }
    }
  } finally {
    lines.close()
  }
  return [...grouped.values()]
    .sort((left, right) => left.harvest_id - right.harvest_id)
    .map((row) => ({
      ...row,
      linked_invoices: row.linked_invoices.sort(
        (left, right) => left.harvest_invoice_id - right.harvest_invoice_id,
      ),
    }))
}

const boundContextRows = async (
  snapshotDir: string,
  sqlite: BetterSqlite3.Database,
  kind: 'retainer' | 'recurring',
): Promise<ContextRow[]> => {
  const source = await sourceContextRows(snapshotDir, kind)
  const loaded = contextRows(sqlite, kind)
  if (canonicalJson(loaded) !== canonicalJson(source)) {
    throw new Error(`loaded ${kind} worksheet context does not exactly match the admitted snapshot`)
  }
  return source.map((row) => ({
    ...row,
    client_name: displayText(row.client_name, `${kind} client name`),
    linked_invoices: row.linked_invoices.map((invoice) => ({
      ...invoice,
      number: displayText(invoice.number, `${kind} linked invoice number`),
    })),
  }))
}

const contextDigest = (
  kind: RetainerWorksheet['kind'] | RecurringInvoiceWorksheet['kind'],
  evidenceValue: Evidence,
  rows: readonly ContextRow[],
): string =>
  sha256(
    canonicalJson({
      version: 1,
      kind,
      snapshot_sha256: evidenceValue.snapshotSha256,
      manifest_sha256: evidenceValue.manifestSha256,
      load_options_sha256: evidenceValue.loadOptionsSha256,
      rows,
    }),
  )

const header = (
  kind: RetainerWorksheet['kind'] | RecurringInvoiceWorksheet['kind'],
  evidenceValue: Evidence,
  rows: readonly ContextRow[],
  completed: number,
): WorksheetHeader => ({
  version: 1,
  snapshot_sha256: evidenceValue.snapshotSha256,
  manifest_sha256: evidenceValue.manifestSha256,
  load_options_sha256: evidenceValue.loadOptionsSha256,
  context_sha256: contextDigest(kind, evidenceValue, rows),
  status: { total: rows.length, completed, pending: rows.length - completed },
})

const completedIds = (
  sqlite: BetterSqlite3.Database,
  kind: RetainerWorksheet['kind'] | RecurringInvoiceWorksheet['kind'],
  snapshotSha256: string,
  contextSha256: string,
  rows: readonly ContextRow[],
): Set<number> => {
  const expected = new Set(rows.map((row) => row.harvest_id))
  const completed = new Set<number>()
  for (const row of completionMap(sqlite, kind).values()) {
    if (
      !expected.has(row.harvestId) ||
      row.snapshotSha256 !== snapshotSha256 ||
      row.contextSha256 !== contextSha256 ||
      row.inputSha256 !== sha256(row.inputJson)
    ) {
      throw new Error(`${kind} has completion evidence outside the current worksheet context`)
    }
    completed.add(row.harvestId)
  }
  return completed
}

const withDatabase = async <T>(
  options: WorksheetOptions,
  action: (sqlite: BetterSqlite3.Database, database: ImportDatabase) => Promise<T>,
): Promise<T> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'worksheets')
  try {
    const sqlite = new BetterSqlite3(options.databasePath, { fileMustExist: true })
    try {
      migrateContainer(sqlite)
      return await action(sqlite, createContainerDatabase(sqlite) as ImportDatabase)
    } finally {
      sqlite.close()
    }
  } finally {
    await releaseSnapshotLock(lock)
  }
}

export const generateRetainerWorksheet = async (
  options: WorksheetOptions,
): Promise<RetainerWorksheet> =>
  withDatabase(options, async (sqlite, database) => {
    const evidenceValue = await evidence(options.snapshotDir, sqlite, database)
    const context = await boundContextRows(options.snapshotDir, sqlite, 'retainer')
    const contextSha256 = contextDigest('retainer_balance', evidenceValue, context)
    const completed = completedIds(
      sqlite,
      'retainer_balance',
      evidenceValue.snapshotSha256,
      contextSha256,
      context,
    )
    return {
      ...header('retainer_balance', evidenceValue, context, completed.size),
      kind: 'retainer_balance',
      rows: context.map((row) => ({
        harvest_retainer_id: row.harvest_id,
        harvest_client_id: row.harvest_client_id,
        client_name: row.client_name,
        currency: row.currency,
        linked_invoices: row.linked_invoices,
        status: completed.has(row.harvest_id) ? 'completed' : 'pending',
        balance_cents: null,
        occurred_on: null,
        notes: null,
      })),
    }
  })

export const generateRecurringInvoiceWorksheet = async (
  options: WorksheetOptions,
): Promise<RecurringInvoiceWorksheet> =>
  withDatabase(options, async (sqlite, database) => {
    const evidenceValue = await evidence(options.snapshotDir, sqlite, database)
    const context = await boundContextRows(options.snapshotDir, sqlite, 'recurring')
    const contextSha256 = contextDigest('recurring_invoice_definition', evidenceValue, context)
    const completed = completedIds(
      sqlite,
      'recurring_invoice_definition',
      evidenceValue.snapshotSha256,
      contextSha256,
      context,
    )
    return {
      ...header('recurring_invoice_definition', evidenceValue, context, completed.size),
      kind: 'recurring_invoice_definition',
      rows: context.map((row) => ({
        harvest_recurring_invoice_id: row.harvest_id,
        harvest_client_id: row.harvest_client_id,
        client_name: row.client_name,
        currency: row.currency,
        linked_invoices: row.linked_invoices,
        status: completed.has(row.harvest_id) ? 'completed' : 'pending',
        subject_template: null,
        notes_template: null,
        every_n_months: null,
        day_of_month: null,
        next_issue_on: null,
        amount_config: null,
        can_draw_from_harvest_retainer_id: null,
      })),
    }
  })

const assertBoundContext = (
  worksheet: RetainerWorksheet | RecurringInvoiceWorksheet,
  expectedEvidence: Evidence,
  expectedRows: readonly ContextRow[],
): void => {
  if (
    worksheet.snapshot_sha256 !== expectedEvidence.snapshotSha256 ||
    worksheet.manifest_sha256 !== expectedEvidence.manifestSha256 ||
    worksheet.load_options_sha256 !== expectedEvidence.loadOptionsSha256
  ) {
    throw new Error('worksheet evidence does not match the admitted snapshot and load options')
  }
  const expectedContext = contextDigest(worksheet.kind, expectedEvidence, expectedRows)
  if (worksheet.context_sha256 !== expectedContext) {
    throw new Error('worksheet context does not match the loaded source identities')
  }
  if (worksheet.rows.length !== expectedRows.length) {
    throw new Error('worksheet does not contain exactly one row per source stub')
  }
  for (const [index, expected] of expectedRows.entries()) {
    const actual = worksheet.rows[index]!
    const harvestId =
      'harvest_retainer_id' in actual
        ? actual.harvest_retainer_id
        : actual.harvest_recurring_invoice_id
    if (
      harvestId !== expected.harvest_id ||
      actual.harvest_client_id !== expected.harvest_client_id ||
      actual.client_name !== expected.client_name ||
      actual.currency !== expected.currency ||
      canonicalJson(actual.linked_invoices) !== canonicalJson(expected.linked_invoices)
    ) {
      throw new Error(`worksheet row ${index + 1} does not match its loaded source context`)
    }
  }
}

const completionMap = (sqlite: BetterSqlite3.Database, kind: string): Map<number, CompletionRow> =>
  new Map(
    all<CompletionRow>(
      sqlite,
      `SELECT kind, harvest_id AS harvestId,
      resource_id AS resourceId, snapshot_sha256 AS snapshotSha256,
      context_sha256 AS contextSha256, input_sha256 AS inputSha256,
      input_json AS inputJson FROM _ezacto_worksheet_completions
    WHERE kind = ? ORDER BY harvest_id`,
      [kind],
    ).map((row) => [row.harvestId, row]),
  )

const assertCompletion = (
  completion: CompletionRow,
  expectedJson: string,
  expectedSnapshot: string,
  expectedContext: string,
): void => {
  if (
    completion.snapshotSha256 !== expectedSnapshot ||
    completion.contextSha256 !== expectedContext ||
    completion.inputJson !== expectedJson ||
    completion.inputSha256 !== sha256(expectedJson)
  ) {
    throw new Error(
      `${completion.kind} for Harvest id ${completion.harvestId} has conflicting prior completion evidence`,
    )
  }
}

const assertOpaqueCompletion = (
  completion: CompletionRow,
  expectedKind: RetainerWorksheet['kind'] | RecurringInvoiceWorksheet['kind'],
  expectedHarvestId: number,
  expectedResourceId: number,
  expectedSnapshot: string,
  expectedContext: string,
): void => {
  let parsed: unknown
  try {
    parsed = JSON.parse(completion.inputJson) as unknown
  } catch {
    throw new Error(`${expectedKind} completion for Harvest id ${expectedHarvestId} is invalid`)
  }
  const identityField =
    expectedKind === 'retainer_balance' ? 'harvest_retainer_id' : 'harvest_recurring_invoice_id'
  if (
    !isRecord(parsed) ||
    completion.kind !== expectedKind ||
    completion.harvestId !== expectedHarvestId ||
    completion.resourceId !== expectedResourceId ||
    completion.snapshotSha256 !== expectedSnapshot ||
    completion.contextSha256 !== expectedContext ||
    completion.inputSha256 !== sha256(completion.inputJson) ||
    canonicalJson(parsed) !== completion.inputJson ||
    parsed.kind !== expectedKind ||
    parsed[identityField] !== expectedHarvestId ||
    parsed.snapshot_sha256 !== expectedSnapshot ||
    parsed.context_sha256 !== expectedContext
  ) {
    throw new Error(`${expectedKind} completion for Harvest id ${expectedHarvestId} is invalid`)
  }
}

const retainerInputJson = (worksheet: RetainerWorksheet, row: RetainerWorksheetRow): string =>
  canonicalJson({
    version: 1,
    kind: 'retainer_balance',
    harvest_retainer_id: row.harvest_retainer_id,
    snapshot_sha256: worksheet.snapshot_sha256,
    context_sha256: worksheet.context_sha256,
    balance_cents: row.balance_cents,
    occurred_on: row.occurred_on,
    notes: row.notes,
  })

export const applyRetainerWorksheet = async (
  options: WorksheetApplyOptions,
): Promise<WorksheetApplyResult> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'worksheets')
  try {
    const worksheet = parseRetainerWorksheet(
      parseWorksheetJson(await readFile(options.inputPath, 'utf8')),
    )
    for (const [index, row] of worksheet.rows.entries()) {
      const complete = row.balance_cents !== null && row.occurred_on !== null && row.notes !== null
      const blank = row.balance_cents === null && row.occurred_on === null && row.notes === null
      if ((row.status === 'pending' && !complete) || (row.status === 'completed' && !blank)) {
        throw new Error(`retainer worksheet row ${index + 1} is incomplete`)
      }
    }
    const sqlite = new BetterSqlite3(options.databasePath, { fileMustExist: true })
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite) as ImportDatabase
      const evidenceValue = await evidence(options.snapshotDir, sqlite, database)
      const context = await boundContextRows(options.snapshotDir, sqlite, 'retainer')
      assertBoundContext(worksheet, evidenceValue, context)
      const completions = completionMap(sqlite, worksheet.kind)
      const targets = new Map(
        all<RetainerTarget>(
          sqlite,
          `SELECT retainer.id, retainer.harvest_id AS harvestId,
          retainer.client_id AS clientId, retainer.denomination,
          balance.balance, count(entry.id) AS ledgerCount
        FROM retainers retainer
        LEFT JOIN retainer_balances balance ON balance.retainer_id = retainer.id
        LEFT JOIN retainer_ledger entry ON entry.retainer_id = retainer.id
        WHERE retainer.harvest_id IS NOT NULL
        GROUP BY retainer.id, retainer.harvest_id, retainer.client_id,
          retainer.denomination, balance.balance`,
        ).map((row) => [row.harvestId, row]),
      )
      for (const row of worksheet.rows) {
        const target = targets.get(row.harvest_retainer_id)
        if (target === undefined || target.clientId === null || target.denomination !== 'money') {
          throw new Error(
            `Harvest retainer ${row.harvest_retainer_id} does not resolve to a money stub`,
          )
        }
        const prior = completions.get(row.harvest_retainer_id)
        if (row.status === 'completed') {
          if (prior === undefined) {
            throw new Error(`Harvest retainer ${row.harvest_retainer_id} is not completed`)
          }
          assertOpaqueCompletion(
            prior,
            worksheet.kind,
            row.harvest_retainer_id,
            target.id,
            worksheet.snapshot_sha256,
            worksheet.context_sha256,
          )
          continue
        }
        const inputJson = retainerInputJson(worksheet, row)
        if (prior !== undefined) {
          if (prior.resourceId !== target.id) {
            throw new Error(
              `Harvest retainer ${row.harvest_retainer_id} completion resolves to a different native row`,
            )
          }
          assertCompletion(prior, inputJson, worksheet.snapshot_sha256, worksheet.context_sha256)
        } else if (target.balance !== 0 || target.ledgerCount !== 0) {
          throw new Error(
            `Harvest retainer ${row.harvest_retainer_id} no longer has a pristine opening ledger`,
          )
        }
      }
      const completedAt = new Date().toISOString()
      let completed = 0
      let replayed = worksheet.rows.filter((row) => row.status === 'completed').length
      for (const row of worksheet.rows) {
        if (row.status === 'completed') continue
        const result = await completeHarvestRetainerBalance(database, {
          harvestRetainerId: row.harvest_retainer_id,
          snapshotSha256: worksheet.snapshot_sha256,
          contextSha256: worksheet.context_sha256,
          balanceCents: row.balance_cents!,
          occurredOn: row.occurred_on!,
          notes: row.notes!,
          completedAt,
        })
        if (result.replayed) replayed++
        else completed++
      }
      return {
        total: worksheet.rows.length,
        completed,
        replayed,
        pending: 0,
        snapshotSha256: worksheet.snapshot_sha256,
      }
    } finally {
      sqlite.close()
    }
  } finally {
    await releaseSnapshotLock(lock)
  }
}

const resolveAmountConfig = (
  value: WorksheetRecurringAmountConfig,
  clientId: number,
  projects: ReadonlyMap<number, ProjectTarget>,
): RecurringAmountConfig => {
  const projectId = (harvestId: number): number => {
    const project = projects.get(harvestId)
    if (project === undefined) throw new Error(`Harvest project ${harvestId} does not resolve`)
    if (project.clientId !== clientId) {
      throw new Error(`Harvest project ${harvestId} belongs to a different client`)
    }
    return project.id
  }
  const resolved: RecurringAmountConfig =
    value.type === 'fixed_lines'
      ? {
          schema_version: 1,
          type: 'fixed_lines',
          line_items: value.line_items.map((line) => ({
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unit_price_cents: line.unit_price_cents,
            taxed: line.taxed,
            taxed2: line.taxed2,
            project_id:
              line.harvest_project_id === null ? null : projectId(line.harvest_project_id),
          })),
        }
      : {
          schema_version: 1,
          type: 'line_items_import',
          project_ids: value.harvest_project_ids.map(projectId),
          ...(value.time === undefined ? {} : { time: value.time }),
          ...(value.expenses === undefined ? {} : { expenses: value.expenses }),
        }
  assertRecurringAmountConfig(resolved)
  return resolved
}

const recurringInputJson = (
  worksheet: RecurringInvoiceWorksheet,
  row: RecurringInvoiceWorksheetRow,
  amountConfig: RecurringAmountConfig,
  retainerId: number | null,
): string =>
  canonicalJson({
    version: 1,
    kind: 'recurring_invoice_definition',
    harvest_recurring_invoice_id: row.harvest_recurring_invoice_id,
    snapshot_sha256: worksheet.snapshot_sha256,
    context_sha256: worksheet.context_sha256,
    subject_template: row.subject_template,
    notes_template: row.notes_template,
    every_n_months: row.every_n_months,
    day_of_month: row.day_of_month,
    next_issue_on: row.next_issue_on,
    source_amount_config: row.amount_config,
    amount_config: amountConfig,
    source_can_draw_from_harvest_retainer_id: row.can_draw_from_harvest_retainer_id,
    can_draw_from_retainer_id: retainerId,
  })

interface RecurringPlan {
  row: RecurringInvoiceWorksheetRow
  amountConfig: RecurringAmountConfig
  retainerId: number | null
}

export const applyRecurringInvoiceWorksheet = async (
  options: WorksheetApplyOptions,
): Promise<WorksheetApplyResult> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'worksheets')
  try {
    const worksheet = parseRecurringWorksheet(
      parseWorksheetJson(await readFile(options.inputPath, 'utf8')),
    )
    for (const [index, row] of worksheet.rows.entries()) {
      const complete =
        row.subject_template !== null &&
        row.notes_template !== null &&
        row.every_n_months !== null &&
        row.day_of_month !== null &&
        row.next_issue_on !== null &&
        row.amount_config !== null
      const blank =
        row.subject_template === null &&
        row.notes_template === null &&
        row.every_n_months === null &&
        row.day_of_month === null &&
        row.next_issue_on === null &&
        row.amount_config === null &&
        row.can_draw_from_harvest_retainer_id === null
      if ((row.status === 'pending' && !complete) || (row.status === 'completed' && !blank)) {
        throw new Error(`recurring worksheet row ${index + 1} is incomplete`)
      }
    }
    const sqlite = new BetterSqlite3(options.databasePath, { fileMustExist: true })
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite) as ImportDatabase
      const evidenceValue = await evidence(options.snapshotDir, sqlite, database)
      const context = await boundContextRows(options.snapshotDir, sqlite, 'recurring')
      assertBoundContext(worksheet, evidenceValue, context)
      const completions = completionMap(sqlite, worksheet.kind)
      const targets = new Map(
        all<RecurringTarget>(
          sqlite,
          `SELECT id, harvest_id AS harvestId,
          client_id AS clientId, definition_status AS definitionStatus,
          subject_template AS subjectTemplate, notes_template AS notesTemplate,
          every_n_months AS everyNMonths, day_of_month AS dayOfMonth,
          next_issue_on AS nextIssueOn, amount_config AS amountConfig,
          can_draw_from_retainer_id AS canDrawFromRetainerId
        FROM recurring_invoices WHERE harvest_id IS NOT NULL`,
        ).map((row) => [row.harvestId, row]),
      )
      const projects = new Map(
        all<ProjectTarget>(
          sqlite,
          'SELECT id, harvest_id AS harvestId, client_id AS clientId FROM projects WHERE harvest_id IS NOT NULL',
        ).map((row) => [row.harvestId, row]),
      )
      const retainers = new Map(
        all<RetainerReference>(
          sqlite,
          `SELECT id,
          harvest_id AS harvestId, client_id AS clientId, denomination
        FROM retainers WHERE harvest_id IS NOT NULL`,
        ).map((row) => [row.harvestId, row]),
      )
      const plans: RecurringPlan[] = []
      for (const row of worksheet.rows) {
        const target = targets.get(row.harvest_recurring_invoice_id)
        if (target === undefined) {
          throw new Error(
            `Harvest recurring invoice ${row.harvest_recurring_invoice_id} does not resolve to a stub`,
          )
        }
        const prior = completions.get(row.harvest_recurring_invoice_id)
        if (row.status === 'completed') {
          if (prior === undefined) {
            throw new Error(
              `Harvest recurring invoice ${row.harvest_recurring_invoice_id} is not completed`,
            )
          }
          assertOpaqueCompletion(
            prior,
            worksheet.kind,
            row.harvest_recurring_invoice_id,
            target.id,
            worksheet.snapshot_sha256,
            worksheet.context_sha256,
          )
          continue
        }
        const amountConfig = resolveAmountConfig(row.amount_config!, target.clientId, projects)
        let retainerId: number | null = null
        if (row.can_draw_from_harvest_retainer_id !== null) {
          const retainer = retainers.get(row.can_draw_from_harvest_retainer_id)
          if (
            retainer === undefined ||
            retainer.clientId !== target.clientId ||
            retainer.denomination !== 'money'
          ) {
            throw new Error(
              `Harvest retainer ${row.can_draw_from_harvest_retainer_id} is not a same-client money retainer`,
            )
          }
          retainerId = retainer.id
        }
        const inputJson = recurringInputJson(worksheet, row, amountConfig, retainerId)
        if (prior !== undefined) {
          if (prior.resourceId !== target.id) {
            throw new Error(
              `Harvest recurring invoice ${row.harvest_recurring_invoice_id} completion resolves to a different native row`,
            )
          }
          assertCompletion(prior, inputJson, worksheet.snapshot_sha256, worksheet.context_sha256)
        } else if (target.definitionStatus === 'complete') {
          let storedConfig: unknown
          try {
            storedConfig = target.amountConfig === null ? null : JSON.parse(target.amountConfig)
          } catch {
            throw new Error(
              `Harvest recurring invoice ${row.harvest_recurring_invoice_id} has invalid stored config`,
            )
          }
          if (
            target.subjectTemplate !== row.subject_template ||
            target.notesTemplate !== row.notes_template ||
            target.everyNMonths !== row.every_n_months ||
            target.dayOfMonth !== row.day_of_month ||
            target.nextIssueOn !== row.next_issue_on ||
            canonicalJson(storedConfig) !== canonicalJson(amountConfig) ||
            target.canDrawFromRetainerId !== retainerId
          ) {
            throw new Error(
              `Harvest recurring invoice ${row.harvest_recurring_invoice_id} already has a different definition`,
            )
          }
        } else if (target.definitionStatus !== 'incomplete') {
          throw new Error(
            `Harvest recurring invoice ${row.harvest_recurring_invoice_id} has invalid definition state`,
          )
        }
        plans.push({ row, amountConfig, retainerId })
      }
      const completedAt = new Date().toISOString()
      let completed = 0
      let replayed = worksheet.rows.filter((row) => row.status === 'completed').length
      for (const plan of plans) {
        const result = await completeHarvestRecurringInvoice(database, {
          harvestRecurringInvoiceId: plan.row.harvest_recurring_invoice_id,
          snapshotSha256: worksheet.snapshot_sha256,
          contextSha256: worksheet.context_sha256,
          subjectTemplate: plan.row.subject_template!,
          notesTemplate: plan.row.notes_template!,
          everyNMonths: plan.row.every_n_months!,
          dayOfMonth: plan.row.day_of_month!,
          nextIssueOn: plan.row.next_issue_on!,
          sourceAmountConfig: plan.row.amount_config!,
          resolvedAmountConfig: plan.amountConfig,
          sourceCanDrawFromHarvestRetainerId: plan.row.can_draw_from_harvest_retainer_id,
          resolvedCanDrawFromRetainerId: plan.retainerId,
          completedAt,
        })
        if (result.replayed) replayed++
        else completed++
      }
      return {
        total: worksheet.rows.length,
        completed,
        replayed,
        pending: 0,
        snapshotSha256: worksheet.snapshot_sha256,
      }
    } finally {
      sqlite.close()
    }
  } finally {
    await releaseSnapshotLock(lock)
  }
}
