import {
  calculateInvoiceLineAmountCents,
  trackedAmountCents,
  uninvoicedGenerationPreview,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  readUninvoicedCandidates,
  type UninvoicedExpenseCandidateRow,
  type UninvoicedTimeCandidateRow,
} from './reports.js'
import type { InvoiceResource } from './money-resources.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type InvoiceGenerationDatabase = ContainerDatabase | WorkerDatabase

export type InvoiceGenerationTimeSummary = 'project' | 'task' | 'people' | 'detailed'
export type InvoiceGenerationExpenseSummary = 'project' | 'category' | 'people' | 'detailed'

export interface GenerateInvoiceRequest {
  clientId: number
  from: string
  to: string
  projectIds: readonly number[]
  timeSummaryType: InvoiceGenerationTimeSummary | null
  expenseSummaryType: InvoiceGenerationExpenseSummary | null
}

export interface GenerateInvoicePrincipal {
  userId: number
  profile: string
}

export interface GenerateInvoiceCommand {
  commandId: string
  principal: GenerateInvoicePrincipal
  request: GenerateInvoiceRequest
}

export type InvoiceGenerationErrorCode =
  | 'invalid_command_input'
  | 'forbidden'
  | 'command_id_reused'
  | 'command_incomplete'
  | 'generation_conflict'
  | 'command_storage_conflict'

export class InvoiceGenerationError extends Error {
  readonly code: InvoiceGenerationErrorCode

  constructor(code: InvoiceGenerationErrorCode, message: string) {
    super(message)
    this.name = 'InvoiceGenerationError'
    this.code = code
  }
}

export interface InvoiceGenerationService {
  generate(input: GenerateInvoiceCommand): Promise<InvoiceResource>
}

export interface InvoiceGenerationServiceOptions {
  clock?: () => string
}

interface SqlStatement {
  text: string
  params: Array<string | number | null>
}

interface StoredCreateCommand {
  inputFingerprint: string
  actorType: string
  actorId: number | null
  expectedInvoiceVersion: number | null
  completed: number | boolean
  resultJson: string | null
}

interface ClientDefaults {
  id: number
  currency: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
}

interface GeneratedLine {
  id: number
  position: number
  kind: 'Service' | 'Expense'
  description: string
  quantity: number
  unitPriceCents: number
  amountCents: number
  projectId: number
}

interface TimeGroup {
  key: string
  projectId: number
  description: string
  entries: UninvoicedTimeCandidateRow[]
}

interface ExpenseGroup {
  key: string
  projectId: number
  description: string
  expenses: UninvoicedExpenseCandidateRow[]
}

const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/
const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const moneyProfiles = new Set(['accounting', 'executive_manager', 'administrator'])
const centsLimit = 9_000_000_000_000n
/** Keeps one D1 command comfortably below request/bind payload limits. */
export const maximumGenerationSourceRows = 1_000
/** Leaves room below D1's 2 MB row cap for the completed result snapshot. */
export const maximumGenerationManifestBytes = 750_000

const invalid = (message: string): never => {
  throw new InvoiceGenerationError('invalid_command_input', message)
}

const assertDate = (value: string, field: string): void => {
  if (!canonicalDatePattern.test(value)) invalid(`${field} must be a canonical date`)
  const instant = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isSafeInteger(instant) || new Date(instant).toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be a real calendar date`)
  }
}

const assertTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  if (match === null) return invalid('clock must return a canonical UTC timestamp')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(
    match[7] ?? ''
  ).padEnd(3, '0')}Z`
  const instant = Date.parse(normalized)
  if (!Number.isSafeInteger(instant) || new Date(instant).toISOString() !== normalized) {
    invalid('clock must return a real canonical UTC timestamp')
  }
}

const normalizedRequest = (input: GenerateInvoiceCommand): GenerateInvoiceRequest => {
  if (!commandIdPattern.test(input.commandId)) {
    invalid('commandId must be 1-128 ASCII characters from [A-Za-z0-9._:-]')
  }
  if (!Number.isSafeInteger(input.principal.userId) || input.principal.userId < 1) {
    invalid('principal.userId must be a positive safe integer')
  }
  const request = input.request
  if (!Number.isSafeInteger(request.clientId) || request.clientId < 1) {
    invalid('clientId must be a positive safe integer')
  }
  assertDate(request.from, 'from')
  assertDate(request.to, 'to')
  if (request.from > request.to) invalid('generation date range is inverted')
  if (
    !Array.isArray(request.projectIds) ||
    request.projectIds.length === 0 ||
    request.projectIds.length > 10_000 ||
    request.projectIds.some((projectId) => !Number.isSafeInteger(projectId) || projectId < 1) ||
    new Set(request.projectIds).size !== request.projectIds.length
  ) {
    invalid('projectIds must be a non-empty unique positive integer list')
  }
  if (request.timeSummaryType === null && request.expenseSummaryType === null) {
    invalid('at least one generation summary type is required')
  }
  return { ...request, projectIds: [...request.projectIds].sort((left, right) => left - right) }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('fingerprint input must be finite JSON')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return invalid('fingerprint input must be JSON')
}

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const stableId = async (namespace: string, commandId: string, suffix = ''): Promise<number> =>
  Number.parseInt((await digest(`${namespace}\u001f${commandId}\u001f${suffix}`)).slice(0, 13), 16) + 1

