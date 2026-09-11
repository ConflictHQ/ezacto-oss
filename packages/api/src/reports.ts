import { canViewMoneyField } from "@ezacto/core";
import type { Hono } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext, UserPrincipal } from "./context.js";
import { ApiError, type FieldError } from "./errors.js";
import {
  assertFields,
  notFound,
  queryBoolean,
  queryDate,
  queryEnum,
  queryPositiveInteger,
  resourceId,
  strictSearchParams,
} from "./resources/support.js";

export interface ReportDateRange {
  from: string;
  to: string;
}

export interface ContractorCostRowRecord {
  userId: number;
  name: string;
  /** A proposal for matching the person at a payout provider, never the join. */
  payrollEmail: string | null;
  isContractor: boolean;
  /** Always the organization's currency: a cost rate carries none of its own. */
  currency: string;
  roundedSeconds: number;
  /** Null when any entry in the row has no cost rate. */
  costCents: number | null;
  entriesWithoutRate: number;
}

export interface ContractorCostReportRecord {
  from: string;
  to: string;
  rows: readonly ContractorCostRowRecord[];
}

export interface ProfitabilityRowRecord {
  projectId: number;
  projectName: string;
  projectCode: string;
  clientId: number;
  clientName: string;
  /** The project's billing currency. Revenue is denominated in it. */
  currency: string;
  roundedSeconds: number;
  /** Null when any billable entry on the project has no rate. */
  revenueCents: number | null;
  /** Organization currency, always. Null when any entry has no cost rate. */
  costCents: number | null;
  /** Null when either side is missing, or the project bills in another currency. */
  profitCents: number | null;
  entriesWithoutBillableRate: number;
  entriesWithoutCostRate: number;
}

export interface ProfitabilityTotals {
  roundedSeconds: number;
  revenueCents: number | null;
  costCents: number | null;
  profitCents: number | null;
  entriesWithoutBillableRate: number;
  entriesWithoutCostRate: number;
  /** Projects left out of the headline because they bill in another currency. */
  projectsNotConverted: number;
}

export interface ProfitabilityReportRecord {
  from: string;
  to: string;
  organizationCurrency: string;
  rows: readonly ProfitabilityRowRecord[];
  totals: Readonly<ProfitabilityTotals>;
  previousFrom: string;
  previousTo: string;
  previousTotals: Readonly<ProfitabilityTotals>;
}

export interface DetailedExpenseRowRecord {
  expenseId: number;
  spentDate: string;
  clientId: number;
  clientName: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  categoryId: number;
  categoryName: string;
  userId: number;
  userName: string;
  notes: string | null;
  units: number | null;
  billable: boolean;
  reimbursable: boolean;
  invoiceId: number | null;
  currency: string;
  totalCostCents: number;
}

export interface DetailedExpenseReportRecord {
  from: string;
  to: string;
  clientId: number | null;
  projectId: number | null;
  billableOnly: boolean;
  rows: readonly DetailedExpenseRowRecord[];
  totals: readonly {
    currency: string;
    expenseCount: number;
    totalCostCents: number;
  }[];
}

export interface UninvoicedCurrencyRecord {
  currency: string;
  roundedSeconds: number;
  timeEntryCount: number;
  unpricedTimeEntryCount: number;
  expenseCount: number;
  timeCents: number;
  expenseCents: number;
  totalCents: number;
}

export interface UninvoicedReportRecord extends ReportDateRange {
  clientId: number | null;
  projectId: number | null;
  totals: readonly UninvoicedCurrencyRecord[];
}

export interface ClientRollupCurrencyRecord {
  currency: string;
  expenseCents: number;
  uninvoicedTimeCents: number;
  uninvoicedExpenseCents: number;
  uninvoicedTotalCents: number;
  moneyBudgetCents: number;
  costCents: number;
}

export interface ClientRollupMetricsRecord {
  timeEntryCount: number;
  expenseCount: number;
  roundedSeconds: number;
  billableSeconds: number;
  budgetedSeconds: number;
  timeBudgetSeconds: number;
  unpricedBillableEntryCount: number;
  unpricedCostEntryCount: number;
  currencies: readonly ClientRollupCurrencyRecord[];
}

export interface ClientRollupNodeRecord {
  clientId: number;
  name: string;
  parentClientId: number | null;
  depth: number;
  nodeBudgetCents: number | null;
  budgetBurnCents: number;
  direct: ClientRollupMetricsRecord;
  rollup: ClientRollupMetricsRecord;
}

