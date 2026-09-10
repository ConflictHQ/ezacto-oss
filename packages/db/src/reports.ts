import {
  trackedAmountCents,
  uninvoicedGenerationPreview,
  type UninvoicedCurrencyTotal,
  type UserProfile,
} from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface ReportDateRange {
  from: string
  to: string
}

export interface UninvoicedReportFilter extends ReportDateRange {
  clientId?: number
  projectId?: number
}

export interface UninvoicedReportRecord extends ReportDateRange {
  clientId: number | null
  projectId: number | null
  totals: readonly UninvoicedCurrencyTotal[]
}

export interface ClientRollupCurrencyRecord {
  currency: string
  expenseCents: number
  uninvoicedTimeCents: number
  uninvoicedExpenseCents: number
  uninvoicedTotalCents: number
  moneyBudgetCents: number
  costCents: number
}

export interface ClientRollupMetricsRecord {
  timeEntryCount: number
  expenseCount: number
  roundedSeconds: number
  billableSeconds: number
  budgetedSeconds: number
  timeBudgetSeconds: number
  unpricedBillableEntryCount: number
  unpricedCostEntryCount: number
  currencies: readonly ClientRollupCurrencyRecord[]
}

export interface ClientRollupNodeRecord {
  clientId: number
  name: string
  parentClientId: number | null
  depth: number
  nodeBudgetCents: number | null
  budgetBurnCents: number
  direct: ClientRollupMetricsRecord
  rollup: ClientRollupMetricsRecord
}

export interface ClientRollupReportRecord extends ReportDateRange {
  rootClientId: number
  nodes: readonly ClientRollupNodeRecord[]
}

export interface ProjectBudgetGrainRecord {
  source: 'project' | 'task_assignment' | 'user_assignment'
  sourceId: number
  unit: 'seconds' | 'cents'
  calculation: 'time' | 'billable' | 'cost'
  budgetAmount: number | null
  spentAmount: number
  remainingAmount: number | null
  unpricedEntryCount: number
}

export interface ProjectBudgetReportRecord extends ReportDateRange {
  projectId: number
  budgetBy: 'project' | 'project_cost' | 'task' | 'task_fees' | 'person' | 'none'
  expensesIncluded: boolean
  grains: readonly ProjectBudgetGrainRecord[]
}

/**
 * One project's budget consumption at project level, for the projects list.
 * The per-project report answers "where did this budget go" and returns a grain
 * per task or person; a list needs "how is this project doing" for every
 * project at once, which is a different question and a different number of
 * queries — three here, whatever the project count, rather than one call per
 * row.
 */
export interface ProjectBudgetSummaryRecord {
  projectId: number
  /**
   * The project's billing currency, or its client's where the project sets no
   * override -- resolved here rather than by the caller. A reader that has the
   * amount and not the currency has to guess, and the only guess available is
   * the account default, which is right until it is silently wrong.
   */
  currency: string
  budgetBy: 'project' | 'project_cost' | 'task' | 'task_fees' | 'person' | 'none'
  unit: 'seconds' | 'cents' | null
  budgetAmount: number | null
  spentAmount: number
  remainingAmount: number | null
  costCents: number
  unpricedEntryCount: number
}

/**
 * One member's own tracked time, grouped by the project it was booked to.
 *
 * `userId` is a filter the caller supplies, never a field the request carries:
 * the route reads it off the authenticated principal, so no value a member can
 * edit widens the report to somebody else's hours. The other reports here
 * answer firm-wide questions and gate the *fields* they return; this one
 * answers a personal question, so the row set is the thing that has to be
 * scoped, and it is scoped in the query rather than after it.
 */
export interface MemberHoursFilter extends ReportDateRange {
  userId: number
  projectId?: number
}

/**
 * Both durations, because they answer different questions and a member reading
 * one while meaning the other is the confusion this report exists to remove.
 * `seconds` is what the week grid totals -- the number they were paging the
 * timesheet to add up -- and `roundedSeconds` is what every other report and
 * every invoice counts once the account's rounding rule has been applied. On an
 * account that does not round the two are equal; on one that does, reporting
 * only the rounded figure makes this screen disagree with the timesheet beside
 * it for no reason the reader can see.
 */
export interface MemberHoursProjectRecord {
  projectId: number
  projectName: string
  /**
   * Never null: `projects.code` is NOT NULL DEFAULT '', so a project without a
   * code carries the empty string. Typing it nullable invited a `=== null`
   * check that an empty code slips past, which renders as `[] Project name`.
   */
  projectCode: string
  clientId: number
  clientName: string
  seconds: number
  roundedSeconds: number
  /** Rounded seconds on billable entries; the remainder is internal work. */
  billableSeconds: number
  timeEntryCount: number
}

export interface MemberHoursReportRecord extends ReportDateRange {
  userId: number
  projectId: number | null
  seconds: number
  roundedSeconds: number
  billableSeconds: number
  timeEntryCount: number
  projects: readonly MemberHoursProjectRecord[]
}

/**
 * The Time report: one dataset over a period, presented four ways.
 *
 * Harvest's default report is a single population -- every time entry in the
 * range -- grouped by client, by project, by task and by teammate, with one
 * summary strip above all four. It is modelled as one record rather than four
 * endpoints because that is what makes the tabs trustworthy: the four groupings
 * are folds of the same rows, so their totals agree by construction. Four
 * separate queries would let the Projects tab and the Tasks tab disagree about
 * the same month, which is the failure #519 opens with -- two reports that look
 * comparable and are not.
 */
export interface TimeReportAmountRecord {
  /** The project's billing currency, or its client's where it sets none. */
  currency: string
  /**
   * Billable tracked time priced at the entry's own billable rate. Entries
   * whose rate never resolved contribute nothing and are counted separately --
   * see `unpricedBillableEntryCount` -- rather than being priced at zero.
   */
  billableCents: number
  /**
   * The part of `billableCents` that is not yet on an invoice, under exactly
   * the predicate the uninvoiced report uses: still billable, no invoice, an
   * active project, and no timer left running. Recomputing it here under a
   * looser rule would put two numbers in the product that both claim to be
   * "uninvoiced" and disagree -- so archived-project work counts as billable
   * and not as uninvoiced, which is the distinction Harvest draws too.
   */
  uninvoicedCents: number
}

export interface TimeReportTotalsRecord {
  /** Tracked seconds, as the week grid totals them. */
  seconds: number
  /** Rounded seconds -- what invoices and every other report count. */
  roundedSeconds: number
  /** Rounded seconds on billable entries; the remainder is internal work. */
  billableSeconds: number
  timeEntryCount: number
  /**
   * Billable entries with no resolved rate. A money column that quietly
   * omitted them would read as a smaller month rather than an incomplete one.
   */
  unpricedBillableEntryCount: number
  /** One bucket per currency touched by billable work; never summed across. */
  amounts: readonly TimeReportAmountRecord[]
}

export interface TimeReportClientRecord extends TimeReportTotalsRecord {
  clientId: number
  clientName: string
}

export interface TimeReportProjectRecord extends TimeReportTotalsRecord {
  projectId: number
  projectName: string
  /**
   * Never null: `projects.code` is NOT NULL DEFAULT '', so a project without a
   * code carries the empty string and a `=== null` check renders `[] Name`.
   */
  projectCode: string
  clientId: number
  clientName: string
}

