import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, rename } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { trackedAmountCents } from '@ezacto/core'
import { LOAD_RESOURCES } from './load.js'
import { readManifest, type Manifest } from './manifest.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import { hoursLiteralToSeconds, moneyLiteralToCents, numberLexemes } from './transform.js'
import {
  checksumReportDigest,
  reportChunkKey,
  snapshotDigest,
  splitReportRange,
  uninvoicedReportRange,
  type ChecksumReport,
  type ChecksumReportPayload,
} from './verify.js'

export type ReconciliationClassification = 'match' | 'rounding' | 'gap' | 'UNEXPLAINED'
export type ReconciliationSection = 'A' | 'B' | 'C'
export type ReconciliationValue = number | string | null
export type ReconciliationGapId =
  | 'migration-spec-7-retainers-no-api'
  | 'migration-spec-7-recurring-invoices-no-api'
  | 'migration-spec-7-sub-cent-unit-prices'
  | 'migration-spec-7-estimates-module-disabled'
  | 'migration-spec-7-duplicate-harvest-accounts'

export interface ReconciliationGapCitation {
  id: ReconciliationGapId
  reference: string
}

export interface ReconciliationCheck {
  section: ReconciliationSection
  check: string
  key: string
  metric: string
  expected: ReconciliationValue
  actual: ReconciliationValue
  delta: number | null
  classification: ReconciliationClassification
  detail: string | null
  gap_citation?: ReconciliationGapCitation
}

const MIGRATION_SPEC_GAP_CITATIONS = {
  retainersNoApi: {
    id: 'migration-spec-7-retainers-no-api',
    reference: 'docs/migration-spec.md §7: Retainers: no API.',
  },
  recurringInvoicesNoApi: {
    id: 'migration-spec-7-recurring-invoices-no-api',
    reference: 'docs/migration-spec.md §7: Recurring invoices: no API.',
  },
  subCentUnitPrices: {
    id: 'migration-spec-7-sub-cent-unit-prices',
    reference: 'docs/migration-spec.md §7: Per-unit rates finer than a cent.',
  },
  estimatesModuleDisabled: {
    id: 'migration-spec-7-estimates-module-disabled',
    reference: 'docs/migration-spec.md §7: Estimates/approval/activity-log modules disabled.',
  },
  duplicateHarvestAccounts: {
    id: 'migration-spec-7-duplicate-harvest-accounts',
    reference: 'docs/migration-spec.md §7: Two Harvest accounts for one person.',
  },
} as const satisfies Record<string, ReconciliationGapCitation>

/**
 * Which load anomaly kinds §7 accepts as the cost of the migration. A skip that
 * is not on this list has no citation, so it stays unexplained — which is the
 * point: `non_positive_payment` is deliberately absent, because §7 says
 * skipping is not a safe handling for that class. The two squash kinds are the
 * operator's own decision rather than an API limit, and they are cited for the
 * same reason the others are: an accounted-for row must not read as a lost one.
 */
const ACCEPTED_ANOMALY_CITATIONS: Readonly<Record<string, ReconciliationGapCitation>> = {
  rate_residue: MIGRATION_SPEC_GAP_CITATIONS.subCentUnitPrices,
  unresolved_estimate_reference: MIGRATION_SPEC_GAP_CITATIONS.estimatesModuleDisabled,
  duplicate_user_squashed: MIGRATION_SPEC_GAP_CITATIONS.duplicateHarvestAccounts,
  duplicate_row_merged: MIGRATION_SPEC_GAP_CITATIONS.duplicateHarvestAccounts,
}

export interface ReconciliationReport {
  version: 1
  snapshot_sha256: string
  source_report_sha256: string
  generated_at: string
  summary: {
    complete: boolean
    matches: number
    rounding: number
    gaps: number
    unexplained: number
  }
  matches: ReconciliationCheck[]
  rounding: ReconciliationCheck[]
  gaps: ReconciliationCheck[]
  unexplained: ReconciliationCheck[]
}

export interface RunReconcileOptions {
  snapshotDir: string
  databasePath: string
}

export interface RunReconcileResult {
  report: ReconciliationReport
  jsonPath: string
  markdownPath: string
}

interface RawRow {
  row: Record<string, unknown>
  numbers: Map<string, string>
  line: number
}

interface ProjectSource {
  id: number
  clientId: number
  currency: string
  isActive: boolean
  billingMethod: string
  budgetBy: string
  budgetLiteral: string | null
  costBudgetLiteral: string | null
  feeLiteral: string | null
  startsOn: string | null
  createdOn: string
  budgetIsMonthly: boolean
  costBudgetIncludeExpenses: boolean
}

interface TimeAggregate {
  totalSeconds: number
  billableSeconds: number
  billableCents: number
  unpricedBillable: number
}

interface ExpenseAggregate {
  totalCents: number
  billableCents: number
}

interface MonthlyAggregate {
  seconds: number
  billableCents: number
  costCents: number
  expenseCents: number
  unpricedBillable: number
  unpricedCost: number
}

interface UninvoicedAggregate {
  totalSeconds: number
  uninvoicedSeconds: number
  uninvoicedExpenseCents: number
  uninvoicedAmountCents: number
  unpricedTime: number
  fixedFee: boolean
}

interface BudgetActivity {
  seconds: number
  billableCents: number
  costCents: number
  expenseCents: number
  unpricedBillable: number
  unpricedCost: number
}

interface InvoiceSource {
  currency: string
  state: string | null
  amountCents: number | null
  dueAmountCents: number | null
  taxAmountCents: number | null
  tax2AmountCents: number | null
  discountAmountCents: number | null
  paymentOptions: string | null
  retainerId: number | null
  recurringInvoiceId: number | null
}

const centsLimit = 9_000_000_000_000n
const safeLimit = 9_007_199_254_740_991n

const checked = (value: bigint, field: string, limit = safeLimit): number => {
  if (value < -limit || value > limit) throw new Error(`${field} exceeds the supported range`)
  return Number(value)
}

const add = (left: number, right: number, field: string): number =>
  checked(BigInt(left) + BigInt(right), field)

const currencyCode = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new Error(`${field} must be a three-letter currency code`)
  }
  return value.trim().toUpperCase()
}

const booleanValue = (row: Record<string, unknown>, field: string, fallback = false): boolean => {
  const value = row[field]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`)
  return value
}

const integerLiteral = (literal: string | undefined, field: string): number => {
  if (literal === undefined || !/^\d+$/.test(literal)) {
    throw new Error(`${field} must be a positive integer`)
  }
  const value = BigInt(literal)
  if (value < 1n || value > safeLimit) throw new Error(`${field} is outside the safe range`)
  return Number(value)
}

const optionalIdAt = (source: RawRow, pointer: string, field: string): number | null => {
  const literal = source.numbers.get(pointer)
  return literal === undefined ? null : integerLiteral(literal, field)
}

const idAt = (source: RawRow, pointer: string, field: string): number =>
  integerLiteral(source.numbers.get(pointer), field)

const decimalLiteral = (value: unknown, field: string): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite decimal number`)
  }
  return String(value)
}

const requiredMoney = (source: RawRow, pointer: string, field: string): number => {
  const literal = source.numbers.get(pointer)
  if (literal === undefined) throw new Error(`${field} has no lossless number token`)
  return moneyLiteralToCents(literal, field)
}

const nullableMoney = (source: RawRow, pointer: string, field: string): number | null => {
  const literal = source.numbers.get(pointer)
  return literal === undefined ? null : moneyLiteralToCents(literal, field)
}

const reportMoney = (value: unknown, field: string): number =>
  moneyLiteralToCents(decimalLiteral(value, field), field)

const nonnegativeReportMoney = (value: unknown, field: string): number => {
  const cents = reportMoney(value, field)
  if (cents < 0) throw new Error(`${field} cannot be negative`)
  return cents
}

const reportSeconds = (value: unknown, field: string): number =>
  hoursLiteralToSeconds(decimalLiteral(value, field), field).seconds