export interface ClientRollupReportRecord extends ReportDateRange {
  rootClientId: number;
  nodes: readonly ClientRollupNodeRecord[];
}

export interface ProjectBudgetGrainRecord {
  source: "project" | "task_assignment" | "user_assignment";
  sourceId: number;
  unit: "seconds" | "cents";
  calculation: "time" | "billable" | "cost";
  budgetAmount: number | null;
  spentAmount: number;
  remainingAmount: number | null;
  unpricedEntryCount: number;
}

export interface ProjectBudgetSummaryRecord {
  projectId: number;
  /** Resolved by the repository from the project, or its client. */
  currency: string;
  budgetBy: "project" | "project_cost" | "task" | "task_fees" | "person" | "none";
  unit: "seconds" | "cents" | null;
  budgetAmount: number | null;
  spentAmount: number;
  remainingAmount: number | null;
  costCents: number;
  unpricedEntryCount: number;
}

export interface ProjectBudgetReportRecord extends ReportDateRange {
  projectId: number;
  budgetBy:
    "project" | "project_cost" | "task" | "task_fees" | "person" | "none";
  expensesIncluded: boolean;
  grains: readonly ProjectBudgetGrainRecord[];
}

export interface MyHoursProjectRecord {
  projectId: number;
  projectName: string;
  projectCode: string;
  clientId: number;
  clientName: string;
  seconds: number;
  roundedSeconds: number;
  billableSeconds: number;
  timeEntryCount: number;
}

export interface MyHoursReportRecord extends ReportDateRange {
  userId: number;
  projectId: number | null;
  seconds: number;
  roundedSeconds: number;
  billableSeconds: number;
  timeEntryCount: number;
  projects: readonly MyHoursProjectRecord[];
}

export type DetailedTimeHours =
  | "all"
  | "billable"
  | "non_billable"
  | "uninvoiced";

export interface DetailedTimeRowRecord {
  spentDate: string;
  clientId: number;
  clientName: string;
  projectId: number;
  projectName: string;
  /** NOT NULL DEFAULT '' in the schema: an uncoded project carries "". */
  projectCode: string;
  taskId: number;
  taskName: string;
  userId: number;
  userName: string;
  roles: readonly string[];
  currency: string;
  seconds: number;
  roundedSeconds: number;
  billableSeconds: number;
  uninvoicedBillableSeconds: number;
  timeEntryCount: number;
  /** Null when any billable entry folded into the row has no resolved rate. */
  billableAmountCents: number | null;
  entriesWithoutBillableRate: number;
}

export interface DetailedTimeCurrencyRecord {
  currency: string;
  billableAmountCents: number | null;
  entriesWithoutBillableRate: number;
}

export interface DetailedTimeReportRecord extends ReportDateRange {
  clientId: number | null;
  projectId: number | null;
  hours: DetailedTimeHours;
  activeProjectsOnly: boolean;
  seconds: number;
  roundedSeconds: number;
  billableSeconds: number;
  uninvoicedBillableSeconds: number;
  timeEntryCount: number;
  currencies: readonly DetailedTimeCurrencyRecord[];
  rows: readonly DetailedTimeRowRecord[];
}

/**
 * The reader refuses a range whose entry count it will not read, and says so as
 * a value rather than an exception: this package holds no dependency on the
 * database package, so the seam is a shape both sides agree on.
 */
export type DetailedTimeReportResult =
  | { kind: "report"; report: DetailedTimeReportRecord }
  | { kind: "too_many_entries"; limit: number };

export interface TimeReportAmountRecord {
  currency: string;
  billableCents: number;
  /** The part of `billableCents` not yet on an invoice, on the uninvoiced report's predicate. */
  uninvoicedCents: number;
}

export interface TimeReportTotalsRecord {
  seconds: number;
  roundedSeconds: number;
  billableSeconds: number;
  timeEntryCount: number;
  unpricedBillableEntryCount: number;
  amounts: readonly TimeReportAmountRecord[];
}

export interface TimeReportClientRecord extends TimeReportTotalsRecord {
  clientId: number;
  clientName: string;
}

export interface TimeReportProjectRecord extends TimeReportTotalsRecord {
  projectId: number;
  projectName: string;
  projectCode: string;
  clientId: number;
  clientName: string;
}

export interface TimeReportTaskRecord extends TimeReportTotalsRecord {
  taskId: number;
  taskName: string;
}