export interface TimeReportTaskRecord extends TimeReportTotalsRecord {
  taskId: number
  taskName: string
}

export interface TimeReportTeammateRecord extends TimeReportTotalsRecord {
  userId: number
  userName: string
  /** The Employees / Contractors split the teammates tab groups on. */
  isContractor: boolean
  /**
   * The person's weekly capacity prorated across the reported days. The team
   * screen divides a week's hours by `users.weekly_capacity` directly; a report
   * period is any number of days, so the same divisor has to be scaled or the
   * utilization of a month reads as four weeks' worth. A seven-day period
   * therefore produces exactly the figure the team roster shows.
   */
  capacitySeconds: number
  /** Null where the person's capacity is zero: no rate can be stated. */
  utilizationPpm: number | null
}

export interface TimeReportRecord extends ReportDateRange {
  totals: TimeReportTotalsRecord
  clients: readonly TimeReportClientRecord[]
  projects: readonly TimeReportProjectRecord[]
  tasks: readonly TimeReportTaskRecord[]
  teammates: readonly TimeReportTeammateRecord[]
}

export interface ProjectReportViewer {
  userId: number
  profile: UserProfile
}

export interface ContractorCostRow {
  userId: number
  name: string
  /**
   * The person's primary address, offered as a *proposal* for matching them at
   * a payout provider -- never as the join itself. #421 settles that: the real
   * link is the provider's own identifier, stored when a person links their
   * account, because matching on an address is a guess whose failure mode is
   * paying the wrong person.
   *
   * Primary rather than a payroll-kind address because that column does not
   * exist yet, and the import deliberately kept the source system's address
   * primary for exactly this reason. When #280's `kind` lands this reads it
   * instead, and the meaning stops being a coincidence of another flag.
   */
  payrollEmail: string | null
  isContractor: boolean
  /**
   * The organization's currency, always. Cost rates carry no currency of their
   * own -- there is no cost_currency column and the rate resolver never mentions
   * one -- so a cost figure is an org-currency figure. Bucketing it under the
   * project's billing currency would relabel a USD number as EUR without
   * converting it, which is the one mistake a payroll export must not make.
   */
  currency: string
  roundedSeconds: number
  /** Null when any entry in the row has no cost rate -- see the note below. */
  costCents: number | null
  entriesWithoutRate: number
}

export interface ContractorCostReportRecord {
  from: string
  to: string
  rows: ContractorCostRow[]
}

export interface ReportRepository {
  contractorCost(range: Readonly<ReportDateRange>): Promise<ContractorCostReportRecord>
  timeReport(range: Readonly<ReportDateRange>): Promise<TimeReportRecord>
  memberHours(filter: Readonly<MemberHoursFilter>): Promise<MemberHoursReportRecord>
  uninvoiced(filter: Readonly<UninvoicedReportFilter>): Promise<UninvoicedReportRecord>
  clientRollup(
    clientId: number,
    range: Readonly<ReportDateRange>,
  ): Promise<ClientRollupReportRecord | null>
  projectBudgetSummaries(
    range: Readonly<ReportDateRange>,
    viewer: Readonly<ProjectReportViewer>,
  ): Promise<readonly ProjectBudgetSummaryRecord[]>
  projectBudget(
    projectId: number,
    range: Readonly<ReportDateRange>,
    viewer: Readonly<ProjectReportViewer>,
  ): Promise<ProjectBudgetReportRecord | null>
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/

const assertDate = (value: string, field: string): void => {
  const match = datePattern.exec(value)
  if (match === null) throw new RangeError(`${field} must be a canonical date`)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a real calendar date`)
  }
}

const assertRange = (range: Readonly<ReportDateRange>): void => {
  assertDate(range.from, 'report from')
  assertDate(range.to, 'report to')
  if (range.from > range.to) throw new RangeError('report date range is inverted')
}

const assertId = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const checkedAdd = (left: number, right: number, field: string): number => {
  const sum = BigInt(left) + BigInt(right)
  if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds the supported aggregate range`)
  }
  return Number(sum)
}

export interface UninvoicedTimeCandidateRow {
  id: number
  clientId: number
  projectId: number
  projectName: string
  taskId: number
  taskName: string
  userId: number
  userName: string
  spentDate: string
  notes: string | null
  currency: string
  roundedSeconds: number
  billableRateCents: number | null
  updatedAt: string
}

export interface UninvoicedExpenseCandidateRow {
  id: number
  clientId: number
  projectId: number
  projectName: string
  categoryId: number
  categoryName: string
  userId: number
  userName: string
  spentDate: string
  notes: string | null
  units: number | null
  currency: string
  totalCostCents: number
  updatedAt: string
}

export interface UninvoicedCandidateFilter extends UninvoicedReportFilter {
  projectIds?: readonly number[]
}

const projectFilter = (filter: Readonly<UninvoicedCandidateFilter>) => {
  if (filter.projectId !== undefined) return sql`project.id = ${filter.projectId}`
  if (filter.projectIds === undefined) return sql`1`
  return sql`project.id IN (
    SELECT CAST(value AS INTEGER) FROM json_each(${JSON.stringify(filter.projectIds)})
  )`
}

const clientFilter = (clientId: number | undefined) =>
  clientId === undefined
    ? sql`1`
    : sql`project.client_id IN (
        WITH RECURSIVE descendants(id, visited) AS (
          SELECT id, printf(',%d,', id) FROM clients WHERE id = ${clientId}
          UNION ALL
          SELECT child.id, descendants.visited || child.id || ','
          FROM descendants
          JOIN clients child ON child.parent_client_id = descendants.id
          WHERE instr(descendants.visited, printf(',%d,', child.id)) = 0
        )
        SELECT id FROM descendants
      )`

/**
 * Harvest's uninvoiced report covers active projects only, so an archived
 * project's unbilled work is neither reported nor offered to generation.
 * Including it overstated the receivables pipeline with work Harvest itself
 * will not invoice.
 */