const fingerprint = async (
  commandId: string,
  userId: number,
  request: GenerateInvoiceRequest,
): Promise<string> =>
  `sha256:${await digest(
    canonicalJson({
      invoice_id: await stableId('invoice-generation', commandId),
      command_kind: 'invoice.create',
      actor: { type: 'user', id: userId },
      input: {
        expected_version: 0,
        client_id: request.clientId,
        from: request.from,
        to: request.to,
        project_ids: request.projectIds,
        time_summary_type: request.timeSummaryType,
        expense_summary_type: request.expenseSummaryType,
      },
    }),
  )}`

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: InvoiceGenerationDatabase,
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

const all = async <T>(
  database: InvoiceGenerationDatabase,
  statement: SqlStatement,
): Promise<T[]> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (await client.prepare(statement.text).bind(...statement.params).all<T>()).results
  }
  return client.prepare(statement.text).all(...statement.params) as T[]
}

const runAtomic = async (
  database: InvoiceGenerationDatabase,
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

const assertAuthorized = async (
  database: InvoiceGenerationDatabase,
  principal: GenerateInvoicePrincipal,
): Promise<void> => {
  const actor = await first<{ profile: string }>(database, {
    text: 'SELECT profile FROM users WHERE id = ? AND is_active = 1',
    params: [principal.userId],
  })
  if (
    actor === null ||
    actor.profile !== principal.profile ||
    !moneyProfiles.has(actor.profile)
  ) {
    throw new InvoiceGenerationError('forbidden', 'the acting user cannot generate invoices')
  }
}

const readCommand = (
  database: InvoiceGenerationDatabase,
  invoiceId: number,
  commandId: string,
): Promise<StoredCreateCommand | null> =>
  first(database, {
    text: `SELECT input_fingerprint AS "inputFingerprint", actor_type AS "actorType",
        actor_id AS "actorId", expected_invoice_version AS "expectedInvoiceVersion",
        completed, result_json AS "resultJson"
      FROM invoice_command_ledger WHERE invoice_id = ? AND command_id = ?`,
    params: [invoiceId, commandId],
  })

const parseStoredInvoice = (
  command: StoredCreateCommand,
  expectedFingerprint: string,
  userId: number,
): InvoiceResource => {
  if (
    command.inputFingerprint !== expectedFingerprint ||
    command.actorType !== 'user' ||
    command.actorId !== userId ||
    command.expectedInvoiceVersion !== 0
  ) {
    throw new InvoiceGenerationError(
      'command_id_reused',
      'invoice generation command id was reused with different causation',
    )
  }
  if (!command.completed || command.resultJson === null) {
    throw new InvoiceGenerationError('command_incomplete', 'invoice generation is incomplete')
  }
  let stored: unknown
  try {
    stored = JSON.parse(command.resultJson)
  } catch {
    throw new InvoiceGenerationError('command_storage_conflict', 'stored generation result is invalid')
  }
  if (
    typeof stored !== 'object' ||
    stored === null ||
    Reflect.get(stored, 'schema_version') !== 1 ||
    typeof Reflect.get(stored, 'invoice') !== 'object' ||
    Reflect.get(stored, 'invoice') === null
  ) {
    throw new InvoiceGenerationError(
      'command_storage_conflict',
      'stored generation result has an unsupported shape',
    )
  }
  return Reflect.get(stored, 'invoice') as InvoiceResource
}

const checkedSum = (values: readonly number[], field: string): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < 0n || sum > centsLimit) invalid(`${field} exceeds the invoice cents limit`)
  return Number(sum)
}

const checkedIntegerSum = (values: readonly number[], field: string): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < 0n || sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(`${field} exceeds the safe integer limit`)
  }
  return Number(sum)
}

const candidateSignature = (
  timeEntries: readonly UninvoicedTimeCandidateRow[],
  expenses: readonly UninvoicedExpenseCandidateRow[],
): string => sourceManifest(timeEntries, expenses)