const streamRaw = async function* (snapshotDir: string, resource: string): AsyncGenerator<RawRow> {
  const path = join(snapshotDir, 'raw', `${resource}.jsonl`)
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  try {
    for await (const raw of lines) {
      line += 1
      if (!raw.trim()) continue
      const value = JSON.parse(raw) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path}:${line} is not a JSON object`)
      }
      yield { row: value as Record<string, unknown>, numbers: numberLexemes(raw), line }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    lines.close()
  }
}

/**
 * Resources whose snapshot row and loaded row can be compared one to one by
 * `harvest_id`, and whose `updated_at` the loader carries across unchanged.
 *
 * Deliberately not every table with those two columns: line items, messages and
 * payments are children written as part of their parent's load, so a stale
 * parent is the finding and counting its children again would trip the same
 * alarm several times over.
 */
const REFRESHABLE_RESOURCES: readonly { resource: string; table: string }[] = [
  { resource: 'clients', table: 'clients' },
  { resource: 'contacts', table: 'contacts' },
  { resource: 'projects', table: 'projects' },
  { resource: 'tasks', table: 'tasks' },
  { resource: 'users', table: 'users' },
  { resource: 'expense_categories', table: 'expense_categories' },
  { resource: 'time_entries', table: 'time_entries' },
  { resource: 'expenses', table: 'expenses' },
  { resource: 'invoices', table: 'invoices' },
  { resource: 'estimates', table: 'estimates' },
]

/**
 * Rows the snapshot has moved on from since they were loaded.
 *
 * `load` is insert-if-absent, not upsert: a row whose `updated_at` advanced
 * upstream is refreshed in the snapshot by `sync` and then skipped, because a
 * row already carries that `harvest_id`. Nothing else in this report notices,
 * because the row is present and the counts still agree -- only its contents
 * are behind, which is the one kind of wrong that reads as right.
 *
 * So the check is the comparison itself. Zero means the loaded database is
 * genuinely current as of this snapshot; anything else means it is add-only and
 * says how far behind, per resource, before anyone reads the totals below it.
 */
const staleLoadChecks = async (
  checks: Checks,
  snapshotDir: string,
  databasePath: string,
): Promise<void> => {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true })
  try {
    for (const { resource, table } of REFRESHABLE_RESOURCES) {
      const loaded = database.prepare(
        `SELECT updated_at AS updatedAt FROM ${table} WHERE harvest_id = ?`,
      )
      let behind = 0
      let missing = 0
      let compared = 0
      for await (const source of streamRaw(snapshotDir, resource)) {
        const id = source.row.id
        const updatedAt = source.row.updated_at
        if (typeof updatedAt !== 'string' || (typeof id !== 'number' && typeof id !== 'string')) {
          continue
        }
        const row = loaded.get(String(id)) as { updatedAt: string | null } | undefined
        if (row === undefined) {
          // Never loaded at all. That is a different finding and the row-count
          // checks already own it; counting it here would double-report.
          missing += 1
          continue
        }
        compared += 1
        // Both sides are canonical UTC, so a lexical comparison is a temporal
        // one. Equal is current: `sync` rewrites a row only when it changed.
        if (row.updatedAt !== null && updatedAt > row.updatedAt) behind += 1
      }
      if (compared === 0 && missing === 0) continue
      checks.compare(
        'C',
        'load currency',
        resource,
        'rows_behind_snapshot',
        0,
        behind,
        'UNEXPLAINED',
        behind === 0
          ? null
          : `${behind} of ${compared} loaded ${resource} rows are older than the snapshot. ` +
            'load is insert-if-absent, so edits upstream do not reach an already-loaded ' +
            'database; the totals in this report describe the snapshot, not this database.',
      )
    }
  } finally {
    database.close()
  }
}

const timeAggregate = (): TimeAggregate => ({
  totalSeconds: 0,
  billableSeconds: 0,
  billableCents: 0,
  unpricedBillable: 0,
})

const expenseAggregate = (): ExpenseAggregate => ({ totalCents: 0, billableCents: 0 })

const monthlyAggregate = (): MonthlyAggregate => ({
  seconds: 0,
  billableCents: 0,
  costCents: 0,
  expenseCents: 0,
  unpricedBillable: 0,
  unpricedCost: 0,
})

const uninvoicedAggregate = (): UninvoicedAggregate => ({
  totalSeconds: 0,
  uninvoicedSeconds: 0,
  uninvoicedExpenseCents: 0,
  uninvoicedAmountCents: 0,
  unpricedTime: 0,
  fixedFee: false,
})

const budgetActivity = (): BudgetActivity => ({
  seconds: 0,
  billableCents: 0,
  costCents: 0,
  expenseCents: 0,
  unpricedBillable: 0,
  unpricedCost: 0,
})

const getOrCreate = <K, T>(map: Map<K, T>, key: K, create: () => T): T => {
  let value = map.get(key)
  if (value === undefined) {
    value = create()
    map.set(key, value)
  }
  return value
}

const periodFor = (
  periods: ChecksumReport['periods'],
  date: string,
): ChecksumReport['periods'][number] => {
  const matches = periods.filter((period) => date >= period.from && date <= period.to)
  if (matches.length !== 1) {
    throw new Error(
      `${date} maps to ${matches.length} verified report periods, expected exactly one`,
    )
  }
  return matches[0]!
}

const groupKey = (id: number, currency: string): string => `${id}|${currency}`
const monthlyKey = (userId: number, projectId: number, date: string, currency: string): string =>
  `${userId}|${projectId}|${date.slice(0, 7)}|${currency}`

const monthlySecondsKey = (currencyKey: string): string =>
  currencyKey.slice(0, currencyKey.lastIndexOf('|'))

const checkOrder = (left: ReconciliationCheck, right: ReconciliationCheck): number => {
  const leftKey = `${left.section}\0${left.check}\0${left.key}\0${left.metric}`
  const rightKey = `${right.section}\0${right.check}\0${right.key}\0${right.metric}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

class Checks {
  readonly rows: ReconciliationCheck[] = []

  compare(
    section: ReconciliationSection,
    check: string,
    key: string,
    metric: string,
    expected: ReconciliationValue,
    actual: ReconciliationValue,
    mismatch: Exclude<ReconciliationClassification, 'match' | 'gap'> = 'UNEXPLAINED',
    detail: string | null = null,
    // A documented skip's contribution to this exact metric. The delta counts
    // as an explained gap only when it equals this to the unit — an
    // approximate match is still unexplained.
    explained?: { delta: number; citation: ReconciliationGapCitation },
  ): void {
    const same = expected === actual
    const delta =
      typeof expected === 'number' && typeof actual === 'number' ? actual - expected : null
    const cited =
      !same &&
      explained !== undefined &&
      explained.delta !== 0 &&
      delta !== null &&
      delta === explained.delta
    this.rows.push({
      section,
      check,
      key,
      metric,
      expected,
      actual,
      delta,
      classification: same ? 'match' : cited ? 'gap' : mismatch,
      detail: same
        ? null
        : cited
          ? `explained exactly by rows migration-spec §7 documents as skipped (${explained.delta})`
          : detail,
      ...(cited ? { gap_citation: explained.citation } : {}),
    })
  }

  note(
    section: ReconciliationSection,
    check: string,
    key: string,
    classification: 'gap',
    detail: string,
    gapCitation: ReconciliationGapCitation,
  ): void
  note(
    section: ReconciliationSection,
    check: string,
    key: string,
    classification: Exclude<ReconciliationClassification, 'match' | 'gap'>,
    detail: string,
  ): void
  note(
    section: ReconciliationSection,
    check: string,
    key: string,
    classification: Exclude<ReconciliationClassification, 'match'>,
    detail: string,
    gapCitation?: ReconciliationGapCitation,
  ): void {
    if ((classification === 'gap') !== (gapCitation !== undefined)) {
      throw new Error('gap reconciliation checks must carry exactly one gap citation')
    }
    this.rows.push({
      section,
      check,
      key,
      metric: 'anomaly_count',
      expected: 0,
      actual: 1,
      delta: 1,
      classification,
      detail,
      ...(gapCitation === undefined ? {} : { gap_citation: gapCitation }),
    })
  }
}

interface SourceState {
  clients: Map<number, string>
  projects: Map<number, ProjectSource>
  timeReports: Map<string, Map<string, TimeAggregate>>
  expenseReports: Map<string, Map<string, ExpenseAggregate>>
  monthly: Map<string, MonthlyAggregate>
  uninvoiced: Map<string, UninvoicedAggregate>
  budgets: Map<number, BudgetActivity>
  taskBudgetActivity: Map<number, BudgetActivity>
  userBudgetActivity: Map<number, BudgetActivity>
  taskBudgets: Map<number, Array<{ assignmentId: number; literal: string | null }>>
  userBudgets: Map<number, Array<{ assignmentId: number; literal: string | null }>>
  invoices: Map<number, InvoiceSource>
  retainerIds: Set<number>
  recurringInvoiceIds: Set<number>
  roundingAnomalies: Set<string>
  uninvoicedRange: { from: string; to: string }
}

const sourceState = async (
  snapshotDir: string,
  checksums: ChecksumReport,
): Promise<SourceState> => {
  const roundingAnomalies = new Set<string>()
  const recordHoursResidue = (
    resource: string,
    sourceId: number | string,
    path: string,
    literal: string | null,
  ): number | null => {
    if (literal === null) return null
    const transformed = hoursLiteralToSeconds(literal, `${resource}.${path}`)
    if (transformed.residue !== null) {
      roundingAnomalies.add(`${resource}:${sourceId}:hours_residue:${path}=${literal}`)
    }
    return transformed.seconds
  }
  const clients = new Map<number, string>()
  for await (const source of streamRaw(snapshotDir, 'clients')) {
    clients.set(
      idAt(source, '/id', `clients:${source.line}.id`),
      currencyCode(source.row.currency, `clients:${source.line}.currency`),
    )
  }

  const projects = new Map<number, ProjectSource>()
  for await (const source of streamRaw(snapshotDir, 'projects')) {
    const id = idAt(source, '/id', `projects:${source.line}.id`)
    const clientId = idAt(source, '/client/id', `projects:${source.line}.client.id`)
    const clientCurrency = clients.get(clientId)
    if (clientCurrency === undefined)
      throw new Error(`project ${id} references missing client ${clientId}`)
    projects.set(id, {
      id,
      clientId,
      currency: clientCurrency,
      isActive: booleanValue(source.row, 'is_active', true),
      billingMethod: booleanValue(source.row, 'is_billable', true)
        ? booleanValue(source.row, 'is_fixed_fee')
          ? 'fixed_fee'
          : 'time_materials'
        : 'non_billable',
      budgetBy: typeof source.row.budget_by === 'string' ? source.row.budget_by : 'none',
      budgetLiteral: source.numbers.get('/budget') ?? null,
      costBudgetLiteral: source.numbers.get('/cost_budget') ?? null,
      feeLiteral: source.numbers.get('/fee') ?? null,
      startsOn: typeof source.row.starts_on === 'string' ? source.row.starts_on : null,
      createdOn:
        typeof source.row.created_at === 'string' && canonicalUtcTimestamp(source.row.created_at)
          ? source.row.created_at.slice(0, 10)
          : (() => {
              throw new Error(`projects:${source.line}.created_at is not canonical UTC`)
            })(),
      budgetIsMonthly: booleanValue(source.row, 'budget_is_monthly'),
      costBudgetIncludeExpenses: booleanValue(source.row, 'cost_budget_include_expenses'),
    })
    if (projects.get(id)?.budgetBy === 'project') {
      recordHoursResidue('projects', id, '/budget', source.numbers.get('/budget') ?? null)
    }
  }

  const taskBudgets = new Map<number, Array<{ assignmentId: number; literal: string | null }>>()
  for await (const source of streamRaw(snapshotDir, 'task_assignments')) {
    const projectId = idAt(source, '/project/id', `task_assignments:${source.line}.project.id`)
    const rows = taskBudgets.get(projectId) ?? []
    rows.push({
      assignmentId: idAt(source, '/id', `task_assignments:${source.line}.id`),
      literal: source.numbers.get('/budget') ?? null,
    })
    if (projects.get(projectId)?.budgetBy === 'task') {
      recordHoursResidue(
        'task_assignments',
        rows.at(-1)!.assignmentId,
        '/budget',
        source.numbers.get('/budget') ?? null,
      )
    }
    taskBudgets.set(projectId, rows)
  }
  const userBudgets = new Map<number, Array<{ assignmentId: number; literal: string | null }>>()
  for await (const source of streamRaw(snapshotDir, 'user_assignments')) {
    const projectId = idAt(source, '/project/id', `user_assignments:${source.line}.project.id`)
    const rows = userBudgets.get(projectId) ?? []
    rows.push({
      assignmentId: idAt(source, '/id', `user_assignments:${source.line}.id`),
      literal: source.numbers.get('/budget') ?? null,
    })
    if (projects.get(projectId)?.budgetBy === 'person') {
      recordHoursResidue(
        'user_assignments',
        rows.at(-1)!.assignmentId,
        '/budget',
        source.numbers.get('/budget') ?? null,
      )
    }
    userBudgets.set(projectId, rows)
  }

  const timeReports = new Map<string, Map<string, TimeAggregate>>()
  const expenseReports = new Map<string, Map<string, ExpenseAggregate>>()
  const monthly = new Map<string, MonthlyAggregate>()
  const uninvoiced = new Map<string, UninvoicedAggregate>()
  const budgets = new Map<number, BudgetActivity>()
  const taskBudgetActivity = new Map<number, BudgetActivity>()
  const userBudgetActivity = new Map<number, BudgetActivity>()
  const generatedMonth = checksums.generated_at.slice(0, 7)
  const uninvoicedRange = checksums.report_ranges!.uninvoiced

  for await (const source of streamRaw(snapshotDir, 'time_entries')) {
    const entryId = source.numbers.get('/id')
    if (entryId === undefined || !/^\d+$/.test(entryId) || BigInt(entryId) < 1n) {
      throw new Error(`time_entries:${source.line}.id must be a positive integer`)
    }
    const userId = idAt(source, '/user/id', `time_entries:${source.line}.user.id`)
    const projectId = idAt(source, '/project/id', `time_entries:${source.line}.project.id`)
    const taskId = idAt(source, '/task/id', `time_entries:${source.line}.task.id`)
    const taskAssignmentId = idAt(
      source,
      '/task_assignment/id',
      `time_entries:${source.line}.task_assignment.id`,
    )
    const userAssignmentId = idAt(
      source,
      '/user_assignment/id',
      `time_entries:${source.line}.user_assignment.id`,
    )
    const project = projects.get(projectId)
    if (project === undefined) throw new Error(`time entry references missing project ${projectId}`)
    const date = source.row.spent_date
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`time_entries:${source.line}.spent_date is not canonical`)
    }
    const roundedLiteral = source.numbers.get('/rounded_hours')
    if (roundedLiteral === undefined)
      throw new Error(`time_entries:${source.line}.rounded_hours is missing`)
    const roundedSeconds = recordHoursResidue(
      'time_entries',
      entryId,
      '/rounded_hours',
      roundedLiteral,
    )!
    const hoursLiteral = source.numbers.get('/hours')
    if (hoursLiteral === undefined) throw new Error(`time_entries:${source.line}.hours is missing`)
    const seconds = recordHoursResidue('time_entries', entryId, '/hours', hoursLiteral)!
    recordHoursResidue(
      'time_entries',
      entryId,
      '/hours_without_timer',
      source.numbers.get('/hours_without_timer') ?? null,
    )
    const billable = booleanValue(source.row, 'billable')
    const billableRateLiteral = source.numbers.get('/billable_rate')
    const costRateLiteral = source.numbers.get('/cost_rate')
    const billableRate =
      billableRateLiteral === undefined
        ? null
        : moneyLiteralToCents(billableRateLiteral, `time_entries:${source.line}.billable_rate`)
    const costRate =
      costRateLiteral === undefined
        ? null
        : moneyLiteralToCents(costRateLiteral, `time_entries:${source.line}.cost_rate`)
    const period = periodFor(checksums.periods, date)
    if (period !== undefined) {
      for (const [grain, id] of [
        ['clients', project.clientId],
        ['projects', projectId],
        ['tasks', taskId],
        ['team', userId],
      ] as const) {
        const report = getOrCreate(
          timeReports,
          `time/${grain}/${period.year}`,
          () => new Map<string, TimeAggregate>(),
        )
        const aggregate = getOrCreate(report, groupKey(id, project.currency), timeAggregate)
        aggregate.totalSeconds = add(aggregate.totalSeconds, roundedSeconds, 'time report seconds')
        if (billable) {
          aggregate.billableSeconds = add(
            aggregate.billableSeconds,
            roundedSeconds,
            'billable report seconds',
          )
          const exposesBillableAmount =
            project.billingMethod !== 'fixed_fee' ||
            project.budgetBy === 'project_cost' ||
            project.budgetBy === 'task_fees'
          if (billableRate !== null && exposesBillableAmount) {
            aggregate.billableCents = add(
              aggregate.billableCents,
              trackedAmountCents(roundedSeconds, billableRate),
              'billable report cents',
            )
          }
        }
      }
    }
    const month = getOrCreate(
      monthly,
      monthlyKey(userId, projectId, date, project.currency),
      monthlyAggregate,
    )
    month.seconds = add(month.seconds, seconds, 'monthly seconds')
    if (billable && billableRate !== null) {
      month.billableCents = add(
        month.billableCents,
        trackedAmountCents(roundedSeconds, billableRate),
        'monthly billable cents',
      )
    } else if (billable) month.unpricedBillable += 1
    if (costRate !== null) {
      month.costCents = add(
        month.costCents,
        trackedAmountCents(roundedSeconds, costRate),
        'monthly cost cents',
      )
    } else month.unpricedCost += 1

    // Harvest's uninvoiced report lists active projects only. Recomputing over
    // archived ones manufactured a delta on every archived project that still
    // had uninvoiced work, and a long-lived account always has some.
    if (
      project.isActive &&
      project.billingMethod !== 'non_billable' &&
      date >= uninvoicedRange.from &&
      date <= uninvoicedRange.to
    ) {
      const uninvoice = getOrCreate(
        uninvoiced,
        groupKey(projectId, project.currency),
        uninvoicedAggregate,
      )
      uninvoice.totalSeconds = add(
        uninvoice.totalSeconds,
        roundedSeconds,
        'uninvoiced total seconds',
      )
      uninvoice.fixedFee ||= project.billingMethod === 'fixed_fee'
      if (source.row.invoice === null && billable) {
        uninvoice.uninvoicedSeconds = add(
          uninvoice.uninvoicedSeconds,
          roundedSeconds,
          'uninvoiced seconds',
        )
        if (billableRate !== null && project.billingMethod !== 'fixed_fee') {
          uninvoice.uninvoicedAmountCents = add(
            uninvoice.uninvoicedAmountCents,
            trackedAmountCents(roundedSeconds, billableRate),
            'uninvoiced amount',
          )
        }
      }
    }

    const includeInBudget =
      booleanValue(source.row, 'budgeted') &&
      (!project.budgetIsMonthly || date.slice(0, 7) === generatedMonth)
    if (includeInBudget) {
      for (const activity of [
        getOrCreate(budgets, projectId, budgetActivity),
        getOrCreate(taskBudgetActivity, taskAssignmentId, budgetActivity),
        getOrCreate(userBudgetActivity, userAssignmentId, budgetActivity),
      ]) {
        activity.seconds = add(activity.seconds, roundedSeconds, 'budget seconds')
        if (billable && billableRate !== null) {
          activity.billableCents = add(
            activity.billableCents,
            trackedAmountCents(roundedSeconds, billableRate),
            'budget billable cents',
          )
        }
        if (costRate !== null) {
          activity.costCents = add(
            activity.costCents,
            trackedAmountCents(roundedSeconds, costRate),
            'budget cost cents',
          )
        }
      }
    }
  }

  for await (const source of streamRaw(snapshotDir, 'expenses')) {
    const userId = idAt(source, '/user/id', `expenses:${source.line}.user.id`)
    const projectId = idAt(source, '/project/id', `expenses:${source.line}.project.id`)
    const categoryId = idAt(
      source,
      '/expense_category/id',
      `expenses:${source.line}.expense_category.id`,
    )
    const project = projects.get(projectId)
    if (project === undefined) throw new Error(`expense references missing project ${projectId}`)
    const date = source.row.spent_date
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`expenses:${source.line}.spent_date is not canonical`)
    }
    const cents = requiredMoney(source, '/total_cost', `expenses:${source.line}.total_cost`)
    const billable = booleanValue(source.row, 'billable', true)
    const period = periodFor(checksums.periods, date)
    if (period !== undefined) {
      for (const [grain, id] of [
        ['clients', project.clientId],
        ['projects', projectId],
        ['categories', categoryId],
        ['team', userId],
      ] as const) {
        const report = getOrCreate(
          expenseReports,
          `expenses/${grain}/${period.year}`,
          () => new Map<string, ExpenseAggregate>(),
        )
        const aggregate = getOrCreate(report, groupKey(id, project.currency), expenseAggregate)
        aggregate.totalCents = add(aggregate.totalCents, cents, 'expense report cents')
        if (billable) {
          aggregate.billableCents = add(
            aggregate.billableCents,
            cents,
            'billable expense report cents',
          )
        }
      }
    }
    const month = getOrCreate(
      monthly,
      monthlyKey(userId, projectId, date, project.currency),
      monthlyAggregate,
    )
    month.expenseCents = add(month.expenseCents, cents, 'monthly expense cents')
    if (
      project.isActive &&
      date >= uninvoicedRange.from &&
      date <= uninvoicedRange.to &&
      project.billingMethod !== 'non_billable' &&
      source.row.invoice === null &&
      billable
    ) {
      const aggregate = getOrCreate(
        uninvoiced,
        groupKey(projectId, project.currency),
        uninvoicedAggregate,
      )
      aggregate.uninvoicedExpenseCents = add(
        aggregate.uninvoicedExpenseCents,
        cents,
        'uninvoiced expense cents',
      )
      if (project.billingMethod === 'time_materials') {
        aggregate.uninvoicedAmountCents = add(
          aggregate.uninvoicedAmountCents,
          cents,
          'uninvoiced amount',
        )
      }
    }
    if (!project.budgetIsMonthly || date.slice(0, 7) === generatedMonth) {
      const activity = getOrCreate(budgets, projectId, budgetActivity)
      activity.expenseCents = add(activity.expenseCents, cents, 'budget expense cents')
    }
  }

  const invoices = new Map<number, InvoiceSource>()
  const retainerIds = new Set<number>()
  const recurringInvoiceIds = new Set<number>()
  const invoicedByProjectCurrency = new Map<string, number>()
  for await (const source of streamRaw(snapshotDir, 'invoices')) {
    const id = idAt(source, '/id', `invoices:${source.line}.id`)
    const invoiceCurrency = currencyCode(source.row.currency, `invoices:${source.line}.currency`)
    const retainerId = optionalIdAt(source, '/retainer/id', `invoices:${source.line}.retainer.id`)
    const recurringInvoiceId = optionalIdAt(
      source,
      '/recurring_invoice_id',
      `invoices:${source.line}.recurring_invoice_id`,
    )
    if (retainerId !== null) retainerIds.add(retainerId)
    if (recurringInvoiceId !== null) recurringInvoiceIds.add(recurringInvoiceId)
    if (!Array.isArray(source.row.line_items)) {
      throw new Error(`invoices:${source.line}.line_items must be an array`)
    }
    for (const [index] of source.row.line_items.entries()) {
      const projectId = optionalIdAt(
        source,
        `/line_items/${index}/project/id`,
        `invoices:${source.line}.line_items[${index}].project.id`,
      )
      if (projectId === null) continue
      const project = projects.get(projectId)
      if (project === undefined) {
        throw new Error(`invoice ${id} line ${index} references missing project ${projectId}`)
      }
      if (project.currency !== invoiceCurrency) {
        throw new Error(
          `invoice ${id} line ${index} currency ${invoiceCurrency} does not match project ${projectId} currency ${project.currency}`,
        )
      }
      const amount = requiredMoney(
        source,
        `/line_items/${index}/amount`,
        `invoices:${source.line}.line_items[${index}].amount`,
      )
      const key = groupKey(projectId, invoiceCurrency)
      invoicedByProjectCurrency.set(
        key,
        add(invoicedByProjectCurrency.get(key) ?? 0, amount, 'invoiced project amount'),
      )
    }
    invoices.set(id, {
      currency: invoiceCurrency,
      state: typeof source.row.state === 'string' ? source.row.state : null,
      amountCents: nullableMoney(source, '/amount', `invoices:${source.line}.amount`),
      dueAmountCents: nullableMoney(source, '/due_amount', `invoices:${source.line}.due_amount`),
      taxAmountCents: nullableMoney(source, '/tax_amount', `invoices:${source.line}.tax_amount`),
      tax2AmountCents: nullableMoney(source, '/tax2_amount', `invoices:${source.line}.tax2_amount`),
      discountAmountCents: nullableMoney(
        source,
        '/discount_amount',
        `invoices:${source.line}.discount_amount`,
      ),
      paymentOptions:
        source.row.payment_options === null || source.row.payment_options === undefined
          ? null
          : JSON.stringify(source.row.payment_options),
      retainerId,
      recurringInvoiceId,
    })
  }

  const reportThrough = uninvoicedRange.to
  for (const project of projects.values()) {
    if (!project.isActive || project.billingMethod !== 'fixed_fee') continue
    const aggregate = getOrCreate(
      uninvoiced,
      groupKey(project.id, project.currency),
      uninvoicedAggregate,
    )
    const anchor = project.startsOn ?? project.createdOn
    const fixedFeeAmount =
      reportThrough < anchor
        ? 0
        : add(
            project.feeLiteral === null
              ? 0
              : moneyLiteralToCents(project.feeLiteral, `projects:${project.id}.fee`),
            -(invoicedByProjectCurrency.get(groupKey(project.id, project.currency)) ?? 0),
            'fixed-fee uninvoiced amount',
          )
    aggregate.uninvoicedAmountCents = add(
      aggregate.uninvoicedAmountCents,
      fixedFeeAmount,
      'fixed-fee uninvoiced plus expenses',
    )
  }

  return {
    clients,
    projects,
    timeReports,
    expenseReports,
    monthly,
    uninvoiced,
    budgets,
    taskBudgetActivity,
    userBudgetActivity,
    taskBudgets,
    userBudgets,
    invoices,
    retainerIds,
    recurringInvoiceIds,
    roundingAnomalies,
    uninvoicedRange,
  }
}