export interface TimeReportTeammateRecord extends TimeReportTotalsRecord {
  userId: number;
  userName: string;
  isContractor: boolean;
  /** Weekly capacity prorated across the reported days. */
  capacitySeconds: number;
  utilizationPpm: number | null;
}

export interface TimeReportRecord extends ReportDateRange {
  totals: TimeReportTotalsRecord;
  clients: readonly TimeReportClientRecord[];
  projects: readonly TimeReportProjectRecord[];
  tasks: readonly TimeReportTaskRecord[];
  teammates: readonly TimeReportTeammateRecord[];
}

export interface ProjectReportViewer {
  userId: number;
  profile: UserPrincipal["profile"];
}

export interface ReportReader {
  memberHours(filter: {
    from: string;
    to: string;
    userId: number;
    projectId?: number;
  }): Promise<MyHoursReportRecord>;
  contractorCost(range: Readonly<ReportDateRange>): Promise<ContractorCostReportRecord>;
  detailedExpense(filter: {
    from: string;
    to: string;
    clientId?: number;
    projectId?: number;
    billableOnly?: boolean;
  }): Promise<DetailedExpenseReportRecord>;
  profitability(range: Readonly<ReportDateRange>): Promise<ProfitabilityReportRecord>;
  timeReport(range: Readonly<ReportDateRange>): Promise<TimeReportRecord>;
  detailedTime(filter: {
    from: string;
    to: string;
    clientId?: number;
    projectId?: number;
    hours?: DetailedTimeHours;
    activeProjectsOnly?: boolean;
  }): Promise<DetailedTimeReportResult>;
  uninvoiced(filter: {
    from: string;
    to: string;
    clientId?: number;
    projectId?: number;
  }): Promise<UninvoicedReportRecord>;
  clientRollup(
    clientId: number,
    range: Readonly<ReportDateRange>,
  ): Promise<ClientRollupReportRecord | null>;
  projectBudget(
    projectId: number,
    range: Readonly<ReportDateRange>,
    viewer: Readonly<ProjectReportViewer>,
  ): Promise<ProjectBudgetReportRecord | null>;
  projectBudgetSummaries(
    range: Readonly<ReportDateRange>,
    viewer: Readonly<ProjectReportViewer>,
  ): Promise<readonly ProjectBudgetSummaryRecord[]>;
}

const reportKeys = new Set(["from", "to"]);
const uninvoicedKeys = new Set([...reportKeys, "client_id", "project_id"]);
// Deliberately no user_id. The strict parser refuses every key that is not on
// this list, so `?user_id=7` is a 422 rather than a report of somebody else's
// week -- and even if it were accepted, the repository is handed the principal.
const myHoursKeys = new Set([...reportKeys, "project_id"]);
const detailedExpenseKeys = new Set([...uninvoicedKeys, "billable_only"]);
const detailedTimeKeys = new Set([
  ...uninvoicedKeys,
  "hours",
  "active_projects_only",
]);
const detailedTimeHours: readonly DetailedTimeHours[] = [
  "all",
  "billable",
  "non_billable",
  "uninvoiced",
];

const rangeFrom = (
  url: URL,
  allowed: ReadonlySet<string>,
): {
  range: ReportDateRange;
  params: ReadonlyMap<string, string>;
  errors: FieldError[];
} => {
  const params = strictSearchParams(url, allowed);
  const errors: FieldError[] = [];
  const from = queryDate(params, "from", errors);
  const to = queryDate(params, "to", errors);
  if (from === undefined && !params.has("from")) {
    errors.push({
      field: "from",
      code: "required",
      message: "from is required",
    });
  }
  if (to === undefined && !params.has("to")) {
    errors.push({ field: "to", code: "required", message: "to is required" });
  }
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({
      field: "to",
      code: "inverted_range",
      message: "to must be on or after from",
    });
  }
  return { range: { from: from!, to: to! }, params, errors };
};

/**
 * No money fields, and so no `canViewMoneyField` gating: this report answers
 * "how long did I work and against what", and the rate that turns those hours
 * into an amount is not a member's to see. Adding cents here would mean adding
 * the redaction that every other report carries, for a figure the screen does
 * not ask for.
 */
const serializeMyHours = (report: Readonly<MyHoursReportRecord>) => ({
  from: report.from,
  to: report.to,
  user_id: report.userId,
  project_id: report.projectId,
  seconds: report.seconds,
  rounded_seconds: report.roundedSeconds,
  billable_seconds: report.billableSeconds,
  time_entry_count: report.timeEntryCount,
  projects: report.projects.map((project) => ({
    project_id: project.projectId,
    project_name: project.projectName,
    project_code: project.projectCode,
    client_id: project.clientId,
    client_name: project.clientName,
    seconds: project.seconds,
    rounded_seconds: project.roundedSeconds,
    billable_seconds: project.billableSeconds,
    time_entry_count: project.timeEntryCount,
  })),
});

