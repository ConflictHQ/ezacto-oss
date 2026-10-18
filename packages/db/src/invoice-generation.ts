import {
  calculateInvoiceLineAmountCents,
  hoursToTheHundredth,
  invoiceDueDate,
  reportNoteIsClientVisible,
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
import { bandClaimSelection, bandForegoneUpdate, type BandClaimCeiling } from './band-claim.js'

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
  /** Absent is 'tracked', the only kind there was before blank drafts. */
  kind?: 'tracked'
  clientId: number
  /**
   * Null leaves the start open: every uninvoiced billable row up to and
   * including `to`, with the period starting on the earliest row billed.
   */
  from: string | null
  to: string
  projectIds: readonly number[]
  timeSummaryType: InvoiceGenerationTimeSummary | null
  expenseSummaryType: InvoiceGenerationExpenseSummary | null
}

/**
 * Harvest's free-form invoice: a numbered draft for one client with no lines,
 * no period and no project, written by hand afterwards. Nothing tracked is
 * read or claimed.
 */
export interface GenerateFreeFormInvoiceRequest {
  kind: 'free_form'
  clientId: number
}

/** One line of a band's fee, written as a free-form line is. */
export interface BandedFeeLine {
  kind: string
  description: string | null
  quantity: number
  unitPriceCents: number
  projectId: number | null
}

/**
 * A flat fee covering tracked time: the fee lines, and the uninvoiced time on
 * the selected projects in the period, which the fee consumes instead of
 * pricing (a band, as a recurring definition with `claims_project_ids` raises
 * one). Every entry read lands on this invoice. Those the band claims -- all of
 * them, or the oldest up to a ceiling by the recurring engine's own rule --
 * contribute no line; the rest are billed after the fee as tracked lines at
 * each person's rate. Expenses are not a band's to claim and are left alone.
 */
export interface GenerateBandedInvoiceRequest {
  kind: 'banded'
  clientId: number
  /** Null leaves the start open, as on a tracked request. */
  from: string | null
  to: string
  projectIds: readonly number[]
  lineItems: readonly BandedFeeLine[]
  claimMode: 'all' | 'ceiling'
  /** Exactly one of the two is set on a ceiling, and neither on `all`. */
  claimCeilingSeconds: number | null
  claimCeilingCents: number | null
  /** How hours past the ceiling are billed: required on a ceiling, null on `all`. */
  overageSummaryType: InvoiceGenerationTimeSummary | null
}

export interface GenerateInvoicePrincipal {
  userId: number
  profile: string
}

export interface GenerateInvoiceCommand {
  commandId: string
  principal: GenerateInvoicePrincipal
  request: GenerateInvoiceRequest | GenerateFreeFormInvoiceRequest | GenerateBandedInvoiceRequest
}

/**
 * What a banded draft's fee covered and what it billed past its ceiling, as
 * its receipt records them. A band over no uninvoiced time is still a fee the
 * client owes, so zero claimed hours is an answer rather than a refusal.
 */
export interface InvoiceBandClaim {
  claimed_entry_count: number
  claimed_seconds: number
  billed_entry_count: number
  billed_seconds: number
}

/** The draft; a banded one also says what its fee covered. */
export type GeneratedInvoice = InvoiceResource & { band?: InvoiceBandClaim }

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
  generate(input: GenerateInvoiceCommand): Promise<GeneratedInvoice>
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
  requestJson: string | null
  resultJson: string | null
}

interface ClientDefaults {
  id: number
  name: string
  currency: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
  /** The organization's Default values, copied onto the draft (migration 0097). */
  defaultSubject: string | null
  defaultNotes: string | null
}

interface SelectedProject {
  id: number
  clientId: number
  isActive: number
  name: string
  currency: string
}

interface GeneratedLine {
  id: number
  position: number
  kind: string
  description: string | null
  quantity: number
  unitPriceCents: number
  amountCents: number
  projectId: number | null
}

type DraftLine = Omit<GeneratedLine, 'id' | 'position'>

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

/**
 * What a generated line's description is written from besides its own rows:
 * the period the invoice covers, as Harvest wrote it into every grouped line,
 * in the organization's date format, and whether a note may reach the client.
 */
interface LineContext {
  periodStart: string
  periodEnd: string
  dateFormat: string
  notesVisibleByDefault: boolean
}

type NormalizedRequest =
  | GenerateInvoiceRequest
  | GenerateFreeFormInvoiceRequest
  | GenerateBandedInvoiceRequest

interface InvoiceHeader {
  subject: string | null
  periodStart: string | null
  periodEnd: string | null
  projectId: number | null
  /** The one project's name, for a default subject's `%project%`. */
  projectName: string | null
}

