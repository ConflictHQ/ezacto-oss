import type BetterSqlite3 from 'better-sqlite3'
import { assertRecurringAmountConfig, type RecurringAmountConfig } from '../recurring-invoices.js'

export type WorksheetImportDatabase = { $client: BetterSqlite3.Database | D1Database }

export interface CompleteHarvestRetainerBalanceInput {
  harvestRetainerId: number
  snapshotSha256: string
  contextSha256: string
  balanceCents: number
  occurredOn: string
  notes: string
  completedAt: string
}

export interface SourceRecurringFixedLineV1 {
  kind: string
  description: string | null
  quantity: number
  unit_price_cents: number
  taxed: boolean
  taxed2: boolean
  harvest_project_id: number | null
}

export interface SourceRecurringFixedLinesConfigV1 {
  schema_version: 1
  type: 'fixed_lines'
  line_items: SourceRecurringFixedLineV1[]
}

export interface SourceRecurringLineItemsImportConfigV1 {
  schema_version: 1
  type: 'line_items_import'
  harvest_project_ids: number[]
  time?: { summary_type: 'project' | 'task' | 'people' | 'detailed' }
  expenses?: { summary_type: 'project' | 'category' | 'people' | 'detailed' }
}

export type SourceRecurringAmountConfig =
  SourceRecurringFixedLinesConfigV1 | SourceRecurringLineItemsImportConfigV1

export interface CompleteHarvestRecurringInvoiceInput {
  harvestRecurringInvoiceId: number
  snapshotSha256: string
  contextSha256: string
  subjectTemplate: string
  notesTemplate: string
  everyNMonths: number
  dayOfMonth: number
  nextIssueOn: string
  /** Source-shaped worksheet config retained as immutable operator provenance. */
  sourceAmountConfig: SourceRecurringAmountConfig
  /** Native project ids, resolved from worksheet Harvest ids before this trusted call. */
  resolvedAmountConfig: RecurringAmountConfig
  /** Harvest retainer id retained as immutable operator provenance. */
  sourceCanDrawFromHarvestRetainerId: number | null
  /** Native retainer id, resolved from its Harvest id and client before this trusted call. */
  resolvedCanDrawFromRetainerId: number | null
  completedAt: string
}

export interface WorksheetCompletionResult {
  kind: 'retainer_balance' | 'recurring_invoice_definition'
  harvestId: number
  resourceId: number
  completedAt: string
  replayed: boolean
}

export interface HarvestRetainerCompletionResult extends WorksheetCompletionResult {
  kind: 'retainer_balance'
  balanceCents: number
  ledgerEntryId: string | null
}

export interface HarvestRecurringInvoiceCompletionResult extends WorksheetCompletionResult {
  kind: 'recurring_invoice_definition'
}

interface SqlStatement {
  text: string
  params: readonly unknown[]
}

interface StoredCompletion {
  kind: WorksheetCompletionResult['kind']
  harvestId: number
  resourceId: number
  snapshotSha256: string
  contextSha256: string
  inputSha256: string
  inputJson: string
  completedAt: string
}

interface RetainerRow {
  id: number
  harvestId: number
  balance: number
  ledgerCount: number
}

interface RecurringRow {
  id: number
  harvestId: number
  definitionStatus: 'complete' | 'incomplete'
  subjectTemplate: string | null
  notesTemplate: string | null
  everyNMonths: number | null
  dayOfMonth: number | null
  nextIssueOn: string | null
  amountConfig: string | null
  canDrawFromRetainerId: number | null
  updatedAt: string
}

const centsLimit = 9_000_000_000_000
const sha256Pattern = /^[0-9a-f]{64}$/
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const whitespaceCodePoints = new Set([
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12_288, 65_279,
])