const numberField = (row: Record<string, unknown>, field: string, context: string): number => {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${context}.${field} must be a safe integer`)
  }
  return value
}

const timeReportChecks = (checks: Checks, source: SourceState, report: ChecksumReport): void => {
  for (const period of report.periods) {
    const chunks = splitReportRange(period)
    for (const grain of ['clients', 'projects', 'tasks', 'team'] as const) {
      const annualKey = `time/${grain}/${period.year}`
      const target = source.timeReports.get(annualKey) ?? new Map<string, TimeAggregate>()
      const upstream = new Map<string, TimeAggregate>()
      const idField = grain === 'team' ? 'user_id' : `${grain.slice(0, -1)}_id`
      for (const chunk of chunks) {
        const chunkKey = reportChunkKey(annualKey, chunk, chunks.length)
        const rows = report.reports[chunkKey]
        if (rows === undefined) {
          checks.note(
            'A',
            'harvest_time_report',
            chunkKey,
            'UNEXPLAINED',
            'verified report chunk is missing',
          )
          continue
        }
        const seen = new Set<string>()
        for (const [index, row] of rows.entries()) {
          const id = numberField(row, idField, `${chunkKey}[${index}]`)
          const currency = currencyCode(row.currency, `${chunkKey}[${index}].currency`)
          const key = groupKey(id, currency)
          if (seen.has(key)) throw new Error(`${chunkKey} repeats report row ${key}`)
          seen.add(key)
          const aggregate = getOrCreate(upstream, key, timeAggregate)
          aggregate.totalSeconds = add(
            aggregate.totalSeconds,
            reportSeconds(row.total_hours, `${chunkKey}[${index}].total_hours`),
            'Harvest report seconds',
          )
          aggregate.billableSeconds = add(
            aggregate.billableSeconds,
            reportSeconds(row.billable_hours, `${chunkKey}[${index}].billable_hours`),
            'Harvest report billable seconds',
          )
          aggregate.billableCents = add(
            aggregate.billableCents,
            nonnegativeReportMoney(row.billable_amount, `${chunkKey}[${index}].billable_amount`),
            'Harvest report billable cents',
          )
        }
      }
      for (const key of new Set([...target.keys(), ...upstream.keys()])) {
        const expected = upstream.get(key) ?? timeAggregate()
        const actual = target.get(key) ?? timeAggregate()
        checks.compare(
          'A',
          'harvest_time_report',
          `${annualKey}|${key}`,
          'total_seconds',
          expected.totalSeconds,
          actual.totalSeconds,
        )
        checks.compare(
          'A',
          'harvest_time_report',
          `${annualKey}|${key}`,
          'billable_seconds',
          expected.billableSeconds,
          actual.billableSeconds,
        )
        checks.compare(
          'A',
          'harvest_time_report',
          `${annualKey}|${key}`,
          'billable_amount_cents',
          expected.billableCents,
          actual.billableCents,
        )
        checks.compare(
          'A',
          'harvest_time_report',
          `${annualKey}|${key}`,
          'unpriced_billable_rows',
          0,
          actual.unpricedBillable,
        )
      }
    }
  }
}

const expenseReportChecks = (checks: Checks, source: SourceState, report: ChecksumReport): void => {
  for (const period of report.periods) {
    const chunks = splitReportRange(period)
    for (const grain of ['clients', 'projects', 'categories', 'team'] as const) {
      const annualKey = `expenses/${grain}/${period.year}`
      const target = source.expenseReports.get(annualKey) ?? new Map<string, ExpenseAggregate>()
      const upstream = new Map<string, ExpenseAggregate>()
      const idField =
        grain === 'team'
          ? 'user_id'
          : grain === 'categories'
            ? 'expense_category_id'
            : `${grain.slice(0, -1)}_id`
      for (const chunk of chunks) {
        const chunkKey = reportChunkKey(annualKey, chunk, chunks.length)
        const rows = report.reports[chunkKey]
        if (rows === undefined) {
          checks.note(
            'A',
            'harvest_expense_report',
            chunkKey,
            'UNEXPLAINED',
            'verified report chunk is missing',
          )
          continue
        }
        const seen = new Set<string>()
        for (const [index, row] of rows.entries()) {
          const id = numberField(row, idField, `${chunkKey}[${index}]`)
          const currency = currencyCode(row.currency, `${chunkKey}[${index}].currency`)
          const key = groupKey(id, currency)
          if (seen.has(key)) throw new Error(`${chunkKey} repeats report row ${key}`)
          seen.add(key)
          const aggregate = getOrCreate(upstream, key, expenseAggregate)
          aggregate.totalCents = add(
            aggregate.totalCents,
            nonnegativeReportMoney(row.total_amount, `${chunkKey}[${index}].total_amount`),
            'Harvest report expense cents',
          )
          aggregate.billableCents = add(
            aggregate.billableCents,
            nonnegativeReportMoney(row.billable_amount, `${chunkKey}[${index}].billable_amount`),
            'Harvest report billable expense cents',
          )
        }
      }
      for (const key of new Set([...target.keys(), ...upstream.keys()])) {
        const expected = upstream.get(key) ?? expenseAggregate()
        const actual = target.get(key) ?? expenseAggregate()
        checks.compare(
          'A',
          'harvest_expense_report',
          `${annualKey}|${key}`,
          'total_amount_cents',
          expected.totalCents,
          actual.totalCents,
        )
        checks.compare(
          'A',
          'harvest_expense_report',
          `${annualKey}|${key}`,
          'billable_amount_cents',
          expected.billableCents,
          actual.billableCents,
        )
      }
    }
  }
}

const uninvoicedReportChecks = (
  checks: Checks,
  source: SourceState,
  report: ChecksumReport,
): void => {
  const upstream = new Map<string, UninvoicedAggregate>()
  const rows = report.reports.uninvoiced
  if (rows === undefined) {
    checks.note(
      'A',
      'harvest_uninvoiced_report',
      'uninvoiced',
      'UNEXPLAINED',
      'verified report is missing',
    )
    return
  }
  for (const [index, row] of rows.entries()) {
    const projectId = numberField(row, 'project_id', `uninvoiced[${index}]`)
    const currency = currencyCode(row.currency, `uninvoiced[${index}].currency`)
    const key = groupKey(projectId, currency)
    if (upstream.has(key)) throw new Error(`uninvoiced repeats report row ${key}`)
    const aggregate = getOrCreate(upstream, key, uninvoicedAggregate)
    aggregate.totalSeconds = add(
      aggregate.totalSeconds,
      reportSeconds(row.total_hours, `uninvoiced[${index}].total_hours`),
      'Harvest uninvoiced total seconds',
    )
    aggregate.uninvoicedSeconds = add(
      aggregate.uninvoicedSeconds,
      reportSeconds(row.uninvoiced_hours, `uninvoiced[${index}].uninvoiced_hours`),
      'Harvest uninvoiced seconds',
    )
    aggregate.uninvoicedExpenseCents = add(
      aggregate.uninvoicedExpenseCents,
      nonnegativeReportMoney(row.uninvoiced_expenses, `uninvoiced[${index}].uninvoiced_expenses`),
      'Harvest uninvoiced expense cents',
    )
    aggregate.uninvoicedAmountCents = add(
      aggregate.uninvoicedAmountCents,
      reportMoney(row.uninvoiced_amount, `uninvoiced[${index}].uninvoiced_amount`),
      'Harvest uninvoiced amount cents',
    )
  }
  for (const key of new Set([...source.uninvoiced.keys(), ...upstream.keys()])) {
    const expected = upstream.get(key) ?? uninvoicedAggregate()
    const actual = source.uninvoiced.get(key) ?? uninvoicedAggregate()
    checks.compare(
      'A',
      'harvest_uninvoiced_report',
      key,
      'total_seconds',
      expected.totalSeconds,
      actual.totalSeconds,
    )
    checks.compare(
      'A',
      'harvest_uninvoiced_report',
      key,
      'uninvoiced_seconds',
      expected.uninvoicedSeconds,
      actual.uninvoicedSeconds,
    )
    checks.compare(
      'A',
      'harvest_uninvoiced_report',
      key,
      'uninvoiced_expense_cents',
      expected.uninvoicedExpenseCents,
      actual.uninvoicedExpenseCents,
    )
    checks.compare(
      'A',
      'harvest_uninvoiced_report',
      key,
      'uninvoiced_amount_cents',
      expected.uninvoicedAmountCents,
      actual.uninvoicedAmountCents,
    )
    checks.compare(
      'A',
      'harvest_uninvoiced_report',
      key,
      'unpriced_time_rows',
      0,
      actual.unpricedTime,
    )
  }
}

const budgetValue = (
  row: Record<string, unknown>,
  field: string,
  money: boolean,
  context: string,
): number | null => {
  if (row[field] === null || row[field] === undefined) return null
  if (!money) return reportSeconds(row[field], `${context}.${field}`)
  return field === 'budget_remaining'
    ? reportMoney(row[field], `${context}.${field}`)
    : nonnegativeReportMoney(row[field], `${context}.${field}`)
}

const sourceBudget = (
  project: ProjectSource,
  source: SourceState,
): { amount: number | null; spent: number; remaining: number | null; unpriced: number } => {
  const activity = source.budgets.get(project.id) ?? budgetActivity()
  let amount: number | null = null
  let spent = 0
  let unpriced = 0
  if (project.budgetBy === 'project') {
    amount =
      project.budgetLiteral === null ? null : hoursLiteralToSeconds(project.budgetLiteral).seconds
    spent = activity.seconds
  } else if (project.budgetBy === 'project_cost') {
    amount =
      project.costBudgetLiteral === null ? null : moneyLiteralToCents(project.costBudgetLiteral)
    spent = add(
      activity.billableCents,
      project.costBudgetIncludeExpenses ? activity.expenseCents : 0,
      'project fee budget',
    )
    unpriced = activity.unpricedBillable
  } else if (project.budgetBy === 'task') {
    for (const row of source.taskBudgets.get(project.id) ?? []) {
      if (row.literal === null) continue
      amount = add(amount ?? 0, hoursLiteralToSeconds(row.literal).seconds, 'task budgets')
      spent = add(
        spent,
        source.taskBudgetActivity.get(row.assignmentId)?.seconds ?? 0,
        'task budget spent',
      )
    }
  } else if (project.budgetBy === 'task_fees') {
    for (const row of source.taskBudgets.get(project.id) ?? []) {
      if (row.literal === null) continue
      amount = add(amount ?? 0, moneyLiteralToCents(row.literal), 'task fee budgets')
      spent = add(
        spent,
        source.taskBudgetActivity.get(row.assignmentId)?.billableCents ?? 0,
        'task fee budget spent',
      )
    }
  } else if (project.budgetBy === 'person') {
    for (const row of source.userBudgets.get(project.id) ?? []) {
      if (row.literal === null) continue
      amount = add(amount ?? 0, hoursLiteralToSeconds(row.literal).seconds, 'person budgets')
      spent = add(
        spent,
        source.userBudgetActivity.get(row.assignmentId)?.seconds ?? 0,
        'person budget spent',
      )
    }
  }
  return {
    amount,
    spent,
    remaining: amount === null ? null : add(amount, -spent, 'budget remaining'),
    unpriced,
  }
}

const projectBudgetChecks = (checks: Checks, source: SourceState, report: ChecksumReport): void => {
  const upstream = new Map<number, { row: Record<string, unknown>; active: boolean }>()
  for (const key of ['project_budget/active', 'project_budget/inactive'] as const) {
    const rows = report.reports[key]
    if (rows === undefined) {
      checks.note('A', 'harvest_project_budget', key, 'UNEXPLAINED', 'verified report is missing')
      continue
    }
    for (const [index, row] of rows.entries()) {
      const id = numberField(row, 'project_id', `${key}[${index}]`)
      if (upstream.has(id)) throw new Error(`project budget reports repeat project ${id}`)
      upstream.set(id, { row, active: key === 'project_budget/active' })
    }
  }
  for (const project of source.projects.values()) {
    const key = `project:${project.id}`
    const expected = upstream.get(project.id)
    if (project.budgetBy === 'none') {
      if (expected !== undefined) {
        checks.note(
          'A',
          'harvest_project_budget',
          key,
          'UNEXPLAINED',
          'unbudgeted snapshot project appears in the project budget report',
        )
      }
      continue
    }
    if (expected === undefined) {
      checks.note(
        'A',
        'harvest_project_budget',
        key,
        'UNEXPLAINED',
        'project is absent from both budget report sweeps',
      )
      continue
    }
    const expectedRow = expected.row
    const actual = sourceBudget(project, source)
    const money = project.budgetBy === 'project_cost' || project.budgetBy === 'task_fees'
    const visibilityGap = money && reportMoneyVisibilityMissing(expectedRow)
    if (typeof expectedRow.is_active !== 'boolean') {
      throw new Error(`${key}.is_active must be boolean`)
    }
    if (typeof expectedRow.budget_by !== 'string') {
      throw new Error(`${key}.budget_by must be a string`)
    }
    if (typeof expectedRow.budget_is_monthly !== 'boolean') {
      throw new Error(`${key}.budget_is_monthly must be boolean`)
    }
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'active',
      expectedRow.is_active ? 1 : 0,
      project.isActive ? 1 : 0,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'requested_active_set',
      expected.active ? 1 : 0,
      expectedRow.is_active ? 1 : 0,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'budget_by',
      expectedRow.budget_by,
      project.budgetBy,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'budget_is_monthly',
      expectedRow.budget_is_monthly ? 1 : 0,
      project.budgetIsMonthly ? 1 : 0,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'budget',
      budgetValue(expectedRow, 'budget', money, key),
      actual.amount,
      'UNEXPLAINED',
      visibilityGap ? 'verified report is missing a money budget value' : null,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'budget_spent',
      budgetValue(expectedRow, 'budget_spent', money, key),
      actual.spent,
      'UNEXPLAINED',
      visibilityGap ? 'verified report is missing a money budget value' : null,
    )
    checks.compare(
      'A',
      'harvest_project_budget',
      key,
      'budget_remaining',
      budgetValue(expectedRow, 'budget_remaining', money, key),
      actual.remaining,
      'UNEXPLAINED',
      visibilityGap ? 'verified report is missing a money budget value' : null,
    )
    checks.compare('A', 'harvest_project_budget', key, 'unpriced_rows', 0, actual.unpriced)
  }
  for (const id of upstream.keys()) {
    const project = source.projects.get(id)
    if (project === undefined) {
      checks.note(
        'A',
        'harvest_project_budget',
        `project:${id}`,
        'UNEXPLAINED',
        'budget report project is absent from the snapshot',
      )
    }
  }
}

const reportMoneyVisibilityMissing = (row: Record<string, unknown>): boolean =>
  row.budget === null || row.budget === undefined

const RESOURCE_TABLES: Record<string, { table: string; importedOnly: boolean }> = {
  users: { table: 'users', importedOnly: true },
  billable_rates: { table: 'user_billable_rates', importedOnly: true },
  cost_rates: { table: 'user_cost_rates', importedOnly: true },
  roles: { table: 'roles', importedOnly: true },
  teammates: { table: 'teammate_assignments', importedOnly: false },
  clients: { table: 'clients', importedOnly: true },
  contacts: { table: 'contacts', importedOnly: true },
  tasks: { table: 'tasks', importedOnly: true },
  expense_categories: { table: 'expense_categories', importedOnly: true },
  invoice_item_categories: { table: 'invoice_item_categories', importedOnly: true },
  estimate_item_categories: { table: 'estimate_item_categories', importedOnly: true },
  projects: { table: 'projects', importedOnly: true },
  task_assignments: { table: 'task_assignments', importedOnly: true },
  user_assignments: { table: 'user_assignments', importedOnly: true },
  estimates: { table: 'estimates', importedOnly: true },
  estimate_messages: { table: 'estimate_messages', importedOnly: true },
  invoices: { table: 'invoices', importedOnly: true },
  invoice_messages: { table: 'invoice_messages', importedOnly: true },
  invoice_payments: { table: 'invoice_payments', importedOnly: true },
  time_entries: { table: 'time_entries', importedOnly: true },
  expenses: { table: 'expenses', importedOnly: true },
}

const scalar = <T>(database: BetterSqlite3.Database, sql: string, bindings: unknown[] = []): T =>
  (database
    .prepare(sql)
    .pluck()
    .get(...bindings) as T | undefined) ??
  (() => {
    throw new Error('query returned no row')
  })()

/**
 * The alias map the load was admitted with, read back from the durable load
 * options rather than passed in: the report describes the database in front of
 * it, and that database says which duplicate went into which survivor.
 */
const loadedUserAliases = (database: BetterSqlite3.Database): Map<number, number> => {
  const admission = database
    .prepare(
      `SELECT load_options_json AS loadOptionsJson
       FROM _ezacto_load_admission WHERE singleton = 1`,
    )
    .get() as { loadOptionsJson: string } | undefined
  if (admission === undefined) return new Map()
  const options = JSON.parse(admission.loadOptionsJson) as {
    user_identity?: { aliases?: Array<{ duplicate: number; canonical: number }> }
  }
  return new Map(
    (options.user_identity?.aliases ?? []).map((alias) => [alias.duplicate, alias.canonical]),
  )
}

/**
 * How many source rows each resource lost to a squash, counted from the
 * evidence the loader wrote at the moment it dropped one. The row-count check
 * cites that number rather than netting it out silently: a real loss of one row
 * more is then still a delta that nothing explains.
 */
const squashedRowCounts = (
  database: BetterSqlite3.Database,
  snapshotSha256: string,
): Map<string, number> =>
  new Map(
    (
      database
        .prepare(
          `SELECT resource, count(*) AS rows FROM _ezacto_load_anomalies
           WHERE snapshot_sha256 = ?
             AND kind IN ('duplicate_user_squashed', 'duplicate_row_merged')
           GROUP BY resource`,
        )
        .all(snapshotSha256) as Array<{ resource: string; rows: number }>
    ).map((row) => [row.resource, row.rows]),
  )

const databasePreflight = (
  checks: Checks,
  database: BetterSqlite3.Database,
  manifest: Manifest,
  checksum: ChecksumReport,
  manifestSha256: string,
): void => {
  const admission = database
    .prepare(
      `SELECT snapshot_sha256, manifest_sha256, load_options_json AS loadOptionsJson
       FROM _ezacto_load_admission WHERE singleton = 1`,
    )
    .get() as
    { snapshot_sha256: string; manifest_sha256: string; loadOptionsJson: string } | undefined
  checks.compare(
    'B',
    'load_admission',
    'snapshot',
    'snapshot_sha256',
    checksum.snapshot_sha256,
    admission?.snapshot_sha256 ?? null,
  )
  checks.compare(
    'B',
    'load_admission',
    'snapshot',
    'manifest_sha256',
    manifestSha256,
    admission?.manifest_sha256 ?? null,
  )
  const completed = new Map(
    (
      database
        .prepare(
          `SELECT resource, snapshot_sha256, load_options_json AS loadOptionsJson,
            completed, rows_loaded, total_rows
           FROM _ezacto_load_progress ORDER BY resource`,
        )
        .all() as Array<{
        resource: string
        snapshot_sha256: string
        loadOptionsJson: string
        completed: number
        rows_loaded: number
        total_rows: number
      }>
    ).map((row) => [row.resource, row]),
  )
  for (const resource of LOAD_RESOURCES) {
    const row = completed.get(resource)
    checks.compare(
      'B',
      'load_completion',
      resource,
      'snapshot_sha256',
      checksum.snapshot_sha256,
      row?.snapshot_sha256 ?? null,
    )
    checks.compare(
      'B',
      'load_completion',
      resource,
      'load_options_json',
      admission?.loadOptionsJson ?? null,
      row?.loadOptionsJson ?? null,
    )
    checks.compare(
      'B',
      'load_completion',
      resource,
      'complete',
      1,
      row?.completed === 1 && row.rows_loaded === row.total_rows ? 1 : 0,
    )
  }
  const squashed = squashedRowCounts(database, checksum.snapshot_sha256)
  for (const [resource, progress] of Object.entries(manifest.resources)) {
    const mapping = RESOURCE_TABLES[resource]
    if (mapping === undefined) continue
    const actual = scalar<number>(
      database,
      `SELECT count(*) FROM ${mapping.table}${mapping.importedOnly ? ' WHERE harvest_id IS NOT NULL' : ''}`,
    )
    const merged = squashed.get(resource)
    checks.compare(
      'B',
      'resource_row_count',
      resource,
      'rows',
      progress.count,
      actual,
      'UNEXPLAINED',
      null,
      merged === undefined
        ? undefined
        : { delta: -merged, citation: MIGRATION_SPEC_GAP_CITATIONS.duplicateHarvestAccounts },
    )
  }
  const expectedReceipts = Object.keys(manifest.binaries?.receipts ?? {}).length
  const actualReceipts = scalar<number>(database, 'SELECT count(*) FROM harvest_expense_receipts')
  checks.compare(
    'B',
    'resource_row_count',
    'receipt_binaries',
    'rows',
    expectedReceipts,
    actualReceipts,
  )
}

interface DatabaseMonthlyRow {
  userId: number
  projectId: number
  month: string
  currency: string
  seconds: number
  roundedSeconds: number
  billable: number
  billableRateCents: number | null
  costRateCents: number | null
  expenseCents: number
  kind: 'time' | 'expense'
}

const databaseMonthly = (database: BetterSqlite3.Database): Map<string, MonthlyAggregate> => {
  const result = new Map<string, MonthlyAggregate>()
  const timeRows = database
    .prepare(
      `SELECT user.harvest_id AS userId, project.harvest_id AS projectId,
        substr(entry.spent_date, 1, 7) AS month, entry.seconds AS seconds,
        upper(coalesce(project.billing_currency, client.currency)) AS currency,
        entry.rounded_seconds AS roundedSeconds, entry.billable AS billable,
        entry.billable_rate_cents AS billableRateCents, entry.cost_rate_cents AS costRateCents,
        0 AS expenseCents, 'time' AS kind
       FROM time_entries entry
       JOIN users user ON user.id = entry.user_id
       JOIN projects project ON project.id = entry.project_id
       JOIN clients client ON client.id = project.client_id
       WHERE entry.harvest_id IS NOT NULL ORDER BY user.harvest_id, project.harvest_id, month, entry.id`,
    )
    .all() as DatabaseMonthlyRow[]
  const expenseRows = database
    .prepare(
      `SELECT user.harvest_id AS userId, project.harvest_id AS projectId,
        substr(expense.spent_date, 1, 7) AS month, 0 AS seconds, 0 AS roundedSeconds,
        upper(coalesce(project.billing_currency, client.currency)) AS currency,
        expense.billable AS billable, NULL AS billableRateCents, NULL AS costRateCents,
        expense.total_cost_cents AS expenseCents, 'expense' AS kind
       FROM expenses expense
       JOIN users user ON user.id = expense.user_id
       JOIN projects project ON project.id = expense.project_id
       JOIN clients client ON client.id = project.client_id
       WHERE expense.harvest_id IS NOT NULL ORDER BY user.harvest_id, project.harvest_id, month, expense.id`,
    )
    .all() as DatabaseMonthlyRow[]
  for (const row of [...timeRows, ...expenseRows]) {
    const value = getOrCreate(
      result,
      `${row.userId}|${row.projectId}|${row.month}|${row.currency}`,
      monthlyAggregate,
    )
    if (row.kind === 'expense') {
      value.expenseCents = add(value.expenseCents, row.expenseCents, 'database monthly expense')
      continue
    }
    value.seconds = add(value.seconds, row.seconds, 'database monthly seconds')
    if (row.billable === 1 && row.billableRateCents !== null) {
      value.billableCents = add(
        value.billableCents,
        trackedAmountCents(row.roundedSeconds, row.billableRateCents),
        'database monthly billable cents',
      )
    } else if (row.billable === 1) value.unpricedBillable += 1
    if (row.costRateCents !== null) {
      value.costCents = add(
        value.costCents,
        trackedAmountCents(row.roundedSeconds, row.costRateCents),
        'database monthly cost cents',
      )
    } else value.unpricedCost += 1
  }
  return result
}

/**
 * A squashed account's rows are loaded under the survivor's Harvest id, so the
 * source has to be grouped the same way. Left ungrouped, every (user, project,
 * month) the duplicate touched reads as lost under one id and invented under
 * the other — a pair of unexplained deltas per metric for data that never
 * moved, and the operator loses the ability to tell a real loss from the
 * merge's own shadow.
 */
const foldSquashedUsers = (
  monthly: ReadonlyMap<string, MonthlyAggregate>,
  aliases: ReadonlyMap<number, number>,
): Map<string, MonthlyAggregate> => {
  if (aliases.size === 0) return new Map(monthly)
  const folded = new Map<string, MonthlyAggregate>()
  for (const [key, value] of monthly) {
    const [user, ...rest] = key.split('|')
    const canonical = aliases.get(Number(user))
    const target = getOrCreate(
      folded,
      canonical === undefined ? key : [canonical, ...rest].join('|'),
      monthlyAggregate,
    )
    target.seconds = add(target.seconds, value.seconds, 'squashed monthly seconds')
    target.billableCents = add(
      target.billableCents,
      value.billableCents,
      'squashed monthly billable cents',
    )
    target.costCents = add(target.costCents, value.costCents, 'squashed monthly cost cents')
    target.expenseCents = add(
      target.expenseCents,
      value.expenseCents,
      'squashed monthly expense cents',
    )
    target.unpricedBillable += value.unpricedBillable
    target.unpricedCost += value.unpricedCost
  }
  return folded
}

const monthlyChecks = (
  checks: Checks,
  source: SourceState,
  database: BetterSqlite3.Database,
): void => {
  const loaded = databaseMonthly(database)
  const expected = foldSquashedUsers(source.monthly, loadedUserAliases(database))
  const sourceSeconds = new Map<string, number>()
  const loadedSeconds = new Map<string, number>()
  for (const [key, value] of expected) {
    const base = monthlySecondsKey(key)
    sourceSeconds.set(
      base,
      add(sourceSeconds.get(base) ?? 0, value.seconds, 'source monthly seconds'),
    )
  }
  for (const [key, value] of loaded) {
    const base = monthlySecondsKey(key)
    loadedSeconds.set(
      base,
      add(loadedSeconds.get(base) ?? 0, value.seconds, 'loaded monthly seconds'),
    )
  }
  for (const key of new Set([...sourceSeconds.keys(), ...loadedSeconds.keys()])) {
    checks.compare(
      'B',
      'inv-14',
      key,
      'seconds',
      sourceSeconds.get(key) ?? 0,
      loadedSeconds.get(key) ?? 0,
    )
  }
  for (const key of new Set([...expected.keys(), ...loaded.keys()])) {
    const month = expected.get(key) ?? monthlyAggregate()
    const actual = loaded.get(key) ?? monthlyAggregate()
    checks.compare(
      'B',
      'monthly_money',
      key,
      'billable_cents',
      month.billableCents,
      actual.billableCents,
    )
    checks.compare('B', 'monthly_money', key, 'cost_cents', month.costCents, actual.costCents)
    checks.compare(
      'B',
      'monthly_money',
      key,
      'expense_cents',
      month.expenseCents,
      actual.expenseCents,
    )
    checks.compare(
      'B',
      'monthly_money',
      key,
      'unpriced_billable_rows',
      month.unpricedBillable,
      actual.unpricedBillable,
    )
    checks.compare(
      'B',
      'monthly_money',
      key,
      'unpriced_cost_rows',
      month.unpricedCost,
      actual.unpricedCost,
    )
  }
}

const invoiceSourceChecks = (
  checks: Checks,
  source: SourceState,
  database: BetterSqlite3.Database,
): void => {
  const rows = database
    .prepare(
      `SELECT invoice.harvest_id AS harvestId, invoice.currency AS currency,
        invoice.state AS state,
        invoice.source_amount_cents AS amountCents,
        invoice.source_due_amount_cents AS dueAmountCents,
        invoice.source_tax_amount_cents AS taxAmountCents,
        invoice.source_tax2_amount_cents AS tax2AmountCents,
        invoice.source_discount_amount_cents AS discountAmountCents,
        invoice.source_payment_options AS paymentOptions,
        invoice.amount_cents AS nativeAmountCents,
        invoice.due_amount_cents AS nativeDueAmountCents,
        retainer.harvest_id AS retainerId, recurring.harvest_id AS recurringInvoiceId
       FROM invoices invoice
       LEFT JOIN retainers retainer ON retainer.id = invoice.retainer_id
       LEFT JOIN recurring_invoices recurring ON recurring.id = invoice.recurring_invoice_id
       WHERE invoice.harvest_id IS NOT NULL ORDER BY invoice.harvest_id`,
    )
    .all() as Array<{
    harvestId: number
    currency: string
    state: string
    amountCents: number | null
    dueAmountCents: number | null
    taxAmountCents: number | null
    tax2AmountCents: number | null
    discountAmountCents: number | null
    paymentOptions: string | null
    nativeAmountCents: number
    nativeDueAmountCents: number
    retainerId: number | null
    recurringInvoiceId: number | null
  }>
  const loaded = new Map(rows.map((row) => [row.harvestId, row]))
  for (const [id, expected] of source.invoices) {
    const actual = loaded.get(id)
    const key = `invoice:${id}`
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'currency',
      expected.currency,
      actual?.currency ?? null,
    )
    // Invoice state is derived from the payments that loaded, not carried over,
    // so a payment the import could not represent restates a settled invoice as
    // outstanding. Comparing nothing here is what let that pass unseen.
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'state',
      expected.state,
      actual?.state ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'amount_cents',
      expected.amountCents,
      actual?.amountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'due_amount_cents',
      expected.dueAmountCents,
      actual?.dueAmountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'tax_amount_cents',
      expected.taxAmountCents,
      actual?.taxAmountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'tax2_amount_cents',
      expected.tax2AmountCents,
      actual?.tax2AmountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'discount_amount_cents',
      expected.discountAmountCents,
      actual?.discountAmountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_source_fidelity',
      key,
      'payment_options',
      expected.paymentOptions,
      actual?.paymentOptions ?? null,
    )
    checks.compare(
      'B',
      'invoice_totals',
      key,
      'amount_cents',
      expected.amountCents,
      actual?.nativeAmountCents ?? null,
    )
    checks.compare(
      'B',
      'invoice_totals',
      key,
      'due_amount_cents',
      expected.dueAmountCents,
      actual?.nativeDueAmountCents ?? null,
    )
    checks.compare(
      'B',
      'retainer_stub_link',
      key,
      'harvest_id',
      expected.retainerId,
      actual?.retainerId ?? null,
    )
    checks.compare(
      'B',
      'recurring_invoice_stub_link',
      key,
      'harvest_id',
      expected.recurringInvoiceId,
      actual?.recurringInvoiceId ?? null,
    )
  }
}

const currencyFidelityChecks = (
  checks: Checks,
  source: SourceState,
  database: BetterSqlite3.Database,
): void => {
  const clients = new Map(
    (
      database
        .prepare(
          `SELECT harvest_id AS id, upper(currency) AS currency
           FROM clients WHERE harvest_id IS NOT NULL ORDER BY harvest_id`,
        )
        .all() as Array<{ id: number; currency: string }>
    ).map((row) => [row.id, row.currency]),
  )
  for (const id of new Set([...source.clients.keys(), ...clients.keys()])) {
    checks.compare(
      'B',
      'currency_fidelity',
      `client:${id}`,
      'currency',
      source.clients.get(id) ?? null,
      clients.get(id) ?? null,
    )
  }

  const projects = new Map(
    (
      database
        .prepare(
          `SELECT project.harvest_id AS id,
            upper(coalesce(project.billing_currency, client.currency)) AS currency
           FROM projects project JOIN clients client ON client.id = project.client_id
           WHERE project.harvest_id IS NOT NULL ORDER BY project.harvest_id`,
        )
        .all() as Array<{ id: number; currency: string }>
    ).map((row) => [row.id, row.currency]),
  )
  for (const id of new Set([...source.projects.keys(), ...projects.keys()])) {
    checks.compare(
      'B',
      'currency_fidelity',
      `project:${id}`,
      'currency',
      source.projects.get(id)?.currency ?? null,
      projects.get(id) ?? null,
    )
  }
}

const stubChecks = (
  checks: Checks,
  source: SourceState,
  database: BetterSqlite3.Database,
): void => {
  const loadedRetainers = new Set(
    database
      .prepare('SELECT harvest_id FROM retainers WHERE harvest_id IS NOT NULL')
      .pluck()
      .all() as number[],
  )
  const loadedRecurring = new Set(
    database
      .prepare('SELECT harvest_id FROM recurring_invoices WHERE harvest_id IS NOT NULL')
      .pluck()
      .all() as number[],
  )
  // What the operator has actually finished, so the report can tell a closed
  // gap from an open one. `_ezacto_worksheet_completions` exists for exactly
  // this -- migration 0024 says it is there "to distinguish a confirmed zero
  // balance from an untouched stub" -- and until now nothing outside the
  // worksheet tool ever read it, so these two notes were emitted for every
  // source id regardless and the report said the same thing before and after
  // the manual work (issue 288).
  const completed = (kind: 'retainer_balance' | 'recurring_invoice_definition'): Set<number> =>
    new Set(
      database
        .prepare(
          `SELECT harvest_id FROM _ezacto_worksheet_completions WHERE kind = ?`,
        )
        .pluck()
        .all(kind) as number[],
    )
  const completedRetainers = completed('retainer_balance')
  const completedRecurring = completed('recurring_invoice_definition')

  for (const id of new Set([...source.retainerIds, ...loadedRetainers])) {
    checks.compare(
      'B',
      'retainer_stub_count',
      `retainer:${id}`,
      'present',
      source.retainerIds.has(id) ? 1 : 0,
      loadedRetainers.has(id) ? 1 : 0,
    )
    if (source.retainerIds.has(id) && !completedRetainers.has(id)) {
      checks.note(
        'B',
        'retainer_balance',
        `retainer:${id}`,
        'gap',
        'Harvest exposes this retainer identifier on an invoice but no balance API, and no worksheet completion has been recorded for it',
        MIGRATION_SPEC_GAP_CITATIONS.retainersNoApi,
      )
    }
  }
  for (const id of new Set([...source.recurringInvoiceIds, ...loadedRecurring])) {
    checks.compare(
      'B',
      'recurring_invoice_stub_count',
      `recurring_invoice:${id}`,
      'present',
      source.recurringInvoiceIds.has(id) ? 1 : 0,
      loadedRecurring.has(id) ? 1 : 0,
    )
    if (source.recurringInvoiceIds.has(id) && !completedRecurring.has(id)) {
      checks.note(
        'B',
        'recurring_invoice_definition',
        `recurring_invoice:${id}`,
        'gap',
        'Harvest exposes this recurring invoice identifier but no definition API, and no worksheet completion has been recorded for it',
        MIGRATION_SPEC_GAP_CITATIONS.recurringInvoicesNoApi,
      )
    }
  }
}

const roundedRateShare = (base: bigint, rate: number | null): bigint => {
  const product = base * BigInt(rate ?? 0)
  return (product + (product >= 0n ? 500_000n : -500_000n)) / 1_000_000n
}

const internalInvoiceChecks = (checks: Checks, database: BetterSqlite3.Database): void => {
  const rows = database
    .prepare(
      `SELECT invoice.id, invoice.harvest_id AS harvestId, invoice.state,
        invoice.tax_rate_ppm AS taxRate, invoice.tax2_rate_ppm AS tax2Rate,
        invoice.discount_rate_ppm AS discountRate, invoice.amount_cents AS amountCents,
        invoice.tax_amount_cents AS taxAmountCents,
        invoice.tax2_amount_cents AS tax2AmountCents,
        invoice.discount_amount_cents AS discountAmountCents,
        invoice.due_amount_cents AS dueAmountCents,
        invoice.written_off_cents AS writtenOffCents,
        coalesce((SELECT sum(amount_cents) FROM invoice_line_items line WHERE line.invoice_id = invoice.id), 0) AS subtotalCents,
        coalesce((SELECT sum(amount_cents) FROM invoice_line_items line WHERE line.invoice_id = invoice.id AND line.taxed = 1), 0) AS taxBaseCents,
        coalesce((SELECT sum(amount_cents) FROM invoice_line_items line WHERE line.invoice_id = invoice.id AND line.taxed2 = 1), 0) AS tax2BaseCents,
        coalesce((SELECT sum(amount_cents) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id), 0) AS paymentCents,
        (SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id) AS paymentCount
       FROM invoices invoice WHERE invoice.harvest_id IS NOT NULL ORDER BY invoice.harvest_id`,
    )
    .all() as Array<{
    id: number
    harvestId: number
    state: string
    taxRate: number | null
    tax2Rate: number | null
    discountRate: number | null
    amountCents: number
    taxAmountCents: number
    tax2AmountCents: number
    discountAmountCents: number
    dueAmountCents: number
    writtenOffCents: number
    subtotalCents: number
    taxBaseCents: number
    tax2BaseCents: number
    paymentCents: number
    paymentCount: number
  }>
  for (const row of rows) {
    const subtotal = BigInt(row.subtotalCents)
    const discount = roundedRateShare(subtotal, row.discountRate)
    const tax = roundedRateShare(
      BigInt(row.taxBaseCents) - roundedRateShare(BigInt(row.taxBaseCents), row.discountRate),
      row.taxRate,
    )
    const tax2 = roundedRateShare(
      BigInt(row.tax2BaseCents) - roundedRateShare(BigInt(row.tax2BaseCents), row.discountRate),
      row.tax2Rate,
    )
    const amount = checked(subtotal - discount + tax + tax2, 'invoice amount', centsLimit)
    const due = checked(
      BigInt(amount) - BigInt(row.paymentCents) - BigInt(row.writtenOffCents),
      'invoice due',
      centsLimit,
    )
    const key = `invoice:${row.harvestId}`
    checks.compare(
      'C',
      'inv-04',
      key,
      'discount_amount_cents',
      Number(discount),
      row.discountAmountCents,
    )
    checks.compare('C', 'inv-04', key, 'tax_amount_cents', Number(tax), row.taxAmountCents)
    checks.compare('C', 'inv-04', key, 'tax2_amount_cents', Number(tax2), row.tax2AmountCents)
    checks.compare('C', 'inv-04', key, 'amount_cents', amount, row.amountCents)
    checks.compare('C', 'inv-04', key, 'due_amount_cents', due, row.dueAmountCents)
    if (row.state !== 'closed') {
      const expectedPaid = row.dueAmountCents <= 0 && row.paymentCount > 0 ? 1 : 0
      checks.compare('C', 'inv-05', key, 'paid_state', expectedPaid, row.state === 'paid' ? 1 : 0)
    }
  }
}

const previousDate = (value: string): string => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`rate start_date is not canonical: ${value}`)
  }
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

const rateChainChecks = (checks: Checks, database: BetterSqlite3.Database): void => {
  for (const table of ['user_billable_rates', 'user_cost_rates'] as const) {
    const rows = database
      .prepare(
        `SELECT rate.harvest_id AS harvestId, user.harvest_id AS userId,
          rate.start_date AS startDate, rate.end_date AS endDate
         FROM ${table} rate JOIN users user ON user.id = rate.user_id
         WHERE rate.harvest_id IS NOT NULL
         ORDER BY user.harvest_id, rate.start_date IS NOT NULL, rate.start_date, rate.harvest_id`,
      )
      .all() as Array<{
      harvestId: number
      userId: number
      startDate: string | null
      endDate: string | null
    }>
    for (const [index, row] of rows.entries()) {
      const next = rows[index + 1]
      const expected =
        next !== undefined && next.userId === row.userId && next.startDate !== null
          ? previousDate(next.startDate)
          : null
      checks.compare('C', 'inv-08', `${table}:${row.harvestId}`, 'end_date', expected, row.endDate)
    }
  }
}

const databaseUninvoiced = (
  database: BetterSqlite3.Database,
  range: { from: string; to: string },
): Map<string, UninvoicedAggregate> => {
  const values = new Map<string, UninvoicedAggregate>()
  const timeRows = database
    .prepare(
      `SELECT project.harvest_id AS projectId,
        upper(coalesce(project.billing_currency, client.currency)) AS currency,
        project.billing_method AS billingMethod, entry.rounded_seconds AS roundedSeconds,
        entry.billable AS billable, entry.invoice_id AS invoiceId,
        entry.billable_rate_cents AS billableRateCents
       FROM time_entries entry JOIN projects project ON project.id = entry.project_id
       JOIN clients client ON client.id = project.client_id
       WHERE entry.harvest_id IS NOT NULL AND project.billing_method <> 'non_billable'
         AND project.is_active = 1
         AND entry.spent_date BETWEEN ? AND ?
       ORDER BY project.harvest_id, entry.id`,
    )
    .all(range.from, range.to) as Array<{
    projectId: number
    currency: string
    billingMethod: string
    roundedSeconds: number
    billable: number
    invoiceId: number | null
    billableRateCents: number | null
  }>
  for (const row of timeRows) {
    const value = getOrCreate(values, groupKey(row.projectId, row.currency), uninvoicedAggregate)
    value.totalSeconds = add(value.totalSeconds, row.roundedSeconds, 'database total seconds')
    value.fixedFee ||= row.billingMethod === 'fixed_fee'
    if (row.invoiceId === null && row.billable === 1) {
      value.uninvoicedSeconds = add(
        value.uninvoicedSeconds,
        row.roundedSeconds,
        'database uninvoiced seconds',
      )
      if (row.billableRateCents !== null && row.billingMethod !== 'fixed_fee') {
        value.uninvoicedAmountCents = add(
          value.uninvoicedAmountCents,
          trackedAmountCents(row.roundedSeconds, row.billableRateCents),
          'database uninvoiced amount',
        )
      }
    }
  }
  const expenseRows = database
    .prepare(
      `SELECT project.harvest_id AS projectId,
        upper(coalesce(project.billing_currency, client.currency)) AS currency,
        project.billing_method AS billingMethod, expense.total_cost_cents AS cents
       FROM expenses expense JOIN projects project ON project.id = expense.project_id
       JOIN clients client ON client.id = project.client_id
       WHERE expense.harvest_id IS NOT NULL AND project.billing_method <> 'non_billable'
         AND project.is_active = 1
         AND expense.invoice_id IS NULL
         AND expense.billable = 1 AND expense.spent_date BETWEEN ? AND ?
       ORDER BY project.harvest_id, expense.id`,
    )
    .all(range.from, range.to) as Array<{
    projectId: number
    currency: string
    billingMethod: string
    cents: number
  }>
  for (const row of expenseRows) {
    const value = getOrCreate(values, groupKey(row.projectId, row.currency), uninvoicedAggregate)
    value.uninvoicedExpenseCents = add(
      value.uninvoicedExpenseCents,
      row.cents,
      'database uninvoiced expenses',
    )
    if (row.billingMethod === 'time_materials') {
      value.uninvoicedAmountCents = add(
        value.uninvoicedAmountCents,
        row.cents,
        'database uninvoiced amount',
      )
    }
  }
  const fixedProjects = database
    .prepare(
      `SELECT project.harvest_id AS projectId,
        upper(coalesce(project.billing_currency, client.currency)) AS currency,
        project.fee_cents AS feeCents, project.starts_on AS startsOn,
        substr(project.created_at, 1, 10) AS createdOn,
        coalesce((SELECT sum(line.amount_cents)
          FROM invoice_line_items line JOIN invoices invoice ON invoice.id = line.invoice_id
          WHERE line.project_id = project.id AND invoice.harvest_id IS NOT NULL
            AND upper(invoice.currency) = upper(coalesce(project.billing_currency, client.currency))), 0) AS invoicedCents
       FROM projects project JOIN clients client ON client.id = project.client_id
       WHERE project.harvest_id IS NOT NULL AND project.billing_method = 'fixed_fee'
         AND project.is_active = 1
       ORDER BY project.harvest_id`,
    )
    .all() as Array<{
    projectId: number
    currency: string
    feeCents: number | null
    startsOn: string | null
    createdOn: string
    invoicedCents: number
  }>
  for (const row of fixedProjects) {
    const value = getOrCreate(values, groupKey(row.projectId, row.currency), uninvoicedAggregate)
    const anchor = row.startsOn ?? row.createdOn
    const fixedFeeAmount =
      range.to < anchor
        ? 0
        : add(row.feeCents ?? 0, -row.invoicedCents, 'database fixed-fee uninvoiced amount')
    value.uninvoicedAmountCents = add(
      value.uninvoicedAmountCents,
      fixedFeeAmount,
      'database fixed-fee uninvoiced plus expenses',
    )
  }
  return values
}

const snapshotUninvoicedChecks = (
  checks: Checks,
  source: SourceState,
  database: BetterSqlite3.Database,
): void => {
  const loaded = databaseUninvoiced(database, source.uninvoicedRange)
  for (const key of new Set([...source.uninvoiced.keys(), ...loaded.keys()])) {
    const expected = source.uninvoiced.get(key) ?? uninvoicedAggregate()
    const actual = loaded.get(key) ?? uninvoicedAggregate()
    checks.compare(
      'B',
      'snapshot_uninvoiced_parity',
      key,
      'rounded_seconds',
      expected.uninvoicedSeconds,
      actual.uninvoicedSeconds,
    )
    checks.compare(
      'B',
      'snapshot_uninvoiced_parity',
      key,
      'expense_cents',
      expected.uninvoicedExpenseCents,
      actual.uninvoicedExpenseCents,
    )
    checks.compare(
      'B',
      'snapshot_uninvoiced_parity',
      key,
      'total_cents',
      expected.uninvoicedAmountCents,
      actual.uninvoicedAmountCents,
    )
    checks.compare(
      'B',
      'snapshot_uninvoiced_parity',
      key,
      'unpriced_time_rows',
      expected.unpricedTime,
      actual.unpricedTime,
    )
  }
}

const integrityChecks = (checks: Checks, database: BetterSqlite3.Database): void => {
  const integrity = database.pragma('integrity_check', { simple: true }) as string
  checks.compare('C', 'sqlite_integrity', 'database', 'result', 'ok', integrity)
  const foreignKeys = database.pragma('foreign_key_check') as unknown[]
  checks.compare('C', 'foreign_key_integrity', 'database', 'violations', 0, foreignKeys.length)
}

const loadAnomalyChecks = (
  checks: Checks,
  database: BetterSqlite3.Database,
  snapshotSha256: string,
  source: SourceState,
): void => {
  const rows = database
    .prepare(
      `SELECT resource, source_id AS sourceId, kind, detail
       FROM _ezacto_load_anomalies WHERE snapshot_sha256 = ?
       ORDER BY resource, source_id, kind, detail`,
    )
    .all(snapshotSha256) as Array<{
    resource: string
    sourceId: string | null
    kind: string
    detail: string
  }>
  const observedRounding = new Set<string>()
  for (const row of rows) {
    const key = `${row.resource}:${row.sourceId ?? 'none'}:${row.kind}:${row.detail}`
    const exactRounding = row.kind === 'hours_residue' && source.roundingAnomalies.has(key)
    if (exactRounding) observedRounding.add(key)
    const citation = ACCEPTED_ANOMALY_CITATIONS[row.kind]
    const noteKey = `${row.resource}:${row.sourceId ?? 'none'}:${row.kind}`
    if (!exactRounding && citation !== undefined) {
      checks.note('B', 'load_anomaly', noteKey, 'gap', row.detail, citation)
      continue
    }
    checks.note(
      'B',
      'load_anomaly',
      noteKey,
      exactRounding ? 'rounding' : 'UNEXPLAINED',
      row.detail,
    )
  }
  for (const expected of source.roundingAnomalies) {
    if (!observedRounding.has(expected)) {
      checks.note(
        'B',
        'load_anomaly',
        expected,
        'UNEXPLAINED',
        'expected lossless hours-conversion residue is missing from load evidence',
      )
    }
  }
}

const canonicalDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const canonicalUtcTimestamp = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return false
  const canonical = parsed.toISOString()
  return value === canonical || value === canonical.replace('.000Z', 'Z')
}

const validateReportPeriods = (periods: ChecksumReport['periods']): void => {
  if (periods.length === 0) throw new Error('checksums.json has no verified report periods')
  for (const [index, period] of periods.entries()) {
    if (
      !Number.isInteger(period.year) ||
      !canonicalDate(period.from) ||
      !canonicalDate(period.to) ||
      period.from.slice(0, 4) !== String(period.year) ||
      period.to.slice(0, 4) !== String(period.year) ||
      period.from > period.to
    ) {
      throw new Error(`checksums.json report period ${index} is not canonical`)
    }
    const previous = periods[index - 1]
    if (previous !== undefined && period.year !== previous.year + 1) {
      throw new Error('checksums.json report periods are not unique and contiguous')
    }
    if (index > 0 && period.from !== `${period.year}-01-01`) {
      throw new Error(`checksums.json report period ${period.year} does not start on January 1`)
    }
    if (index < periods.length - 1 && period.to !== `${period.year}-12-31`) {
      throw new Error(`checksums.json report period ${period.year} does not end on December 31`)
    }
  }
}

const manifestCoverageChecks = (checks: Checks, manifest: Manifest): void => {
  for (const [resource, progress] of Object.entries(manifest.resources)) {
    if (progress.incremental && progress.staged_total_entries !== null) {
      checks.compare(
        'A',
        'extract_coverage',
        resource,
        'changed_rows',
        progress.staged_total_entries,
        progress.staged_count,
      )
    } else if (!progress.incremental && progress.total_entries !== null) {
      checks.compare(
        'A',
        'extract_coverage',
        resource,
        'rows',
        progress.total_entries,
        progress.count,
      )
    }
    if (progress.missing_parents > 0) {
      checks.note(
        'A',
        'extract_coverage',
        resource,
        'UNEXPLAINED',
        `${progress.missing_parents} parent resources vanished during extraction`,
      )
    }
  }
}

const readChecksums = async (snapshotDir: string): Promise<ChecksumReport> => {
  const raw = await readFile(join(snapshotDir, 'checksums.json'), 'utf8')
  const value = JSON.parse(raw) as Partial<ChecksumReport>
  const { report_sha256: reportSha256, ...payload } = value
  if (
    typeof reportSha256 !== 'string' ||
    checksumReportDigest(payload as ChecksumReportPayload) !== reportSha256
  ) {
    throw new Error('checksums.json report evidence failed its content digest')
  }
  if (
    value.version !== 1 ||
    typeof value.account_id !== 'string' ||
    typeof value.snapshot_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.snapshot_sha256) ||
    !canonicalUtcTimestamp(value.generated_at) ||
    !Array.isArray(value.periods) ||
    typeof value.reports !== 'object' ||
    value.reports === null ||
    !Number.isSafeInteger(value.requests) ||
    (value.requests ?? -1) < 0
  ) {
    throw new Error('checksums.json is not valid reconciliation evidence')
  }
  if (
    Object.values(value.reports).some(
      (rows) =>
        !Array.isArray(rows) ||
        rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row)),
    )
  ) {
    throw new Error('checksums.json contains an invalid report row collection')
  }
  validateReportPeriods(value.periods as ChecksumReport['periods'])
  const periods = value.periods as ChecksumReport['periods']
  const range = value.report_ranges?.uninvoiced
  const expectedRange = uninvoicedReportRange(periods)
  if (
    range === undefined ||
    !canonicalDate(range.from) ||
    !canonicalDate(range.to) ||
    range.from > range.to ||
    range.from !== expectedRange.from ||
    range.to !== expectedRange.to
  ) {
    throw new Error('checksums.json uninvoiced report range is not the canonical current period')
  }
  return value as ChecksumReport
}

const renderMarkdown = (report: ReconciliationReport): string => {
  const lines = [
    '# Reconciliation report',
    '',
    `Snapshot: \`${report.snapshot_sha256}\``,
    '',
    `Result: **${report.summary.complete ? 'PASS' : 'FAIL'}** — ${report.summary.unexplained} UNEXPLAINED delta(s).`,
    '',
    `Matches: ${report.summary.matches} · Rounding: ${report.summary.rounding} · Gaps: ${report.summary.gaps}`,
    '',
  ]
  const section = (title: string, rows: readonly ReconciliationCheck[]): void => {
    lines.push(`## ${title}`, '')
    if (rows.length === 0) {
      lines.push('None.', '')
      return
    }
    for (const row of rows) {
      const citation =
        row.gap_citation === undefined
          ? ''
          : ` — gap \`${row.gap_citation.id}\` (${row.gap_citation.reference})`
      const detail = row.detail === null ? '' : ` — ${row.detail}`
      lines.push(
        `- [${row.section}] \`${row.check}\` \`${row.key}\` ${row.metric}: expected \`${String(row.expected)}\`, actual \`${String(row.actual)}\`${citation}${detail}`,
      )
    }
    lines.push('')
  }
  section('Rounding', report.rounding)
  section('Gaps', report.gaps)
  section('UNEXPLAINED', report.unexplained)
  return `${lines.join('\n')}\n`
}