const timeSourceSnapshot = (entry: UninvoicedTimeCandidateRow) => ({
  id: entry.id,
  project_id: entry.projectId,
  project_name: entry.projectName,
  task_id: entry.taskId,
  task_name: entry.taskName,
  user_id: entry.userId,
  user_name: entry.userName,
  spent_date: entry.spentDate,
  notes: entry.notes,
  currency: entry.currency,
  rounded_seconds: entry.roundedSeconds,
  billable_rate_cents: entry.billableRateCents,
  updated_at: entry.updatedAt,
})

const expenseSourceSnapshot = (expense: UninvoicedExpenseCandidateRow) => ({
  id: expense.id,
  project_id: expense.projectId,
  project_name: expense.projectName,
  category_id: expense.categoryId,
  category_name: expense.categoryName,
  user_id: expense.userId,
  user_name: expense.userName,
  spent_date: expense.spentDate,
  notes: expense.notes,
  units: expense.units,
  currency: expense.currency,
  total_cost_cents: expense.totalCostCents,
  updated_at: expense.updatedAt,
})

const sourceManifest = (
  timeEntries: readonly UninvoicedTimeCandidateRow[],
  expenses: readonly UninvoicedExpenseCandidateRow[],
): string =>
  canonicalJson({
    schema_version: 1,
    time_entries: timeEntries.map(timeSourceSnapshot),
    expenses: expenses.map(expenseSourceSnapshot),
  })

const lineManifest = (lines: readonly GeneratedLine[]): string =>
  canonicalJson({
    schema_version: 1,
    lines: lines.map((line) => ({
      id: line.id,
      position: line.position,
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      amount_cents: line.amountCents,
      project_id: line.projectId,
    })),
  })

const requestManifest = (
  request: GenerateInvoiceRequest,
  currency: string,
  amountCents: number,
  lineCount: number,
  timeCount: number,
  expenseCount: number,
): string =>
  canonicalJson({
    schema_version: 1,
    expected_version: 0,
    client_id: request.clientId,
    from: request.from,
    to: request.to,
    project_ids: request.projectIds,
    time_summary_type: request.timeSummaryType,
    expense_summary_type: request.expenseSummaryType,
    currency,
    amount_cents: amountCents,
    line_count: lineCount,
    time_entry_count: timeCount,
    expense_count: expenseCount,
  })

const exactLinePrice = (
  amountCents: number,
  preferredQuantity: number,
  preferredUnitPriceCents: number,
): Readonly<{ quantity: number; unitPriceCents: number }> => {
  try {
    if (
      calculateInvoiceLineAmountCents(preferredQuantity, preferredUnitPriceCents) === amountCents
    ) {
      return { quantity: preferredQuantity, unitPriceCents: preferredUnitPriceCents }
    }
  } catch {
    // The canonical exact-total fallback below is always representable.
  }
  return { quantity: 1, unitPriceCents: amountCents }
}

const timeDescription = (
  entry: UninvoicedTimeCandidateRow,
  summary: InvoiceGenerationTimeSummary,
): string => {
  switch (summary) {
    case 'project':
      return entry.projectName
    case 'task':
      return `${entry.projectName} — ${entry.taskName}`
    case 'people':
      return `${entry.projectName} — ${entry.userName}`
    case 'detailed': {
      const detail = `${entry.spentDate} · ${entry.userName} · ${entry.projectName} · ${entry.taskName}`
      return entry.notes === null || entry.notes.trim() === '' ? detail : `${detail}\n${entry.notes}`
    }
  }
}

const timeKey = (
  entry: UninvoicedTimeCandidateRow,
  summary: InvoiceGenerationTimeSummary,
): string => {
  switch (summary) {
    case 'project':
      return `${entry.projectId}`
    case 'task':
      return `${entry.projectId}:${entry.taskId}`
    case 'people':
      return `${entry.projectId}:${entry.userId}`
    case 'detailed':
      return `${entry.id}`
  }
}

const groupTime = (
  entries: readonly UninvoicedTimeCandidateRow[],
  summary: InvoiceGenerationTimeSummary,
): TimeGroup[] => {
  const groups = new Map<string, TimeGroup>()
  for (const entry of entries) {
    const key = timeKey(entry, summary)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        projectId: entry.projectId,
        description: timeDescription(entry, summary),
        entries: [entry],
      })
    } else {
      existing.entries.push(entry)
    }
  }
  return [...groups.values()]
}