const isWhitespaceOnly = (value: string): boolean =>
  [...value].every((character) => whitespaceCodePoints.has(character.codePointAt(0)!))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void => {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${field} has missing or unknown fields`)
  }
}

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertDigest = (value: string, field: string): void => {
  if (!sha256Pattern.test(value)) throw new RangeError(`${field} must be a lowercase SHA-256`)
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

const assertSourceRecurringAmountConfig: (
  value: unknown,
) => asserts value is SourceRecurringAmountConfig = (value) => {
  if (!isRecord(value)) throw new TypeError('sourceAmountConfig must be an object')
  if (value.type === 'fixed_lines') {
    assertExactKeys(value, ['schema_version', 'type', 'line_items'], [], 'sourceAmountConfig')
    if (!Array.isArray(value.line_items)) {
      throw new TypeError('sourceAmountConfig.line_items must be an array')
    }
    const converted = value.line_items.map((line, index) => {
      if (!isRecord(line)) {
        throw new TypeError(`sourceAmountConfig.line_items[${index}] must be an object`)
      }
      assertExactKeys(
        line,
        [
          'kind',
          'description',
          'quantity',
          'unit_price_cents',
          'taxed',
          'taxed2',
          'harvest_project_id',
        ],
        // Optional since migration 0041: the date a line stops appearing on.
        // The receipt records what the operator wrote, so a stop date they set
        // has to survive here too or the apply refuses the row it just built.
        ['through'],
        `sourceAmountConfig.line_items[${index}]`,
      )
      return {
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unit_price_cents: line.unit_price_cents,
        taxed: line.taxed,
        taxed2: line.taxed2,
        project_id: line.harvest_project_id,
        ...(line.through === undefined || line.through === null
          ? {}
          : { through: line.through }),
      }
    })
    assertRecurringAmountConfig({
      schema_version: value.schema_version,
      type: value.type,
      line_items: converted,
    })
    return
  }
  if (value.type === 'line_items_import') {
    assertExactKeys(
      value,
      ['schema_version', 'type', 'harvest_project_ids'],
      ['time', 'expenses'],
      'sourceAmountConfig',
    )
    assertRecurringAmountConfig({
      schema_version: value.schema_version,
      type: value.type,
      project_ids: value.harvest_project_ids,
      ...(Object.hasOwn(value, 'time') ? { time: value.time } : {}),
      ...(Object.hasOwn(value, 'expenses') ? { expenses: value.expenses } : {}),
    })
    return
  }
  throw new TypeError('sourceAmountConfig.type is invalid')
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('worksheet input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('worksheet input is not JSON serializable')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

const assertSourceMappingCorrespondence = (
  source: SourceRecurringAmountConfig,
  resolved: RecurringAmountConfig,
): void => {
  if (source.type !== resolved.type) {
    throw new TypeError('sourceAmountConfig and resolvedAmountConfig types do not match')
  }
  if (source.type === 'fixed_lines' && resolved.type === 'fixed_lines') {
    if (source.line_items.length !== resolved.line_items.length) {
      throw new TypeError('sourceAmountConfig and resolvedAmountConfig line counts do not match')
    }
    for (const [index, sourceLine] of source.line_items.entries()) {
      const resolvedLine = resolved.line_items[index]!
      const sourceScalars = {
        kind: sourceLine.kind,
        description: sourceLine.description,
        quantity: sourceLine.quantity,
        unit_price_cents: sourceLine.unit_price_cents,
        taxed: sourceLine.taxed,
        taxed2: sourceLine.taxed2,
      }
      const resolvedScalars = {
        kind: resolvedLine.kind,
        description: resolvedLine.description,
        quantity: resolvedLine.quantity,
        unit_price_cents: resolvedLine.unit_price_cents,
        taxed: resolvedLine.taxed,
        taxed2: resolvedLine.taxed2,
      }
      if (
        canonicalJson(sourceScalars) !== canonicalJson(resolvedScalars) ||
        (sourceLine.harvest_project_id === null) !== (resolvedLine.project_id === null)
      ) {
        throw new TypeError(
          `sourceAmountConfig.line_items[${index}] does not match its resolved line`,
        )
      }
    }
    return
  }
  if (source.type === 'line_items_import' && resolved.type === 'line_items_import') {
    if (
      source.harvest_project_ids.length !== resolved.project_ids.length ||
      canonicalJson(source.time ?? null) !== canonicalJson(resolved.time ?? null) ||
      canonicalJson(source.expenses ?? null) !== canonicalJson(resolved.expenses ?? null)
    ) {
      throw new TypeError('sourceAmountConfig does not match resolvedAmountConfig')
    }
  }
}

const sha256 = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isD1 = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: WorksheetImportDatabase,
  statement: SqlStatement,
): Promise<T | null> => {
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

const runAtomic = async (
  database: WorksheetImportDatabase,
  statements: readonly SqlStatement[],
): Promise<void> => {
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

const completionStatement = (
  kind: WorksheetCompletionResult['kind'],
  harvestId: number,
): SqlStatement => ({
  text: `SELECT kind, harvest_id AS "harvestId", resource_id AS "resourceId",
      snapshot_sha256 AS "snapshotSha256", context_sha256 AS "contextSha256",
      input_sha256 AS "inputSha256", input_json AS "inputJson",
      completed_at AS "completedAt"
    FROM _ezacto_worksheet_completions WHERE kind = ? AND harvest_id = ?`,
  params: [kind, harvestId],
})

const assertSameCompletion = (
  stored: StoredCompletion,
  inputJson: string,
  inputSha256: string,
): void => {
  if (stored.inputSha256 !== inputSha256 || stored.inputJson !== inputJson) {
    throw new Error(
      `${stored.kind} worksheet for Harvest id ${stored.harvestId} was already completed with different input`,
    )
  }
}

const readCompletion = (
  database: WorksheetImportDatabase,
  kind: WorksheetCompletionResult['kind'],
  harvestId: number,
): Promise<StoredCompletion | null> => first(database, completionStatement(kind, harvestId))

const insertCompletionStatement = (
  kind: WorksheetCompletionResult['kind'],
  harvestId: number,
  resourceId: number,
  snapshotSha256: string,
  contextSha256: string,
  inputSha256: string,
  inputJson: string,
  completedAt: string,
): SqlStatement => ({
  text: `INSERT INTO _ezacto_worksheet_completions (
      kind, harvest_id, resource_id, snapshot_sha256, context_sha256,
      input_sha256, input_json, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [
    kind,
    harvestId,
    resourceId,
    snapshotSha256,
    contextSha256,
    inputSha256,
    inputJson,
    completedAt,
  ],
})