/** Everything one creation command writes, before the manifests describing it. */
interface GenerationContent {
  client: ClientDefaults
  header: InvoiceHeader
  timeEntries: readonly UninvoicedTimeCandidateRow[]
  expenses: readonly UninvoicedExpenseCandidateRow[]
  lines: readonly GeneratedLine[]
  currency: string
  amountCents: number
  /** A banded draft's fee line count and what the fee covered; null otherwise. */
  band: (InvoiceBandClaim & { feeLineCount: number }) | null
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

const trackedOnlyFields = [
  'from',
  'to',
  'projectIds',
  'timeSummaryType',
  'expenseSummaryType',
] as const

const timeSummaries: ReadonlySet<unknown> = new Set(['project', 'task', 'people', 'detailed'])
/** A fee is a handful of lines; the hours it covers are what can run long. */
export const maximumBandFeeLines = 100

const normalizedSelection = (
  request: Pick<GenerateInvoiceRequest, 'from' | 'to' | 'projectIds'>,
): Pick<GenerateInvoiceRequest, 'from' | 'to' | 'projectIds'> => {
  const from = request.from ?? null
  if (from !== null) assertDate(from, 'from')
  assertDate(request.to, 'to')
  if (from !== null && from > request.to) invalid('generation date range is inverted')
  if (
    !Array.isArray(request.projectIds) ||
    request.projectIds.length === 0 ||
    request.projectIds.length > 10_000 ||
    request.projectIds.some((projectId) => !Number.isSafeInteger(projectId) || projectId < 1) ||
    new Set(request.projectIds).size !== request.projectIds.length
  ) {
    invalid('projectIds must be a non-empty unique positive integer list')
  }
  return {
    from,
    to: request.to,
    projectIds: [...request.projectIds].sort((left, right) => left - right),
  }
}

const normalizedFeeLine = (line: BandedFeeLine, index: number): BandedFeeLine => {
  const field = `lineItems[${index}]`
  if (typeof line.kind !== 'string' || line.kind.trim() === '' || line.kind.length > 255) {
    invalid(`${field}.kind must be a non-blank string of at most 255 characters`)
  }
  if (
    line.description !== null &&
    (typeof line.description !== 'string' || line.description.length > 100_000)
  ) {
    invalid(`${field}.description must be a bounded string or null`)
  }
  if (line.projectId !== null && (!Number.isSafeInteger(line.projectId) || line.projectId < 1)) {
    invalid(`${field}.projectId must be a positive safe integer or null`)
  }
  try {
    calculateInvoiceLineAmountCents(line.quantity, line.unitPriceCents)
  } catch {
    invalid(`${field} quantity and unit price must produce a bounded amount`)
  }
  return {
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    projectId: line.projectId,
  }
}

const positiveLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const normalizedBandedRequest = (
  request: GenerateBandedInvoiceRequest,
): GenerateBandedInvoiceRequest => {
  for (const field of ['timeSummaryType', 'expenseSummaryType'] as const) {
    // A band bills its own fee; a summary for the whole selection says the
    // caller expected the hours priced, which is the tracked kind.
    if (Reflect.get(request, field) !== undefined) invalid(`a banded invoice takes no ${field}`)
  }
  const selection = normalizedSelection(request)
  if (
    !Array.isArray(request.lineItems) ||
    request.lineItems.length === 0 ||
    request.lineItems.length > maximumBandFeeLines
  ) {
    invalid(`lineItems must hold the fee in 1-${maximumBandFeeLines} lines`)
  }
  const lineItems = request.lineItems.map(normalizedFeeLine)
  const seconds = request.claimCeilingSeconds ?? null
  const cents = request.claimCeilingCents ?? null
  const overage = request.overageSummaryType ?? null
  if (request.claimMode === 'all') {
    // Refused rather than ignored: a limit on a band that takes everything
    // would read as one that does not.
    if (seconds !== null || cents !== null) invalid('a band covering all of the time takes no ceiling')
    if (overage !== null) invalid('a band covering all of the time bills no overage')
  } else if (request.claimMode === 'ceiling') {
    if (
      !(positiveLimit(seconds) && cents === null) &&
      !(positiveLimit(cents) && seconds === null)
    ) {
      invalid('a ceiling needs exactly one positive limit, in seconds or in cents')
    }
    if (!timeSummaries.has(overage)) {
      invalid('a ceiling needs overageSummaryType: project, task, people, or detailed')
    }
  } else {
    invalid('claimMode must be all or ceiling')
  }
  return {
    kind: 'banded',
    clientId: request.clientId,
    ...selection,
    lineItems,
    claimMode: request.claimMode,
    claimCeilingSeconds: seconds,
    claimCeilingCents: cents,
    overageSummaryType: overage,
  }
}

const normalizedRequest = (input: GenerateInvoiceCommand): NormalizedRequest => {
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
  const kind: unknown = request.kind
  if (kind !== undefined && kind !== 'tracked' && kind !== 'free_form' && kind !== 'banded') {
    invalid('kind must be tracked, free_form, or banded')
  }
  if (request.kind === 'free_form') {
    // Refused rather than ignored: a range or a project on a blank draft says
    // the caller expected tracked work on it, and none will be there.
    for (const field of trackedOnlyFields) {
      if (Reflect.get(request, field) !== undefined) {
        invalid(`a free-form invoice takes no ${field}`)
      }
    }
    return { kind: 'free_form', clientId: request.clientId }
  }
  if (request.kind === 'banded') return normalizedBandedRequest(request)
  const selection = normalizedSelection(request)
  if (request.timeSummaryType === null && request.expenseSummaryType === null) {
    invalid('at least one generation summary type is required')
  }
  return { ...request, ...selection }
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

/** A band's terms, as its fingerprint and its receipt both name them. */
const bandTerms = (request: GenerateBandedInvoiceRequest) => ({
  claim_mode: request.claimMode,
  claim_ceiling_seconds: request.claimCeilingSeconds,
  claim_ceiling_cents: request.claimCeilingCents,
  overage_summary_type: request.overageSummaryType,
})

const fingerprintInput = (request: NormalizedRequest): Record<string, unknown> => {
  switch (request.kind) {
    case 'free_form':
      return { expected_version: 0, kind: request.kind, client_id: request.clientId }
    case 'banded':
      return {
        expected_version: 0,
        kind: request.kind,
        client_id: request.clientId,
        from: request.from,
        to: request.to,
        project_ids: request.projectIds,
        line_items: request.lineItems.map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unit_price_cents: line.unitPriceCents,
          project_id: line.projectId,
        })),
        ...bandTerms(request),
      }
    default:
      return {
        expected_version: 0,
        client_id: request.clientId,
        from: request.from,
        to: request.to,
        project_ids: request.projectIds,
        time_summary_type: request.timeSummaryType,
        expense_summary_type: request.expenseSummaryType,
      }
  }
}