const serializeUninvoiced = (
  report: Readonly<UninvoicedReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  from: report.from,
  to: report.to,
  client_id: report.clientId,
  project_id: report.projectId,
  totals: report.totals.map((total) => ({
    currency: total.currency,
    rounded_seconds: total.roundedSeconds,
    time_entry_count: total.timeEntryCount,
    unpriced_time_entry_count: total.unpricedTimeEntryCount,
    expense_count: total.expenseCount,
    ...(canViewMoneyField(viewer, "billable_rate")
      ? {
          time_cents: total.timeCents,
          expense_cents: total.expenseCents,
          total_cents: total.totalCents,
        }
      : {}),
  })),
});

/**
 * Every figure here is a cost, so the report is administrator-only as a whole
 * rather than served with its numbers stripped. A "contractor cost" report
 * without costs is an hours report under a name that promises otherwise, and a
 * reader could not tell a person with no rate from a person whose rate they are
 * not allowed to see.
 *
 * `cost_cents` stays null exactly where the reader made it null -- any entry in
 * the row without a rate -- and `entries_without_rate` carries the count, so the
 * screen names the gap instead of showing a total that quietly omits hours.
 */
const serializeContractorCost = (report: Readonly<ContractorCostReportRecord>) => ({
  from: report.from,
  to: report.to,
  rows: report.rows.map((row) => ({
    user_id: row.userId,
    name: row.name,
    payroll_email: row.payrollEmail,
    is_contractor: row.isContractor,
    currency: row.currency,
    rounded_seconds: row.roundedSeconds,
    cost_cents: row.costCents,
    entries_without_rate: row.entriesWithoutRate,
  })),
});

const serializeProfitabilityTotals = (
  totals: Readonly<ProfitabilityTotals>,
) => ({
  rounded_seconds: totals.roundedSeconds,
  revenue_cents: totals.revenueCents,
  cost_cents: totals.costCents,
  profit_cents: totals.profitCents,
  entries_without_billable_rate: totals.entriesWithoutBillableRate,
  entries_without_cost_rate: totals.entriesWithoutCostRate,
  projects_not_converted: totals.projectsNotConverted,
});

const serializeProfitability = (report: Readonly<ProfitabilityReportRecord>) => ({
  from: report.from,
  to: report.to,
  organization_currency: report.organizationCurrency,
  rows: report.rows.map((row) => ({
    project_id: row.projectId,
    project_name: row.projectName,
    project_code: row.projectCode,
    client_id: row.clientId,
    client_name: row.clientName,
    currency: row.currency,
    rounded_seconds: row.roundedSeconds,
    revenue_cents: row.revenueCents,
    cost_cents: row.costCents,
    profit_cents: row.profitCents,
    entries_without_billable_rate: row.entriesWithoutBillableRate,
    entries_without_cost_rate: row.entriesWithoutCostRate,
  })),
  totals: serializeProfitabilityTotals(report.totals),
  previous_from: report.previousFrom,
  previous_to: report.previousTo,
  previous_totals: serializeProfitabilityTotals(report.previousTotals),
});

/**
 * Hours are the report; money is an extra column on it, so the report is served
 * to every profile that may read reports and the amounts are dropped per field
 * rather than the whole response refused. That is the opposite call from the
 * contractor report above, and for a reason that survives reading: a detailed
 * time report without amounts still answers who worked on what and for how
 * long, while a contractor *cost* report without costs answers nothing.
 *
 * `entries_without_billable_rate` is not gated. It counts entries, not money,
 * and it is what stops a reader who can see amounts from mistaking a partial
 * total for a complete one -- withholding it alongside the amount would leave
 * the amount unexplained for everybody else's benefit.
 */
/**
 * Amounts are dropped per field rather than the response refused, the same call
 * the detailed time report makes and for the same reason: a list of expenses
 * without amounts still answers who expensed what, when and against which
 * project, while a refusal answers nothing.
 *
 * Gated on `billable_rate` rather than `cost_rate`. An expense total is money
 * the firm paid, but it is the figure billed on to the client and the one an
 * invoice line for it carries, so it belongs with the billable authority.
 *
 * No profile reaches this branch today: `reports:read` is exactly accounting,
 * executive manager and administrator, and all three pass that check. It is
 * written anyway, and stated here rather than left to be discovered, because
 * `serializeDetailedTime` carries the identical branch for the identical
 * reason -- the day a profile is granted reports without billable money, the
 * report that drops amounts is the one that keeps working.
 */