const expenseDescription = (
  expense: UninvoicedExpenseCandidateRow,
  summary: InvoiceGenerationExpenseSummary,
): string => {
  switch (summary) {
    case 'project':
      return expense.projectName
    case 'category':
      return `${expense.projectName} — ${expense.categoryName}`
    case 'people':
      return `${expense.projectName} — ${expense.userName}`
    case 'detailed': {
      const detail = `${expense.spentDate} · ${expense.userName} · ${expense.projectName} · ${expense.categoryName}`
      return expense.notes === null || expense.notes.trim() === ''
        ? detail
        : `${detail}\n${expense.notes}`
    }
  }
}

const expenseKey = (
  expense: UninvoicedExpenseCandidateRow,
  summary: InvoiceGenerationExpenseSummary,
): string => {
  switch (summary) {
    case 'project':
      return `${expense.projectId}`
    case 'category':
      return `${expense.projectId}:${expense.categoryId}`
    case 'people':
      return `${expense.projectId}:${expense.userId}`
    case 'detailed':
      return `${expense.id}`
  }
}

const groupExpenses = (
  expenses: readonly UninvoicedExpenseCandidateRow[],
  summary: InvoiceGenerationExpenseSummary,
): ExpenseGroup[] => {
  const groups = new Map<string, ExpenseGroup>()
  for (const expense of expenses) {
    const key = expenseKey(expense, summary)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        projectId: expense.projectId,
        description: expenseDescription(expense, summary),
        expenses: [expense],
      })
    } else {
      existing.expenses.push(expense)
    }
  }
  return [...groups.values()]
}

const buildLines = async (
  commandId: string,
  timeEntries: readonly UninvoicedTimeCandidateRow[],
  expenses: readonly UninvoicedExpenseCandidateRow[],
  request: GenerateInvoiceRequest,
): Promise<GeneratedLine[]> => {
  const draft: Omit<GeneratedLine, 'id' | 'position'>[] = []
  if (request.timeSummaryType !== null) {
    for (const group of groupTime(timeEntries, request.timeSummaryType)) {
      const roundedSeconds = checkedIntegerSum(
        group.entries.map((entry) => entry.roundedSeconds),
        'time duration',
      )
      const amountCents = checkedSum(
        group.entries.map((entry) =>
          trackedAmountCents(
            entry.roundedSeconds,
            entry.billableRateCents ?? invalid(`time entry ${entry.id} has no billable rate`),
          ),
        ),
        'time line amount',
      )
      const rates = new Set(group.entries.map((entry) => entry.billableRateCents))
      const quantity = roundedSeconds / 3_600
      const pricing = exactLinePrice(
        amountCents,
        quantity,
        rates.size === 1
          ? (group.entries[0]!.billableRateCents ?? 0)
          : Math.round(amountCents / quantity),
      )
      draft.push({
        kind: 'Service',
        description: group.description,
        quantity: pricing.quantity,
        unitPriceCents: pricing.unitPriceCents,
        amountCents,
        projectId: group.projectId,
      })
    }
  }
  if (request.expenseSummaryType !== null) {
    for (const group of groupExpenses(expenses, request.expenseSummaryType)) {
      const amountCents = checkedSum(
        group.expenses.map((expense) => expense.totalCostCents),
        'expense line amount',
      )
      const detailedUnits =
        request.expenseSummaryType === 'detailed' ? group.expenses[0]!.units : null
      const preferredQuantity =
        detailedUnits !== null && detailedUnits > 0 ? detailedUnits : group.expenses.length
      const pricing = exactLinePrice(
        amountCents,
        preferredQuantity,
        Math.round(amountCents / preferredQuantity),
      )
      draft.push({
        kind: 'Expense',
        description: group.description,
        quantity: pricing.quantity,
        unitPriceCents: pricing.unitPriceCents,
        amountCents,
        projectId: group.projectId,
      })
    }
  }
  return Promise.all(
    draft.map(async (line, position) => ({
      ...line,
      id: await stableId('invoice-generation-line', commandId, String(position)),
      position,
    })),
  )
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

const validateSelection = async (
  database: InvoiceGenerationDatabase,
  request: GenerateInvoiceRequest,
): Promise<ClientDefaults> => {
  const client = await first<ClientDefaults>(database, {
    text: `SELECT id, upper(currency) AS currency, payment_terms AS "paymentTerms"
      FROM clients WHERE id = ?`,
    params: [request.clientId],
  })
  if (client === null) return invalid('the selected client does not exist')
  if (!/^[A-Z]{3}$/.test(client.currency)) invalid('the selected client currency is invalid')
  const projects = await all<{ id: number; clientId: number; isActive: number }>(database, {
    text: `SELECT id, client_id AS "clientId", is_active AS "isActive" FROM projects
      WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY id`,
    params: [JSON.stringify(request.projectIds)],
  })
  if (
    projects.length !== request.projectIds.length ||
    projects.some((project) => project.clientId !== request.clientId)
  ) {
    invalid('every selected project must belong to the selected client')
  }
  // Archived work is not billable, and the candidate read drops it. Refusing the
  // selection outright is the difference between "we do not bill this" and an
  // invoice that quietly came out short: a request naming one active and one
  // archived project would otherwise return a document covering half of what was
  // asked for, with nothing on it to say so.
  if (projects.some((project) => project.isActive !== 1)) {
    invalid('an archived project cannot be invoiced')
  }
  return client
}

const lineInsert = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
  linesJson: string,
  occurredAt: string,
): SqlStatement => ({
  text: `INSERT INTO invoice_line_items (
      id, invoice_id, position, kind, description, quantity, unit_price_cents,
      amount_cents, taxed, taxed2, project_id, created_at, updated_at
    ) SELECT
      CAST(json_extract(member.value, '$.id') AS INTEGER), ?,
      CAST(json_extract(member.value, '$.position') AS INTEGER),
      json_extract(member.value, '$.kind'), json_extract(member.value, '$.description'),
      json_extract(member.value, '$.quantity'),
      CAST(json_extract(member.value, '$.unit_price_cents') AS INTEGER),
      CAST(json_extract(member.value, '$.amount_cents') AS INTEGER), 0, 0,
      CAST(json_extract(member.value, '$.project_id') AS INTEGER), ?, ?
    FROM json_each(?, '$.lines') member
    WHERE EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = ? AND command.command_id = ?
        AND command.command_kind = 'invoice.create'
        AND command.input_fingerprint = ? AND command.completed = 0
    ) ORDER BY CAST(json_extract(member.value, '$.position') AS INTEGER)`,
  params: [
    invoiceId,
    occurredAt,
    occurredAt,
    linesJson,
    invoiceId,
    commandId,
    inputFingerprint,
  ],
})