const fingerprint = async (
  commandId: string,
  userId: number,
  request: NormalizedRequest,
): Promise<string> =>
  `sha256:${await digest(
    canonicalJson({
      invoice_id: await stableId('invoice-generation', commandId),
      command_kind: 'invoice.create',
      actor: { type: 'user', id: userId },
      // A tracked request hashes the keys it always has, so every receipt
      // written before blank drafts still replays; an open start hashes as a
      // null `from`. A free-form or banded one carries the kind no tracked
      // input has, so no two kinds can hash alike.
      input: fingerprintInput(request),
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
        completed, request_json AS "requestJson", result_json AS "resultJson"
      FROM invoice_command_ledger WHERE invoice_id = ? AND command_id = ?`,
    params: [invoiceId, commandId],
  })

/**
 * What a banded receipt says its fee covered. Read back from the receipt rather
 * than carried beside it, so a replay answers exactly what the first call did.
 */
const storedBandClaim = (requestJson: string | null): InvoiceBandClaim | null => {
  let stored: unknown
  try {
    stored = requestJson === null ? null : JSON.parse(requestJson)
  } catch {
    throw new InvoiceGenerationError('command_storage_conflict', 'stored generation request is invalid')
  }
  if (typeof stored !== 'object' || stored === null || Reflect.get(stored, 'kind') !== 'banded') {
    return null
  }
  const count = (key: keyof InvoiceBandClaim): number => {
    const value: unknown = Reflect.get(stored, key)
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new InvoiceGenerationError(
        'command_storage_conflict',
        'stored banded request has an unsupported shape',
      )
    }
    return value
  }
  return {
    claimed_entry_count: count('claimed_entry_count'),
    claimed_seconds: count('claimed_seconds'),
    billed_entry_count: count('billed_entry_count'),
    billed_seconds: count('billed_seconds'),
  }
}

const parseStoredInvoice = (
  command: StoredCreateCommand,
  expectedFingerprint: string,
  userId: number,
): GeneratedInvoice => {
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
  const invoice = Reflect.get(stored, 'invoice') as InvoiceResource
  const band = storedBandClaim(command.requestJson)
  return band === null ? invoice : { ...invoice, band }
}

const checkedSum = (values: readonly number[], field: string): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < 0n || sum > centsLimit) invalid(`${field} exceeds the invoice cents limit`)
  return Number(sum)
}

/**
 * A line groups tracked rows, and a correction is one of them: an entry of
 * -1.0h against the same task nets against the +8.0h beside it, which is how
 * Harvest shows a corrected day. So a group's own total is signed, bounded by
 * magnitude, even though the invoice it lands on is not -- an invoice for a
 * negative amount is a credit note, a different document, and `checkedSum`
 * still refuses one at the total.
 */
const checkedSignedSum = (values: readonly number[], field: string): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < -centsLimit || sum > centsLimit) invalid(`${field} exceeds the invoice cents limit`)
  return Number(sum)
}