export const readUninvoicedCandidates = async (
  database: Database,
  filter: Readonly<UninvoicedCandidateFilter>,
): Promise<{
  timeEntries: readonly UninvoicedTimeCandidateRow[]
  expenses: readonly UninvoicedExpenseCandidateRow[]
}> => {
  assertRange(filter)
  if (filter.clientId !== undefined) assertId(filter.clientId, 'client id')
  if (filter.projectId !== undefined) assertId(filter.projectId, 'project id')
  if (filter.projectId !== undefined && filter.projectIds !== undefined) {
    throw new RangeError('project id and project ids cannot both be supplied')
  }
  if (filter.projectIds !== undefined) {
    if (
      filter.projectIds.length === 0 ||
      filter.projectIds.some((projectId) => !Number.isSafeInteger(projectId) || projectId < 1) ||
      new Set(filter.projectIds).size !== filter.projectIds.length
    ) {
      throw new RangeError('project ids must be a non-empty unique positive integer list')
    }
  }
  const projectWhere = projectFilter(filter)
  const clientWhere = clientFilter(filter.clientId)
  const timeEntries = await database.all<UninvoicedTimeCandidateRow>(sql`
    SELECT entry.id AS "id", project.client_id AS "clientId",
      project.id AS "projectId", project.name AS "projectName",
      task.id AS "taskId", task.name AS "taskName", user.id AS "userId",
      trim(user.first_name || ' ' || coalesce(user.last_name, '')) AS "userName",
      entry.spent_date AS "spentDate", entry.notes AS "notes",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency",
      entry.rounded_seconds AS "roundedSeconds",
      entry.billable_rate_cents AS "billableRateCents", entry.updated_at AS "updatedAt"
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    JOIN tasks task ON task.id = entry.task_id
    JOIN users user ON user.id = entry.user_id
    WHERE entry.spent_date BETWEEN ${filter.from} AND ${filter.to}
      AND entry.billable = 1 AND entry.invoice_id IS NULL AND project.is_active = 1
      AND entry.timer_started_at IS NULL
      AND NOT (entry.started_time IS NOT NULL AND entry.ended_time IS NULL)
      AND ${projectWhere} AND ${clientWhere}
    ORDER BY entry.id
  `)
  const expenses = await database.all<UninvoicedExpenseCandidateRow>(sql`
    SELECT expense.id AS "id", project.client_id AS "clientId",
      project.id AS "projectId", project.name AS "projectName",
      category.id AS "categoryId", category.name AS "categoryName",
      user.id AS "userId",
      trim(user.first_name || ' ' || coalesce(user.last_name, '')) AS "userName",
      expense.spent_date AS "spentDate", expense.notes AS "notes", expense.units AS "units",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency",
      expense.total_cost_cents AS "totalCostCents", expense.updated_at AS "updatedAt"
    FROM expenses expense
    JOIN projects project ON project.id = expense.project_id
    JOIN clients client ON client.id = project.client_id
    JOIN expense_categories category ON category.id = expense.expense_category_id
    JOIN users user ON user.id = expense.user_id
    WHERE expense.spent_date BETWEEN ${filter.from} AND ${filter.to}
      AND expense.billable = 1 AND expense.invoice_id IS NULL AND project.is_active = 1
      AND ${projectWhere} AND ${clientWhere}
    ORDER BY expense.id
  `)
  return { timeEntries, expenses }
}

const uninvoicedReport = async (
  database: Database,
  filter: Readonly<UninvoicedReportFilter>,
): Promise<UninvoicedReportRecord> => {
  assertRange(filter)
  if (filter.clientId !== undefined) assertId(filter.clientId, 'client id')
  if (filter.projectId !== undefined) assertId(filter.projectId, 'project id')
  const candidates = await readUninvoicedCandidates(database, filter)
  return {
    from: filter.from,
    to: filter.to,
    clientId: filter.clientId ?? null,
    projectId: filter.projectId ?? null,
    totals: uninvoicedGenerationPreview(candidates),
  }
}

interface ClientNodeRow {
  clientId: number
  name: string
  parentClientId: number | null
  depth: number
  budgetCents: number | null
}

interface RollupTimeRow {
  id: number
  clientId: number
  projectActive: number
  currency: string
  roundedSeconds: number
  billable: number
  budgeted: number
  invoiceId: number | null
  timerStartedAt: string | null
  startedTime: string | null
  endedTime: string | null
  billableRateCents: number | null
  costRateCents: number | null
}

interface RollupExpenseRow {
  id: number
  clientId: number
  projectActive: number
  currency: string
  totalCostCents: number
  billable: number
  invoiceId: number | null
}

interface RollupProjectRow {
  id: number
  clientId: number
  currency: string
  budgetBy: ProjectBudgetReportRecord['budgetBy']
  budgetSeconds: number | null
  costBudgetCents: number | null
}

interface AssignmentBudgetRow {
  projectId: number
  sourceId: number
  amount: number | null
}

type MutableCurrencyRecord = ClientRollupCurrencyRecord

interface MutableMetrics extends Omit<ClientRollupMetricsRecord, 'currencies'> {
  currencyMap: Map<string, MutableCurrencyRecord>
}

const emptyMetrics = (): MutableMetrics => ({
  timeEntryCount: 0,
  expenseCount: 0,
  roundedSeconds: 0,
  billableSeconds: 0,
  budgetedSeconds: 0,
  timeBudgetSeconds: 0,
  unpricedBillableEntryCount: 0,
  unpricedCostEntryCount: 0,
  currencyMap: new Map(),
})

const currencyMetric = (metrics: MutableMetrics, currency: string): MutableCurrencyRecord => {
  const code = currency.toUpperCase()
  let value = metrics.currencyMap.get(code)
  if (value === undefined) {
    value = {
      currency: code,
      expenseCents: 0,
      uninvoicedTimeCents: 0,
      uninvoicedExpenseCents: 0,
      uninvoicedTotalCents: 0,
      moneyBudgetCents: 0,
      costCents: 0,
    }
    metrics.currencyMap.set(code, value)
  }
  return value
}

const addMetric = (
  target: MutableMetrics,
  field: Exclude<keyof MutableMetrics, 'currencyMap'>,
  amount: number,
): void => {
  target[field] = checkedAdd(target[field], amount, field)
}

const addCurrencyMetric = (
  target: MutableMetrics,
  currency: string,
  field: Exclude<keyof MutableCurrencyRecord, 'currency'>,
  amount: number,
): void => {
  const record = currencyMetric(target, currency)
  record[field] = checkedAdd(record[field], amount, field)
}

const mergeMetrics = (target: MutableMetrics, source: MutableMetrics): void => {
  for (const field of [
    'timeEntryCount',
    'expenseCount',
    'roundedSeconds',
    'billableSeconds',
    'budgetedSeconds',
    'timeBudgetSeconds',
    'unpricedBillableEntryCount',
    'unpricedCostEntryCount',
  ] as const) {
    addMetric(target, field, source[field])
  }
  for (const sourceCurrency of source.currencyMap.values()) {
    for (const field of [
      'expenseCents',
      'uninvoicedTimeCents',
      'uninvoicedExpenseCents',
      'uninvoicedTotalCents',
      'moneyBudgetCents',
      'costCents',
    ] as const) {
      addCurrencyMetric(target, sourceCurrency.currency, field, sourceCurrency[field])
    }
  }
}

const finalizedMetrics = (metrics: MutableMetrics): ClientRollupMetricsRecord => ({
  timeEntryCount: metrics.timeEntryCount,
  expenseCount: metrics.expenseCount,
  roundedSeconds: metrics.roundedSeconds,
  billableSeconds: metrics.billableSeconds,
  budgetedSeconds: metrics.budgetedSeconds,
  timeBudgetSeconds: metrics.timeBudgetSeconds,
  unpricedBillableEntryCount: metrics.unpricedBillableEntryCount,
  unpricedCostEntryCount: metrics.unpricedCostEntryCount,
  currencies: [...metrics.currencyMap.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  ),
})

