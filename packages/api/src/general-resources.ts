import {
  GeneralResourceError,
  type GeneralMutationInput,
  type GeneralResourceFilters,
  type GeneralResourceKind,
  type GeneralResourceRecord,
  type GeneralResourceRepository,
  type GeneralValue,
  type UserRateKind,
  type UserRateRecord,
} from "@ezacto/core";
import type { Context, Hono } from "hono";
import { requireApiScope, requireSessionPrincipal } from "./auth.js";
import type { ApiContext, UserPrincipal, UserProfile } from "./context.js";
import {
  ApiError,
  readJsonBody,
  validationError,
  type FieldError,
} from "./errors.js";
import { cursorPage } from "./pagination.js";

export interface GeneralResourceRouteOptions {
  repository: GeneralResourceRepository;
  cursorSigningKey: Uint8Array;
  clock?: () => string;
}

type FieldType =
  | "string"
  | "nullable-string"
  | "boolean"
  | "positive-int"
  | "nullable-positive-int"
  | "nonnegative-int"
  | "nullable-nonnegative-int"
  | "nonnegative-number"
  | "nullable-nonnegative-number"
  | "string-array"
  | "positive-int-array"
  | "enum"
  | "nullable-date";
interface FieldSpec {
  type: FieldType;
  values?: readonly string[];
}
interface ResourceRouteDefinition {
  fields: Readonly<Record<string, FieldSpec>>;
  required: ReadonlySet<string>;
  filters: Readonly<Record<string, keyof GeneralResourceFilters>>;
}

const managerGrantValues = [
  "project_creator",
  "billable_rates_manager",
  "managed_projects_invoice_drafter",
  "managed_projects_invoice_manager",
  "client_and_task_manager",
  "time_and_expenses_manager",
  "estimates_manager",
] as const;

const string = { type: "string" } as const;
const nullableString = { type: "nullable-string" } as const;
const bool = { type: "boolean" } as const;
const positiveInt = { type: "positive-int" } as const;
const nonnegativeInt = { type: "nonnegative-int" } as const;
const nullableNonnegativeInt = { type: "nullable-nonnegative-int" } as const;
const nullableNonnegativeNumber = {
  type: "nullable-nonnegative-number",
} as const;
const valueEnum = (...values: string[]): FieldSpec => ({
  type: "enum",
  values,
});

const routeDefinitions: Readonly<
  Record<GeneralResourceKind, ResourceRouteDefinition>
