import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";

export const recordedResources = [
  "clients",
  "projects",
  "tasks",
  "users",
  "time_entries",
  "expenses",
  "invoices",
];
const fields = {
  invoices: [
    "id",
    "number",
    "purchase_order",
    "amount",
    "due_amount",
    "tax",
    "tax_amount",
    "tax2",
    "tax2_amount",
    "discount",
    "discount_amount",
    "subject",
    "notes",
    "state",
    "period_start",
    "period_end",
    "issue_date",
    "due_date",
    "payment_term",
    "sent_at",
    "paid_at",
    "paid_date",
    "closed_at",
    "recurring_invoice_id",
    "created_at",
    "updated_at",
    "currency",
    "payment_options",
    "client",
    "estimate",
    "retainer",
    "creator",
    "line_items",
  ],

  clients: [
    "id",
    "name",
    "is_active",
    "address",
    "currency",
    "created_at",
    "updated_at",
  ],
  projects: [
    "id",
    "name",
    "code",
    "is_active",
    "is_billable",
    "is_fixed_fee",
    "bill_by",
    "hourly_rate",
    "budget",
    "budget_by",
    "budget_is_monthly",
    "notify_when_over_budget",
    "over_budget_notification_percentage",
    "show_budget_to_all",
    "created_at",
    "updated_at",
    "starts_on",
    "ends_on",
    "notes",
    "cost_budget",
    "cost_budget_include_expenses",
    "fee",
    "client",
  ],
  tasks: [
    "id",
    "name",
    "billable_by_default",
    "is_default",
    "default_hourly_rate",
    "is_active",
    "created_at",
    "updated_at",
  ],
  users: [
    "id",
    "first_name",
    "last_name",
    "email",
    "telephone",
    "timezone",
    "has_access_to_all_future_projects",
    "is_contractor",
    "is_active",
    "weekly_capacity",
    "default_hourly_rate",
    "cost_rate",
    "roles",
    "access_roles",
    "avatar_url",
    "created_at",
    "updated_at",
  ],
  time_entries: [
    "id",
    "spent_date",
    "hours",
    "hours_without_timer",
    "rounded_hours",
    "notes",
    "is_locked",
    "locked_reason",
    "is_closed",
    "approval_status",
    "is_billed",
    "timer_started_at",
    "started_time",
    "ended_time",
    "is_running",
    "billable",
    "budgeted",
    "billable_rate",
    "cost_rate",
    "created_at",
    "updated_at",
    "user",
    "client",
    "project",
    "task",
    "user_assignment",
    "task_assignment",
    "invoice",
    "external_reference",
  ],
  expenses: [
    "id",
    "notes",
    "total_cost",
    "units",
    "is_closed",
    "approval_status",
    "is_locked",
    "is_billed",
    "locked_reason",
    "spent_date",
    "created_at",
    "updated_at",
    "billable",
    "user",
    "user_assignment",
    "project",
    "expense_category",
    "client",
    "invoice",
  ],
};
const types = [
  "clients",
  "projects",
  "tasks",
  "users",
  "time_entries",
  "expenses",
  "user_assignments",
  "task_assignments",
  "expense_categories",
  "invoices",
  "external",
  "invoice_lines",
  "estimates",
  "retainers",
  "recurring",
];
const date = (value) => {
  if (value == null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "2024-02-03";
  const shape =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(
      value,
    );
  if (!shape) throw new Error("Unsupported date representation");
  const offset =
    shape[2] === "Z" ? "Z" : shape[2].includes(":") ? "+00:00" : "+0000";
  return "2024-02-03T10:20:30" + (shape[1]?.replace(/\d/g, "1") ?? "") + offset;
};
const text = (value, replacement) =>
  value == null ? null : value === "" ? "" : replacement;
export const syntheticNumber = (value, duration = false) => {
  if (value == null || Number(value) === 0) return value;
  const raw = String(value),
    numeric = Number(value);
  if (!Number.isFinite(numeric) || !/^-?\d+(\.\d+)?$/.test(raw))
    throw new Error("Unsupported numeric representation");
  const precision = (raw.split(".")[1] ?? "").length;
  const whole = duration
    ? Math.abs(numeric) < 1
      ? 0
      : Math.abs(numeric) < 24
        ? 2
        : 26
    : 2;
  const magnitude = Number(
    whole + (precision ? "." + "2".repeat(precision) : ""),
  );
  const result = numeric < 0 ? -magnitude : magnitude;
  return typeof value === "string" ? result.toFixed(precision) : result;
};
const cents = (value) =>
  value == null ? null : Math.round(Number(value) * 100);
const seconds = (value) =>
  value == null ? null : Math.round(Number(value) * 3600);
const base = (r) => ({
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const user = (r) => ({
  ...base(r),
  firstName: r.first_name,
  lastName: r.last_name,
  email: r.email,
  telephone: r.telephone,
  timezone: r.timezone,
  hasAccessToAllFutureProjects: r.has_access_to_all_future_projects,
  isContractor: r.is_contractor,
  isActive: r.is_active,
  weeklyCapacity: r.weekly_capacity,
  profile: r.access_roles.includes("administrator")
    ? "administrator"
    : r.access_roles.includes("manager")
      ? "project_manager"
      : "member",
  managerGrants: r.access_roles.filter(
    (x) => !["administrator", "manager", "member"].includes(x),
  ),
  avatarUrl: r.avatar_url,
});
const client = (r) => ({
  ...base(r),
  name: r.name,
  isActive: r.is_active,
  address: r.address,
  currency: r.currency,
});
const project = (r) => ({
  ...base(r),
  name: r.name,
  code: r.code,
  isActive: r.is_active,
  clientId: r.client.id,
  billingMethod: r.is_fixed_fee
    ? "fixed_fee"
    : r.is_billable
      ? "time_materials"
      : "non_billable",
  billBy: r.bill_by?.toLowerCase() ?? null,
  hourlyRateCents: cents(r.hourly_rate),
  budgetSeconds: seconds(r.budget),
  budgetBy: r.budget_by,
  budgetIsMonthly: r.budget_is_monthly,
  notifyWhenOverBudget: r.notify_when_over_budget,
  overBudgetPct: r.over_budget_notification_percentage,
  showBudgetToAll: r.show_budget_to_all,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  notes: r.notes,
  costBudgetCents: cents(r.cost_budget),
  costBudgetIncludeExpenses: r.cost_budget_include_expenses,
  feeCents: cents(r.fee),
});
const task = (r) => ({
  ...base(r),
  name: r.name,
  billableByDefault: r.billable_by_default,
  isDefault: r.is_default,
  defaultHourlyRateCents: cents(r.default_hourly_rate),
  isActive: r.is_active,
});
const assignment = (r) =>
  r == null
    ? null
    : {
        ...base(r),
        isProjectManager: r.is_project_manager,
        isActive: r.is_active,
        billable: r.billable,
        hourlyRateCents: cents(r.hourly_rate),
        budgetSeconds: seconds(r.budget),
      };
const clockTime = (value) => {
  if (value == null) return null;
  const m = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(value);
  if (!m) throw new Error("Unsupported clock representation");
  return `${String((Number(m[1]) % 12) + (m[3] === "pm" ? 12 : m[3] ? 0 : Number(m[1]) >= 12 ? 12 : 0)).padStart(2, "0")}:${m[2]}`;
};
const state = (r) => ({
  approvalStatus: r.approval_status,
  invoiceId: r.invoice?.id ?? null,
  isBilled: r.is_billed,
  isLocked: r.is_locked,
  lockedReason: r.locked_reason,
  lockedReasonCode: null,
});

const enumValues = {
  state: new Set(["draft", "open", "paid", "closed"]),
  payment_term: new Set([
    "upon receipt",
    "net 15",
    "net 30",
    "net 45",
    "net 60",
    "custom",
  ]),
  payment_options: new Set(["ach", "credit_card", "paypal"]),
  currency: new Set(Intl.supportedValuesOf("currency")),
  bill_by: new Set(["Project", "Tasks", "People", "none"]),
  budget_by: new Set([
    "project",
    "project_cost",
    "task",
    "task_fees",
    "person",
    "none",
  ]),
  approval_status: new Set(["unsubmitted", "submitted", "approved"]),
  access_roles: new Set([
    "administrator",
    "manager",
    "member",
    "project_creator",
    "estimates_manager",
  ]),
};
const sourceEnum = (key, value) => {
  if (typeof value !== "string" || !enumValues[key].has(value))
    throw new Error(`Unsupported enum ${key}`);
  return value;
};
const booleanFields = new Set([
  "is_active",
  "is_billable",
  "is_fixed_fee",
  "budget_is_monthly",
  "notify_when_over_budget",
  "show_budget_to_all",
  "cost_budget_include_expenses",
  "billable_by_default",
  "is_default",
  "has_access_to_all_future_projects",
  "is_contractor",
  "is_locked",
  "is_closed",
  "is_billed",
  "is_running",
  "billable",
  "budgeted",
  "is_project_manager",
]);
const sourceBoolean = (value) => {
  if (typeof value !== "boolean")
    throw new Error("Unsupported boolean representation");
  return value;
};

const safeString = (value) =>
  [
    /^Sample (clients|projects|tasks|users|time_entries|expenses|invoices) (name|first_name|last_name|address|notes|locked_reason|subject|purchase_order) \d+$/,
    /^Sample users first_name \d+ Sample users last_name \d+$/,
    /^Sample (Role \d+|category \d+|unit|group|account)$/,
    /^[a-z]+@example\.test$/,
    /^https:\/\/example\.test\/(avatars\/\d+\.png|reference)$/,
    /^\+1 555 01\d\d$/,
    /^SMP-\d+$/,
    /^$/,
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/,
    /^[A-Z]{3}$/,
    /^(Etc\/UTC|America\/Costa_Rica)$/,
    /^\d{2}:\d{2}$/,
    /^\d{1,2}:\d{2}(am|pm)$/,
    /^-?\d+(\.\d+)?$/,
    /^(12h|24h|unsubmitted|submitted|approved|invoiced|Invoiced|draft|open|paid|closed|ach|credit_card|paypal|stripe_checkout|paypal_checkout|unsupported_ach|upon_receipt|net_15|net_30|net_45|net_60|upon receipt|net 15|net 30|net 45|net 60|custom)$/,
    /^(net_30|time_materials|fixed_fee|non_billable|project|tasks|people|person|none|project_cost|managers|member|administrator|project_manager|manager|project_creator|estimates_manager|Project|Tasks|People)$/,
  ].some((pattern) => pattern.test(value));
export const assertSynthetic = (value) => {
  if (typeof value === "string" && !safeString(value))
    throw new Error("Redaction produced an unsupported string");
  if (Array.isArray(value)) value.forEach(assertSynthetic);
  else if (value && typeof value === "object")
    Object.values(value).forEach(assertSynthetic);
};

/** Independent projection of recorded provider fields; never calls a shim serializer. */
export function createCorpus(source, timeLimit = 20) {
  const maps = new Map(
    types.map((kind, index) => [
      kind,
      new Map(
        (source[kind] ?? []).map((r, i) => [
          String(r.id),
          (index + 1) * 1000 + i + 1,
        ]),
      ),
    ]),
  );
  const id = (kind, value) => {
    if (value == null) return null;
    const map = maps.get(kind);
    if (!map.has(String(value)))
      map.set(String(value), (types.indexOf(kind) + 1) * 1000 + map.size + 1);
    return map.get(String(value));
  };
  const ref = (kind, r) =>
    r == null
      ? null
      : {
          id: id(kind, r.id),
          name: `Sample ${kind} name ${id(kind, r.id)}`,
          ...(kind === "clients"
            ? { currency: sourceEnum("currency", r.currency) }
            : {}),
          ...(kind === "projects"
            ? { code: text(r.code, `SMP-${id(kind, r.id)}`) }
            : {}),
        };
  const asn = (kind, r) =>
    r == null
      ? null
      : {
          id: id(kind, r.id),
          ...(kind === "user_assignments"
            ? { is_project_manager: sourceBoolean(r.is_project_manager) }
            : { billable: sourceBoolean(r.billable) }),
          is_active: sourceBoolean(r.is_active),
          ...(kind === "user_assignments"
            ? { budget: syntheticNumber(r.budget, true) }
            : {}),
          created_at: date(r.created_at),
          updated_at: date(r.updated_at),
          hourly_rate: syntheticNumber(r.hourly_rate),
          ...(kind === "task_assignments"
            ? { budget: syntheticNumber(r.budget, true) }
            : {}),
        };
  const safe = (kind, r) => {
    const s = {};
    for (const key of fields[kind]) {
      if (!(key in r)) throw new Error(`Missing recorded field ${kind}.${key}`);
      const value = r[key];
      if (key === "id") s[key] = id(kind, value);
      else if (
        [
          "created_at",
          "updated_at",
          "timer_started_at",
          "spent_date",
          "starts_on",
          "ends_on",
          "period_start",
          "period_end",
          "issue_date",
          "due_date",
          "sent_at",
          "paid_at",
          "paid_date",
          "closed_at",
        ].includes(key)
      )
        s[key] = date(value);
      else if (
        [
          "name",
          "first_name",
          "last_name",
          "address",
          "notes",
          "locked_reason",
          "subject",
          "purchase_order",
        ].includes(key)
      )
        s[key] = text(value, `Sample ${kind} ${key} ${id(kind, r.id)}`);
      else if (key === "code") s[key] = text(value, `SMP-${id(kind, r.id)}`);
      else if (key === "email") s[key] = text(value, "sample@example.test");
      else if (key === "telephone") s[key] = text(value, "+1 555 0100");
      else if (key === "timezone")
        s[key] = value === "Etc/UTC" ? "Etc/UTC" : "America/Costa_Rica";
      else if (key === "avatar_url")
        s[key] = text(
          value,
          `https://example.test/avatars/${id(kind, r.id)}.png`,
        );
      else if (key === "roles")
        s[key] = value.map((_, i) => `Sample Role ${i + 1}`);
      else if (key === "access_roles")
        s[key] = value.map((role) => sourceEnum("access_roles", role));
      else if (key === "number") s[key] = `SMP-${id(kind, r.id)}`;
      else if (key === "recurring_invoice_id")
        s[key] = value == null ? null : id("recurring", value);
      else if (["estimate", "retainer"].includes(key))
        s[key] = value == null ? null : { id: id(key + "s", value.id) };
      else if (key === "creator")
        s[key] =
          value == null
            ? null
            : {
                id: id("users", value.id),
                name: `Sample users first_name ${id("users", value.id)} Sample users last_name ${id("users", value.id)}`,
              };
      else if (key === "payment_options")
        s[key] = value.map((option) => sourceEnum("payment_options", option));
      else if (key === "client" && kind === "invoices")
        s[key] = {
          id: id("clients", value.id),
          name: `Sample clients name ${id("clients", value.id)}`,
        };
      else if (key === "line_items")
        s[key] = value.map((line, index) => ({
          id: id("invoice_lines", line.id),
          kind: `Sample category ${index + 1}`,
          description: text(
            line.description,
            `Sample invoices notes ${id(kind, r.id)}`,
          ),
          quantity: syntheticNumber(line.quantity),
          unit_price: syntheticNumber(line.unit_price),
          amount: syntheticNumber(line.amount),
          taxed: sourceBoolean(line.taxed),
          taxed2: sourceBoolean(line.taxed2),
          project: ref("projects", line.project),
        }));
      else if (["client", "project", "task"].includes(key))
        s[key] = ref(key + "s", value);
      else if (key === "user")
        s[key] = {
          id: id("users", value.id),
          name: `Sample users first_name ${id("users", value.id)} Sample users last_name ${id("users", value.id)}`,
        };
      else if (key === "user_assignment")
        s[key] = asn("user_assignments", value);
      else if (key === "task_assignment")
        s[key] = asn("task_assignments", value);
      else if (key === "invoice")
        s[key] =
          value == null
            ? null
            : {
                id: id("invoices", value.id),
                number: `${id("invoices", value.id)}`,
              };
      else if (key === "expense_category")
        s[key] = {
          id: id("expense_categories", value.id),
          name: `Sample category ${id("expense_categories", value.id)}`,
          unit_name: text(value.unit_name, "Sample unit"),
          unit_price: syntheticNumber(value.unit_price),
        };
      else if (key === "external_reference")
        s[key] =
          value == null
            ? null
            : {
                id: `${id("external", value.id)}`,
                group_id: text(value.group_id, "Sample group"),
                account_id: text(value.account_id, "Sample account"),
                permalink: text(
                  value.permalink,
                  "https://example.test/reference",
                ),
              };
      else if (["started_time", "ended_time"].includes(key))
        s[key] = text(
          value,
          /pm$/.test(value) ? "8:30pm" : /am$/.test(value) ? "8:30am" : "08:30",
        );
      else if (
        ["hours", "hours_without_timer", "rounded_hours", "budget"].includes(
          key,
        )
      )
        s[key] = syntheticNumber(value, true);
      else if (enumValues[key]) s[key] = sourceEnum(key, value);
      else if (booleanFields.has(key)) s[key] = sourceBoolean(value);
      else if (
        typeof value === "number" ||
        (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))
      )
        s[key] = syntheticNumber(value);
      else if (value === null) s[key] = value;
      else throw new Error(`Unsupported recorded field ${kind}.${key}`);
    }
    return s;
  };
  const byId = (kind) =>
    new Map((source[kind] ?? []).map((r) => [id(kind, r.id), r]));
  const clients = byId("clients"),
    projects = byId("projects");
  const numberShape = (value) =>
    [
      typeof value,
      String(value).split(".")[1]?.length ?? 0,
      Number(value) === 0
        ? "zero"
        : Number(value) < 0
          ? "negative"
          : Number(value) < 1
            ? "fraction"
            : Number(value) < 24
              ? "day"
              : "multi-day",
    ].join(":");
  const chooseTime = (rows) => {
    const selected = [],
      seen = new Set();
    for (const row of rows) {
      const shape = JSON.stringify([
        numberShape(row.hours),
        numberShape(row.hours_without_timer),
        numberShape(row.rounded_hours),
        row.is_running,
        row.is_locked,
        row.is_billed,
        row.approval_status,
        row.external_reference !== null,
        row.invoice !== null,
      ]);
      if (!seen.has(shape)) {
        seen.add(shape);
        selected.push(row);
      }
      if (selected.length === timeLimit) break;
    }
    for (const row of rows) {
      if (selected.length === timeLimit) break;
      if (!selected.includes(row)) selected.push(row);
    }
    return selected;
  };
  const chooseInvoices = (rows) => {
    const eligible = rows.filter(
      (row) =>
        row.creator == null ||
        (row.creator.name !== null &&
          (source.users ?? []).some((user) => user.id === row.creator.id)),
    );
    const selected = [],
      seen = new Set();
    for (const row of eligible) {
      const shape = JSON.stringify([
        row.state,
        row.currency,
        row.payment_term,
        row.discount === null,
        row.discount === 0,
        row.estimate !== null,
        row.retainer !== null,
        row.payment_options,
      ]);
      if (!seen.has(shape)) {
        seen.add(shape);
        selected.push(row);
      }
      if (selected.length === 20) break;
    }
    for (const row of eligible) {
      if (selected.length === 20) break;
      if (!selected.includes(row)) selected.push(row);
    }
    return selected;
  };
  const pairs = [];
  for (const kind of recordedResources) {
    const rows =
      kind === "time_entries"
        ? chooseTime(source[kind] ?? [])
        : kind === "invoices"
          ? chooseInvoices(source[kind] ?? [])
          : (source[kind] ?? []);
    for (const [index, r] of rows.entries()) {
      const g = safe(kind, r);
      let input;
      if (kind === "clients") input = client(g);
      else if (kind === "tasks") input = task(g);
      else if (kind === "users")
        input = {
          user: user(g),
          context: {
            roleNames: g.roles,
            defaultHourlyRateCents: cents(g.default_hourly_rate),
            costRateCents: cents(g.cost_rate),
          },
        };
      else if (kind === "invoices") {
        input = {
          invoice: {
            id: g.id,
            number: g.number,
            purchase_order: g.purchase_order,
            subject: g.subject,
            notes: g.notes,
            amount_cents: cents(g.amount),
            due_amount_cents: cents(g.due_amount),
            tax_rate_ppm: g.tax == null ? null : Math.round(g.tax * 10000),
            tax_amount_cents: cents(g.tax_amount),
            tax2_rate_ppm: g.tax2 == null ? null : Math.round(g.tax2 * 10000),
            tax2_amount_cents: cents(g.tax2_amount),
            discount_rate_ppm:
              g.discount == null ? null : Math.round(g.discount * 10000),
            discount_amount_cents: cents(g.discount_amount),
            state: g.state,
            currency: g.currency,
            period_start: g.period_start,
            period_end: g.period_end,
            issue_date: g.issue_date,
            due_date: g.due_date,
            payment_terms: g.payment_term.replaceAll(" ", "_"),
            payment_options: g.payment_options.map((option) =>
              option === "credit_card"
                ? "stripe_checkout"
                : option === "paypal"
                  ? "paypal_checkout"
                  : "unsupported_ach",
            ),
            sent_at: g.sent_at,
            paid_at: g.paid_at,
            paid_date: g.paid_date,
            closed_at: g.closed_at,
            recurring_invoice_id: g.recurring_invoice_id,
            created_at: g.created_at,
            updated_at: g.updated_at,
            estimate_id: g.estimate?.id ?? null,
            retainer_id: g.retainer?.id ?? null,
            line_items: g.line_items.map((line) => ({
              id: line.id,
              kind: line.kind,
              description: line.description,
              quantity: line.quantity,
              unit_price_cents: cents(line.unit_price),
              amount_cents: cents(line.amount),
              taxed: line.taxed,
              taxed2: line.taxed2,
              project_id: line.project?.id ?? null,
            })),
          },
          client: g.client,
          creator: g.creator,
          projects: [
            ...new Map(
              g.line_items
                .filter((line) => line.project !== null)
                .map((line) => [line.project.id, line.project]),
            ).values(),
          ],
        };
      } else if (kind === "projects")
        input = {
          project: project(g),
          client: client(safe("clients", clients.get(g.client.id))),
        };
      else {
        const p = safe("projects", projects.get(g.project.id)),
          c = safe("clients", clients.get(g.client.id));
        const ctx = {
          user: {
            id: g.user.id,
            firstName: `Sample users first_name ${g.user.id}`,
            lastName: `Sample users last_name ${g.user.id}`,
            createdAt: g.created_at,
            updatedAt: g.updated_at,
          },
          project: project(p),
          client: client(c),
          userAssignment: assignment(g.user_assignment),
          isBilled: g.is_billed,
          lockedReason: g.locked_reason,
          invoice: g.invoice,
        };
        const common = {
          ...base(g),
          spentDate: g.spent_date,
          notes: g.notes,
          billable: g.billable,
          state: state(g),
        };
        if (kind === "expenses")
          input = {
            expense: {
              ...common,
              totalCostCents: cents(g.total_cost),
              units: g.units,
            },
            context: {
              ...ctx,
              expenseCategory: {
                id: g.expense_category.id,
                name: g.expense_category.name,
                unitName: g.expense_category.unit_name,
                unitPriceCents: cents(g.expense_category.unit_price),
              },
            },
          };
        else
          input = {
            entry: {
              ...common,
              seconds: seconds(g.hours),
              secondsWithoutTimer: seconds(g.hours_without_timer),
              roundedSeconds: seconds(g.rounded_hours),
              timerStartedAt: g.timer_started_at,
              startedTime: clockTime(g.started_time),
              endedTime: clockTime(g.ended_time),
              budgeted: g.budgeted,
              externalRef: g.external_reference,
            },
            context: {
              ...ctx,
              clock: /[ap]m$/.test(g.started_time ?? g.ended_time ?? "")
                ? "12h"
                : "24h",
              task: {
                id: g.task.id,
                name: g.task.name,
                createdAt: g.created_at,
                updatedAt: g.updated_at,
              },
              taskAssignment: assignment(g.task_assignment),
              billableRateCents: cents(g.billable_rate),
              costRateCents: cents(g.cost_rate),
            },
          };
      }
      assertSynthetic(input);
      assertSynthetic(g);
      pairs.push({
        resource: kind,
        name: `snapshot-${String(index + 1).padStart(3, "0")}`,
        input,
        golden: g,
      });
    }
  }
  return pairs;
}

export async function generate(sourceDirectory, outputDirectory) {
  const sourceRoot = await realpath(resolve(sourceDirectory));
  const outputParent = await realpath(dirname(resolve(outputDirectory)));
  const out = join(outputParent, basename(outputDirectory));
  if (out === sourceRoot || out.startsWith(sourceRoot + "/"))
    throw new Error("Output must be separate from private source");
  await mkdir(out, { mode: 0o700 }); // Deliberately refuses an existing output.
  const source = {};
  for (const kind of types.filter((x) => x !== "external")) {
    try {
      source[kind] = (
        await readFile(join(sourceRoot, "raw", kind + ".jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw new Error(`Cannot read private resource ${kind}`);
      source[kind] = [];
    }
  }
  const pairs = createCorpus(source);
  for (const pair of pairs) {
    await mkdir(join(out, pair.resource), { recursive: true, mode: 0o700 });
    for (const kind of ["input", "golden"])
      await writeFile(
        join(out, pair.resource, `${pair.name}.${kind}.json`),
        JSON.stringify(pair[kind], null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
  }
  const manifest = await readFile(join(sourceRoot, "manifest.json"));
  const evidence = {
    kind: "redacted-recorded-subset",
    source_manifest_sha256: createHash("sha256").update(manifest).digest("hex"),
    counts: Object.fromEntries(
      recordedResources.map((r) => [
        r,
        pairs.filter((p) => p.resource === r).length,
      ]),
    ),
    invoice_unrepresented_creator_records: (source.invoices ?? []).filter(
      (row) =>
        row.creator != null &&
        (row.creator.name === null ||
          !(source.users ?? []).some((user) => user.id === row.creator.id)),
    ).length,
    project_assignments:
      "Not generated: no recorded endpoint response in source",
    unsupported_field_counts: Object.fromEntries(
      recordedResources.map((r) => [
        r,
        new Set(
          (source[r] ?? []).flatMap((o) =>
            Object.keys(o).filter((k) => !fields[r].includes(k)),
          ),
        ).size,
      ]),
    ),
    projection_fields: fields,
  };
  await writeFile(
    join(out, "provenance.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [source, out] = process.argv.slice(2);
  if (!source || !out)
    throw new Error(
      "Usage: node scripts/harvest-shim-corpus.mjs PRIVATE_SNAPSHOT NEW_OUTPUT",
    );
  try {
    const result = await generate(source, out);
    console.log(
      JSON.stringify({ counts: result.counts, provenance: result.kind }),
    );
  } catch {
    console.error(
      "Harvest corpus generation failed; no private input values are logged. Inspect inputs locally.",
    );
    process.exitCode = 1;
  }
}