const clientRollupReport = async (
  database: Database,
  rootClientId: number,
  range: Readonly<ReportDateRange>,
): Promise<ClientRollupReportRecord | null> => {
  assertId(rootClientId, 'client id')
  assertRange(range)
  const nodes = await database.all<ClientNodeRow>(sql`
    WITH RECURSIVE subtree(id, name, parent_client_id, budget_cents, depth, visited) AS (
      SELECT id, name, parent_client_id, budget_cents, 0, printf(',%d,', id)
      FROM clients WHERE id = ${rootClientId}
      UNION ALL
      SELECT child.id, child.name, child.parent_client_id, child.budget_cents,
        subtree.depth + 1, subtree.visited || child.id || ','
      FROM subtree
      JOIN clients child ON child.parent_client_id = subtree.id
      WHERE instr(subtree.visited, printf(',%d,', child.id)) = 0
    )
    SELECT id AS "clientId", name AS "name", parent_client_id AS "parentClientId",
      budget_cents AS "budgetCents", depth AS "depth"
    FROM subtree ORDER BY depth, id
  `)
  if (nodes.length === 0) return null

  const subtree = sql`project.client_id IN (
    WITH RECURSIVE descendants(id, visited) AS (
      SELECT id, printf(',%d,', id) FROM clients WHERE id = ${rootClientId}
      UNION ALL
      SELECT child.id, descendants.visited || child.id || ','
      FROM descendants JOIN clients child ON child.parent_client_id = descendants.id
      WHERE instr(descendants.visited, printf(',%d,', child.id)) = 0
    ) SELECT id FROM descendants
  )`
  const [timeRows, expenseRows, projectRows, organizationRows] = await Promise.all([
    database.all<RollupTimeRow>(sql`
      SELECT entry.id AS "id", project.client_id AS "clientId",
        project.is_active AS "projectActive",
        upper(coalesce(project.billing_currency, client.currency)) AS "currency",
        entry.rounded_seconds AS "roundedSeconds", entry.billable AS "billable",
        entry.budgeted AS "budgeted", entry.invoice_id AS "invoiceId",
        entry.timer_started_at AS "timerStartedAt", entry.started_time AS "startedTime",
        entry.ended_time AS "endedTime", entry.billable_rate_cents AS "billableRateCents",
        entry.cost_rate_cents AS "costRateCents"
      FROM time_entries entry
      JOIN projects project ON project.id = entry.project_id
      JOIN clients client ON client.id = project.client_id
      WHERE entry.spent_date BETWEEN ${range.from} AND ${range.to} AND ${subtree}
      ORDER BY entry.id
    `),
    database.all<RollupExpenseRow>(sql`
      SELECT expense.id AS "id", project.client_id AS "clientId",
        project.is_active AS "projectActive",
        upper(coalesce(project.billing_currency, client.currency)) AS "currency",
        expense.total_cost_cents AS "totalCostCents", expense.billable AS "billable",
        expense.invoice_id AS "invoiceId"
      FROM expenses expense
      JOIN projects project ON project.id = expense.project_id
      JOIN clients client ON client.id = project.client_id
      WHERE expense.spent_date BETWEEN ${range.from} AND ${range.to} AND ${subtree}
      ORDER BY expense.id
    `),
    database.all<RollupProjectRow>(sql`
      SELECT project.id AS "id", project.client_id AS "clientId",
        upper(coalesce(project.billing_currency, client.currency)) AS "currency",
        project.budget_by AS "budgetBy", project.budget_seconds AS "budgetSeconds",
        project.cost_budget_cents AS "costBudgetCents"
      FROM projects project JOIN clients client ON client.id = project.client_id
      WHERE ${subtree} ORDER BY project.id
    `),
    database.all<{ currency: string }>(sql`
      SELECT upper(currency) AS "currency" FROM organizations WHERE id = 1
    `),
  ])
  const organizationCurrency = organizationRows[0]?.currency
  if (organizationCurrency === undefined) {
    throw new Error('organization must exist before reports are read')
  }

  const projectIds = new Set(projectRows.map(({ id }) => id))
  const [taskBudgets, userBudgets] = await Promise.all([
    database.all<AssignmentBudgetRow>(sql`
      SELECT assignment.project_id AS "projectId", assignment.id AS "sourceId",
        CASE WHEN project.budget_by = 'task' THEN assignment.budget_seconds
          WHEN project.budget_by = 'task_fees' THEN assignment.budget_cents ELSE NULL END AS "amount"
      FROM task_assignments assignment
      JOIN projects project ON project.id = assignment.project_id
      WHERE ${subtree}
      ORDER BY assignment.id
    `),
    database.all<AssignmentBudgetRow>(sql`
      SELECT assignment.project_id AS "projectId", assignment.id AS "sourceId",
        assignment.budget_seconds AS "amount"
      FROM user_assignments assignment
      JOIN projects project ON project.id = assignment.project_id
      WHERE project.budget_by = 'person' AND ${subtree}
      ORDER BY assignment.id
    `),
  ])
  const direct = new Map(nodes.map(({ clientId }) => [clientId, emptyMetrics()]))
  const projectById = new Map(projectRows.map((project) => [project.id, project]))

  for (const row of timeRows) {
    const metrics = direct.get(row.clientId)!
    addMetric(metrics, 'timeEntryCount', 1)
    addMetric(metrics, 'roundedSeconds', row.roundedSeconds)
    if (row.billable === 1) addMetric(metrics, 'billableSeconds', row.roundedSeconds)
    if (row.budgeted === 1) addMetric(metrics, 'budgetedSeconds', row.roundedSeconds)
    if (row.costRateCents === null) addMetric(metrics, 'unpricedCostEntryCount', 1)
    else {
      addCurrencyMetric(
        metrics,
        // Cost rates carry no currency of their own — there is no cost_currency
        // column and rate-resolver never mentions one — so they are org-currency
        // figures. Bucketing them under the project's billing currency would
        // relabel a USD number as EUR without converting it.
        organizationCurrency,
        'costCents',
        trackedAmountCents(row.roundedSeconds, row.costRateCents),
      )
    }
    const stopped =
      row.timerStartedAt === null && !(row.startedTime !== null && row.endedTime === null)
    // Tracked and cost figures cover archived projects, because the work
    // happened; the uninvoiced columns answer the same question as the
    // uninvoiced report and carry its active-project predicate.
    if (row.projectActive === 1 && row.billable === 1 && row.invoiceId === null && stopped) {
      if (row.billableRateCents === null) {
        addMetric(metrics, 'unpricedBillableEntryCount', 1)
      } else {
        const cents = trackedAmountCents(row.roundedSeconds, row.billableRateCents)
        addCurrencyMetric(metrics, row.currency, 'uninvoicedTimeCents', cents)
        addCurrencyMetric(metrics, row.currency, 'uninvoicedTotalCents', cents)
      }
    }
  }
  for (const row of expenseRows) {
    const metrics = direct.get(row.clientId)!
    addMetric(metrics, 'expenseCount', 1)
    addCurrencyMetric(metrics, row.currency, 'expenseCents', row.totalCostCents)
    if (row.projectActive === 1 && row.billable === 1 && row.invoiceId === null) {
      addCurrencyMetric(metrics, row.currency, 'uninvoicedExpenseCents', row.totalCostCents)
      addCurrencyMetric(metrics, row.currency, 'uninvoicedTotalCents', row.totalCostCents)
    }
  }
  for (const project of projectRows) {
    const metrics = direct.get(project.clientId)!
    if (project.budgetBy === 'project' && project.budgetSeconds !== null) {
      addMetric(metrics, 'timeBudgetSeconds', project.budgetSeconds)
    }
    if (project.budgetBy === 'project_cost' && project.costBudgetCents !== null) {
      addCurrencyMetric(metrics, organizationCurrency, 'moneyBudgetCents', project.costBudgetCents)
    }
  }
  for (const budget of taskBudgets) {
    if (budget.amount === null || !projectIds.has(budget.projectId)) continue
    const project = projectById.get(budget.projectId)!
    const metrics = direct.get(project.clientId)!
    if (project.budgetBy === 'task') {
      addMetric(metrics, 'timeBudgetSeconds', budget.amount)
    } else if (project.budgetBy === 'task_fees') {
      addCurrencyMetric(metrics, project.currency, 'moneyBudgetCents', budget.amount)
    }
  }
  for (const budget of userBudgets) {
    if (budget.amount === null || !projectIds.has(budget.projectId)) continue
    const project = projectById.get(budget.projectId)!
    addMetric(direct.get(project.clientId)!, 'timeBudgetSeconds', budget.amount)
  }

  const parentById = new Map(nodes.map((node) => [node.clientId, node.parentClientId]))
  const rollup = new Map(nodes.map(({ clientId }) => [clientId, emptyMetrics()]))
  for (const [clientId, metrics] of direct) {
    let ancestor: number | null = clientId
    while (ancestor !== null && rollup.has(ancestor)) {
      mergeMetrics(rollup.get(ancestor)!, metrics)
      ancestor = parentById.get(ancestor) ?? null
    }
  }

  const budgetBurn = (metrics: MutableMetrics): number => {
    let burn = 0
    for (const currency of metrics.currencyMap.values()) {
      burn = checkedAdd(burn, currency.costCents, 'budget burn')
      burn = checkedAdd(burn, currency.expenseCents, 'budget burn')
    }
    return burn
  }

  return {
    rootClientId,
    from: range.from,
    to: range.to,
    nodes: nodes.map((node) => ({
      clientId: node.clientId,
      name: node.name,
      parentClientId: node.parentClientId,
      depth: node.depth,
      nodeBudgetCents: node.budgetCents,
      budgetBurnCents: budgetBurn(rollup.get(node.clientId)!),
      direct: finalizedMetrics(direct.get(node.clientId)!),
      rollup: finalizedMetrics(rollup.get(node.clientId)!),
    })),
  }
}