const checkedIntegerSum = (values: readonly number[], field: string): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (
    sum < BigInt(Number.MIN_SAFE_INTEGER) ||
    sum > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
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

const selectionManifest = (
  request: NormalizedRequest,
  periodStart: string | null,
): Record<string, unknown> => {
  switch (request.kind) {
    case 'free_form':
      return { kind: request.kind, client_id: request.clientId }
    case 'banded':
      return {
        kind: request.kind,
        client_id: request.clientId,
        from: periodStart,
        to: request.to,
        project_ids: request.projectIds,
        ...bandTerms(request),
      }
    default:
      return {
        client_id: request.clientId,
        from: periodStart,
        to: request.to,
        project_ids: request.projectIds,
        time_summary_type: request.timeSummaryType,
        expense_summary_type: request.expenseSummaryType,
      }
  }
}

/**
 * The creation CHECK and event guard read this against the header, so a
 * tracked `from` is the period the invoice covers -- for an open start, the
 * first date it bills -- and a blank draft records its kind and no selection.
 * A banded one records its terms, how many of its lines are the fee, and what
 * the fee covered against what was billed past it.
 */
const requestManifest = (request: NormalizedRequest, content: GenerationContent): string =>
  canonicalJson({
    schema_version: 1,
    expected_version: 0,
    ...selectionManifest(request, content.header.periodStart),
    currency: content.currency,
    amount_cents: content.amountCents,
    line_count: content.lines.length,
    time_entry_count: content.timeEntries.length,
    expense_count: content.expenses.length,
    ...(content.band === null
      ? {}
      : {
          fee_line_count: content.band.feeLineCount,
          claimed_entry_count: content.band.claimed_entry_count,
          claimed_seconds: content.band.claimed_seconds,
          billed_entry_count: content.band.billed_entry_count,
          billed_seconds: content.band.billed_seconds,
        }),
  })

/**
 * An expense line keeps its exact total: units times a price where that comes
 * out to the cent, else one of the whole amount. Expenses are amounts, not
 * hours, so nothing here rounds them; time lines are priced by `timeLines`.
 */
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

/** Harvest's `[code] ` before a project's name, or the name alone when it has no code. */
const projectLabel = (name: string, code: string): string =>
  code.trim() === '' ? name : `[${code}] ${name}`

/**
 * A calendar date as the organization writes dates (`date_format`, which an
 * import carries over from the Harvest account). Harvest wrote every date in a
 * generated line in the account's own format, so an account that kept
 * `%m/%d/%Y` reads `08/31/2026` there and one on `%Y-%m-%d` reads `2026-08-31`.
 */
const organizationDate = (date: string, format: string): string =>
  format.replace(/%[Ymd]/gu, (token) =>
    token === '%Y' ? date.slice(0, 4) : token === '%m' ? date.slice(5, 7) : date.slice(8, 10),
  )

/** A grouped line names the period it covers: ` (2026-08-01 - 2026-08-31)`. */
const linePeriod = (context: LineContext): string =>
  ` (${organizationDate(context.periodStart, context.dateFormat)} - ${organizationDate(
    context.periodEnd,
    context.dateFormat,
  )})`

/**
 * Harvest's line descriptions, to the character, so a draft reads as the
 * invoices a client has been receiving:
 *
 * - by project: `[code] Project (from - to)`
 * - by task or person: `[code] Project: Task (from - to)`, `... : Person (...)`
 * - detailed: `[code] Project - date - Task / Person: note`
 *
 * A detailed line carries the entry's note only where a client may read it
 * (D20): the entry's own `client_visible`, else the organization's default. The
 * line is printed on the invoice, listed in its email, and mirrored to the
 * books, so an internal note written into it would leave by all three. Without
 * one the line simply ends at the person.
 */
const timeDescription = (
  entry: UninvoicedTimeCandidateRow,
  summary: InvoiceGenerationTimeSummary,
  context: LineContext,
): string => {
  const project = projectLabel(entry.projectName, entry.projectCode)
  switch (summary) {
    case 'project':
      return `${project}${linePeriod(context)}`
    case 'task':
      return `${project}: ${entry.taskName}${linePeriod(context)}`
    case 'people':
      return `${project}: ${entry.userName}${linePeriod(context)}`
    case 'detailed': {
      const detail = `${project} - ${organizationDate(entry.spentDate, context.dateFormat)} - ${entry.taskName} / ${entry.userName}`
      const visible = reportNoteIsClientVisible(
        { clientVisible: entry.clientVisible === null ? null : entry.clientVisible === 1 },
        context.notesVisibleByDefault,
      )
      return !visible || entry.notes === null || entry.notes.trim() === ''
        ? detail
        : `${detail}: ${entry.notes}`
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
  context: LineContext,
): TimeGroup[] => {
  const groups = new Map<string, TimeGroup>()
  for (const entry of entries) {
    const key = timeKey(entry, summary)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        projectId: entry.projectId,
        description: timeDescription(entry, summary, context),
        entries: [entry],
      })
    } else {
      existing.entries.push(entry)
    }
  }
  return [...groups.values()]
}

/** The same shapes, with the expense category where time has its task. */
const expenseDescription = (
  expense: UninvoicedExpenseCandidateRow,
  summary: InvoiceGenerationExpenseSummary,
  context: LineContext,
): string => {
  const project = projectLabel(expense.projectName, expense.projectCode)
  switch (summary) {
    case 'project':
      return `${project}${linePeriod(context)}`
    case 'category':
      return `${project}: ${expense.categoryName}${linePeriod(context)}`
    case 'people':
      return `${project}: ${expense.userName}${linePeriod(context)}`
    case 'detailed': {
      const detail = `${project} - ${organizationDate(expense.spentDate, context.dateFormat)} - ${expense.categoryName} / ${expense.userName}`
      return expense.notes === null || expense.notes.trim() === ''
        ? detail
        : `${detail}: ${expense.notes}`
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
  context: LineContext,
): ExpenseGroup[] => {
  const groups = new Map<string, ExpenseGroup>()
  for (const expense of expenses) {
    const key = expenseKey(expense, summary)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        projectId: expense.projectId,
        description: expenseDescription(expense, summary, context),
        expenses: [expense],
      })
    } else {
      existing.expenses.push(expense)
    }
  }
  return [...groups.values()]
}

/**
 * Tracked time, one line per group, written the way Harvest writes it: the
 * group's hours to the hundredth times its rate, and the amount computed from
 * those two (issue 923). That can differ by a few cents from pricing each
 * entry on its own; the line is what the client reads and checks, so the line
 * is what is billed. The hours are `hoursToTheHundredth`, the figure the work
 * journal prints for the same entries.
 *
 * A group at one rate bills at that rate. One that mixes rates -- a task
 * several people worked at their own rates -- bills at its per-entry total
 * over the rounded hours, to the cent, which is as close to the entries as one
 * quantity and one price can come. Hours that round to nothing bill nothing.
 */