> = {
  clients: {
    fields: {
      name: string,
      address: nullableString,
      currency: string,
      is_active: bool,
      parent_client_id: { type: "nullable-positive-int" },
      bill_to_client_id: { type: "nullable-positive-int" },
      payment_terms: valueEnum(
        "upon_receipt",
        "net_15",
        "net_30",
        "net_45",
        "net_60",
        "custom",
      ),
      default_tax_pct: nullableNonnegativeNumber,
      default_tax2_pct: nullableNonnegativeNumber,
      default_discount_pct: nullableNonnegativeNumber,
    },
    required: new Set(["name"]),
    filters: {
      is_active: "isActive",
      updated_since: "updatedSince",
      parent_client_id: "parentClientId",
      bill_to_client_id: "billToClientId",
    },
  },
  contacts: {
    fields: {
      client_id: positiveInt,
      title: nullableString,
      first_name: string,
      last_name: nullableString,
      email: nullableString,
      phone_office: nullableString,
      phone_mobile: nullableString,
      fax: nullableString,
      invoice_recipient_status: valueEnum("none", "recipient", "cc", "bcc"),
    },
    required: new Set(["client_id", "first_name"]),
    filters: { client_id: "clientId", updated_since: "updatedSince" },
  },
  projects: {
    fields: {
      client_id: positiveInt,
      name: string,
      code: string,
      is_active: bool,
      billing_method: valueEnum("non_billable", "time_materials", "fixed_fee"),
      bill_by: valueEnum("project", "tasks", "people", "none"),
      hourly_rate_cents: nullableNonnegativeInt,
      fee_cents: nullableNonnegativeInt,
      budget_by: valueEnum(
        "project",
        "project_cost",
        "task",
        "task_fees",
        "person",
        "none",
      ),
      budget_seconds: nullableNonnegativeInt,
      cost_budget_cents: nullableNonnegativeInt,
      budget_is_monthly: bool,
      cost_budget_include_expenses: bool,
      notify_when_over_budget: bool,
      over_budget_pct: nullableNonnegativeNumber,
      show_budget_to_all: bool,
      report_visibility: valueEnum("managers", "everyone"),
      starts_on: { type: "nullable-date" },
      ends_on: { type: "nullable-date" },
      notes: nullableString,
      billing_currency: nullableString,
    },
    required: new Set(["client_id", "name"]),
    filters: {
      client_id: "clientId",
      is_active: "isActive",
      updated_since: "updatedSince",
    },
  },
  tasks: {
    fields: {
      name: string,
      billable_by_default: bool,
      default_hourly_rate_cents: nullableNonnegativeInt,
      is_default: bool,
      is_active: bool,
    },
    required: new Set(["name"]),
    filters: { is_active: "isActive", updated_since: "updatedSince" },
  },
  "task-assignments": {
    fields: {
      project_id: positiveInt,
      task_id: positiveInt,
      is_active: bool,
      billable: bool,
      hourly_rate_cents: nullableNonnegativeInt,
      budget_seconds: nullableNonnegativeInt,
      budget_cents: nullableNonnegativeInt,
    },
    required: new Set(["project_id", "task_id"]),
    filters: {
      project_id: "projectId",
      task_id: "taskId",
      is_active: "isActive",
      updated_since: "updatedSince",
    },
  },
  "user-assignments": {
    fields: {
      project_id: positiveInt,
      user_id: positiveInt,
      is_active: bool,
      is_project_manager: bool,
      use_default_rates: bool,
      hourly_rate_cents: nullableNonnegativeInt,
      budget_seconds: nullableNonnegativeInt,
    },
    required: new Set(["project_id", "user_id"]),
    filters: {
      project_id: "projectId",
      user_id: "userId",
      is_active: "isActive",
      updated_since: "updatedSince",
    },
  },
  users: {
    fields: {
      first_name: string,
      last_name: string,
      email: string,
      telephone: nullableString,
      employee_id: nullableString,
      timezone: string,
      is_contractor: bool,
      is_active: bool,
      has_access_to_all_future_projects: bool,
      weekly_capacity: nonnegativeInt,
      profile: valueEnum(
        "member",
        "project_manager",
        "people_admin",
        "accounting",
        "executive_manager",
        "administrator",
      ),
      manager_grants: { type: "string-array", values: managerGrantValues },
      avatar_url: nullableString,
      saml_exempt: bool,
    },
    required: new Set(["first_name", "last_name", "email"]),
    filters: {
      is_active: "isActive",
      updated_since: "updatedSince",
      profile: "profile",
      is_contractor: "isContractor",
    },
  },
  roles: {
    fields: { name: string, user_ids: { type: "positive-int-array" } },
    required: new Set(["name"]),
    filters: {},
  },
};

const camel = (value: string): string =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const snake = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const canonicalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const serializeRaw = (
  record: Readonly<GeneralResourceRecord | UserRateRecord>,
): Record<string, GeneralValue> => {
  const output: Record<string, GeneralValue> = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === "harvestId") continue;
    output[snake(field)] = value;
  }
  return output;
};

const moneyProfiles: ReadonlySet<UserProfile> = new Set([
  "accounting",
  "executive_manager",
  "administrator",
]);