interface ProjectRow {
  id: number
  budgetBy: ProjectBudgetReportRecord['budgetBy']
  budgetSeconds: number | null
  costBudgetCents: number | null
  costBudgetIncludeExpenses: number
  currency: string
}

interface BudgetEntryRow {
  taskAssignmentId: number
  userAssignmentId: number
  roundedSeconds: number
  billableRateCents: number | null
  costRateCents: number | null
}

const remaining = (budget: number | null, spent: number): number | null =>
  budget === null ? null : checkedAdd(budget, -spent, 'remaining budget')

/**
 * Three queries, whatever the project count: the visible projects, their
 * budgeted time, and their expenses. A per-project call would be one round trip
 * per row, which is what kept these columns off the list.
 */
const projectBudgetSummaryReport = async (
  database: Database,
  range: Readonly<ReportDateRange>,
  viewer: Readonly<ProjectReportViewer>,
): Promise<readonly ProjectBudgetSummaryRecord[]> => {
  assertId(viewer.userId, 'report viewer user id')
  assertRange(range)
  const accountWide = new Set<UserProfile>([
    'accounting',
    'executive_manager',
    'administrator',
  ]).has(viewer.profile)
  // The same visibility predicate the per-project report applies, so the list
  // cannot become a way to read a budget the detail page would refuse.
  const projects = await database.all<ProjectRow>(sql`
    SELECT project.id AS "id", project.budget_by AS "budgetBy",
      project.budget_seconds AS "budgetSeconds",
      project.cost_budget_cents AS "costBudgetCents",
      project.cost_budget_include_expenses AS "costBudgetIncludeExpenses",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency"
    FROM projects project
    JOIN clients client ON client.id = project.client_id
    WHERE (
      ${accountWide ? 1 : 0} = 1 OR EXISTS (
        SELECT 1 FROM user_assignments assignment
        WHERE assignment.project_id = project.id
          AND assignment.user_id = ${viewer.userId}
          AND assignment.is_active = 1
          AND (
            project.report_visibility = 'everyone'
            OR (${viewer.profile} = 'project_manager' AND assignment.is_project_manager = 1)
          )
      )
    )
    ORDER BY id
  `)
  if (projects.length === 0) return []
  const entries = await database.all<{
    projectId: number
    roundedSeconds: number
    billableRateCents: number | null
    costRateCents: number | null
  }>(sql`
    SELECT project_id AS "projectId", rounded_seconds AS "roundedSeconds",
      billable_rate_cents AS "billableRateCents", cost_rate_cents AS "costRateCents"
    FROM time_entries
    WHERE budgeted = 1 AND spent_date BETWEEN ${range.from} AND ${range.to}
    ORDER BY id
  `)
  const expenses = await database.all<{ projectId: number; cents: number }>(sql`
    SELECT project_id AS "projectId", total_cost_cents AS "cents"
    FROM expenses WHERE spent_date BETWEEN ${range.from} AND ${range.to}
    ORDER BY id
  `)

  const seconds = new Map<number, number>()
  const costs = new Map<number, number>()
  const billable = new Map<number, number>()
  const unpriced = new Map<number, number>()
  for (const entry of entries) {
    seconds.set(
      entry.projectId,
      checkedAdd(seconds.get(entry.projectId) ?? 0, entry.roundedSeconds, 'budget seconds'),
    )
    if (entry.costRateCents === null) {
      unpriced.set(entry.projectId, (unpriced.get(entry.projectId) ?? 0) + 1)
    } else {
      costs.set(
        entry.projectId,
        checkedAdd(
          costs.get(entry.projectId) ?? 0,
          trackedAmountCents(entry.roundedSeconds, entry.costRateCents),
          'project cost',
        ),
      )
    }
    if (entry.billableRateCents !== null) {
      billable.set(
        entry.projectId,
        checkedAdd(
          billable.get(entry.projectId) ?? 0,
          trackedAmountCents(entry.roundedSeconds, entry.billableRateCents),
          'project fees',
        ),
      )
    }
  }
  const expenseCents = new Map<number, number>()
  for (const expense of expenses) {
    expenseCents.set(
      expense.projectId,
      checkedAdd(expenseCents.get(expense.projectId) ?? 0, expense.cents, 'project expenses'),
    )
  }

  return projects.map((project) => {
    const trackedSeconds = seconds.get(project.id) ?? 0
    const cost = costs.get(project.id) ?? 0
    const withExpenses =
      project.costBudgetIncludeExpenses === 1
        ? checkedAdd(cost, expenseCents.get(project.id) ?? 0, 'project cost')
        : cost
    // A project budgeted by task or person has no single project-level budget
    // to report; the figure that means something on a list is what has been
    // spent, so the budget reads null rather than a sum of parts the detail
    // page would show differently.
    const monetary = project.budgetBy === 'project_cost' || project.budgetBy === 'task_fees'
    const budgetAmount =
      project.budgetBy === 'project'
        ? project.budgetSeconds
        : project.budgetBy === 'project_cost'
          ? project.costBudgetCents
          : null
    const spentAmount =
      project.budgetBy === 'project_cost'
        ? withExpenses
        : project.budgetBy === 'task_fees'
          ? (billable.get(project.id) ?? 0)
          : trackedSeconds
    return {
      projectId: project.id,
      currency: project.currency,
      budgetBy: project.budgetBy,
      unit: project.budgetBy === 'none' ? null : monetary ? ('cents' as const) : ('seconds' as const),
      budgetAmount,
      spentAmount,
      remainingAmount: remaining(budgetAmount, spentAmount),
      costCents: withExpenses,
      unpricedEntryCount: unpriced.get(project.id) ?? 0,
    }
  })
}