const timeLines = (
  entries: readonly UninvoicedTimeCandidateRow[],
  summary: InvoiceGenerationTimeSummary,
  context: LineContext,
): DraftLine[] =>
  groupTime(entries, summary, context).map((group) => {
    const roundedSeconds = checkedIntegerSum(
      group.entries.map((entry) => entry.roundedSeconds),
      'time duration',
    )
    const rates = group.entries.map(
      (entry) => entry.billableRateCents ?? invalid(`time entry ${entry.id} has no billable rate`),
    )
    const quantity = hoursToTheHundredth(roundedSeconds)
    let unitPriceCents = rates[0]!
    if (quantity !== 0 && rates.some((rate) => rate !== unitPriceCents)) {
      const entriesCents = checkedSignedSum(
        group.entries.map((entry, index) => trackedAmountCents(entry.roundedSeconds, rates[index]!)),
        'time line amount',
      )
      unitPriceCents = Math.round(entriesCents / quantity)
    }
    let amountCents: number
    try {
      amountCents = calculateInvoiceLineAmountCents(quantity, unitPriceCents)
    } catch (error) {
      if (error instanceof RangeError) return invalid('time line amount exceeds the invoice cents limit')
      throw error
    }
    return {
      kind: 'Service',
      description: group.description,
      quantity,
      unitPriceCents,
      amountCents: checkedSignedSum([amountCents], 'time line amount'),
      projectId: group.projectId,
    }
  })

const expenseLines = (
  expenses: readonly UninvoicedExpenseCandidateRow[],
  summary: InvoiceGenerationExpenseSummary,
  context: LineContext,
): DraftLine[] =>
  groupExpenses(expenses, summary, context).map((group) => {
    const amountCents = checkedSum(
      group.expenses.map((expense) => expense.totalCostCents),
      'expense line amount',
    )
    const detailedUnits = summary === 'detailed' ? group.expenses[0]!.units : null
    const preferredQuantity =
      detailedUnits !== null && detailedUnits > 0 ? detailedUnits : group.expenses.length
    const pricing = exactLinePrice(
      amountCents,
      preferredQuantity,
      Math.round(amountCents / preferredQuantity),
    )
    return {
      kind: 'Expense',
      description: group.description,
      quantity: pricing.quantity,
      unitPriceCents: pricing.unitPriceCents,
      amountCents,
      projectId: group.projectId,
    }
  })

/** Lines take their ids from the command, so a retry writes the same ones. */
const numberedLines = (commandId: string, draft: readonly DraftLine[]): Promise<GeneratedLine[]> =>
  Promise.all(
    draft.map(async (line, position) => ({
      ...line,
      id: await stableId('invoice-generation-line', commandId, String(position)),
      position,
    })),
  )

const readClient = async (
  database: InvoiceGenerationDatabase,
  clientId: number,
): Promise<ClientDefaults> => {
  const client = await first<Omit<ClientDefaults, 'defaultSubject' | 'defaultNotes'>>(database, {
    text: `SELECT id, name, upper(currency) AS currency, payment_terms AS "paymentTerms"
      FROM clients WHERE id = ?`,
    params: [clientId],
  })
  if (client === null) return invalid('the selected client does not exist')
  if (!/^[A-Z]{3}$/.test(client.currency)) invalid('the selected client currency is invalid')
  // What a new draft starts with (migration 0097). `*` rather than the two
  // columns by name, so a database the defaults have not reached yet starts a
  // draft with none instead of refusing to make one. The notes carry the
  // payment details; once copied they belong to the invoice.
  const organization = await first<Record<string, unknown>>(database, {
    text: `SELECT * FROM organizations ORDER BY id LIMIT 1`,
    params: [],
  })
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    ...client,
    defaultSubject: text(organization?.invoice_default_subject),
    defaultNotes: text(organization?.invoice_default_notes),
  }
}

/** A client in the tree under the invoice's client, named for the order lines are written in. */
interface ClientNode {
  id: number
  name: string
  parentClientId: number | null
}

/**
 * The client and every client beneath it, depth first with siblings by name:
 * the order an invoice for a parent lists its end-clients in (issue 33).
 */
const readClientTree = async (
  database: InvoiceGenerationDatabase,
  rootId: number,
): Promise<readonly ClientNode[]> => {
  const rows = await all<ClientNode>(database, {
    text: `WITH RECURSIVE tree(id) AS (
        SELECT id FROM clients WHERE id = ?
        UNION
        SELECT child.id FROM clients child JOIN tree ON child.parent_client_id = tree.id
      )
      SELECT client.id, client.name, client.parent_client_id AS "parentClientId"
      FROM clients client WHERE client.id IN (SELECT id FROM tree)`,
    params: [rootId],
  })
  const children = new Map<number | null, ClientNode[]>()
  for (const row of rows) {
    const siblings = children.get(row.parentClientId)
    if (siblings === undefined) children.set(row.parentClientId, [row])
    else siblings.push(row)
  }
  const ordered: ClientNode[] = []
  const visit = (node: ClientNode): void => {
    ordered.push(node)
    const below = children.get(node.id) ?? []
    below.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id)
    below.forEach(visit)
  }
  const root = rows.find((row) => row.id === rootId)
  if (root !== undefined) visit(root)
  return ordered
}

