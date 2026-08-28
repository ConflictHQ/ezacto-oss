export type ApiContractMethod = "get" | "post" | "patch" | "delete";

export interface ApiContractParameter {
  name: string;
  location: "path" | "query";
  schema: Readonly<Record<string, unknown>>;
  required?: boolean;
}

export interface ApiContractOperation {
  method: ApiContractMethod;
  /** Runtime/Hono path. OpenAPI braces are produced by the generator. */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  responseStatus: number;
  responseSchema?: string;
  requestSchema?: string;
  requestRequired?: boolean;
  sessionOnly?: boolean;
  parameters?: readonly ApiContractParameter[];
  generateClient?: boolean;
}

type JsonSchema = Readonly<Record<string, unknown>>;

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer", minimum: 1 } as const;
const booleanSchema = { type: "boolean" } as const;
const dateSchema = { type: "string", format: "date" } as const;
const timestampSchema = { type: "string", format: "date-time" } as const;

const query = (
  name: string,
  schema: JsonSchema = stringSchema,
): ApiContractParameter => ({ name, location: "query", schema });

const path = (name: string): ApiContractParameter => ({
  name,
  location: "path",
  schema: integerSchema,
  required: true,
});

const pageParameters = [
  query("cursor"),
  query("per_page", { type: "integer", minimum: 1, maximum: 200 }),
] as const;

const filterSchemas: Readonly<Record<string, JsonSchema>> = {
  is_active: booleanSchema,
  updated_since: timestampSchema,
  client_id: integerSchema,
  project_id: integerSchema,
  task_id: integerSchema,
  user_id: integerSchema,
  parent_client_id: integerSchema,
  bill_to_client_id: integerSchema,
  profile: {
    type: "string",
    enum: [
      "member",
      "project_manager",
      "people_admin",
      "accounting",
      "executive_manager",
      "administrator",
    ],
  },
  is_contractor: booleanSchema,
};

const generalResources = [
  {
    plural: "clients",
    singular: "Client",
    filters: [
      "is_active",
      "updated_since",
      "parent_client_id",
      "bill_to_client_id",
    ],
  },
  {
    plural: "contacts",
    singular: "Contact",
    filters: ["client_id", "updated_since"],
  },
  {
    plural: "projects",
    singular: "Project",
    filters: ["client_id", "is_active", "updated_since"],
  },
  {
    plural: "tasks",
    singular: "Task",
    filters: ["is_active", "updated_since"],
  },
  {
    plural: "task-assignments",
    singular: "TaskAssignment",
    filters: ["project_id", "task_id", "is_active", "updated_since"],
  },
  {
    plural: "user-assignments",
    singular: "UserAssignment",
    filters: ["project_id", "user_id", "is_active", "updated_since"],
    sessionOnlyMutation: true,
  },
  {
    plural: "users",
    singular: "User",
    filters: ["is_active", "updated_since", "profile", "is_contractor"],
    sessionOnlyMutation: true,
  },
  {
    plural: "roles",
    singular: "Role",
    filters: [],
    sessionOnlyMutation: true,
  },
] as const;

