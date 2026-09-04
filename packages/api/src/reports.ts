import { canViewMoneyField } from "@ezacto/core";
import type { Hono } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext, UserPrincipal } from "./context.js";
import type { FieldError } from "./errors.js";
import {
  assertFields,
  notFound,
  queryDate,
  queryPositiveInteger,
  resourceId,
  strictSearchParams,
} from "./resources/support.js";

export interface ReportDateRange {
  from: string;
  to: string;
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

export interface ProjectBudgetReportRecord extends ReportDateRange {
  projectId: number;
  budgetBy:
    "project" | "project_cost" | "task" | "task_fees" | "person" | "none";
  expensesIncluded: boolean;
  grains: readonly ProjectBudgetGrainRecord[];
}

export interface ProjectReportViewer {
  userId: number;
  profile: UserPrincipal["profile"];
}

export interface ReportReader {
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
}

const reportKeys = new Set(["from", "to"]);
const uninvoicedKeys = new Set([...reportKeys, "client_id", "project_id"]);

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

export const installReportRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  reports: ReportReader,
): void => {
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

export { serializeClientRollup, serializeProjectBudget, serializeUninvoiced };