const validateSelection = async (
  database: InvoiceGenerationDatabase,
  request: Pick<GenerateInvoiceRequest, 'clientId' | 'projectIds'>,
  /**
   * A tracked invoice may bill the work of clients beneath the one it is for,
   * each line attributed to its end-client by its project (issue 33). A band
   * claims its own client's work only.
   */
  scope: 'client' | 'tree' = 'client',
): Promise<{
  client: ClientDefaults
  projects: readonly SelectedProject[]
  tree: readonly ClientNode[]
}> => {
  const client = await readClient(database, request.clientId)
  const projects = await all<SelectedProject>(database, {
    text: `SELECT project.id, project.client_id AS "clientId", project.is_active AS "isActive",
        project.name, upper(coalesce(project.billing_currency, client.currency)) AS currency
      FROM projects project JOIN clients client ON client.id = project.client_id
      WHERE project.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY project.id`,
    params: [JSON.stringify(request.projectIds)],
  })
  const tree = scope === 'tree' ? await readClientTree(database, request.clientId) : []
  const reachable = new Set(scope === 'tree' ? tree.map((node) => node.id) : [request.clientId])
  if (
    projects.length !== request.projectIds.length ||
    projects.some((project) => !reachable.has(project.clientId))
  ) {
    invalid(
      scope === 'tree'
        ? 'every selected project must belong to the selected client or a client beneath it'
        : 'every selected project must belong to the selected client',
    )
  }
  // Archived work is not billable, and the candidate read drops it. Refusing the
  // selection outright is the difference between "we do not bill this" and an
  // invoice that quietly came out short: a request naming one active and one
  // archived project would otherwise return a document covering half of what was
  // asked for, with nothing on it to say so.
  if (projects.some((project) => project.isActive !== 1)) {
    invalid('an archived project cannot be invoiced')
  }
  return { client, projects, tree }
}

const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * The organization's default subject, with its placeholders filled for this
 * draft so one default reads right for every client:
 *
 * - `%client%` -- the client's name
 * - `%project%` -- the project, on an invoice for exactly one; empty otherwise
 * - `%period_month_name%`, `%period_year%` -- the month the invoice period
 *   starts in: September for a 2026-09-01 to 2026-09-30 draft issued in
 *   October. A draft with no start takes its end, and one with no period at
 *   all, its issue date.
 *
 * Everything else is kept as written. A subject that fills to nothing is no
 * subject, rather than a blank one.
 */