const canSeeBillableMoney = (viewer: Readonly<UserPrincipal>): boolean =>
  moneyProfiles.has(viewer.profile) ||
  (viewer.profile === "project_manager" &&
    viewer.managerGrants.includes("billable_rates_manager"));

const canSeeMoneyBudgets = (viewer: Readonly<UserPrincipal>): boolean =>
  moneyProfiles.has(viewer.profile);

const hiddenGeneralField = (
  kind: GeneralResourceKind,
  field: string,
  viewer: Readonly<UserPrincipal>,
): boolean => {
  if (kind === "projects") {
    if (field === "notes") return viewer.profile !== "administrator";
    if (field === "hourlyRateCents" || field === "feeCents")
      return !canSeeBillableMoney(viewer);
    if (field === "costBudgetCents") return !canSeeMoneyBudgets(viewer);
  }
  if (
    (kind === "tasks" && field === "defaultHourlyRateCents") ||
    ((kind === "task-assignments" || kind === "user-assignments") &&
      field === "hourlyRateCents")
  ) {
    return !canSeeBillableMoney(viewer);
  }
  if (kind === "task-assignments" && field === "budgetCents")
    return !canSeeMoneyBudgets(viewer);
  if (
    kind === "users" &&
    (field === "managerGrants" || field === "samlExempt")
  ) {
    return viewer.profile !== "administrator";
  }
  return false;
};

const serializeGeneral = (
  kind: GeneralResourceKind,
  record: Readonly<GeneralResourceRecord>,
  viewer: Readonly<UserPrincipal>,
): Record<string, GeneralValue> => {
  const visible = Object.fromEntries(
    Object.entries(record).filter(
      ([field]) => !hiddenGeneralField(kind, field, viewer),
    ),
  ) as GeneralResourceRecord;
  return serializeRaw(visible);
};

const objectBody = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<Record<string, unknown>> => {
  const body = await readJsonBody<unknown>(context);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError([
      {
        field: "body",
        code: "invalid",
        message: "request body must be a JSON object",
      },
    ]);
  }
  return body as Record<string, unknown>;
};

const parseField = (
  field: string,
  value: unknown,
  spec: FieldSpec,
  errors: FieldError[],
): GeneralValue | undefined => {
  const invalid = (code: string, message: string): undefined => {
    errors.push({ field, code, message });
    return undefined;
  };
  if (spec.type === "string")
    return typeof value === "string" && value.trim().length > 0
      ? value
      : invalid("invalid_string", `${field} must be a non-empty string`);
  if (spec.type === "nullable-string")
    return value === null || typeof value === "string"
      ? value
      : invalid("invalid_string", `${field} must be a string or null`);
  if (spec.type === "boolean")
    return typeof value === "boolean"
      ? value
      : invalid("invalid_boolean", `${field} must be a boolean`);
  if (spec.type === "positive-int")
    return Number.isSafeInteger(value) && (value as number) > 0
      ? (value as number)
      : invalid("invalid_integer", `${field} must be a positive safe integer`);
  if (spec.type === "nullable-positive-int")
    return value === null ||
      (Number.isSafeInteger(value) && (value as number) > 0)
      ? (value as number | null)
      : invalid(
          "invalid_integer",
          `${field} must be a positive safe integer or null`,
        );
  if (spec.type === "nonnegative-int")
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : invalid(
          "invalid_integer",
          `${field} must be a non-negative safe integer`,
        );
  if (spec.type === "nullable-nonnegative-int")
    return value === null ||
      (Number.isSafeInteger(value) && (value as number) >= 0)
      ? (value as number | null)
      : invalid(
          "invalid_integer",
          `${field} must be a non-negative safe integer or null`,
        );
  if (spec.type === "nonnegative-number")
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : invalid(
          "invalid_number",
          `${field} must be a non-negative finite number`,
        );
  if (spec.type === "nullable-nonnegative-number")
    return value === null ||
      (typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? (value as number | null)
      : invalid(
          "invalid_number",
          `${field} must be a non-negative finite number or null`,
        );
  if (spec.type === "enum")
    return typeof value === "string" && spec.values?.includes(value)
      ? value
      : invalid("invalid_enum", `${field} is not an accepted value`);
  if (spec.type === "nullable-date")
    return value === null || (typeof value === "string" && canonicalDate(value))
      ? (value as string | null)
      : invalid(
          "invalid_date",
          `${field} must be a real canonical date or null`,
        );
  if (spec.type === "string-array")
    return Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === "string" &&
          (spec.values === undefined || spec.values.includes(item)),
      ) &&
      new Set(value).size === value.length
      ? (value as string[])
      : invalid(
          "invalid_array",
          `${field} must contain distinct accepted strings`,
        );
  return Array.isArray(value) &&
    value.every((item) => Number.isSafeInteger(item) && item > 0) &&
    new Set(value).size === value.length
    ? (value as number[])
    : invalid(
        "invalid_array",
        `${field} must contain distinct positive safe integers`,
      );
};