const atomicWrite = async (path: string, content: string): Promise<void> => {
  const temporary = `${path}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

const invalidatePublishedReport = async (jsonPath: string, markdownPath: string): Promise<void> => {
  const json = `${JSON.stringify({ version: 1, status: 'incomplete' }, null, 2)}\n`
  const markdown = '# Reconciliation report\n\nResult: **INCOMPLETE**.\n'
  await atomicWrite(jsonPath, json)
  await atomicWrite(markdownPath, markdown)
}

const buildReport = (checks: Checks, checksum: ChecksumReport): ReconciliationReport => {
  const matching = checks.rows.filter((row) => row.classification === 'match').sort(checkOrder)
  const rounding = checks.rows.filter((row) => row.classification === 'rounding').sort(checkOrder)
  const gaps = checks.rows.filter((row) => row.classification === 'gap').sort(checkOrder)
  const unexplained = checks.rows
    .filter((row) => row.classification === 'UNEXPLAINED')
    .sort(checkOrder)
  return {
    version: 1,
    snapshot_sha256: checksum.snapshot_sha256,
    source_report_sha256: checksum.report_sha256,
    generated_at: checksum.generated_at,
    summary: {
      complete: unexplained.length === 0,
      matches: matching.length,
      rounding: rounding.length,
      gaps: gaps.length,
      unexplained: unexplained.length,
    },
    matches: matching,
    rounding,
    gaps,
    unexplained,
  }
}

export const reconciliationExitCode = (report: ReconciliationReport): 0 | 1 =>
  report.summary.unexplained === 0 ? 0 : 1

export const runReconcile = async (options: RunReconcileOptions): Promise<RunReconcileResult> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'reconcile')
  const jsonPath = join(options.snapshotDir, 'reconciliation-report.json')
  const markdownPath = join(options.snapshotDir, 'reconciliation-report.md')
  try {
    await invalidatePublishedReport(jsonPath, markdownPath)
    const [manifest, checksum] = await Promise.all([
      readManifest(options.snapshotDir),
      readChecksums(options.snapshotDir),
    ])
    const manifestSha256 = createHash('sha256')
      .update(await readFile(join(options.snapshotDir, 'manifest.json')))
      .digest('hex')
    if (manifest.account.id !== checksum.account_id) {
      throw new Error('checksums.json belongs to a different Harvest account')
    }
    if ((await snapshotDigest(options.snapshotDir, manifest)) !== checksum.snapshot_sha256) {
      throw new Error('snapshot bytes changed after checksums.json was written')
    }
    const source = await sourceState(options.snapshotDir, checksum)
    const checks = new Checks()
    manifestCoverageChecks(checks, manifest)
    timeReportChecks(checks, source, checksum)
    expenseReportChecks(checks, source, checksum)
    uninvoicedReportChecks(checks, source, checksum)
    projectBudgetChecks(checks, source, checksum)

    await staleLoadChecks(checks, options.snapshotDir, options.databasePath)

    const database = new BetterSqlite3(options.databasePath, {
      readonly: true,
      fileMustExist: true,
    })
    let databaseTransaction = false
    try {
      database.exec('BEGIN')
      databaseTransaction = true
      databasePreflight(checks, database, manifest, checksum, manifestSha256)
      monthlyChecks(checks, source, database)
      currencyFidelityChecks(checks, source, database)
      invoiceSourceChecks(checks, source, database)
      stubChecks(checks, source, database)
      integrityChecks(checks, database)
      internalInvoiceChecks(checks, database)
      rateChainChecks(checks, database)
      snapshotUninvoicedChecks(checks, source, database)
      loadAnomalyChecks(checks, database, checksum.snapshot_sha256, source)
      database.exec('COMMIT')
      databaseTransaction = false
    } finally {
      if (databaseTransaction) database.exec('ROLLBACK')
      database.close()
    }

    const report = buildReport(checks, checksum)
    const json = `${JSON.stringify(report, null, 2)}\n`
    const markdown = renderMarkdown(report)
    await atomicWrite(markdownPath, markdown)
    await atomicWrite(jsonPath, json)
    return { report, jsonPath, markdownPath }
  } finally {
    await releaseSnapshotLock(lock)
  }
}