const defaultSubject = (
  template: string,
  client: ClientDefaults,
  header: InvoiceHeader,
  issueDate: string,
): string | null => {
  const period = header.periodStart ?? header.periodEnd ?? issueDate
  const subject = template
    .replace(/%client%/gu, () => client.name)
    .replace(/%project%/gu, () => header.projectName ?? '')
    .replace(/%period_month_name%/gu, () => monthNames[Number(period.slice(5, 7)) - 1]!)
    .replace(/%period_year%/gu, () => period.slice(0, 4))
  return subject.trim() === '' ? null : subject
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

/** The invoice's client and every client beneath it: whose projects it may claim work from. */
const clientTree = `WITH RECURSIVE tree(id) AS (
          SELECT id FROM clients WHERE id = ?
          UNION
          SELECT child.id FROM clients child JOIN tree ON child.parent_client_id = tree.id
        ) SELECT id FROM tree`

const timeClaim = (
  invoiceId: number,
  commandId: string,
  inputFingerprint: string,
  sourceManifestJson: string,
  currency: string,
  clientId: number,
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
        WHERE project.id = time_entries.project_id AND project.client_id IN (${clientTree})
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
    clientId,
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
  clientId: number,
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
        WHERE project.id = expenses.project_id AND project.client_id IN (${clientTree})
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
    clientId,
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
  client: ClientDefaults
  header: InvoiceHeader
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
  band: GenerationContent['band']
}): SqlStatement[] => {
  const issueDate = input.occurredAt.slice(0, 10)
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
          id, client_id, created_by_user_id, number, subject, notes, currency,
          issue_date, due_date, payment_terms, period_start, period_end,
          project_id, created_at, updated_at
        ) SELECT ?, ?, ?, CAST(sequence.next_number AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        input.client.id,
        input.command.principal.userId,
        // The organization's defaults win over the period subject: a draft
        // starts the way Harvest's Default values said it should.
        input.client.defaultSubject === null
          ? input.header.subject
          : defaultSubject(input.client.defaultSubject, input.client, input.header, issueDate),
        input.client.defaultNotes,
        input.currency,
        issueDate,
        invoiceDueDate(issueDate, input.client.paymentTerms),
        input.client.paymentTerms,
        input.header.periodStart,
        input.header.periodEnd,
        input.header.projectId,
        input.occurredAt,
        input.occurredAt,
        input.command.principal.userId,
        input.command.principal.profile,
        input.client.id,
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
        input.client.id,
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
        input.client.id,
      ),
    )
  }
  if (input.band !== null) {
    // What the band absorbed, recorded as the recurring engine records it.
    statements.push(
      bandForegoneUpdate(input.invoiceId, {
        text: `EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'invoice.create'
              AND command.input_fingerprint = ? AND command.completed = 0
          )`,
        params: [input.invoiceId, input.command.commandId, input.fingerprint],
      }),
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

/**
 * Read once, beside the rows: the organization default for a note's
 * visibility, which an entry with no answer of its own follows (D20), and the
 * date format its lines are written in. An instance with no organization row
 * yet takes the columns' own defaults.
 */
const lineContext = async (
  database: InvoiceGenerationDatabase,
  periodStart: string,
  periodEnd: string,
): Promise<LineContext> => {
  const organization = await first<{ visibleDefault: number; dateFormat: string }>(database, {
    text: `SELECT report_notes_client_visible_default AS "visibleDefault",
        date_format AS "dateFormat"
      FROM organizations ORDER BY id LIMIT 1`,
    params: [],
  })
  return {
    periodStart,
    periodEnd,
    dateFormat: organization?.dateFormat ?? '%Y-%m-%d',
    notesVisibleByDefault: organization === null || organization.visibleDefault !== 0,
  }
}

const earliestDate = (rows: readonly { spentDate: string }[]): string | null =>
  rows.reduce<string | null>(
    (earliest, row) => (earliest === null || row.spentDate < earliest ? row.spentDate : earliest),
    null,
  )

const trackedContent = async (
  database: InvoiceGenerationDatabase,
  commandId: string,
  request: GenerateInvoiceRequest,
): Promise<GenerationContent> => {
  const { client, projects, tree } = await validateSelection(database, request, 'tree')
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
  // An open start has no date of its own, so the period begins on the earliest
  // row this invoice bills: a date the document can stand behind, where a
  // placeholder would print as a 1970 period on the invoice and its subject.
  const periodStart = request.from ?? earliestDate([...timeEntries, ...expenses])!
  const context = await lineContext(database, periodStart, request.to)
  // One end-client at a time, in the tree's order, its time and then its
  // expenses: an invoice for a parent reads as a section per end-client, and
  // the line a project is on says whose work it is (issue 33). Every group is
  // keyed by project and a project has one client, so no group is split; an
  // invoice for one client is the time lines and then the expense lines, as it
  // always was.
  const nodes = tree.filter(
    (node) =>
      timeEntries.some((entry) => entry.clientId === node.id) ||
      expenses.some((expense) => expense.clientId === node.id),
  )
  const drafted = nodes.map((node) => ({
    time:
      request.timeSummaryType === null
        ? []
        : timeLines(
            timeEntries.filter((entry) => entry.clientId === node.id),
            request.timeSummaryType,
            context,
          ),
    expenses:
      request.expenseSummaryType === null
        ? []
        : expenseLines(
            expenses.filter((expense) => expense.clientId === node.id),
            request.expenseSummaryType,
            context,
          ),
  }))
  const expenseDraft = drafted.flatMap((node) => node.expenses)
  // Expenses are billed to the cent the preview shows. Time is not: its lines
  // bill rounded hours times the rate (see `timeLines`), which the preview's
  // per-entry pricing can differ from by a few cents a line.
  if (
    checkedSum(
      expenseDraft.map((line) => line.amountCents),
      'expense amount',
    ) !== currencyTotal.expenseCents
  ) {
    throw new Error('invoice generation lines diverged from the canonical uninvoiced preview')
  }
  const lines = await numberedLines(
    commandId,
    drafted.flatMap((node) => [...node.time, ...node.expenses]),
  )
  const amountCents = checkedSum(
    lines.map((line) => line.amountCents),
    'invoice amount',
  )
  return {
    client,
    header: {
      subject: `Tracked work ${periodStart} – ${request.to}`,
      periodStart,
      periodEnd: request.to,
      // The header's project must be the invoice client's own (migration 0004);
      // a project of an end-client beneath it is attributed on its lines.
      projectId:
        request.projectIds.length === 1 && projects[0]!.clientId === request.clientId
          ? request.projectIds[0]!
          : null,
      projectName: projects.length === 1 ? projects[0]!.name : null,
    },
    timeEntries,
    expenses,
    lines,
    currency: currencyTotal.currency,
    amountCents,
    band: null,
  }
}

/** A blank draft reads nothing tracked, so it bills in the client's own currency. */
const freeFormContent = async (
  database: InvoiceGenerationDatabase,
  request: GenerateFreeFormInvoiceRequest,
): Promise<GenerationContent> => {
  const client = await readClient(database, request.clientId)
  return {
    client,
    header: {
      subject: null,
      periodStart: null,
      periodEnd: null,
      projectId: null,
      projectName: null,
    },
    timeEntries: [],
    expenses: [],
    lines: [],
    currency: client.currency,
    amountCents: 0,
    band: null,
  }
}

/**
 * A band raised by hand: the fee first, then whatever the band leaves to bill.
 *
 * The time it reads is exactly what a tracked draft over the same selection
 * would bill, and all of it lands on this invoice, so none of it reads as
 * uninvoiced afterwards. Which of it the fee covers is decided by the rule the
 * recurring engine applies (`bandClaimSelection`), run over exactly these
 * entries; the rest is priced as tracked lines, at each person's own rate,
 * grouped as asked.
 */
const bandedContent = async (
  database: InvoiceGenerationDatabase,
  commandId: string,
  request: GenerateBandedInvoiceRequest,
): Promise<GenerationContent> => {
  const { client, projects } = await validateSelection(database, request)
  // The fee is charged in the projects' billing currency, which every hour on
  // them is billed in too; it cannot be in two at once.
  if (new Set(projects.map((project) => project.currency)).size !== 1) {
    invalid('selected projects must bill in one invoice currency')
  }
  const currency = projects[0]!.currency
  const feeProjects = [
    ...new Set(request.lineItems.flatMap((line) => (line.projectId === null ? [] : [line.projectId]))),
  ]
  if (feeProjects.length > 0) {
    const owned = await all<{ id: number }>(database, {
      text: `SELECT id FROM projects
        WHERE client_id = ? AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
      params: [request.clientId, JSON.stringify(feeProjects)],
    })
    if (owned.length !== feeProjects.length) {
      invalid('a fee line project must belong to the selected client')
    }
  }
  const { timeEntries } = await readUninvoicedCandidates(database, {
    clientId: request.clientId,
    from: request.from,
    to: request.to,
    projectIds: request.projectIds,
  })
  if (timeEntries.length > maximumGenerationSourceRows) {
    invalid(
      `one generation command can consume at most ${maximumGenerationSourceRows} tracked rows`,
    )
  }
  try {
    uninvoicedGenerationPreview({ timeEntries, expenses: [] })
  } catch (error) {
    if (error instanceof RangeError) invalid(error.message)
    throw error
  }
  const ceiling: BandClaimCeiling | null =
    request.claimMode === 'all'
      ? null
      : request.claimCeilingSeconds !== null
        ? { unit: 'seconds', limit: request.claimCeilingSeconds }
        : { unit: 'cents', limit: request.claimCeilingCents! }
  const claimedIds =
    timeEntries.length === 0
      ? new Set<number>()
      : new Set(
          (
            await all<{ id: number }>(
              database,
              bandClaimSelection(
                {
                  text: `id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
                  params: [JSON.stringify(timeEntries.map((entry) => entry.id))],
                },
                ceiling,
              ),
            )
          ).map(({ id }) => id),
        )
  const claimed = timeEntries.filter((entry) => claimedIds.has(entry.id))
  const billed = timeEntries.filter((entry) => !claimedIds.has(entry.id))
  // The same open start a tracked draft has, dated from the earliest entry the
  // invoice takes. A band over nothing yet has no such entry, so its period
  // has an end and no invented start.
  const periodStart = request.from ?? earliestDate(timeEntries)
  const fee: DraftLine[] = request.lineItems.map((line) => ({
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    amountCents: calculateInvoiceLineAmountCents(line.quantity, line.unitPriceCents),
    projectId: line.projectId,
  }))
  let overage: DraftLine[] = []
  if (billed.length > 0) {
    // Without a ceiling the band takes every entry it was offered, so an entry
    // left over means one moved between the two reads.
    if (request.overageSummaryType === null || periodStart === null) {
      throw new InvoiceGenerationError(
        'generation_conflict',
        'tracked rows changed while generation was reading them',
      )
    }
    overage = timeLines(
      billed,
      request.overageSummaryType,
      await lineContext(database, periodStart, request.to),
    )
  }
  const lines = await numberedLines(commandId, [...fee, ...overage])
  const amountCents = checkedSum(
    lines.map((line) => line.amountCents),
    'invoice amount',
  )
  const seconds = (entries: readonly UninvoicedTimeCandidateRow[]): number =>
    checkedIntegerSum(
      entries.map((entry) => entry.roundedSeconds),
      'time duration',
    )
  return {
    client,
    header: {
      subject: periodStart === null ? null : `Tracked work ${periodStart} – ${request.to}`,
      periodStart,
      periodEnd: request.to,
      projectId: request.projectIds.length === 1 ? request.projectIds[0]! : null,
      projectName: projects.length === 1 ? projects[0]!.name : null,
    },
    timeEntries,
    expenses: [],
    lines,
    currency,
    amountCents,
    band: {
      feeLineCount: fee.length,
      claimed_entry_count: claimed.length,
      claimed_seconds: seconds(claimed),
      billed_entry_count: billed.length,
      billed_seconds: seconds(billed),
    },
  }
}