const generalOperations = (): ApiContractOperation[] =>
  generalResources.flatMap((resource) => {
    const collection = `/api/v1/${resource.plural}`;
    const member = `${collection}/:id`;
    const listParameters = [
      ...pageParameters,
      ...resource.filters.map((name) => query(name, filterSchemas[name]!)),
    ];
    return [
      {
        method: "get",
        path: collection,
        operationId: `list${resource.singular}s`,
        summary: `List ${resource.plural}`,
        tag: resource.plural,
        responseStatus: 200,
        responseSchema: "GeneralResourcePage",
        parameters: listParameters,
      },
      {
        method: "post",
        path: collection,
        operationId: `create${resource.singular}`,
        summary: `Create a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 201,
        responseSchema: "GeneralResourceEnvelope",
        requestSchema: "GeneralMutationInput",
        requestRequired: true,
        ...("sessionOnlyMutation" in resource &&
        resource.sessionOnlyMutation === true
          ? { sessionOnly: true }
          : {}),
      },
      {
        method: "get",
        path: member,
        operationId: `get${resource.singular}`,
        summary: `Get a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 200,
        responseSchema: "GeneralResourceEnvelope",
        parameters: [path("id")],
      },
      {
        method: "patch",
        path: member,
        operationId: `update${resource.singular}`,
        summary: `Update a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 200,
        responseSchema: "GeneralResourceEnvelope",
        requestSchema: "GeneralMutationInput",
        requestRequired: true,
        parameters: [path("id")],
        ...("sessionOnlyMutation" in resource &&
        resource.sessionOnlyMutation === true
          ? { sessionOnly: true }
          : {}),
      },
      {
        method: "delete",
        path: member,
        operationId: `delete${resource.singular}`,
        summary: `Delete or archive a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 204,
        parameters: [path("id")],
        ...("sessionOnlyMutation" in resource &&
        resource.sessionOnlyMutation === true
          ? { sessionOnly: true }
          : {}),
      },
    ];
  });

const rateOperations = (): ApiContractOperation[] =>
  (["billable", "cost"] as const).flatMap((kind) => {
    const title = kind === "billable" ? "BillableRate" : "CostRate";
    const collection = `/api/v1/users/:userId/${kind}-rates`;
    const member = `${collection}/:id`;
    const tag = "user-rates";
    const identifiers = [path("userId")];
    const memberIdentifiers = [path("userId"), path("id")];
    const rejected = (method: "patch" | "delete", route: string) => ({
      method,
      path: route,
      operationId: `${method}${title}${route === collection ? "Collection" : ""}NotAllowed`,
      summary: `${title} records are append-only`,
      tag,
      responseStatus: 405,
      responseSchema: "ErrorEnvelope",
      parameters: route === collection ? identifiers : memberIdentifiers,
      generateClient: false,
    }) satisfies ApiContractOperation;
    return [
      {
        method: "get",
        path: collection,
        operationId: `list${title}s`,
        summary: `List ${kind} rates for a user`,
        tag,
        responseStatus: 200,
        responseSchema: "UserRatePage",
        parameters: [...identifiers, ...pageParameters],
      },
      {
        method: "post",
        path: collection,
        operationId: `append${title}`,
        summary: `Append a ${kind} rate for a user`,
        tag,
        responseStatus: 201,
        responseSchema: "UserRateEnvelope",
        requestSchema: "UserRateInput",
        requestRequired: true,
        sessionOnly: true,
        parameters: identifiers,
      },
      {
        method: "get",
        path: member,
        operationId: `get${title}`,
        summary: `Get a ${kind} rate`,
        tag,
        responseStatus: 200,
        responseSchema: "UserRateEnvelope",
        parameters: memberIdentifiers,
      },
      rejected("patch", member),
      rejected("delete", member),
      rejected("patch", collection),
      rejected("delete", collection),
    ];
  });

const trackedListParameters = [
  ...pageParameters,
  query("user_id", integerSchema),
  query("client_id", integerSchema),
  query("project_id", integerSchema),
  query("spent_date", dateSchema),
  query("from", dateSchema),
  query("to", dateSchema),
  query("approval_status", {
    type: "string",
    enum: ["unsubmitted", "submitted", "approved"],
  }),
  query("invoice_id", integerSchema),
  query("is_billed", booleanSchema),
  query("billable", booleanSchema),
  query("updated_since", timestampSchema),
] as const;

const timeEntryOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/time-entries",
    operationId: "listTimeEntries",
    summary: "List the acting user's time entries",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryPage",
    parameters: [
      ...trackedListParameters,
      query("task_id", integerSchema),
      query("is_running", booleanSchema),
      query("budgeted", booleanSchema),
      query("external_reference_id"),
    ],
  },
  {
    method: "post",
    path: "/api/v1/time-entries",
    operationId: "createTimeEntry",
    summary: "Create or start a time entry",
    tag: "time-entries",
    responseStatus: 201,
    responseSchema: "TimeEntryEnvelope",
    requestSchema: "TimeEntryInput",
    requestRequired: true,
  },
  ...(["get", "patch", "delete"] as const).map((method) => ({
    method,
    path: "/api/v1/time-entries/:id",
    operationId: `${method === "get" ? "get" : method === "patch" ? "update" : "delete"}TimeEntry`,
    summary: `${method === "get" ? "Get" : method === "patch" ? "Update" : "Delete"} a time entry`,
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryEnvelope",
    ...(method === "patch"
      ? { requestSchema: "TimeEntryPatch", requestRequired: true }
      : {}),
    parameters: [path("id")],
  })),
  ...(["stop", "restart"] as const).map((action) => ({
    method: "post" as const,
    path: `/api/v1/time-entries/:id/${action}`,
    operationId: `${action}TimeEntry`,
    summary: `${action === "stop" ? "Stop" : "Restart"} a time entry`,
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryEnvelope",
    parameters: [path("id")],
  })),
];

const expenseOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/expenses",
    operationId: "listExpenses",
    summary: "List the acting user's expenses",
    tag: "expenses",
    responseStatus: 200,
    responseSchema: "ExpensePage",
    parameters: [
      ...trackedListParameters,
      query("expense_category_id", integerSchema),
      query("reimbursable", booleanSchema),
      query("reimbursement_status", {
        type: "string",
        enum: ["none", "pending", "approved", "paid"],
      }),
    ],
  },
  {
    method: "post",
    path: "/api/v1/expenses",
    operationId: "createExpense",
    summary: "Create an expense",
    tag: "expenses",
    responseStatus: 201,
    responseSchema: "ExpenseEnvelope",
    requestSchema: "ExpenseInput",
    requestRequired: true,
  },
  ...(["get", "patch", "delete"] as const).map((method) => ({
    method,
    path: "/api/v1/expenses/:id",
    operationId: `${method === "get" ? "get" : method === "patch" ? "update" : "delete"}Expense`,
    summary: `${method === "get" ? "Get" : method === "patch" ? "Update" : "Delete"} an expense`,
    tag: "expenses",
    responseStatus: 200,
    responseSchema: "ExpenseEnvelope",
    ...(method === "patch"
      ? { requestSchema: "ExpensePatch", requestRequired: true }
      : {}),
    parameters: [path("id")],
  })),
];

export const apiContractOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1",
    operationId: "getApiRoot",
    summary: "Get API service metadata",
    tag: "service",
    responseStatus: 200,
    responseSchema: "ServiceEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/api-tokens",
    operationId: "listApiTokens",
    summary: "List API tokens for the acting user",
    tag: "api-tokens",
    responseStatus: 200,
    responseSchema: "ApiTokenListEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/api-tokens",
    operationId: "createApiToken",
    summary: "Issue an API token",
    tag: "api-tokens",
    responseStatus: 201,
    responseSchema: "IssuedApiTokenEnvelope",
    requestSchema: "CreateApiTokenInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/api-tokens/:tokenId",
    operationId: "revokeApiToken",
    summary: "Revoke an API token",
    tag: "api-tokens",
    responseStatus: 200,
    responseSchema: "ApiTokenEnvelope",
    parameters: [path("tokenId")],
    sessionOnly: true,
  },
  ...generalOperations(),
  ...rateOperations(),
  ...timeEntryOperations,
  ...expenseOperations,
];