const parseMutation = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  definition: ResourceRouteDefinition,
  create: boolean,
): Promise<GeneralMutationInput> => {
  const body = await objectBody(context);
  const errors: FieldError[] = [];
  const output: Record<string, GeneralValue> = {};
  for (const field of Object.keys(body)) {
    const spec = definition.fields[field];
    if (spec === undefined) {
      errors.push({
        field,
        code: "unknown",
        message: `${field} is not accepted`,
      });
      continue;
    }
    const value = parseField(field, body[field], spec, errors);
    if (value !== undefined) output[camel(field)] = value;
  }
  if (create)
    for (const field of definition.required)
      if (!Object.hasOwn(body, field))
        errors.push({
          field,
          code: "required",
          message: `${field} is required`,
        });
  if (!create && Object.keys(body).length === 0)
    errors.push({
      field: "body",
      code: "empty",
      message: "at least one field is required",
    });
  if (errors.length > 0) throw validationError(errors);
  return output;
};

const singleQuery = (url: URL, name: string): string | undefined => {
  const values = url.searchParams.getAll(name);
  if (values.length > 1)
    throw validationError([
      { field: name, code: "duplicate", message: `${name} may appear once` },
    ]);
  return values[0];
};

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const parseFilters = (
  url: URL,
  definition: ResourceRouteDefinition,
): GeneralResourceFilters => {
  const allowed = new Set([
    "per_page",
    "cursor",
    ...Object.keys(definition.filters),
  ]);
  const errors: FieldError[] = [];
  for (const key of url.searchParams.keys())
    if (!allowed.has(key))
      errors.push({
        field: key,
        code: "unknown",
        message: `${key} is not accepted`,
      });
  const filters: GeneralResourceFilters = {};
  for (const [query, field] of Object.entries(definition.filters)) {
    const raw = singleQuery(url, query);
    if (raw === undefined) continue;
    if (query === "is_active" || query === "is_contractor") {
      if (raw !== "true" && raw !== "false")
        errors.push({
          field: query,
          code: "invalid_boolean",
          message: `${query} must be true or false`,
        });
      else Object.assign(filters, { [field]: raw === "true" });
    } else if (query === "updated_since") {
      if (!timestampPattern.test(raw) || !Number.isFinite(Date.parse(raw)))
        errors.push({
          field: query,
          code: "invalid_timestamp",
          message: `${query} must be a canonical UTC timestamp`,
        });
      else Object.assign(filters, { [field]: raw });
    } else if (query === "profile") {
      if (!routeDefinitions.users.fields.profile!.values!.includes(raw))
        errors.push({
          field: query,
          code: "invalid_enum",
          message: `${query} is not an accepted value`,
        });
      else Object.assign(filters, { [field]: raw });
    } else if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      errors.push({
        field: query,
        code: "invalid_integer",
        message: `${query} must be a positive safe integer`,
      });
    else Object.assign(filters, { [field]: Number(raw) });
  }
  if (errors.length > 0) throw validationError(errors);
  return filters;
};