const projectBudgetReport = async (
  database: Database,
  projectId: number,
  range: Readonly<ReportDateRange>,
  viewer: Readonly<ProjectReportViewer>,
): Promise<ProjectBudgetReportRecord | null> => {
  assertId(projectId, 'project id')
  assertId(viewer.userId, 'report viewer user id')
  assertRange(range)
  const accountWide = new Set<UserProfile>([
    'accounting',
    'executive_manager',
    'administrator',
  ]).has(viewer.profile)
  const projects = await database.all<ProjectRow>(sql`
    SELECT id AS "id", budget_by AS "budgetBy", budget_seconds AS "budgetSeconds",
      cost_budget_cents AS "costBudgetCents",
      cost_budget_include_expenses AS "costBudgetIncludeExpenses"
    FROM projects project WHERE id = ${projectId} AND (
      ${accountWide ? 1 : 0} = 1 OR EXISTS (
        SELECT 1 FROM user_assignments assignment
        WHERE assignment.project_id = project.id
          AND assignment.user_id = ${viewer.userId}
          AND assignment.is_active = 1
          AND (
            project.report_visibility = 'everyone'
            OR (${viewer.profile} = 'project_manager' AND assignment.is_project_manager = 1)
          )
      )
    )
  `)
  const project = projects[0]
  if (project === undefined) return null
  const entries = await database.all<BudgetEntryRow>(sql`
    SELECT task_assignment_id AS "taskAssignmentId",
      user_assignment_id AS "userAssignmentId", rounded_seconds AS "roundedSeconds",
      billable_rate_cents AS "billableRateCents", cost_rate_cents AS "costRateCents"
    FROM time_entries
    WHERE project_id = ${projectId} AND budgeted = 1
      AND spent_date BETWEEN ${range.from} AND ${range.to}
    ORDER BY id
  `)
  const grains: ProjectBudgetGrainRecord[] = []
  if (project.budgetBy === 'project') {
    const spent = entries.reduce(
      (sum, entry) => checkedAdd(sum, entry.roundedSeconds, 'budget seconds'),
      0,
    )
    grains.push({
      source: 'project',
      sourceId: project.id,
      unit: 'seconds',
      calculation: 'time',
      budgetAmount: project.budgetSeconds,
      spentAmount: spent,
      remainingAmount: remaining(project.budgetSeconds, spent),
      unpricedEntryCount: 0,
    })
  } else if (project.budgetBy === 'project_cost') {
    let spent = 0
    let unpriced = 0
    for (const entry of entries) {
      if (entry.costRateCents === null) unpriced += 1
      else {
        spent = checkedAdd(
          spent,
          trackedAmountCents(entry.roundedSeconds, entry.costRateCents),
          'project cost',
        )
      }
    }
    if (project.costBudgetIncludeExpenses === 1) {
      const expenseRows = await database.all<{ cents: number }>(sql`
        SELECT total_cost_cents AS "cents" FROM expenses
        WHERE project_id = ${projectId}
          AND spent_date BETWEEN ${range.from} AND ${range.to}
        ORDER BY id
      `)
      for (const expense of expenseRows) {
        spent = checkedAdd(spent, expense.cents, 'project cost')
      }
    }
    grains.push({
      source: 'project',
      sourceId: project.id,
      unit: 'cents',
      calculation: 'cost',
      budgetAmount: project.costBudgetCents,
      spentAmount: spent,
      remainingAmount: remaining(project.costBudgetCents, spent),
      unpricedEntryCount: unpriced,
    })
  } else if (project.budgetBy === 'task' || project.budgetBy === 'task_fees') {
    const budgets = await database.all<{ id: number; amount: number | null }>(sql`
      SELECT id AS "id",
        ${project.budgetBy === 'task' ? sql`budget_seconds` : sql`budget_cents`} AS "amount"
      FROM task_assignments WHERE project_id = ${projectId} ORDER BY id
    `)
    for (const budget of budgets) {
      const matching = entries.filter((entry) => entry.taskAssignmentId === budget.id)
      let spent = 0
      let unpriced = 0
      for (const entry of matching) {
        if (project.budgetBy === 'task') {
          spent = checkedAdd(spent, entry.roundedSeconds, 'task budget seconds')
        } else if (entry.billableRateCents === null) unpriced += 1
        else {
          spent = checkedAdd(
            spent,
            trackedAmountCents(entry.roundedSeconds, entry.billableRateCents),
            'task fee budget',
          )
        }
      }
      grains.push({
        source: 'task_assignment',
        sourceId: budget.id,
        unit: project.budgetBy === 'task' ? 'seconds' : 'cents',
        calculation: project.budgetBy === 'task' ? 'time' : 'billable',
        budgetAmount: budget.amount,
        spentAmount: spent,
        remainingAmount: remaining(budget.amount, spent),
        unpricedEntryCount: unpriced,
      })
    }
  } else if (project.budgetBy === 'person') {
    const budgets = await database.all<{ id: number; amount: number | null }>(sql`
      SELECT id AS "id", budget_seconds AS "amount"
      FROM user_assignments WHERE project_id = ${projectId} ORDER BY id
    `)
    for (const budget of budgets) {
      const spent = entries
        .filter((entry) => entry.userAssignmentId === budget.id)
        .reduce((sum, entry) => checkedAdd(sum, entry.roundedSeconds, 'person budget seconds'), 0)
      grains.push({
        source: 'user_assignment',
        sourceId: budget.id,
        unit: 'seconds',
        calculation: 'time',
        budgetAmount: budget.amount,
        spentAmount: spent,
        remainingAmount: remaining(budget.amount, spent),
        unpricedEntryCount: 0,
      })
    }
  }
  return {
    projectId,
    budgetBy: project.budgetBy,
    expensesIncluded:
      project.budgetBy === 'project_cost' && project.costBudgetIncludeExpenses === 1,
    from: range.from,
    to: range.to,
    grains,
  }
}

interface ContractorCostQueryRow {
  userId: number
  name: string
  payrollEmail: string | null
  isContractor: number
  roundedSeconds: number
  costRateCents: number | null
}

interface MemberHoursQueryRow {
  projectId: number
  projectName: string
  /**
   * Never null: `projects.code` is NOT NULL DEFAULT '', so a project without a
   * code carries the empty string. Typing it nullable invited a `=== null`
   * check that an empty code slips past, which renders as `[] Project name`.
   */
  projectCode: string
  clientId: number
  clientName: string
  seconds: number
  roundedSeconds: number
  billable: number
}

/**
 * The person is a WHERE clause, not a filter applied to a wider result. Reading
 * every entry in the range and keeping this member's afterwards would leave a
 * personal report one forgotten line away from being firm-wide, so the query
 * never touches a row that is not theirs.
 *
 * Archived projects stay in. Time booked to a project that has since closed is
 * still time this person worked, which is the opposite of the uninvoiced
 * report's rule and deliberately so: that report answers what can still be
 * billed, this one answers what was done.
 */