const serializeDetailedExpense = (
  report: Readonly<DetailedExpenseReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => {
  const money = canViewMoneyField(viewer, "billable_rate");
  return {
    from: report.from,
    to: report.to,
    client_id: report.clientId,
    project_id: report.projectId,
    billable_only: report.billableOnly,
    totals: report.totals.map((total) => ({
      currency: total.currency,
      expense_count: total.expenseCount,
      ...(money ? { total_cost_cents: total.totalCostCents } : {}),
    })),
    rows: report.rows.map((row) => ({
      expense_id: row.expenseId,
      spent_date: row.spentDate,
      client_id: row.clientId,
      client_name: row.clientName,
      project_id: row.projectId,
      project_name: row.projectName,
      project_code: row.projectCode,
      category_id: row.categoryId,
      category_name: row.categoryName,
      user_id: row.userId,
      user_name: row.userName,
      notes: row.notes,
      units: row.units,
      billable: row.billable,
      reimbursable: row.reimbursable,
      invoice_id: row.invoiceId,
      currency: row.currency,
      ...(money ? { total_cost_cents: row.totalCostCents } : {}),
    })),
  };
};

const serializeDetailedTime = (
  report: Readonly<DetailedTimeReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => {
  const money = canViewMoneyField(viewer, "billable_rate");
  return {
    from: report.from,
    to: report.to,
    client_id: report.clientId,
    project_id: report.projectId,
    hours: report.hours,
    active_projects_only: report.activeProjectsOnly,
    seconds: report.seconds,
    rounded_seconds: report.roundedSeconds,
    billable_seconds: report.billableSeconds,
    uninvoiced_billable_seconds: report.uninvoicedBillableSeconds,
    time_entry_count: report.timeEntryCount,
    currencies: report.currencies.map((currency) => ({
      currency: currency.currency,
      entries_without_billable_rate: currency.entriesWithoutBillableRate,
      ...(money ? { billable_amount_cents: currency.billableAmountCents } : {}),
    })),
    rows: report.rows.map((row) => ({
      spent_date: row.spentDate,
      client_id: row.clientId,
      client_name: row.clientName,
      project_id: row.projectId,
      project_name: row.projectName,
      project_code: row.projectCode,
      task_id: row.taskId,
      task_name: row.taskName,
      user_id: row.userId,
      user_name: row.userName,
      roles: [...row.roles],
      currency: row.currency,
      seconds: row.seconds,
      rounded_seconds: row.roundedSeconds,
      billable_seconds: row.billableSeconds,
      uninvoiced_billable_seconds: row.uninvoicedBillableSeconds,
      time_entry_count: row.timeEntryCount,
      entries_without_billable_rate: row.entriesWithoutBillableRate,
      ...(money ? { billable_amount_cents: row.billableAmountCents } : {}),
    })),
  };
};

/**
 * Hours for everyone who can reach the report, amounts only for a viewer who
 * may see billable rates -- the rule every other report here follows, applied
 * once at the totals level so the summary strip and all four tabs redact
 * together. Unlike the contractor report, this one is not refused outright when
 * the money is withheld: hours by client, project, task and teammate is a whole
 * useful report on its own, and only two of its columns are money.
 *
 * Today no profile reaches this route without that permission -- `reports:read`
 * is accounting, executive manager and administrator, and all three may see
 * billable rates -- so the branch is not reachable through the route. It is
 * still written, and tested directly against the serializer, because the day
 * `reports:read` widens (a project manager without the billable_rates_manager
 * grant is the obvious candidate) the absence of this gate would be a silent
 * disclosure rather than a compile error.
 */
const serializeTimeTotals = (
  totals: Readonly<TimeReportTotalsRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  seconds: totals.seconds,
  rounded_seconds: totals.roundedSeconds,
  billable_seconds: totals.billableSeconds,
  time_entry_count: totals.timeEntryCount,
  unpriced_billable_entry_count: totals.unpricedBillableEntryCount,
  ...(canViewMoneyField(viewer, "billable_rate")
    ? {
        amounts: totals.amounts.map((amount) => ({
          currency: amount.currency,
          billable_cents: amount.billableCents,
          uninvoiced_cents: amount.uninvoicedCents,
        })),
      }
    : {}),
});

const serializeTimeReport = (
  report: Readonly<TimeReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  from: report.from,
  to: report.to,
  totals: serializeTimeTotals(report.totals, viewer),
  clients: report.clients.map((client) => ({
    ...serializeTimeTotals(client, viewer),
    client_id: client.clientId,
    client_name: client.clientName,
  })),
  projects: report.projects.map((project) => ({
    ...serializeTimeTotals(project, viewer),
    project_id: project.projectId,
    project_name: project.projectName,
    project_code: project.projectCode,
    client_id: project.clientId,
    client_name: project.clientName,
  })),
  tasks: report.tasks.map((task) => ({
    ...serializeTimeTotals(task, viewer),
    task_id: task.taskId,
    task_name: task.taskName,
  })),
  teammates: report.teammates.map((teammate) => ({
    ...serializeTimeTotals(teammate, viewer),
    user_id: teammate.userId,
    user_name: teammate.userName,
    is_contractor: teammate.isContractor,
    capacity_seconds: teammate.capacitySeconds,
    utilization_ppm: teammate.utilizationPpm,
  })),
});