const generationContent = (
  database: InvoiceGenerationDatabase,
  commandId: string,
  request: NormalizedRequest,
): Promise<GenerationContent> => {
  switch (request.kind) {
    case 'free_form':
      return freeFormContent(database, request)
    case 'banded':
      return bandedContent(database, commandId, request)
    default:
      return trackedContent(database, commandId, request)
  }
}

export const createInvoiceGenerationService = (
  database: InvoiceGenerationDatabase,
  options: InvoiceGenerationServiceOptions = {},
): InvoiceGenerationService => ({
  async generate(input): Promise<GeneratedInvoice> {
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

    const content = await generationContent(database, input.commandId, request)
    const { client, header, timeEntries, expenses, lines, currency, amountCents } = content
    const sourceManifestJson = sourceManifest(timeEntries, expenses)
    const lineManifestJson = lineManifest(lines)
    const requestJson = requestManifest(request, content)
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
          client,
          header,
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
          band: content.band,
        }),
      )
    } catch (error) {
      const winner = await readCommand(database, invoiceId, input.commandId)
      if (winner !== null) {
        await assertAuthorized(database, input.principal)
        return parseStoredInvoice(winner, inputFingerprint, input.principal.userId)
      }
      await assertAuthorized(database, input.principal)
      // A blank draft read no tracked rows, so none can have moved under it.
      if (request.kind === 'free_form') throw error
      const current = await readUninvoicedCandidates(database, {
        clientId: request.clientId,
        from: request.from,
        to: request.to,
        projectIds: request.projectIds,
      })
      // A band reads all the time and no expenses; a tracked draft, what it bills.
      const currentTime =
        request.kind === 'banded' || request.timeSummaryType !== null ? current.timeEntries : []
      const currentExpenses =
        request.kind !== 'banded' && request.expenseSummaryType !== null ? current.expenses : []
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