const memberHoursReport = async (
  database: Database,
  filter: Readonly<MemberHoursFilter>,
): Promise<MemberHoursReportRecord> => {
  assertId(filter.userId, 'report member user id')
  if (filter.projectId !== undefined) assertId(filter.projectId, 'project id')
  assertRange(filter)
  const rows = await database.all<MemberHoursQueryRow>(sql`
    SELECT project.id AS "projectId", project.name AS "projectName",
      project.code AS "projectCode", client.id AS "clientId",
      client.name AS "clientName", entry.seconds AS "seconds",
      entry.rounded_seconds AS "roundedSeconds", entry.billable AS "billable"
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    WHERE entry.user_id = ${filter.userId}
      AND entry.spent_date BETWEEN ${filter.from} AND ${filter.to}
      AND ${filter.projectId === undefined ? sql`1` : sql`entry.project_id = ${filter.projectId}`}
    ORDER BY client.name, project.name, project.id, entry.id
  `)
  const projects = new Map<number, MemberHoursProjectRecord>()
  let seconds = 0
  let roundedSeconds = 0
  let billableSeconds = 0
  for (const row of rows) {
    const existing = projects.get(row.projectId) ?? {
      projectId: row.projectId,
      projectName: row.projectName,
      projectCode: row.projectCode,
      clientId: row.clientId,
      clientName: row.clientName,
      seconds: 0,
      roundedSeconds: 0,
      billableSeconds: 0,
      timeEntryCount: 0,
    }
    existing.seconds += row.seconds
    existing.roundedSeconds += row.roundedSeconds
    if (row.billable === 1) existing.billableSeconds += row.roundedSeconds
    existing.timeEntryCount += 1
    projects.set(row.projectId, existing)
    seconds += row.seconds
    roundedSeconds += row.roundedSeconds
    if (row.billable === 1) billableSeconds += row.roundedSeconds
  }
  return {
    from: filter.from,
    to: filter.to,
    userId: filter.userId,
    projectId: filter.projectId ?? null,
    seconds,
    roundedSeconds,
    billableSeconds,
    timeEntryCount: rows.length,
    projects: [...projects.values()],
  }
}

/**
 * What each person cost over a period, for the payroll hand-off.
 *
 * Grouped per person and currency rather than per person alone: an agency
 * billing two clients in two currencies has two figures, and adding them would
 * invent an exchange rate this system does not hold.
 *
 * The cost is null rather than partial when any entry in the group has no rate.
 * A total that silently omits the unrated hours is the dangerous answer here --
 * it looks payable and underpays, and nobody reading a number can see which
 * hours it left out. `entriesWithoutRate` says how many, so the report can name
 * the gap instead of averaging over it.
 */
const contractorCostReport = async (
  database: Database,
  range: Readonly<ReportDateRange>,
): Promise<ContractorCostReportRecord> => {
  const rows = await database.all<ContractorCostQueryRow>(sql`
    SELECT person.id AS "userId",
      person.first_name || ' ' || person.last_name AS "name",
      (SELECT address FROM user_emails
        WHERE user_id = person.id AND is_primary = 1 AND invalidated_at IS NULL
        LIMIT 1) AS "payrollEmail",
      person.is_contractor AS "isContractor",
      entry.rounded_seconds AS "roundedSeconds",
      entry.cost_rate_cents AS "costRateCents"
    FROM time_entries entry
    JOIN users person ON person.id = entry.user_id
    WHERE entry.spent_date BETWEEN ${range.from} AND ${range.to}
    ORDER BY person.id, entry.id
  `)
  const organization = await database.all<{ currency: string }>(
    sql`SELECT upper(currency) AS "currency" FROM organizations WHERE id = 1`,
  )
  const currency = organization[0]?.currency
  if (currency === undefined) {
    throw new Error('organization must exist before reports are read')
  }

  const grouped = new Map<string, ContractorCostRow>()
  for (const row of rows) {
    // Per person. Not per person and project currency: the money here is
    // org-currency by construction, so splitting on a billing currency would
    // produce two rows that mean the same thing and invite adding them.
    const key = String(row.userId)
    const existing = grouped.get(key) ?? {
      userId: row.userId,
      name: row.name,
      payrollEmail: row.payrollEmail,
      isContractor: row.isContractor === 1,
      currency,
      roundedSeconds: 0,
      costCents: 0,
      entriesWithoutRate: 0,
    }
    existing.roundedSeconds += row.roundedSeconds
    if (row.costRateCents === null) {
      existing.entriesWithoutRate += 1
      existing.costCents = null
    } else if (existing.costCents !== null) {
      existing.costCents += trackedAmountCents(row.roundedSeconds, row.costRateCents)
    }
    grouped.set(key, existing)
  }
  return { from: range.from, to: range.to, rows: [...grouped.values()] }
}

interface TimeReportQueryRow {
  seconds: number
  roundedSeconds: number
  billable: number
  billableRateCents: number | null
  /** 1 where the entry still qualifies for the uninvoiced report, else 0. */
  uninvoiced: number
  currency: string
  clientId: number
  clientName: string
  projectId: number
  projectName: string
  projectCode: string
  taskId: number
  taskName: string
  userId: number
  userName: string
  isContractor: number
  weeklyCapacity: number
}

interface MutableTimeAmount {
  currency: string
  billableCents: number
  uninvoicedCents: number
}

interface MutableTimeTotals {
  seconds: number
  roundedSeconds: number
  billableSeconds: number
  timeEntryCount: number
  unpricedBillableEntryCount: number
  amounts: Map<string, MutableTimeAmount>
}

const emptyTimeTotals = (): MutableTimeTotals => ({
  seconds: 0,
  roundedSeconds: 0,
  billableSeconds: 0,
  timeEntryCount: 0,
  unpricedBillableEntryCount: 0,
  amounts: new Map(),
})

/**
 * Every grouping folds the same row the same way, so the four tabs cannot come
 * to different answers about one month: whatever changes here changes for all
 * of them at once.
 */
const addTimeRow = (totals: MutableTimeTotals, row: Readonly<TimeReportQueryRow>): void => {
  totals.seconds = checkedAdd(totals.seconds, row.seconds, 'time report seconds')
  totals.roundedSeconds = checkedAdd(
    totals.roundedSeconds,
    row.roundedSeconds,
    'time report rounded seconds',
  )
  totals.timeEntryCount += 1
  if (row.billable !== 1) return
  totals.billableSeconds = checkedAdd(
    totals.billableSeconds,
    row.roundedSeconds,
    'time report billable seconds',
  )
  let amount = totals.amounts.get(row.currency)
  if (amount === undefined) {
    amount = { currency: row.currency, billableCents: 0, uninvoicedCents: 0 }
    totals.amounts.set(row.currency, amount)
  }
  // A billable entry with no resolved rate opens its currency bucket and adds
  // nothing to it. Pricing it at zero would make an unpriced month look like a
  // cheap one; the count beside the figure is what says the total is partial.
  if (row.billableRateCents === null) {
    totals.unpricedBillableEntryCount += 1
    return
  }
  const cents = trackedAmountCents(row.roundedSeconds, row.billableRateCents)
  amount.billableCents = checkedAdd(amount.billableCents, cents, 'time report billable cents')
  if (row.uninvoiced === 1) {
    amount.uninvoicedCents = checkedAdd(
      amount.uninvoicedCents,
      cents,
      'time report uninvoiced cents',
    )
  }
}