const serializeRollupMetrics = (
  metrics: Readonly<ClientRollupMetricsRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  time_entry_count: metrics.timeEntryCount,
  expense_count: metrics.expenseCount,
  rounded_seconds: metrics.roundedSeconds,
  billable_seconds: metrics.billableSeconds,
  budgeted_seconds: metrics.budgetedSeconds,
  time_budget_seconds: metrics.timeBudgetSeconds,
  unpriced_billable_entry_count: metrics.unpricedBillableEntryCount,
  unpriced_cost_entry_count: metrics.unpricedCostEntryCount,
  currencies: metrics.currencies.map((currency) => ({
    currency: currency.currency,
    expense_cents: currency.expenseCents,
    ...(canViewMoneyField(viewer, "billable_rate")
      ? {
          uninvoiced_time_cents: currency.uninvoicedTimeCents,
          uninvoiced_expense_cents: currency.uninvoicedExpenseCents,
          uninvoiced_total_cents: currency.uninvoicedTotalCents,
        }
      : {}),
    ...(canViewMoneyField(viewer, "money_budget")
      ? { money_budget_cents: currency.moneyBudgetCents }
      : {}),
    ...(canViewMoneyField(viewer, "cost_rate")
      ? { cost_cents: currency.costCents }
      : {}),
  })),
});

const serializeClientRollup = (
  report: Readonly<ClientRollupReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  root_client_id: report.rootClientId,
  from: report.from,
  to: report.to,
  nodes: report.nodes.map((node) => ({
    client_id: node.clientId,
    name: node.name,
    parent_client_id: node.parentClientId,
    depth: node.depth,
    ...(canViewMoneyField(viewer, "money_budget")
      ? { node_budget_cents: node.nodeBudgetCents }
      : {}),
    ...(canViewMoneyField(viewer, "cost_rate")
      ? { budget_burn_cents: node.budgetBurnCents }
      : {}),
    direct: serializeRollupMetrics(node.direct, viewer),
    rollup: serializeRollupMetrics(node.rollup, viewer),
  })),
});

const serializeProjectBudget = (
  report: Readonly<ProjectBudgetReportRecord>,
  viewer: Readonly<UserPrincipal>,
) => ({
  project_id: report.projectId,
  budget_by: report.budgetBy,
  expenses_included: report.expensesIncluded,
  from: report.from,
  to: report.to,
  grains: report.grains.map((grain) => {
    const base = {
      source: grain.source,
      source_id: grain.sourceId,
      unit: grain.unit,
      calculation: grain.calculation,
      unpriced_entry_count: grain.unpricedEntryCount,
    };
    if (grain.unit === "seconds") {
      return {
        ...base,
        budget_seconds: grain.budgetAmount,
        spent_seconds: grain.spentAmount,
        remaining_seconds: grain.remainingAmount,
      };
    }
    const canSeeBudget = canViewMoneyField(viewer, "money_budget");
    const canSeeSpent = canViewMoneyField(
      viewer,
      grain.calculation === "cost" ? "cost_rate" : "billable_rate",
    );
    return {
      ...base,
      ...(canSeeBudget ? { budget_cents: grain.budgetAmount } : {}),
      ...(canSeeSpent ? { spent_cents: grain.spentAmount } : {}),
      ...(canSeeBudget && canSeeSpent
        ? { remaining_cents: grain.remainingAmount }
        : {}),
    };
  }),
});