const resourceId = (raw: string | undefined): number => {
  if (
    raw === undefined ||
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  ) {
    throw validationError([
      {
        field: "id",
        code: "invalid_integer",
        message: "id must be a positive safe integer",
      },
    ]);
  }
  return Number(raw);
};

const translate = (error: unknown): never => {
  if (!(error instanceof GeneralResourceError)) throw error;
  if (error.code === "not_found")
    throw new ApiError({
      status: 404,
      code: "not_found",
      message: error.message,
    });
  if (error.code === "conflict" || error.code === "in_use")
    throw new ApiError({
      status: 409,
      code: error.code,
      message: error.message,
    });
  throw validationError([
    { field: error.field ?? "body", code: error.code, message: error.message },
  ]);
};

const profileForbidden = (): never => {
  throw new ApiError({
    status: 403,
    code: "profile_forbidden",
    message: "The acting user profile cannot perform this operation.",
  });
};

const sessionWriteProfiles: Readonly<
  Partial<Record<GeneralResourceKind, ReadonlySet<UserProfile>>>
> = {
  "user-assignments": new Set([
    "project_manager",
    "people_admin",
    "executive_manager",
    "administrator",
  ]),
  users: new Set(["people_admin", "executive_manager", "administrator"]),
  roles: new Set(["people_admin", "executive_manager", "administrator"]),
};

const resourceScopes: Readonly<
  Record<
    Exclude<GeneralResourceKind, "user-assignments" | "users" | "roles">,
    {
      read: "clients:read" | "projects:read";
      write: "clients:write" | "projects:write";
    }
  >
> = {
  clients: { read: "clients:read", write: "clients:write" },
  contacts: { read: "clients:read", write: "clients:write" },
  projects: { read: "projects:read", write: "projects:write" },
  tasks: { read: "projects:read", write: "projects:write" },
  "task-assignments": { read: "projects:read", write: "projects:write" },
};

const requireResourceRead = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  kind: GeneralResourceKind,
): UserPrincipal => {
  const access = resourceScopes[kind as keyof typeof resourceScopes] as
    (typeof resourceScopes)[keyof typeof resourceScopes] | undefined;
  requireApiScope(context, access?.read ?? "team:read");
  return context.get("principal");
};

const requireResourceWrite = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  kind: GeneralResourceKind,
): UserPrincipal => {
  const profiles = sessionWriteProfiles[kind];
  if (profiles !== undefined) {
    const principal = requireSessionPrincipal(context);
    if (!profiles.has(principal.profile)) return profileForbidden();
    return principal;
  }
  const access = resourceScopes[kind as keyof typeof resourceScopes]!;
  requireApiScope(context, access.write);
  return context.get("principal");
};

const authorizeMutationFields = (
  kind: GeneralResourceKind,
  input: Readonly<GeneralMutationInput>,
  principal: Readonly<UserPrincipal>,
): void => {
  const fields = new Set(Object.keys(input));
  if (
    kind === "users" &&
    ["profile", "managerGrants", "samlExempt"].some((field) =>
      fields.has(field),
    ) &&
    principal.profile !== "administrator"
  ) {
    return profileForbidden();
  }
  if (
    kind === "projects" &&
    fields.has("notes") &&
    principal.profile !== "administrator"
  ) {
    return profileForbidden();
  }
  if (
    ((kind === "projects" &&
      (fields.has("hourlyRateCents") || fields.has("feeCents"))) ||
      (kind === "tasks" && fields.has("defaultHourlyRateCents")) ||
      ((kind === "task-assignments" || kind === "user-assignments") &&
        fields.has("hourlyRateCents"))) &&
    !canSeeBillableMoney(principal)
  ) {
    return profileForbidden();
  }
  if (
    ((kind === "projects" && fields.has("costBudgetCents")) ||
      (kind === "task-assignments" && fields.has("budgetCents"))) &&
    !canSeeMoneyBudgets(principal)
  ) {
    return profileForbidden();
  }
};