const finalizedTimeTotals = (totals: MutableTimeTotals): TimeReportTotalsRecord => ({
  seconds: totals.seconds,
  roundedSeconds: totals.roundedSeconds,
  billableSeconds: totals.billableSeconds,
  timeEntryCount: totals.timeEntryCount,
  unpricedBillableEntryCount: totals.unpricedBillableEntryCount,
  amounts: [...totals.amounts.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  ),
})

/**
 * Hours descending, because the bar beside each row reads as a ranking and a
 * table sorted by name puts the month's biggest client wherever the alphabet
 * happens to put it. Name then id break ties so SQLite and D1 return the same
 * order for the same data.
 */
const byHours = <Row extends TimeReportTotalsRecord>(
  name: (row: Row) => string,
  id: (row: Row) => number,
) => (left: Row, right: Row): number =>
  right.roundedSeconds - left.roundedSeconds ||
  name(left).localeCompare(name(right)) ||
  id(left) - id(right)

const dayMilliseconds = 86_400_000

/** Inclusive, so a single-day report divides utilization by one day of capacity. */
const reportedDays = (range: Readonly<ReportDateRange>): number =>
  Math.round(
    (Date.parse(`${range.to}T00:00:00.000Z`) - Date.parse(`${range.from}T00:00:00.000Z`)) /
      dayMilliseconds,
  ) + 1

const timeUtilizationPpm = (seconds: number, capacity: number): number | null => {
  if (capacity <= 0) return null
  const value =
    (BigInt(seconds) * 1_000_000n + BigInt(Math.floor(capacity / 2))) / BigInt(capacity)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('time report utilization exceeds the supported aggregate range')
  }
  return Number(value)
}

/**
 * Harvest's Time report, read once and folded four ways.
 *
 * Every tracked entry in the range is in the population, archived projects and
 * inactive people included: this report answers what was done, not what can
 * still be billed. The uninvoiced column is the one place the narrower question
 * is asked, and it is asked with the uninvoiced report's own predicate so the
 * two screens cannot disagree.
 */
const timeReport = async (
  database: Database,
  range: Readonly<ReportDateRange>,
): Promise<TimeReportRecord> => {
  assertRange(range)
  const rows = await database.all<TimeReportQueryRow>(sql`
    SELECT entry.seconds AS "seconds", entry.rounded_seconds AS "roundedSeconds",
      entry.billable AS "billable", entry.billable_rate_cents AS "billableRateCents",
      CASE WHEN entry.billable = 1 AND entry.invoice_id IS NULL
        AND project.is_active = 1 AND entry.timer_started_at IS NULL
        AND NOT (entry.started_time IS NOT NULL AND entry.ended_time IS NULL)
        THEN 1 ELSE 0 END AS "uninvoiced",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency",
      client.id AS "clientId", client.name AS "clientName",
      project.id AS "projectId", project.name AS "projectName",
      project.code AS "projectCode",
      task.id AS "taskId", task.name AS "taskName",
      person.id AS "userId",
      trim(person.first_name || ' ' || person.last_name) AS "userName",
      person.is_contractor AS "isContractor",
      person.weekly_capacity AS "weeklyCapacity"
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    JOIN tasks task ON task.id = entry.task_id
    JOIN users person ON person.id = entry.user_id
    WHERE entry.spent_date BETWEEN ${range.from} AND ${range.to}
    ORDER BY entry.id
  `)

  const totals = emptyTimeTotals()
  const clients = new Map<number, MutableTimeTotals & { clientId: number; clientName: string }>()
  const projects = new Map<
    number,
    MutableTimeTotals & {
      projectId: number
      projectName: string
      projectCode: string
      clientId: number
      clientName: string
    }
  >()
  const tasks = new Map<number, MutableTimeTotals & { taskId: number; taskName: string }>()
  const teammates = new Map<
    number,
    MutableTimeTotals & {
      userId: number
      userName: string
      isContractor: boolean
      weeklyCapacity: number
    }
  >()

  for (const row of rows) {
    addTimeRow(totals, row)
    const client = clients.get(row.clientId) ?? {
      ...emptyTimeTotals(),
      clientId: row.clientId,
      clientName: row.clientName,
    }
    addTimeRow(client, row)
    clients.set(row.clientId, client)
    const project = projects.get(row.projectId) ?? {
      ...emptyTimeTotals(),
      projectId: row.projectId,
      projectName: row.projectName,
      projectCode: row.projectCode,
      clientId: row.clientId,
      clientName: row.clientName,
    }
    addTimeRow(project, row)
    projects.set(row.projectId, project)
    const task = tasks.get(row.taskId) ?? {
      ...emptyTimeTotals(),
      taskId: row.taskId,
      taskName: row.taskName,
    }
    addTimeRow(task, row)
    tasks.set(row.taskId, task)
    const teammate = teammates.get(row.userId) ?? {
      ...emptyTimeTotals(),
      userId: row.userId,
      userName: row.userName,
      isContractor: row.isContractor === 1,
      weeklyCapacity: row.weeklyCapacity,
    }
    addTimeRow(teammate, row)
    teammates.set(row.userId, teammate)
  }

  const days = reportedDays(range)
  return {
    from: range.from,
    to: range.to,
    totals: finalizedTimeTotals(totals),
    clients: [...clients.values()]
      .map((client) => ({
        ...finalizedTimeTotals(client),
        clientId: client.clientId,
        clientName: client.clientName,
      }))
      .sort(byHours((row) => row.clientName, (row) => row.clientId)),
    projects: [...projects.values()]
      .map((project) => ({
        ...finalizedTimeTotals(project),
        projectId: project.projectId,
        projectName: project.projectName,
        projectCode: project.projectCode,
        clientId: project.clientId,
        clientName: project.clientName,
      }))
      .sort(byHours((row) => row.projectName, (row) => row.projectId)),
    tasks: [...tasks.values()]
      .map((task) => ({
        ...finalizedTimeTotals(task),
        taskId: task.taskId,
        taskName: task.taskName,
      }))
      .sort(byHours((row) => row.taskName, (row) => row.taskId)),
    teammates: [...teammates.values()]
      .map((teammate) => {
        const capacitySeconds = Math.round((teammate.weeklyCapacity * days) / 7)
        const finalized = finalizedTimeTotals(teammate)
        return {
          ...finalized,
          userId: teammate.userId,
          userName: teammate.userName,
          isContractor: teammate.isContractor,
          capacitySeconds,
          utilizationPpm: timeUtilizationPpm(finalized.roundedSeconds, capacitySeconds),
        }
      })
      .sort(byHours((row) => row.userName, (row) => row.userId)),
  }
}

export const createReportRepository = (database: Database): ReportRepository => ({
  contractorCost: (range) => contractorCostReport(database, range),
  timeReport: (range) => timeReport(database, range),
  memberHours: (filter) => memberHoursReport(database, filter),
  uninvoiced: (filter) => uninvoicedReport(database, filter),
  clientRollup: (clientId, range) => clientRollupReport(database, clientId, range),
  projectBudgetSummaries: (range, viewer) =>
    projectBudgetSummaryReport(database, range, viewer),
  projectBudget: (projectId, range, viewer) =>
    projectBudgetReport(database, projectId, range, viewer),
})