const serializeProjectBudgetSummary = (
  summary: Readonly<ProjectBudgetSummaryRecord>,
  viewer: Readonly<UserPrincipal>,
) => {
  const base = {
    project_id: summary.projectId,
    currency: summary.currency,
    budget_by: summary.budgetBy,
    unit: summary.unit,
    unpriced_entry_count: summary.unpricedEntryCount,
  };
  if (summary.unit === "seconds") {
    return {
      ...base,
      budget_seconds: summary.budgetAmount,
      spent_seconds: summary.spentAmount,
      remaining_seconds: summary.remainingAmount,
      // Cost is money whatever the budget is denominated in, so it is gated
      // even on a time-budgeted project.
      ...(canViewMoneyField(viewer, "cost_rate")
        ? { cost_cents: summary.costCents }
        : {}),
    };
  }
  // The same per-field rule the per-project report applies: a list must not
  // become a way to read a budget the detail page would hide.
  const canSeeBudget = canViewMoneyField(viewer, "money_budget");
  const canSeeSpent = canViewMoneyField(
    viewer,
    summary.budgetBy === "task_fees" ? "billable_rate" : "cost_rate",
  );
  return {
    ...base,
    ...(canSeeBudget ? { budget_cents: summary.budgetAmount } : {}),
    ...(canSeeSpent ? { spent_cents: summary.spentAmount } : {}),
    ...(canSeeBudget && canSeeSpent
      ? { remaining_cents: summary.remainingAmount }
      : {}),
    ...(canViewMoneyField(viewer, "cost_rate")
      ? { cost_cents: summary.costCents }
      : {}),
  };
};