const requireRateRead = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  kind: UserRateKind,
): UserPrincipal => {
  const principal = context.get("principal");
  if (kind === "cost") {
    if (principal.profile !== "administrator") return profileForbidden();
    requireApiScope(context, "reports:read");
    return principal;
  }
  if (!canSeeBillableMoney(principal)) return profileForbidden();
  requireApiScope(
    context,
    principal.profile === "project_manager" ? "projects:read" : "reports:read",
  );
  return principal;
};

const requireRateWrite = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  kind: UserRateKind,
): UserPrincipal => {
  const principal = requireSessionPrincipal(context);
  const allowed =
    principal.profile === "administrator" ||
    (kind === "billable" &&
      principal.profile === "project_manager" &&
      principal.managerGrants.includes("billable_rates_manager"));
  if (!allowed) return profileForbidden();
  return principal;
};

const envelope = (
  kind: GeneralResourceKind,
  record: GeneralResourceRecord,
  viewer: Readonly<UserPrincipal>,
) => ({
  data: serializeGeneral(kind, record, viewer),
  links: { self: `/api/v1/${kind}/${record.id}` },
});

const installResource = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  kind: GeneralResourceKind,
  options: Required<GeneralResourceRouteOptions>,
): void => {
  const definition = routeDefinitions[kind];
  api.get(`/${kind}`, async (context) => {
    const principal = requireResourceRead(context, kind);
    const filters = parseFilters(new URL(context.req.url), definition);
    try {
      return context.json(
        await cursorPage({
          requestUrl: new URL(context.req.url),
          cursorSigningKey: options.cursorSigningKey,
          viewer: principal,
          serializer: (record: Readonly<GeneralResourceRecord>) =>
            serializeGeneral(kind, record, principal),
          source: {
            highWatermark: () =>
              options.repository.highWatermark(kind, filters),
            list: (window) => options.repository.list(kind, filters, window),
          },
        }),
      );
    } catch (error) {
      return translate(error);
    }
  });
  api.post(`/${kind}`, async (context) => {
    const principal = requireResourceWrite(context, kind);
    const input = await parseMutation(context, definition, true);
    authorizeMutationFields(kind, input, principal);
    try {
      const record = await options.repository.create(
        kind,
        input,
        options.clock(),
      );
      return context.json(envelope(kind, record, principal), 201);
    } catch (error) {
      return translate(error);
    }
  });
  api.get(`/${kind}/:id`, async (context) => {
    const principal = requireResourceRead(context, kind);
    try {
      return context.json(
        envelope(
          kind,
          await options.repository.get(
            kind,
            resourceId(context.req.param("id")),
          ),
          principal,
        ),
      );
    } catch (error) {
      return translate(error);
    }
  });
  api.patch(`/${kind}/:id`, async (context) => {
    const principal = requireResourceWrite(context, kind);
    const input = await parseMutation(context, definition, false);
    authorizeMutationFields(kind, input, principal);
    try {
      const record = await options.repository.update(
        kind,
        resourceId(context.req.param("id")),
        input,
        options.clock(),
      );
      return context.json(envelope(kind, record, principal));
    } catch (error) {
      return translate(error);
    }
  });
  api.delete(`/${kind}/:id`, async (context) => {
    requireResourceWrite(context, kind);
    try {
      await options.repository.remove(
        kind,
        resourceId(context.req.param("id")),
        options.clock(),
      );
      return context.body(null, 204);
    } catch (error) {
      return translate(error);
    }
  });
};