const timeClaim = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
  sourceManifestJson: string,
  currency: string,
  request: GenerateInvoiceRequest,
): SqlStatement => ({
  text: `UPDATE time_entries SET invoice_id = ?
    WHERE id IN (
      SELECT CAST(json_extract(member.value, '$.id') AS INTEGER)
      FROM json_each(?, '$.time_entries') member
      WHERE time_entries.project_id = json_extract(member.value, '$.project_id')
        AND time_entries.spent_date = json_extract(member.value, '$.spent_date')
        AND time_entries.rounded_seconds = json_extract(member.value, '$.rounded_seconds')
        AND time_entries.billable_rate_cents IS json_extract(member.value, '$.billable_rate_cents')
        AND time_entries.updated_at = json_extract(member.value, '$.updated_at')
    ) AND billable = 1 AND invoice_id IS NULL AND timer_started_at IS NULL
      AND NOT (started_time IS NOT NULL AND ended_time IS NULL)
      AND EXISTS (
        SELECT 1 FROM projects project JOIN clients client ON client.id = project.client_id
        WHERE project.id = time_entries.project_id AND project.client_id = ?
          AND upper(coalesce(project.billing_currency, client.currency)) = ?
      ) AND EXISTS (
        SELECT 1 FROM invoice_command_ledger command
        WHERE command.invoice_id = ? AND command.command_id = ?
          AND command.command_kind = 'invoice.create'
          AND command.input_fingerprint = ? AND command.completed = 0
      )`,
  params: [
    invoiceId,
    sourceManifestJson,
    request.clientId,
    currency,
    invoiceId,
    commandId,
    inputFingerprint,
  ],
})

const expenseClaim = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
  sourceManifestJson: string,
  currency: string,
  request: GenerateInvoiceRequest,
): SqlStatement => ({
  text: `UPDATE expenses SET invoice_id = ?
    WHERE id IN (
      SELECT CAST(json_extract(member.value, '$.id') AS INTEGER)
      FROM json_each(?, '$.expenses') member
      WHERE expenses.project_id = json_extract(member.value, '$.project_id')
        AND expenses.spent_date = json_extract(member.value, '$.spent_date')
        AND expenses.total_cost_cents = json_extract(member.value, '$.total_cost_cents')
        AND expenses.updated_at = json_extract(member.value, '$.updated_at')
    ) AND billable = 1 AND invoice_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projects project JOIN clients client ON client.id = project.client_id
        WHERE project.id = expenses.project_id AND project.client_id = ?
          AND upper(coalesce(project.billing_currency, client.currency)) = ?
      ) AND EXISTS (
        SELECT 1 FROM invoice_command_ledger command
        WHERE command.invoice_id = ? AND command.command_id = ?
          AND command.command_kind = 'invoice.create'
          AND command.input_fingerprint = ? AND command.completed = 0
      )`,
  params: [
    invoiceId,
    sourceManifestJson,
    request.clientId,
    currency,
    invoiceId,
    commandId,
    inputFingerprint,
  ],
})