export const installReportRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  reports: ReportReader,
): void => {
  api.get("/reports/my-hours", async (context) => {
    // `time_entries:read`, not `reports:read`. The firm-wide reports are gated
    // to the three reporting profiles; these are the acting user's own entries
    // aggregated, so the authority is the one that already lets them read their
    // own time. Gating this on `reports:read` would hand a member a Reports
    // screen with nothing on it -- the gap #492 opens with.
    requireApiScope(context, "time_entries:read");
    const parsed = rangeFrom(new URL(context.req.url), myHoursKeys);
    const projectId = queryPositiveInteger(
      parsed.params,
      "project_id",
      parsed.errors,
    );
    assertFields(parsed.errors);
    const principal = context.get("principal");
    // The one place whose hours these are is decided, and it is not the
    // request. A project narrows the rows; it cannot change the person.
    const report = await reports.memberHours({
      ...parsed.range,
      userId: principal.userId,
      ...(projectId === undefined ? {} : { projectId }),
    });
    return context.json(
      {
        data: serializeMyHours(report),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/time", async (context) => {
    requireApiScope(context, "reports:read");
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const report = await reports.timeReport(parsed.range);
    return context.json(
      {
        data: serializeTimeReport(report, context.get("principal")),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/contractor", async (context) => {
    requireApiScope(context, "reports:read");
    const principal = context.get("principal");
    // The whole report is cost, and cost authority belongs to the administrator
    // alone. Refused here rather than by omitting the fields, because that
    // alternative serves a report with every column missing and no statement of
    // why.
    if (!canViewMoneyField(principal, "cost_rate")) {
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "The acting user profile cannot perform this operation.",
      });
    }
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const report = await reports.contractorCost(parsed.range);
    return context.json(
      {
        data: serializeContractorCost(report),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/detailed-time", async (context) => {
    requireApiScope(context, "reports:read");
    const parsed = rangeFrom(new URL(context.req.url), detailedTimeKeys);
    const clientId = queryPositiveInteger(
      parsed.params,
      "client_id",
      parsed.errors,
    );
    const projectId = queryPositiveInteger(
      parsed.params,
      "project_id",
      parsed.errors,
    );
    const hours = queryEnum(
      parsed.params,
      "hours",
      detailedTimeHours,
      parsed.errors,
    );
    const activeProjectsOnly = queryBoolean(
      parsed.params,
      "active_projects_only",
      parsed.errors,
    );
    assertFields(parsed.errors);
    const result = await reports.detailedTime({
      ...parsed.range,
      ...(clientId === undefined ? {} : { clientId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(hours === undefined ? {} : { hours }),
      ...(activeProjectsOnly === undefined ? {} : { activeProjectsOnly }),
    });
    // 422 on the range rather than a partial body: the response has no field
    // that could say "these rows are some of the rows", and a caller that got
    // 200 would total the page it was handed and publish the answer.
    if (result.kind === "too_many_entries") {
      throw new ApiError({
        status: 422,
        code: "validation_failed",
        message: "The request contains invalid fields.",
        fields: [
          {
            field: "to",
            code: "range_too_wide",
            message: `from and to cover more than ${result.limit} time entries; narrow the period or the client and project filters`,
          },
        ],
      });
    }
    return context.json(
      {
        data: serializeDetailedTime(result.report, context.get("principal")),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/profitability", async (context) => {
    requireApiScope(context, "reports:read");
    const principal = context.get("principal");
    // Every row states a cost, so this is refused on the same authority as the
    // contractor report rather than on the broader financial one. A margin is
    // the cost figure with one subtraction applied; serving it to a profile
    // refused the cost itself would hand back the same fact rearranged.
    if (!canViewMoneyField(principal, "cost_rate")) {
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "The acting user profile cannot perform this operation.",
      });
    }
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const report = await reports.profitability(parsed.range);
    return context.json(
      {
        data: serializeProfitability(report),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/detailed-expense", async (context) => {
    requireApiScope(context, "reports:read");
    const parsed = rangeFrom(new URL(context.req.url), detailedExpenseKeys);
    const clientId = queryPositiveInteger(
      parsed.params,
      "client_id",
      parsed.errors,
    );
    const projectId = queryPositiveInteger(
      parsed.params,
      "project_id",
      parsed.errors,
    );
    const billableOnly = queryBoolean(
      parsed.params,
      "billable_only",
      parsed.errors,
    );
    assertFields(parsed.errors);
    const report = await reports.detailedExpense({
      ...parsed.range,
      ...(clientId === undefined ? {} : { clientId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(billableOnly === undefined ? {} : { billableOnly }),
    });
    return context.json(
      {
        data: serializeDetailedExpense(report, context.get("principal")),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/uninvoiced", async (context) => {
    requireApiScope(context, "reports:read");
    const parsed = rangeFrom(new URL(context.req.url), uninvoicedKeys);
    const clientId = queryPositiveInteger(
      parsed.params,
      "client_id",
      parsed.errors,
    );
    const projectId = queryPositiveInteger(
      parsed.params,
      "project_id",
      parsed.errors,
    );
    assertFields(parsed.errors);
    const principal = context.get("principal");
    const report = await reports.uninvoiced({
      ...parsed.range,
      ...(clientId === undefined ? {} : { clientId }),
      ...(projectId === undefined ? {} : { projectId }),
    });
    return context.json(
      {
        data: serializeUninvoiced(report, principal),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/client-rollups/:clientId", async (context) => {
    requireApiScope(context, "reports:read");
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const clientId = resourceId(context.req.param("clientId"), "client");
    const report = await reports.clientRollup(clientId, parsed.range);
    if (report === null) throw notFound("client");
    return context.json(
      {
        data: serializeClientRollup(report, context.get("principal")),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/project-budgets", async (context) => {
    // Visible wherever a project is visible, like the per-project report; the
    // repository applies the same assignment predicate, and the serializer the
    // same money gating.
    requireApiScope(context, "projects:read");
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const summaries = await reports.projectBudgetSummaries(
      parsed.range,
      context.get("principal"),
    );
    return context.json(
      {
        data: summaries.map((summary) =>
          serializeProjectBudgetSummary(summary, context.get("principal")),
        ),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  api.get("/reports/project-budget/:projectId", async (context) => {
    // The project budget surface is visible wherever a project is visible; its
    // serializer removes money fields according to the acting-user profile.
    requireApiScope(context, "projects:read");
    const parsed = rangeFrom(new URL(context.req.url), reportKeys);
    assertFields(parsed.errors);
    const projectId = resourceId(context.req.param("projectId"), "project");
    const report = await reports.projectBudget(
      projectId,
      parsed.range,
      context.get("principal"),
    );
    if (report === null) throw notFound("project");
    return context.json(
      {
        data: serializeProjectBudget(report, context.get("principal")),
        links: {
          self:
            new URL(context.req.url).pathname + new URL(context.req.url).search,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });
};

export {
  serializeClientRollup,
  serializeDetailedTime,
  serializeTimeReport,
  serializeMyHours,
  serializeProjectBudget,
  serializeProjectBudgetSummary,
  serializeUninvoiced,
};
