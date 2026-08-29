import {
  trackedAmountCents,
  uninvoicedGenerationPreview,
  type UninvoicedCurrencyTotal,
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

export interface ReportRepository {
  uninvoiced(filter: Readonly<UninvoicedReportFilter>): Promise<UninvoicedReportRecord>
  clientRollup(
    clientId: number,
    range: Readonly<ReportDateRange>,
  ): Promise<ClientRollupReportRecord | null>
  projectBudget(
    projectId: number,
    range: Readonly<ReportDateRange>,
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

interface TimeCandidateRow {
  id: number
  clientId: number
  projectId: number
  currency: string
  roundedSeconds: number
  billableRateCents: number | null
}

interface ExpenseCandidateRow {
  id: number
  clientId: number
  projectId: number
  currency: string
  totalCostCents: number
}

const projectFilter = (projectId: number | undefined) =>
  projectId === undefined ? sql`1` : sql`project.id = ${projectId}`

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

const uninvoicedCandidates = async (
  database: Database,
  filter: Readonly<UninvoicedReportFilter>,
): Promise<{
  timeEntries: readonly TimeCandidateRow[]
  expenses: readonly ExpenseCandidateRow[]
}> => {
  const projectWhere = projectFilter(filter.projectId)
  const clientWhere = clientFilter(filter.clientId)
  const timeEntries = await database.all<TimeCandidateRow>(sql`
    SELECT entry.id AS "id", project.client_id AS "clientId",
      project.id AS "projectId",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency",
      entry.rounded_seconds AS "roundedSeconds",
      entry.billable_rate_cents AS "billableRateCents"
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    WHERE entry.spent_date BETWEEN ${filter.from} AND ${filter.to}
      AND entry.billable = 1 AND entry.invoice_id IS NULL
      AND entry.timer_started_at IS NULL
      AND NOT (entry.started_time IS NOT NULL AND entry.ended_time IS NULL)
      AND ${projectWhere} AND ${clientWhere}
    ORDER BY entry.id
  `)
  const expenses = await database.all<ExpenseCandidateRow>(sql`
    SELECT expense.id AS "id", project.client_id AS "clientId",
      project.id AS "projectId",
      upper(coalesce(project.billing_currency, client.currency)) AS "currency",
      expense.total_cost_cents AS "totalCostCents"
    FROM expenses expense
    JOIN projects project ON project.id = expense.project_id
    JOIN clients client ON client.id = project.client_id
    WHERE expense.spent_date BETWEEN ${filter.from} AND ${filter.to}
      AND expense.billable = 1 AND expense.invoice_id IS NULL
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
  const candidates = await uninvoicedCandidates(database, filter)
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
}

interface RollupTimeRow {
  id: number
  clientId: number
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
    WITH RECURSIVE subtree(id, name, parent_client_id, depth, visited) AS (
      SELECT id, name, parent_client_id, 0, printf(',%d,', id)
      FROM clients WHERE id = ${rootClientId}
      UNION ALL
      SELECT child.id, child.name, child.parent_client_id, subtree.depth + 1,
        subtree.visited || child.id || ','
      FROM subtree
      JOIN clients child ON child.parent_client_id = subtree.id
      WHERE instr(subtree.visited, printf(',%d,', child.id)) = 0
    )
    SELECT id AS "clientId", name AS "name", parent_client_id AS "parentClientId",
      depth AS "depth"
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
        organizationCurrency,
        'costCents',
        trackedAmountCents(row.roundedSeconds, row.costRateCents),
      )
    }
    const stopped =
      row.timerStartedAt === null && !(row.startedTime !== null && row.endedTime === null)
    if (row.billable === 1 && row.invoiceId === null && stopped) {
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
    if (row.billable === 1 && row.invoiceId === null) {
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

  return {
    rootClientId,
    from: range.from,
    to: range.to,
    nodes: nodes.map((node) => ({
      ...node,
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

const projectBudgetReport = async (
  database: Database,
  projectId: number,
  range: Readonly<ReportDateRange>,
): Promise<ProjectBudgetReportRecord | null> => {
  assertId(projectId, 'project id')
  assertRange(range)
  const projects = await database.all<ProjectRow>(sql`
    SELECT id AS "id", budget_by AS "budgetBy", budget_seconds AS "budgetSeconds",
      cost_budget_cents AS "costBudgetCents",
      cost_budget_include_expenses AS "costBudgetIncludeExpenses"
    FROM projects WHERE id = ${projectId}
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

export const createReportRepository = (database: Database): ReportRepository => ({
  uninvoiced: (filter) => uninvoicedReport(database, filter),
  clientRollup: (clientId, range) => clientRollupReport(database, clientId, range),
  projectBudget: (projectId, range) => projectBudgetReport(database, projectId, range),
})