const retainerLedgerId = (harvestRetainerId: number): string =>
  `harvest-retainer:${harvestRetainerId}:opening`

const retainerResult = (
  completion: StoredCompletion,
  balanceCents: number,
  replayed: boolean,
): HarvestRetainerCompletionResult => ({
  kind: 'retainer_balance',
  harvestId: completion.harvestId,
  resourceId: completion.resourceId,
  completedAt: completion.completedAt,
  replayed,
  balanceCents,
  ledgerEntryId: balanceCents === 0 ? null : retainerLedgerId(completion.harvestId),
})

export const completeHarvestRetainerBalance = async (
  database: WorksheetImportDatabase,
  input: CompleteHarvestRetainerBalanceInput,
): Promise<HarvestRetainerCompletionResult> => {
  assertPositiveSafeInteger(input.harvestRetainerId, 'harvestRetainerId')
  assertDigest(input.snapshotSha256, 'snapshotSha256')
  assertDigest(input.contextSha256, 'contextSha256')
  if (
    !Number.isSafeInteger(input.balanceCents) ||
    input.balanceCents < 0 ||
    input.balanceCents > centsLimit
  ) {
    throw new RangeError('balanceCents must be non-negative bounded integer cents')
  }
  assertCanonicalDate(input.occurredOn, 'occurredOn')
  if (typeof input.notes !== 'string' || isWhitespaceOnly(input.notes)) {
    throw new TypeError('notes must be a non-empty adjustment reason')
  }
  assertCanonicalTimestamp(input.completedAt, 'completedAt')

  const inputJson = canonicalJson({
    version: 1,
    kind: 'retainer_balance',
    harvest_retainer_id: input.harvestRetainerId,
    snapshot_sha256: input.snapshotSha256,
    context_sha256: input.contextSha256,
    balance_cents: input.balanceCents,
    occurred_on: input.occurredOn,
    notes: input.notes,
  })
  const inputSha256 = await sha256(inputJson)
  const prior = await readCompletion(database, 'retainer_balance', input.harvestRetainerId)
  if (prior !== null) {
    assertSameCompletion(prior, inputJson, inputSha256)
    return retainerResult(prior, input.balanceCents, true)
  }

  const retainer = await first<RetainerRow>(database, {
    text: `SELECT retainer.id, retainer.harvest_id AS "harvestId",
        balance.balance, count(entry.id) AS "ledgerCount"
      FROM retainers retainer
      JOIN retainer_balances balance ON balance.retainer_id = retainer.id
      LEFT JOIN retainer_ledger entry ON entry.retainer_id = retainer.id
      WHERE retainer.harvest_id = ? AND retainer.denomination = 'money'
        AND retainer.client_id IS NOT NULL
      GROUP BY retainer.id, retainer.harvest_id, balance.balance`,
    params: [input.harvestRetainerId],
  })
  if (retainer === null) {
    throw new Error(`Harvest retainer ${input.harvestRetainerId} does not have a money stub`)
  }
  if (retainer.ledgerCount !== 0 || retainer.balance !== 0) {
    throw new Error(
      `Harvest retainer ${input.harvestRetainerId} no longer has a pristine opening ledger`,
    )
  }

  const statements: SqlStatement[] = []
  statements.push({
    text: `INSERT INTO _ezacto_worksheet_import_authority (
        kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
      ) VALUES ('retainer_balance', ?, ?, ?, ?, ?)`,
    params: [input.harvestRetainerId, retainer.id, inputSha256, inputJson, input.completedAt],
  })
  if (input.balanceCents > 0) {
    statements.push({
      text: `INSERT INTO retainer_ledger (
          id, retainer_id, kind, unit, amount, invoice_id, occurred_on, notes, created_at
        ) VALUES (?, ?, 'adjustment', 'cents', ?, NULL, ?, ?, ?)`,
      params: [
        retainerLedgerId(input.harvestRetainerId),
        retainer.id,
        input.balanceCents,
        input.occurredOn,
        input.notes,
        input.completedAt,
      ],
    })
  }
  statements.push(
    insertCompletionStatement(
      'retainer_balance',
      input.harvestRetainerId,
      retainer.id,
      input.snapshotSha256,
      input.contextSha256,
      inputSha256,
      inputJson,
      input.completedAt,
    ),
  )
  statements.push({
    text: `DELETE FROM _ezacto_worksheet_import_authority
      WHERE kind = 'retainer_balance' AND harvest_id = ?
        AND resource_id = ? AND input_sha256 = ?`,
    params: [input.harvestRetainerId, retainer.id, inputSha256],
  })

  try {
    await runAtomic(database, statements)
  } catch (error) {
    const raced = await readCompletion(database, 'retainer_balance', input.harvestRetainerId)
    if (raced === null) throw error
    assertSameCompletion(raced, inputJson, inputSha256)
    return retainerResult(raced, input.balanceCents, true)
  }

  const stored = await readCompletion(database, 'retainer_balance', input.harvestRetainerId)
  if (stored === null) throw new Error('retainer worksheet completion did not persist')
  assertSameCompletion(stored, inputJson, inputSha256)
  return retainerResult(stored, input.balanceCents, false)
}