const nullable = (schema: JsonSchema): JsonSchema => ({
  anyOf: [schema, { type: "null" }],
});
const reference = (name: string): JsonSchema => ({
  $ref: `#/components/schemas/${name}`,
});
const envelope = (name: string): JsonSchema => ({
  type: "object",
  required: ["data", "links"],
  properties: {
    data: reference(name),
    links: reference("Links"),
  },
  additionalProperties: false,
});
const page = (name: string): JsonSchema => ({
  type: "object",
  required: ["data", "links", "page"],
  properties: {
    data: { type: "array", items: reference(name) },
    links: reference("PageLinks"),
    page: reference("PageMetadata"),
  },
  additionalProperties: false,
});

const apiScopes = [
  "time_entries:read",
  "time_entries:write",
  "projects:read",
  "projects:write",
  "clients:read",
  "clients:write",
  "invoices:read",
  "invoices:write",
  "expenses:read",
  "expenses:write",
  "team:read",
  "schedule:read",
  "schedule:write",
  "reports:read",
] as const;

export const apiContractSchemas: Readonly<Record<string, JsonSchema>> = {
  FieldError: {
    type: "object",
    required: ["field", "code", "message"],
    properties: {
      field: stringSchema,
      code: stringSchema,
      message: stringSchema,
    },
    additionalProperties: false,
  },
  ErrorDetail: {
    type: "object",
    required: ["code", "message", "fields"],
    properties: {
      code: stringSchema,
      message: stringSchema,
      fields: { type: "array", items: reference("FieldError") },
    },
    additionalProperties: false,
  },
  ErrorEnvelope: {
    type: "object",
    required: ["error", "request_id"],
    properties: {
      error: reference("ErrorDetail"),
      request_id: stringSchema,
    },
    additionalProperties: false,
  },
  Links: {
    type: "object",
    required: ["self"],
    properties: { self: stringSchema },
    additionalProperties: false,
  },
  PageLinks: {
    type: "object",
    required: ["self", "next"],
    properties: { self: stringSchema, next: nullable(stringSchema) },
    additionalProperties: false,
  },
  PageMetadata: {
    type: "object",
    required: ["per_page", "next_cursor"],
    properties: {
      per_page: { type: "integer", minimum: 1, maximum: 200 },
      next_cursor: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  Service: {
    type: "object",
    required: ["service", "version"],
    properties: { service: { const: "ezacto" }, version: { const: "v1" } },
    additionalProperties: false,
  },
  ServiceEnvelope: envelope("Service"),
  GeneralResource: {
    type: "object",
    required: ["id", "created_at", "updated_at"],
    properties: {
      id: integerSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: true,
  },
  GeneralMutationInput: {
    type: "object",
    minProperties: 1,
    additionalProperties: true,
  },
  GeneralResourceEnvelope: envelope("GeneralResource"),
  GeneralResourcePage: page("GeneralResource"),
  UserRate: {
    type: "object",
    required: [
      "id",
      "user_id",
      "amount_cents",
      "start_date",
      "end_date",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      amount_cents: { type: "integer", minimum: 0 },
      start_date: nullable(dateSchema),
      end_date: nullable(dateSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  UserRateInput: {
    type: "object",
    required: ["amount_cents"],
    properties: {
      amount_cents: { type: "integer", minimum: 0 },
      start_date: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  UserRateEnvelope: envelope("UserRate"),
  UserRatePage: page("UserRate"),
  ApiToken: {
    type: "object",
    required: [
      "id",
      "name",
      "scopes",
      "token_hint",
      "created_at",
      "last_used_at",
      "expires_at",
      "revoked_at",
    ],
    properties: {
      id: integerSchema,
      name: stringSchema,
      scopes: { type: "array", items: { type: "string", enum: apiScopes } },
      token_hint: stringSchema,
      created_at: timestampSchema,
      last_used_at: nullable(timestampSchema),
      expires_at: nullable(timestampSchema),
      revoked_at: nullable(timestampSchema),
    },
    additionalProperties: false,
  },
  IssuedApiToken: {
    allOf: [
      reference("ApiToken"),
      {
        type: "object",
        required: ["token"],
        properties: { token: stringSchema },
      },
    ],
  },
  CreateApiTokenInput: {
    type: "object",
    required: ["name", "scopes"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      scopes: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", enum: apiScopes },
      },
      expires_at: nullable(timestampSchema),
    },
    additionalProperties: false,
  },
  ApiTokenEnvelope: envelope("ApiToken"),
  IssuedApiTokenEnvelope: envelope("IssuedApiToken"),
  ApiTokenListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("ApiToken") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  TimeEntry: {
    type: "object",
    required: [
      "id",
      "user_id",
      "project_id",
      "task_id",
      "spent_date",
      "seconds",
      "is_running",
      "billable",
      "budgeted",
      "approval_status",
      "is_billed",
      "is_locked",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      project_id: integerSchema,
      task_id: integerSchema,
      user_assignment_id: integerSchema,
      task_assignment_id: integerSchema,
      spent_date: dateSchema,
      seconds: { type: "integer", minimum: 0 },
      seconds_without_timer: { type: "integer", minimum: 0 },
      rounded_seconds: { type: "integer", minimum: 0 },
      is_running: booleanSchema,
      timer_started_at: nullable(timestampSchema),
      started_time: nullable({ type: "string", pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
      ended_time: nullable({ type: "string", pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
      notes: nullable(stringSchema),
      billable: booleanSchema,
      budgeted: booleanSchema,
      approval_status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      invoice_id: nullable(integerSchema),
      is_billed: booleanSchema,
      is_locked: booleanSchema,
      locked_reason_code: nullable(stringSchema),
      locked_reason: nullable(stringSchema),
      external_ref: nullable({ type: "object", additionalProperties: true }),
      calendar_event_ref: nullable({ type: "object", additionalProperties: true }),
      billable_rate_cents: nullable({ type: "integer", minimum: 0 }),
      cost_rate_cents: nullable({ type: "integer", minimum: 0 }),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TimeEntryInput: {
    type: "object",
    required: ["project_id", "task_id"],
    properties: {
      project_id: integerSchema,
      task_id: integerSchema,
      spent_date: dateSchema,
      seconds: { type: "integer", minimum: 0 },
      started_time: { type: "string" },
      ended_time: { type: "string" },
      notes: nullable(stringSchema),
      budgeted: booleanSchema,
      external_ref: nullable({ type: "object", additionalProperties: true }),
      calendar_event_ref: nullable({ type: "object", additionalProperties: true }),
    },
    additionalProperties: false,
  },
  TimeEntryPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      project_id: integerSchema,
      task_id: integerSchema,
      spent_date: dateSchema,
      seconds: { type: "integer", minimum: 0 },
      started_time: { type: "string" },
      ended_time: { type: "string" },
      notes: nullable(stringSchema),
      budgeted: booleanSchema,
      external_ref: nullable({ type: "object", additionalProperties: true }),
      calendar_event_ref: nullable({ type: "object", additionalProperties: true }),
    },
    additionalProperties: false,
  },
  TimeEntryEnvelope: envelope("TimeEntry"),
  TimeEntryPage: page("TimeEntry"),
  Expense: {
    type: "object",
    required: [
      "id",
      "user_id",
      "project_id",
      "expense_category_id",
      "spent_date",
      "total_cost_cents",
      "billable",
      "approval_status",
      "is_billed",
      "is_locked",
      "reimbursable",
      "reimbursement_status",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      project_id: integerSchema,
      expense_category_id: integerSchema,
      spent_date: dateSchema,
      notes: nullable(stringSchema),
      units: nullable({ type: "number", minimum: 0 }),
      total_cost_cents: { type: "integer", minimum: 0 },
      billable: booleanSchema,
      approval_status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      invoice_id: nullable(integerSchema),
      is_billed: booleanSchema,
      is_locked: booleanSchema,
      locked_reason_code: nullable(stringSchema),
      locked_reason: nullable(stringSchema),
      reimbursable: booleanSchema,
      reimbursement_status: {
        type: "string",
        enum: ["none", "pending", "approved", "paid"],
      },
      payout_ref: nullable(stringSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  ExpenseInput: {
    type: "object",
    required: ["project_id", "expense_category_id", "spent_date"],
    properties: {
      project_id: integerSchema,
      expense_category_id: integerSchema,
      spent_date: dateSchema,
      notes: nullable(stringSchema),
      units: { type: "number", minimum: 0 },
      total_cost_cents: { type: "integer", minimum: 0 },
      billable: booleanSchema,
      reimbursable: booleanSchema,
    },
    additionalProperties: false,
  },
  ExpensePatch: {
    type: "object",
    minProperties: 1,
    properties: {
      project_id: integerSchema,
      expense_category_id: integerSchema,
      spent_date: dateSchema,
      notes: nullable(stringSchema),
      units: { type: "number", minimum: 0 },
      total_cost_cents: { type: "integer", minimum: 0 },
      billable: booleanSchema,
      reimbursable: booleanSchema,
    },
    additionalProperties: false,
  },
  ExpenseEnvelope: envelope("Expense"),
  ExpensePage: page("Expense"),
};

const openApiPath = (runtimePath: string): string =>
  runtimePath.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");

const schemaResponse = (schema: string): Record<string, unknown> => ({
  description: "Successful response",
  content: {
    "application/json": { schema: reference(schema) },
  },
});

const errorResponse = (description: string): Record<string, unknown> => ({
  description,
  content: {
    "application/json": { schema: reference("ErrorEnvelope") },
  },
});

export const generateOpenApiDocument = (): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of apiContractOperations) {
    const route = openApiPath(operation.path);
    const responses: Record<string, unknown> = {
      [operation.responseStatus]:
        operation.responseStatus === 204
          ? { description: "No content" }
          : schemaResponse(operation.responseSchema ?? "ErrorEnvelope"),
      "400": { $ref: "#/components/responses/MalformedRequest" },
      "401": { $ref: "#/components/responses/AuthenticationRequired" },
      "403": { $ref: "#/components/responses/InsufficientPermission" },
      "404": { $ref: "#/components/responses/ResourceNotFound" },
      "422": { $ref: "#/components/responses/ValidationFailed" },
    };
    const entry: Record<string, unknown> = {
      operationId: operation.operationId,
      summary: operation.summary,
      tags: [operation.tag],
      security: operation.sessionOnly
        ? [{ cookieSession: [] }]
        : [{ bearerAuth: [] }, { cookieSession: [] }],
      responses,
      "x-ezacto-runtime-path": operation.path,
      "x-ezacto-generate-client": operation.generateClient !== false,
    };
    if (operation.parameters !== undefined)
      entry.parameters = operation.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.location,
        required: parameter.location === "path" || parameter.required === true,
        schema: parameter.schema,
      }));
    if (operation.requestSchema !== undefined) {
      entry.requestBody = {
        required: operation.requestRequired === true,
        content: {
          "application/json": { schema: reference(operation.requestSchema) },
        },
      };
    }
    (paths[route] ??= {})[operation.method] = entry;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "ezacto API",
      version: "1.0.0",
      description:
        "The native ezacto v1 contract. Contract and generated clients are deterministic build artifacts.",
    },
    servers: [{ url: "https://ezacto.io" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieSession: { type: "apiKey", in: "cookie", name: "session" },
      },
      responses: {
        MalformedRequest: errorResponse("Malformed request"),
        AuthenticationRequired: errorResponse("Authentication required"),
        InsufficientPermission: errorResponse("Insufficient permission"),
        ResourceNotFound: errorResponse("Resource not found"),
        ValidationFailed: errorResponse("Validation failed"),
      },
      schemas: apiContractSchemas,
    },
  };
};