const eventPayload = (
  eventId: string,
  commandId: string,
  userId: number,
  invoiceId: number,
  occurredAt: string,
  amountCents: number,
): string =>
  JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: 'invoice.created',
    occurred_at: occurredAt,
    aggregate: { type: 'invoice', id: invoiceId, sequence: 0 },
    command: { id: commandId, kind: 'invoice.create', event_index: 0 },
    actor: { type: 'user', id: userId },
    trigger: { type: 'invoice_header', id: invoiceId },
    invoice: {
      before: null,
      after: {
        version: 0,
        updated_at: occurredAt,
        state: 'draft',
        close_reason: null,
        close_write_off_cents: 0,
        sent_at: null,
        paid_at: null,
        paid_date: null,
        closed_at: null,
        amount_cents: amountCents,
        due_amount_cents: amountCents,
        written_off_cents: 0,
        payment_count: 0,
        payment_status: 'unpaid',
      },
    },
    payment: { before: null, after: null },
  })

const outboxInsert = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
  eventId: string,
  occurredAt: string,
  payload: string,
): SqlStatement => ({
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
        AND command.command_kind = 'invoice.create'
        AND command.input_fingerprint = ? AND command.completed = 0
    )`,
  params: [
    eventId,
    invoiceId,
    commandId,
    payload,
    occurredAt,
    occurredAt,
    invoiceId,
    invoiceId,
    commandId,
    inputFingerprint,
  ],
})

const completion = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
): SqlStatement => ({
  text: `UPDATE invoice_command_ledger SET
      event_count = (
        SELECT count(*) FROM event_outbox event
        WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = ?
          AND event.command_id = ?
      ),
      first_aggregate_sequence = (
        SELECT min(aggregate_sequence) FROM event_outbox event
        WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = ?
          AND event.command_id = ?
      ),
      result_json = (
        SELECT json_object(
          'schema_version', 1,
          'event_ids', json((
            SELECT json_group_array(id) FROM (
              SELECT id FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
                AND event.command_id = ? ORDER BY event_index
            )
          )),
          'first_aggregate_sequence', (
            SELECT min(aggregate_sequence) FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
              AND event.command_id = ?
          ),
          'event_count', (
            SELECT count(*) FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
              AND event.command_id = ?
          ),
          'invoice', json_object(
            'id', invoice.id, 'client_id', invoice.client_id,
            'created_by_user_id', invoice.created_by_user_id, 'number', invoice.number,
            'subject', invoice.subject, 'purchase_order', invoice.purchase_order,
            'notes', invoice.notes, 'currency', invoice.currency,
            'issue_date', invoice.issue_date, 'due_date', invoice.due_date,
            'payment_terms', invoice.payment_terms, 'state', invoice.state,
            'version', invoice.version, 'close_reason', invoice.close_reason,
            'close_write_off_cents', invoice.close_write_off_cents,
            'sent_at', invoice.sent_at, 'paid_at', invoice.paid_at,
            'paid_date', invoice.paid_date, 'closed_at', invoice.closed_at,
            'period_start', invoice.period_start, 'period_end', invoice.period_end,
            'project_id', invoice.project_id, 'retainer_id', invoice.retainer_id,
            'recurring_invoice_id', invoice.recurring_invoice_id,
            'estimate_id', invoice.estimate_id,
            'reminder_policy', CASE WHEN invoice.reminder_policy IS NULL THEN NULL
              ELSE json(invoice.reminder_policy) END,
            'tax_rate_ppm', invoice.tax_rate_ppm, 'tax2_rate_ppm', invoice.tax2_rate_ppm,
            'discount_rate_ppm', invoice.discount_rate_ppm,
            'amount_cents', invoice.amount_cents, 'due_amount_cents', invoice.due_amount_cents,
            'tax_amount_cents', invoice.tax_amount_cents,
            'tax2_amount_cents', invoice.tax2_amount_cents,
            'discount_amount_cents', invoice.discount_amount_cents,
            'written_off_cents', invoice.written_off_cents,
            'payment_options', json(invoice.payment_options),
            'reference_token', invoice.reference_token,
            'created_at', invoice.created_at, 'updated_at', invoice.updated_at,
            'line_items', json(COALESCE((
              SELECT json_group_array(json(item.value)) FROM (
                SELECT json_object(
                  'id', line.id, 'invoice_id', line.invoice_id, 'position', line.position,
                  'kind', line.kind, 'description', line.description, 'quantity', line.quantity,
                  'unit_price_cents', line.unit_price_cents, 'amount_cents', line.amount_cents,
                  'taxed', json(CASE line.taxed WHEN 1 THEN 'true' ELSE 'false' END),
                  'taxed2', json(CASE line.taxed2 WHEN 1 THEN 'true' ELSE 'false' END),
                  'project_id', line.project_id, 'created_at', line.created_at,
                  'updated_at', line.updated_at
                ) AS value
                FROM invoice_line_items line WHERE line.invoice_id = invoice.id
                ORDER BY line.position, line.id
              ) item
            ), '[]'))
          )
        ) FROM invoices invoice WHERE invoice.id = ?
      ),
      completed_at = occurred_at,
      completed = 1
    WHERE invoice_id = ? AND command_id = ? AND input_fingerprint = ? AND completed = 0`,
  params: [
    invoiceId,
    commandId,
    invoiceId,
    commandId,
    commandId,
    commandId,
    commandId,
    invoiceId,
    invoiceId,
    commandId,
    inputFingerprint,
  ],
})

const createStatements = (input: {
  command: GenerateInvoiceCommand
  request: GenerateInvoiceRequest
  client: ClientDefaults
  invoiceId: number
  eventId: string
  fingerprint: string
  occurredAt: string
  lines: readonly GeneratedLine[]
  timeEntries: readonly UninvoicedTimeCandidateRow[]
  expenses: readonly UninvoicedExpenseCandidateRow[]
  amountCents: number
  currency: string
  requestJson: string
  sourceManifestJson: string
  lineManifestJson: string
}): SqlStatement[] => {
  const issueDate = input.occurredAt.slice(0, 10)
  const projectId = input.request.projectIds.length === 1 ? input.request.projectIds[0]! : null
  const statements: SqlStatement[] = [
    {
      text: `INSERT INTO invoice_command_ledger (
          invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
          expected_invoice_version, occurred_at, request_json, source_manifest_json,
          line_manifest_json
        ) VALUES (?, ?, 'invoice.create', ?, 'user', ?, 0, ?, ?, ?, ?)`,
      params: [
        input.invoiceId,
        input.command.commandId,
        input.fingerprint,
        input.command.principal.userId,
        input.occurredAt,
        input.requestJson,
        input.sourceManifestJson,
        input.lineManifestJson,
      ],
    },
    {
      text: `INSERT INTO invoices (
          id, client_id, created_by_user_id, number, subject, currency,
          issue_date, due_date, payment_terms, period_start, period_end,
          project_id, created_at, updated_at
        ) SELECT ?, ?, ?, CAST(sequence.next_number AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM invoice_number_sequence sequence
        WHERE sequence.singleton = 1
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND is_active = 1 AND profile = ?
              AND profile IN ('accounting','executive_manager','administrator')
          )
          AND EXISTS (SELECT 1 FROM clients WHERE id = ?)
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'invoice.create'
              AND command.input_fingerprint = ? AND command.completed = 0
          )`,
      params: [
        input.invoiceId,
        input.request.clientId,
        input.command.principal.userId,
        `Tracked work ${input.request.from} – ${input.request.to}`,
        input.currency,
        issueDate,
        dueDate(issueDate, input.client.paymentTerms),
        input.client.paymentTerms,
        input.request.from,
        input.request.to,
        projectId,
        input.occurredAt,
        input.occurredAt,
        input.command.principal.userId,
        input.command.principal.profile,
        input.request.clientId,
        input.invoiceId,
        input.command.commandId,
        input.fingerprint,
      ],
    },
    lineInsert(
      input.invoiceId,
      input.command.commandId,
      input.fingerprint,
      input.lineManifestJson,
      input.occurredAt,
    ),
  ]
  if (input.timeEntries.length > 0) {
    statements.push(
      timeClaim(
        input.invoiceId,
        input.command.commandId,
        input.fingerprint,
        input.sourceManifestJson,
        input.currency,
        input.request,
      ),
    )
  }
  if (input.expenses.length > 0) {
    statements.push(
      expenseClaim(
        input.invoiceId,
        input.command.commandId,
        input.fingerprint,
        input.sourceManifestJson,
        input.currency,
        input.request,
      ),
    )
  }
  statements.push(
    outboxInsert(
      input.invoiceId,
      input.command.commandId,
      input.fingerprint,
      input.eventId,
      input.occurredAt,
      eventPayload(
        input.eventId,
        input.command.commandId,
        input.command.principal.userId,
        input.invoiceId,
        input.occurredAt,
        input.amountCents,
      ),
    ),
    completion(input.invoiceId, input.command.commandId, input.fingerprint),
  )
  return statements
}

export const createInvoiceGenerationService = (
  database: InvoiceGenerationDatabase,
  options: InvoiceGenerationServiceOptions = {},
): InvoiceGenerationService => ({
  async generate(input): Promise<InvoiceResource> {
    const request = normalizedRequest(input)
    await assertAuthorized(database, input.principal)
    const invoiceId = await stableId('invoice-generation', input.commandId)
    const inputFingerprint = await fingerprint(
      input.commandId,
      input.principal.userId,
      request,
    )
    const existing = await readCommand(database, invoiceId, input.commandId)
    if (existing !== null) {
      await assertAuthorized(database, input.principal)
      return parseStoredInvoice(existing, inputFingerprint, input.principal.userId)
    }

    const client = await validateSelection(database, request)
    const candidates = await readUninvoicedCandidates(database, {
      clientId: request.clientId,
      from: request.from,
      to: request.to,
      projectIds: request.projectIds,
    })
    const timeEntries = request.timeSummaryType === null ? [] : candidates.timeEntries
    const expenses = request.expenseSummaryType === null ? [] : candidates.expenses
    if (timeEntries.length === 0 && expenses.length === 0) {
      invalid('the selected filter has no uninvoiced billable content')
    }
    if (timeEntries.length + expenses.length > maximumGenerationSourceRows) {
      invalid(
        `one generation command can consume at most ${maximumGenerationSourceRows} tracked rows`,
      )
    }
    let preview: ReturnType<typeof uninvoicedGenerationPreview>
    try {
      preview = uninvoicedGenerationPreview({ timeEntries, expenses })
    } catch (error) {
      if (error instanceof RangeError) invalid(error.message)
      throw error
    }
    if (preview.length !== 1) invalid('selected tracked rows must use one invoice currency')
    const currencyTotal = preview[0]!
    const currency = currencyTotal.currency
    const lines = await buildLines(input.commandId, timeEntries, expenses, request)
    const amountCents = checkedSum(
      lines.map((line) => line.amountCents),
      'invoice amount',
    )
    if (amountCents !== currencyTotal.totalCents) {
      throw new Error('invoice generation lines diverged from the canonical uninvoiced preview')
    }
    const sourceManifestJson = sourceManifest(timeEntries, expenses)
    const lineManifestJson = lineManifest(lines)
    const requestJson = requestManifest(
      request,
      currency,
      amountCents,
      lines.length,
      timeEntries.length,
      expenses.length,
    )
    const manifestBytes = new TextEncoder().encode(
      `${sourceManifestJson}${lineManifestJson}${requestJson}`,
    ).byteLength
    if (manifestBytes > maximumGenerationManifestBytes) {
      invalid('the generated invoice manifest is too large for one atomic command')
    }
    const occurredAt = (options.clock ?? (() => new Date().toISOString()))()
    assertTimestamp(occurredAt)
    const eventId = `evt_${await digest(`invoice-generation-event\u001f${input.commandId}`)}`
    try {
      await runAtomic(
        database,
        createStatements({
          command: input,
          request,
          client,
          invoiceId,
          eventId,
          fingerprint: inputFingerprint,
          occurredAt,
          lines,
          timeEntries,
          expenses,
          amountCents,
          currency,
          requestJson,
          sourceManifestJson,
          lineManifestJson,
        }),
      )
    } catch (error) {
      const winner = await readCommand(database, invoiceId, input.commandId)
      if (winner !== null) {
        await assertAuthorized(database, input.principal)
        return parseStoredInvoice(winner, inputFingerprint, input.principal.userId)
      }
      await assertAuthorized(database, input.principal)
      const current = await readUninvoicedCandidates(database, {
        clientId: request.clientId,
        from: request.from,
        to: request.to,
        projectIds: request.projectIds,
      })
      const currentTime = request.timeSummaryType === null ? [] : current.timeEntries
      const currentExpenses = request.expenseSummaryType === null ? [] : current.expenses
      if (
        candidateSignature(timeEntries, expenses) !==
        candidateSignature(currentTime, currentExpenses)
      ) {
        throw new InvoiceGenerationError(
          'generation_conflict',
          'tracked rows changed or were invoiced while generation was committing',
        )
      }
      throw error
    }

    const completed = await readCommand(database, invoiceId, input.commandId)
    if (completed === null) {
      throw new InvoiceGenerationError(
        'command_storage_conflict',
        'generation committed without a durable result',
      )
    }
    await assertAuthorized(database, input.principal)
    return parseStoredInvoice(completed, inputFingerprint, input.principal.userId)
  },
})