const recurringSame = (
  stored: RecurringRow,
  input: CompleteHarvestRecurringInvoiceInput,
): boolean => {
  let storedConfig: unknown
  try {
    storedConfig = stored.amountConfig === null ? null : JSON.parse(stored.amountConfig)
  } catch {
    return false
  }
  return (
    stored.definitionStatus === 'complete' &&
    stored.subjectTemplate === input.subjectTemplate &&
    stored.notesTemplate === input.notesTemplate &&
    stored.everyNMonths === input.everyNMonths &&
    stored.dayOfMonth === input.dayOfMonth &&
    stored.nextIssueOn === input.nextIssueOn &&
    canonicalJson(storedConfig) === canonicalJson(input.resolvedAmountConfig) &&
    stored.canDrawFromRetainerId === input.resolvedCanDrawFromRetainerId
  )
}

const recurringResult = (
  completion: StoredCompletion,
  replayed: boolean,
): HarvestRecurringInvoiceCompletionResult => ({
  kind: 'recurring_invoice_definition',
  harvestId: completion.harvestId,
  resourceId: completion.resourceId,
  completedAt: completion.completedAt,
  replayed,
})

export const completeHarvestRecurringInvoice = async (
  database: WorksheetImportDatabase,
  input: CompleteHarvestRecurringInvoiceInput,
): Promise<HarvestRecurringInvoiceCompletionResult> => {
  assertPositiveSafeInteger(input.harvestRecurringInvoiceId, 'harvestRecurringInvoiceId')
  assertDigest(input.snapshotSha256, 'snapshotSha256')
  assertDigest(input.contextSha256, 'contextSha256')
  if (typeof input.subjectTemplate !== 'string' || isWhitespaceOnly(input.subjectTemplate)) {
    throw new TypeError('subjectTemplate must be a non-empty string')
  }
  if (typeof input.notesTemplate !== 'string') throw new TypeError('notesTemplate must be a string')
  assertPositiveSafeInteger(input.everyNMonths, 'everyNMonths')
  if (!Number.isSafeInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    throw new RangeError('dayOfMonth must be an integer from 1 through 31')
  }
  assertCanonicalDate(input.nextIssueOn, 'nextIssueOn')
  assertSourceRecurringAmountConfig(input.sourceAmountConfig)
  assertRecurringAmountConfig(input.resolvedAmountConfig)
  assertSourceMappingCorrespondence(input.sourceAmountConfig, input.resolvedAmountConfig)
  if (input.sourceCanDrawFromHarvestRetainerId !== null) {
    assertPositiveSafeInteger(
      input.sourceCanDrawFromHarvestRetainerId,
      'sourceCanDrawFromHarvestRetainerId',
    )
  }
  if (input.resolvedCanDrawFromRetainerId !== null) {
    assertPositiveSafeInteger(input.resolvedCanDrawFromRetainerId, 'resolvedCanDrawFromRetainerId')
  }
  if (
    (input.sourceCanDrawFromHarvestRetainerId === null) !==
    (input.resolvedCanDrawFromRetainerId === null)
  ) {
    throw new TypeError('source and resolved retainer references must both be null or both be set')
  }
  assertCanonicalTimestamp(input.completedAt, 'completedAt')

  const inputJson = canonicalJson({
    version: 1,
    kind: 'recurring_invoice_definition',
    harvest_recurring_invoice_id: input.harvestRecurringInvoiceId,
    snapshot_sha256: input.snapshotSha256,
    context_sha256: input.contextSha256,
    subject_template: input.subjectTemplate,
    notes_template: input.notesTemplate,
    every_n_months: input.everyNMonths,
    day_of_month: input.dayOfMonth,
    next_issue_on: input.nextIssueOn,
    source_amount_config: input.sourceAmountConfig,
    amount_config: input.resolvedAmountConfig,
    source_can_draw_from_harvest_retainer_id: input.sourceCanDrawFromHarvestRetainerId,
    can_draw_from_retainer_id: input.resolvedCanDrawFromRetainerId,
  })
  const inputSha256 = await sha256(inputJson)
  const prior = await readCompletion(
    database,
    'recurring_invoice_definition',
    input.harvestRecurringInvoiceId,
  )
  if (prior !== null) {
    assertSameCompletion(prior, inputJson, inputSha256)
    return recurringResult(prior, true)
  }

  const recurring = await first<RecurringRow>(database, {
    text: `SELECT id, harvest_id AS "harvestId", definition_status AS "definitionStatus",
        subject_template AS "subjectTemplate", notes_template AS "notesTemplate",
        every_n_months AS "everyNMonths", day_of_month AS "dayOfMonth",
        next_issue_on AS "nextIssueOn", amount_config AS "amountConfig",
        can_draw_from_retainer_id AS "canDrawFromRetainerId", updated_at AS "updatedAt"
      FROM recurring_invoices WHERE harvest_id = ?`,
    params: [input.harvestRecurringInvoiceId],
  })
  if (recurring === null) {
    throw new Error(
      `Harvest recurring invoice ${input.harvestRecurringInvoiceId} does not have a stub`,
    )
  }
  if (recurring.definitionStatus === 'complete' && !recurringSame(recurring, input)) {
    throw new Error(
      `Harvest recurring invoice ${input.harvestRecurringInvoiceId} was already completed with a different definition`,
    )
  }

  const statements: SqlStatement[] = []
  const targetUpdatedAt =
    recurring.definitionStatus === 'incomplete' ? input.completedAt : recurring.updatedAt
  statements.push({
    text: `INSERT INTO _ezacto_worksheet_import_authority (
        kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
      ) VALUES ('recurring_invoice_definition', ?, ?, ?, ?, ?)`,
    params: [
      input.harvestRecurringInvoiceId,
      recurring.id,
      inputSha256,
      inputJson,
      targetUpdatedAt,
    ],
  })
  if (recurring.definitionStatus === 'incomplete') {
    statements.push({
      text: `UPDATE recurring_invoices
        SET definition_status = 'complete', subject_template = ?, notes_template = ?,
          every_n_months = ?, day_of_month = ?, next_issue_on = ?, amount_config = ?,
          can_draw_from_retainer_id = ?, updated_at = ?
        WHERE id = ? AND harvest_id = ? AND definition_status = 'incomplete'`,
      params: [
        input.subjectTemplate,
        input.notesTemplate,
        input.everyNMonths,
        input.dayOfMonth,
        input.nextIssueOn,
        canonicalJson(input.resolvedAmountConfig),
        input.resolvedCanDrawFromRetainerId,
        input.completedAt,
        recurring.id,
        input.harvestRecurringInvoiceId,
      ],
    })
  }
  statements.push(
    insertCompletionStatement(
      'recurring_invoice_definition',
      input.harvestRecurringInvoiceId,
      recurring.id,
      input.snapshotSha256,
      input.contextSha256,
      inputSha256,
      inputJson,
      input.completedAt,
    ),
  )
  statements.push({
    text: `DELETE FROM _ezacto_worksheet_import_authority
      WHERE kind = 'recurring_invoice_definition' AND harvest_id = ?
        AND resource_id = ? AND input_sha256 = ?`,
    params: [input.harvestRecurringInvoiceId, recurring.id, inputSha256],
  })

  try {
    await runAtomic(database, statements)
  } catch (error) {
    const raced = await readCompletion(
      database,
      'recurring_invoice_definition',
      input.harvestRecurringInvoiceId,
    )
    if (raced === null) throw error
    assertSameCompletion(raced, inputJson, inputSha256)
    return recurringResult(raced, true)
  }

  const stored = await readCompletion(
    database,
    'recurring_invoice_definition',
    input.harvestRecurringInvoiceId,
  )
  if (stored === null) throw new Error('recurring worksheet completion did not persist')
  assertSameCompletion(stored, inputJson, inputSha256)
  return recurringResult(stored, false)
}