const installRates = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  kind: UserRateKind,
  options: Required<GeneralResourceRouteOptions>,
): void => {
  const segment = `${kind}-rates`;
  api.get(`/users/:userId/${segment}`, async (context) => {
    const principal = requireRateRead(context, kind);
    const userId = resourceId(context.req.param("userId"));
    const url = new URL(context.req.url);
    const allowed = new Set(["per_page", "cursor"]);
    for (const key of url.searchParams.keys())
      if (!allowed.has(key))
        throw validationError([
          { field: key, code: "unknown", message: `${key} is not accepted` },
        ]);
    try {
      return context.json(
        await cursorPage({
          requestUrl: url,
          cursorSigningKey: options.cursorSigningKey,
          viewer: principal,
          serializer: (record: Readonly<UserRateRecord>) =>
            serializeRaw(record),
          source: {
            highWatermark: () =>
              options.repository.highWatermarkRates(userId, kind),
            list: (window) =>
              options.repository.listRates(userId, kind, window),
          },
        }),
      );
    } catch (error) {
      return translate(error);
    }
  });
  api.post(`/users/:userId/${segment}`, async (context) => {
    requireRateWrite(context, kind);
    const body = await objectBody(context);
    const errors: FieldError[] = [];
    for (const field of Object.keys(body))
      if (field !== "amount_cents" && field !== "start_date")
        errors.push({
          field,
          code: "unknown",
          message: `${field} is not accepted`,
        });
    const amountCents = parseField(
      "amount_cents",
      body.amount_cents,
      nonnegativeInt,
      errors,
    ) as number | undefined;
    const startDate =
      body.start_date === undefined
        ? null
        : (parseField(
            "start_date",
            body.start_date,
            { type: "nullable-date" },
            errors,
          ) as string | null | undefined);
    if (amountCents === undefined && body.amount_cents === undefined)
      errors.push({
        field: "amount_cents",
        code: "required",
        message: "amount_cents is required",
      });
    if (errors.length > 0) throw validationError(errors);
    try {
      const record = await options.repository.appendRate(
        resourceId(context.req.param("userId")),
        kind,
        { amountCents: amountCents!, startDate: startDate ?? null },
        options.clock(),
      );
      return context.json(
        {
          data: serializeRaw(record),
          links: {
            self: `/api/v1/users/${record.userId}/${segment}/${record.id}`,
          },
        },
        201,
      );
    } catch (error) {
      return translate(error);
    }
  });
  api.get(`/users/:userId/${segment}/:id`, async (context) => {
    requireRateRead(context, kind);
    try {
      const record = await options.repository.getRate(
        resourceId(context.req.param("userId")),
        kind,
        resourceId(context.req.param("id")),
      );
      return context.json({
        data: serializeRaw(record),
        links: {
          self: `/api/v1/users/${record.userId}/${segment}/${record.id}`,
        },
      });
    } catch (error) {
      return translate(error);
    }
  });
  const rejectMutation = (context: Context<ApiContext<Bindings>>) => {
    context.header("allow", "GET, POST");
    throw new ApiError({
      status: 405,
      code: "method_not_allowed",
      message: "Rates are append-only; use POST to add a new effective rate.",
    });
  };
  api.patch(`/users/:userId/${segment}/:id`, rejectMutation);
  api.delete(`/users/:userId/${segment}/:id`, rejectMutation);
  api.patch(`/users/:userId/${segment}`, rejectMutation);
  api.delete(`/users/:userId/${segment}`, rejectMutation);
};

/** Standalone installer. The integration lane owns auth and top-level resource composition. */
export const installGeneralResourceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  supplied: GeneralResourceRouteOptions,
): void => {
  const options: Required<GeneralResourceRouteOptions> = {
    ...supplied,
    clock: supplied.clock ?? (() => new Date().toISOString()),
  };
  for (const kind of Object.keys(routeDefinitions) as GeneralResourceKind[])
    installResource(api, kind, options);
  installRates(api, "billable", options);
  installRates(api, "cost", options);
};
