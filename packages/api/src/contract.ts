import { ACCOUNT_PRIVACY_FRAMEWORKS } from '@ezacto/core';
import { paymentRunOperations, paymentRunSchemas } from './payment-run-contract.js'
import { staffPaymentOperations, staffPaymentSchemas } from './staff-payment-contract.js';
import { commercialTermFields, DETAILED_TIME_PDF_ROW_LIMIT, maximumBulkApprovalSelections, timeRoundingIncrements, timeRoundingModes } from "@ezacto/core";
import {
  attachmentContractOperations,
  attachmentContractSchemas,
} from "./attachment-contract.js";

export type ApiContractMethod = "get" | "post" | "patch" | "delete";

export interface ApiContractParameter {
  name: string;
  location: "path" | "query" | "header";
  schema: Readonly<Record<string, unknown>>;
  required?: boolean;
}

export interface ApiContractOperation {
  method: ApiContractMethod;
  /** Runtime/Hono path. OpenAPI braces are produced by the generator. */
  path: string;
  operationId: string;
  summary: string;
  /** Longer prose for the operation, where the summary cannot carry a rule a caller relies on. */
  description?: string;
  tag: string;
  responseStatus: number;
  additionalResponseStatuses?: readonly number[];
  responseSchema?: string;
  requestSchema?: string;
  requestRequired?: boolean;
  requestContentType?: "application/json" | "multipart/form-data";
  binaryResponse?: boolean;
  sessionOnly?: boolean;
  public?: boolean;
  parameters?: readonly ApiContractParameter[];
  generateClient?: boolean;
}

type JsonSchema = Readonly<Record<string, unknown>>;

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer", minimum: 1 } as const;
// Durations and the totals netted from them. A Harvest correction entry is
// negative by construction, so everything downstream of one is signed (#279).
const signedIntegerSchema = { type: "integer" } as const;
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

const stringPath = (name: string): ApiContractParameter => ({
  name,
  location: "path",
  schema: stringSchema,
  required: true,
});

const header = (name: string): ApiContractParameter => ({
  name,
  location: "header",
  schema: stringSchema,
  required: true,
});

const pageParameters = [
  query("cursor"),
  query("per_page", { type: "integer", minimum: 1, maximum: 200 }),
] as const;

// A set of client ids rather than one, for the same reason `state` is a set:
// the question a client 360 asks is about a subtree, so the caller already has
// every id in hand and one id per request would be one round-trip per node of a
// holding company's tree. Comma-separated, and accepted repeated.
const clientIdSetSchema = {
  type: "string",
  pattern: "^[1-9][0-9]*(,[1-9][0-9]*)*$",
} as const;

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
  q: { type: "string", minLength: 1, pattern: "\\S" },
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
      "q",
    ],
  },
  {
    plural: "contacts",
    singular: "Contact",
    filters: ["client_id", "updated_since"],
  },
  {
    plural: "expense-categories",
    singular: "ExpenseCategory",
    listOperationId: "listExpenseCategories",
    responseSchema: "ExpenseCategory",
    createSchema: "ExpenseCategoryInput",
    updateSchema: "ExpenseCategoryPatch",
    filters: ["is_active", "updated_since"],
    sessionOnlyMutation: true,
  },
  {
    plural: "projects",
    singular: "Project",
    filters: ["client_id", "is_active", "updated_since", "q"],
  },
  {
    plural: "tasks",
    singular: "Task",
    filters: ["is_active", "updated_since", "q"],
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
    const responseSchema =
      "responseSchema" in resource ? resource.responseSchema : null;
    const envelopeSchema =
      responseSchema === null
        ? "GeneralResourceEnvelope"
        : `${responseSchema}Envelope`;
    const pageSchema =
      responseSchema === null ? "GeneralResourcePage" : `${responseSchema}Page`;
    const createSchema =
      "createSchema" in resource
        ? resource.createSchema
        : "GeneralMutationInput";
    const updateSchema =
      "updateSchema" in resource
        ? resource.updateSchema
        : "GeneralMutationInput";
    const listParameters = [
      ...pageParameters,
      ...resource.filters.map((name) => query(name, filterSchemas[name]!)),
    ];
    return [
      {
        method: "get",
        path: collection,
        operationId:
          "listOperationId" in resource
            ? resource.listOperationId
            : `list${resource.singular}s`,
        summary: `List ${resource.plural}`,
        tag: resource.plural,
        responseStatus: 200,
        responseSchema: pageSchema,
        parameters: listParameters,
      },
      {
        method: "post",
        path: collection,
        operationId: `create${resource.singular}`,
        summary: `Create a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 201,
        responseSchema: envelopeSchema,
        requestSchema: createSchema,
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
        responseSchema: envelopeSchema,
        parameters: [path("id")],
      },
      {
        method: "patch",
        path: member,
        operationId: `update${resource.singular}`,
        summary: `Update a ${resource.singular.toLowerCase()}`,
        tag: resource.plural,
        responseStatus: 200,
        responseSchema: envelopeSchema,
        requestSchema: updateSchema,
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
    const rejected = (method: "patch" | "delete", route: string) =>
      ({
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
        parameters: [...identifiers, idempotency],
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
  query("invoice_id", { ...integerSchema, description: "Requires invoices:read for both the profile and token." }),
  query("is_billed", { ...booleanSchema, description: "Requires invoices:read for both the profile and token." }),
  query("billable", booleanSchema),
  query("updated_since", timestampSchema),
] as const;

const timeEntryOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/time-entry-settings",
    operationId: "getTimeEntrySettings",
    summary: "Get organization time-entry display and entry-mode settings",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntrySettingsEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/time-entry-note-settings",
    operationId: "getTimeEntryNoteSettings",
    summary: "Get organization time-entry note settings",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryNoteSettingsEnvelope",
  },
  {
    method: "patch",
    path: "/api/v1/time-entry-note-settings",
    operationId: "updateTimeEntryNoteSettings",
    summary: "Update organization time-entry note settings",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryNoteSettingsEnvelope",
    requestSchema: "TimeEntryNoteSettingsPatch",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "patch",
    path: "/api/v1/time-entry-rounding-settings",
    operationId: "updateTimeEntryRoundingSettings",
    summary: "Update the organization's time rounding rule",
    description:
      "A direction and an increment, either or both. Nothing already saved changes: the rule rounds time saved from now on, and open time is re-rounded only by `/time-rounding-recalculation`, after a preview. Executive managers and administrators only.",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeRoundingEnvelope",
    requestSchema: "TimeRoundingPatch",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/time-rounding-recalculation",
    operationId: "previewTimeRoundingRecalculation",
    summary: "Preview re-rounding open time under the current rules",
    description:
      "What the apply would change, writing nothing: how many open entries change, their rounded hours before and after, a breakdown by project, the date span, and what is left alone and why. Open means the same as for a single edit: stopped, not invoiced, not approved, on an unlocked date, under an active client, project and task. The `fingerprint` names exactly this set. Executive managers and administrators only.",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeRoundingRecalculationPreviewEnvelope",
    parameters: [query("project_id", integerSchema), query("from", dateSchema), query("to", dateSchema)],
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/time-rounding-recalculation",
    operationId: "applyTimeRoundingRecalculation",
    summary: "Re-round open time under the current rules",
    description:
      "Applies the preview whose `fingerprint` is sent, for the same scope. If anything has changed since that preview, nothing is written and the answer is 409 `preview_stale`. Executive managers and administrators only.",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeRoundingRecalculationAppliedEnvelope",
    requestSchema: "TimeRoundingRecalculationRequest",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/time-entry-options",
    operationId: "listTimeEntryOptions",
    summary: "List the active project and task combinations a user may log time against",
    description:
      "The acting user's unless `user_id` names somebody else, which only an administrator may do (403 `row_forbidden` otherwise).",
    tag: "time-entries",
    responseStatus: 200,
    responseSchema: "TimeEntryOptionListEnvelope",
    parameters: [query("user_id", integerSchema)],
  },
  {
    method: "get",
    path: "/api/v1/time-entries",
    operationId: "listTimeEntries",
    summary: "List time entries",
    description:
      "The acting user's unless `user_id` names somebody else, which only an administrator may do (403 `row_forbidden` otherwise). An administrator may also read, update, stop and delete any entry by id; everyone else reaches only their own.",
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
    description:
      "`started_time` with `ended_time` logs a stopped start/end entry in either organization mode, its `seconds` derived from the two times (an end before the start is past midnight); `seconds` beside them is 422 `mode_mismatch`. Without times the organization's `time_entry_mode` decides: in `duration`, `seconds` logs a stopped entry and leaving it out starts a timer; in `start_end`, leaving out `ended_time` starts a timer at the current local time and `seconds` is 422 `mode_mismatch`. A timer in a `duration` organization never carries times, so `started_time` without `ended_time` there is 422 `mode_mismatch`. Entries may overlap; each counts its own full duration.",
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
      ? {
          description:
            "An entry keeps the shape it was created with, whatever the organization's mode: a start/end entry takes `started_time` and `ended_time` and re-derives `seconds`, a duration entry takes `seconds`, and the other is 422 `mode_mismatch`.",
          requestSchema: "TimeEntryPatch",
          requestRequired: true,
        }
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

const timesheetApprovalOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/timesheet-submissions",
    operationId: "listTimesheetSubmissions",
    summary: "List the acting user's timesheet submissions",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionPage",
    parameters: [
      ...pageParameters,
      query("period_start", dateSchema),
      query("period_end", dateSchema),
    ],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions",
    operationId: "submitTimesheet",
    summary: "Submit a timesheet period for approval",
    tag: "timesheet-approvals",
    responseStatus: 201,
    additionalResponseStatuses: [200],
    responseSchema: "TimesheetSubmissionEnvelope",
    requestSchema: "TimesheetSubmissionInput",
    requestRequired: true,
  },
  {
    method: "get",
    path: "/api/v1/timesheet-submissions/pending",
    operationId: "listPendingTimesheetSubmissions",
    summary: "List timesheet submissions awaiting review",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionPage",
    parameters: [
      ...pageParameters,
      query("period_start", dateSchema),
      query("period_end", dateSchema),
      query("user_id", integerSchema),
      query("client_id", integerSchema),
      query("project_id", integerSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/timesheet-submissions/approved",
    operationId: "listApprovedTimesheetSubmissions",
    summary: "List recently approved timesheet periods available to reopen",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionPage",
    parameters: [
      ...pageParameters,
      query("period_start", dateSchema),
      query("period_end", dateSchema),
      query("user_id", integerSchema),
      query("client_id", integerSchema),
      query("project_id", integerSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/timesheet-submissions/:id",
    operationId: "getTimesheetSubmission",
    summary: "Get an owner- or approver-visible timesheet submission",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionDetailEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions/bulk-approve",
    operationId: "bulkApproveTimesheetSubmissions",
    summary: "Approve an explicit selection of submitted timesheet periods",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetBulkApprovalResult",
    requestSchema: "TimesheetBulkApprovalInput",
    requestRequired: true,
    parameters: [header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions/:id/approve",
    operationId: "approveTimesheetSubmission",
    summary: "Approve a submitted timesheet period",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions/:id/reject",
    operationId: "rejectTimesheetSubmission",
    summary: "Reject a submitted timesheet period with a reason",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionEnvelope",
    requestSchema: "TimesheetRejectionInput",
    requestRequired: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions/:id/unsubmit",
    operationId: "unsubmitTimesheetSubmission",
    summary: "Take back your own timesheet before anyone has reviewed it",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-submissions/:id/withdraw",
    operationId: "withdrawTimesheetSubmission",
    summary: "Explicitly withdraw or reopen a timesheet period",
    tag: "timesheet-approvals",
    responseStatus: 200,
    responseSchema: "TimesheetSubmissionEnvelope",
    requestSchema: "TimesheetWithdrawalInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const timesheetLockPolicyOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/timesheet-lock-policy",
    operationId: "getTimesheetLockPolicy",
    summary: "Get the organization timesheet lock policy",
    tag: "timesheet-locks",
    responseStatus: 200,
    responseSchema: "TimesheetLockPolicyEnvelope",
    sessionOnly: true,
  },
  {
    method: "patch",
    path: "/api/v1/timesheet-lock-policy",
    operationId: "updateTimesheetLockPolicy",
    summary: "Update the organization timesheet lock policy",
    tag: "timesheet-locks",
    responseStatus: 200,
    responseSchema: "TimesheetLockPolicyEnvelope",
    requestSchema: "TimesheetLockPolicyPatch",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/timesheet-locks",
    operationId: "listTimesheetLocks",
    summary: "List durable timesheet lock windows",
    tag: "timesheet-locks",
    responseStatus: 200,
    responseSchema: "TimesheetLockWindowPage",
    sessionOnly: true,
    parameters: [
      ...pageParameters,
      query("active", booleanSchema),
      query("kind", { type: "string", enum: ["manual", "auto"] }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/timesheet-locks/:id",
    operationId: "getTimesheetLock",
    summary: "Get a durable timesheet lock window",
    tag: "timesheet-locks",
    responseStatus: 200,
    responseSchema: "TimesheetLockWindowEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-locks",
    operationId: "createTimesheetManualLock",
    summary: "Create an organization-wide manual lock cutoff",
    tag: "timesheet-locks",
    responseStatus: 201,
    responseSchema: "TimesheetLockWindowEnvelope",
    requestSchema: "TimesheetManualLockInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/timesheet-locks/:id/unlock",
    operationId: "unlockTimesheetLock",
    summary: "Explicitly unlock a timesheet lock window",
    tag: "timesheet-locks",
    responseStatus: 200,
    responseSchema: "TimesheetLockWindowEnvelope",
    requestSchema: "TimesheetUnlockInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
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

const idempotency = header("Idempotency-Key");

const moneyOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/invoices",
    operationId: "listInvoices",
    summary: "List invoices",
    description:
      "Newest first: by issue_date, latest first; then by number, highest first -- compared as a number when it is made of digits alone (leading zeros ignored) and as text, by Unicode code point, otherwise, with all-digit numbers ahead of the rest on a day that has both; then by id, highest first, so no two invoices tie. " +
      "The first page fixes the traversal to the invoices that existed when it was read: an invoice created after it does not appear on later pages of the same traversal, and is listed by a new one. " +
      "Editing an invoice's issue_date or number moves it in the order, so a traversal already under way may miss it or list it twice. " +
      "The number parameter narrows the list to the invoice with exactly that number, compared as text, so 089 is not 89; numbers are unique, so the page holds that invoice or nothing. " +
      "The sort parameter orders by issue_date, due_date, number, amount or balance, with - in front for descending (the default is -issue_date, the order above). The chosen column ranks first, then the number, then the id, all in the one direction. A cursor belongs to the sort it was issued under and is refused under another.",
    tag: "invoices",
    responseStatus: 200,
    responseSchema: "InvoicePage",
    parameters: [
      ...pageParameters,
      // A comma-separated set, because the list a person actually wants open
      // is draft plus open and one enum value cannot ask for two states. Also
      // accepted repeated, so `state=draft&state=open` means the same thing.
      query("state", {
        type: "string",
        pattern: "^(draft|open|paid|closed)(,(draft|open|paid|closed))*$",
      }),
      query("client_id", clientIdSetSchema),
      // One number, exactly: how a page addressed by an invoice number finds
      // the record behind it.
      query("number", { type: "string", minLength: 1, maxLength: 64 }),
      // Server-side, so Load more continues in the chosen order. Client and
      // status are not sortable here: a client's display name and the derived
      // overdue pill cannot be ordered consistently with the cursor.
      query("sort", {
        type: "string",
        pattern: "^-?(issue_date|due_date|number|amount|balance)$",
      }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/invoices/:id",
    operationId: "getInvoice",
    summary: "Get an invoice",
    tag: "invoices",
    responseStatus: 200,
    responseSchema: "InvoiceEnvelope",
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/estimates",
    operationId: "listEstimates",
    summary: "List estimates",
    tag: "estimates",
    responseStatus: 200,
    responseSchema: "EstimatePage",
    parameters: pageParameters,
  },
  {
    method: "get",
    path: "/api/v1/estimates/:id",
    operationId: "getEstimate",
    summary: "Get an estimate",
    tag: "estimates",
    responseStatus: 200,
    responseSchema: "EstimateEnvelope",
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/estimates/:id/messages",
    operationId: "listEstimateMessages",
    summary: "List estimate lifecycle messages",
    tag: "estimate-messages",
    responseStatus: 200,
    responseSchema: "EstimateMessageListEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/estimates/:id/messages",
    operationId: "createEstimateMessage",
    summary: "Create a retry-safe estimate lifecycle message",
    tag: "estimate-messages",
    responseStatus: 201,
    responseSchema: "EstimateMessageCommandEnvelope",
    requestSchema: "EstimateMessageInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/estimates/:id/convert",
    operationId: "convertEstimate",
    summary: "Convert an accepted estimate into one draft invoice",
    tag: "estimates",
    responseStatus: 201,
    responseSchema: "EstimateConversionEnvelope",
    requestSchema: "EstimateConversionInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/invoice-generations",
    operationId: "generateInvoice",
    summary:
      "Create one draft invoice from tracked work, a flat fee covering tracked work, or a blank free-form draft",
    tag: "invoices",
    responseStatus: 201,
    responseSchema: "InvoiceGenerationEnvelope",
    requestSchema: "InvoiceGenerationInput",
    requestRequired: true,
    parameters: [idempotency],
  },
  {
    method: "patch",
    path: "/api/v1/invoices/:id",
    operationId: "updateInvoice",
    summary: "Apply one retry-safe invoice edit",
    tag: "invoices",
    responseStatus: 200,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoiceEditInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/line-items",
    operationId: "createInvoiceLine",
    summary: "Add a parent-owned invoice line",
    tag: "invoices",
    responseStatus: 201,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoiceLineInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  ...(["patch", "delete"] as const).map((method) => ({
    method,
    path: "/api/v1/invoices/:id/line-items/:lineId",
    operationId: `${method === "patch" ? "update" : "delete"}InvoiceLine`,
    summary: `${method === "patch" ? "Update" : "Delete"} a parent-owned invoice line`,
    tag: "invoices",
    responseStatus: 200,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema:
      method === "patch" ? "InvoiceLineUpdateInput" : "VersionedRowDeleteInput",
    requestRequired: true,
    parameters: [path("id"), path("lineId"), idempotency],
  })),
  {
    method: "get",
    path: "/api/v1/invoices/:id/messages",
    operationId: "listInvoiceMessages",
    summary: "List invoice lifecycle messages",
    tag: "invoice-messages",
    responseStatus: 200,
    responseSchema: "InvoiceMessageListEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/messages",
    operationId: "createInvoiceMessage",
    summary: "Create an invoice lifecycle message",
    tag: "invoice-messages",
    responseStatus: 201,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoiceMessageInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/transitions",
    operationId: "transitionInvoice",
    summary: "Create the message equivalent of an invoice transition",
    tag: "invoice-messages",
    responseStatus: 201,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoiceTransitionInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/deliveries",
    operationId: "deliverInvoiceEmail",
    summary: "Confirm and durably enqueue invoice email delivery",
    description:
      "One email: To the recipients, Cc the copies, the organization's always-Cc addresses and, when send_me_a_copy is true, the person sending. The subject and message are templates; the body is the message followed by the invoice summary.",
    tag: "invoice-messages",
    responseStatus: 202,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoiceEmailDeliveryInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/deliveries/preview",
    operationId: "previewInvoiceEmail",
    summary: "Compose the invoice email a delivery would send, without sending or recording anything",
    tag: "invoice-messages",
    responseStatus: 200,
    responseSchema: "InvoiceEmailPreviewEnvelope",
    requestSchema: "InvoiceEmailPreviewInput",
    requestRequired: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/invoices/:id/deliveries/preview/document",
    operationId: "downloadInvoiceEmailPreviewDocument",
    summary: "Download the invoice PDF a delivery would carry, stamped PREVIEW on every page",
    tag: "invoice-messages",
    responseStatus: 200,
    binaryResponse: true,
    parameters: [path("id"), query("append_pdfs", { type: "string", enum: ["true", "false"] })],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/deliveries/preview/send",
    operationId: "sendInvoiceEmailPreview",
    summary: "Send the invoice email, stamped PREVIEW, to the signed-in user only",
    description:
      "Not a delivery: no invoice message, no delivery record, no event. Limited to a few per invoice per hour.",
    tag: "invoice-messages",
    responseStatus: 202,
    additionalResponseStatuses: [429],
    responseSchema: "InvoiceEmailPreviewSentEnvelope",
    requestSchema: "InvoiceEmailPreviewInput",
    requestRequired: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/invoices/:id/payments",
    operationId: "listInvoicePayments",
    summary: "List effective invoice payments",
    tag: "invoice-payments",
    responseStatus: 200,
    responseSchema: "InvoicePaymentListEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/payments",
    operationId: "recordInvoicePayment",
    summary: "Record a retry-safe manual invoice payment",
    tag: "invoice-payments",
    responseStatus: 201,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema: "InvoicePaymentInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  ...(["patch", "delete"] as const).map((method) => ({
    method,
    path: "/api/v1/invoices/:id/payments/:paymentId",
    operationId: `${method === "patch" ? "update" : "delete"}InvoicePayment`,
    summary: `${method === "patch" ? "Correct" : "Delete"} a retry-safe manual payment`,
    tag: "invoice-payments",
    responseStatus: 200,
    responseSchema: "InvoiceCommandEnvelope",
    requestSchema:
      method === "patch"
        ? "InvoicePaymentUpdateInput"
        : "VersionedRowDeleteInput",
    requestRequired: true,
    parameters: [path("id"), path("paymentId"), idempotency],
  })),
  {
    method: "get",
    path: "/api/v1/retainers",
    operationId: "listRetainers",
    summary: "List retainers with live balances",
    tag: "retainers",
    responseStatus: 200,
    responseSchema: "RetainerPage",
    parameters: [...pageParameters, query("client_id", clientIdSetSchema)],
  },
  {
    method: "post",
    path: "/api/v1/retainers",
    operationId: "createRetainer",
    summary: "Create a single-denomination retainer",
    tag: "retainers",
    responseStatus: 201,
    responseSchema: "RetainerEnvelope",
    requestSchema: "RetainerInput",
    requestRequired: true,
    parameters: [idempotency],
  },
  ...(["get", "patch"] as const).map((method) => ({
    method,
    path: "/api/v1/retainers/:id",
    operationId: `${method === "get" ? "get" : "update"}Retainer`,
    summary: `${method === "get" ? "Get" : "Update"} a retainer`,
    tag: "retainers",
    responseStatus: 200,
    responseSchema: "RetainerEnvelope",
    ...(method === "patch"
      ? { requestSchema: "RetainerPatch", requestRequired: true }
      : {}),
    parameters: [path("id")],
  })),
  {
    method: "get",
    path: "/api/v1/retainers/:id/ledger",
    operationId: "listRetainerLedger",
    summary: "List append-only retainer movements",
    tag: "retainers",
    responseStatus: 200,
    responseSchema: "RetainerLedgerListEnvelope",
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/retainers/:id/ledger",
    operationId: "appendRetainerLedger",
    summary: "Append a stable retainer movement",
    tag: "retainers",
    responseStatus: 201,
    responseSchema: "RetainerLedgerMutationEnvelope",
    requestSchema: "RetainerLedgerInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/retainers/:id/drawdowns",
    operationId: "drawDownRetainer",
    summary: "Draw down a retainer and return its new balance",
    tag: "retainers",
    responseStatus: 201,
    responseSchema: "RetainerLedgerMutationEnvelope",
    requestSchema: "RetainerDrawdownInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "get",
    path: "/api/v1/recurring-invoices",
    operationId: "listRecurringInvoices",
    summary: "List recurring invoice definitions",
    tag: "recurring-invoices",
    responseStatus: 200,
    responseSchema: "RecurringInvoicePage",
    parameters: pageParameters,
  },
  {
    method: "post",
    path: "/api/v1/recurring-invoices",
    operationId: "createRecurringInvoice",
    summary: "Create a recurring invoice definition",
    tag: "recurring-invoices",
    responseStatus: 201,
    responseSchema: "RecurringInvoiceEnvelope",
    requestSchema: "RecurringInvoiceInput",
    requestRequired: true,
    parameters: [idempotency],
  },
  ...(["get", "patch", "delete"] as const).map((method) => ({
    method,
    path: "/api/v1/recurring-invoices/:id",
    operationId: `${method === "get" ? "get" : method === "patch" ? "update" : "delete"}RecurringInvoice`,
    summary: `${method === "get" ? "Get" : method === "patch" ? "Replace" : "Delete"} a recurring invoice definition`,
    tag: "recurring-invoices",
    responseStatus: method === "delete" ? 204 : 200,
    ...(method === "delete"
      ? {}
      : { responseSchema: "RecurringInvoiceEnvelope" }),
    ...(method === "patch"
      ? { requestSchema: "RecurringInvoiceInput", requestRequired: true }
      : {}),
    parameters: [path("id")],
  })),
  {
    // Filling in the claims a band was issued too early to make (#712).
    // Rehearsal is the default: a call writes nothing unless it says `apply`,
    // because the figures this moves are large enough that nobody should
    // approve them from a description. The invoices are named rather than
    // inferred -- a definition's own invoices are not reliably linked to it.
    method: "post",
    path: "/api/v1/recurring-invoices/:id/claim-backfill",
    operationId: "backfillRecurringInvoiceClaims",
    summary: "Rehearse or apply the claims a band was issued too early to make",
    tag: "recurring-invoices",
    responseStatus: 200,
    responseSchema: "BandClaimBackfillEnvelope",
    requestSchema: "BandClaimBackfillInput",
    requestRequired: true,
    parameters: [path("id"), idempotency],
  },
  {
    method: "post",
    path: "/api/v1/recurring-invoices/:id/generations",
    operationId: "generateRecurringInvoice",
    summary: "Issue the invoice this definition is due for",
    tag: "recurring-invoices",
    responseStatus: 201,
    responseSchema: "RecurringGenerationEnvelope",
    parameters: [path("id"), idempotency],
  },
];

const requiredReportRange = [
  { ...query("from", dateSchema), required: true },
  { ...query("to", dateSchema), required: true },
] as const;

const moduleSettingsOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/admin/modules",
    operationId: "listModules",
    summary: "List module enabled states",
    tag: "admin-modules",
    responseStatus: 200,
    responseSchema: "ModuleListEnvelope",
    sessionOnly: true,
  },
  {
    method: "patch",
    path: "/api/v1/admin/modules/:module",
    operationId: "updateModule",
    summary: "Enable or disable a module",
    tag: "admin-modules",
    responseStatus: 200,
    responseSchema: "ModuleListEnvelope",
    requestSchema: "ModulePatch",
    requestRequired: true,
    sessionOnly: true,
    parameters: [stringPath("module")],
  },
];

// Issue 761. Which ways in the instance offers, as an administrator setting
// rather than three separate deploy secrets.
const accountDeletionOperations: ApiContractOperation[] = [
  { method: "post", path: "/account-deletion/requests/:id/status", operationId: "readAccountDeletionTrackingStatus", summary: "Read minimal deletion status with its private tracking capability", tag: "profile", public: true, responseStatus: 200, responseSchema: "AccountDeletionTrackingEnvelope", requestSchema: "AccountDeletionTrackingInput", requestRequired: true, parameters: [stringPath("id")] },

  { method:"get",path:"/api/v1/admin/retention-reviews",operationId:"listDueRetentionReviews",summary:"List due retained-record and downstream review obligations",tag:"admin-modules",responseStatus:200,responseSchema:"RetentionReviewListEnvelope",sessionOnly:true,parameters:[{name:"after",location:"query",required:false,schema:{type:"string"}}] },
  { method:"get",path:"/api/v1/admin/deletion-requests/:id/retention-reviews",operationId:"readRetentionReviews",summary:"Read recorded retention and cleanup evidence",tag:"admin-modules",responseStatus:200,responseSchema:"RetentionReviewListEnvelope",sessionOnly:true,parameters:[stringPath("id")] },
  { method:"patch",path:"/api/v1/admin/deletion-requests/:id/retention-reviews/:area",operationId:"recordRetentionReview",summary:"Record an operator review with evidence and compare-and-swap",tag:"admin-modules",responseStatus:200,responseSchema:"RetentionReviewEnvelope",sessionOnly:true,parameters:[stringPath("id"),stringPath("area")],requestSchema:"RetentionReviewInput",requestRequired:true },
  { method:"post",path:"/api/v1/admin/deletion-requests/:id/completion",operationId:"completeReviewedDeletionRequest",summary:"Confirm a reviewed request outcome with remaining retention disclosed",tag:"admin-modules",responseStatus:200,responseSchema:"DeletionCompletionEnvelope",sessionOnly:true,parameters:[stringPath("id")],requestSchema:"DeletionCompletionInput",requestRequired:true },
  { method: "get", path: "/api/v1/admin/deletion-requests/:id/closure", operationId: "previewAccountClosure", summary: "Review actual account data before irreversible access closure", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountClosurePreviewEnvelope", sessionOnly: true, parameters: [stringPath("id")] },
  { method: "post", path: "/api/v1/admin/deletion-requests/:id/closure", operationId: "closeAccountAccess", summary: "Erase local credentials and optional profile under reviewed retention decisions", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountClosureRecordEnvelope", sessionOnly: true, parameters: [stringPath("id")], requestSchema: "AccountClosureInput", requestRequired: true },
  { method: "post", path: "/api/v1/admin/deletion-requests/:id/apple-cleanup", operationId: "retryAccountAppleCleanup", summary: "Retry server-managed Apple cleanup after local account closure", tag: "admin-modules", responseStatus: 200, responseSchema: "AppleCleanupStatusEnvelope", sessionOnly: true, parameters: [stringPath("id")], requestSchema: "EmptyObject", requestRequired: true },

  { method: "get", path: "/api/v1/profile/deletion-request", operationId: "getAccountDeletionRequest", summary: "Read your deletion request and original policy disclosure", tag: "profile", responseStatus: 200, responseSchema: "AccountDeletionStatusEnvelope" },
  { method: "get", path: "/api/v1/admin/deletion-requests", operationId: "listAccountDeletionRequests", summary: "List account deletion requests", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountDeletionListEnvelope", sessionOnly: true, parameters: [{ name: "after", location: "query", required: false, schema: { type: "string" } }] },
  { method: "get", path: "/api/v1/admin/deletion-requests/:id", operationId: "getAccountDeletionRequestForAdmin", summary: "Read an account deletion request", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountDeletionDetailEnvelope", sessionOnly: true, parameters: [stringPath("id")] },
  { method: "patch", path: "/api/v1/admin/deletion-requests/:id", operationId: "updateAccountDeletionRequest", summary: "Update request progress without completing erasure", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountDeletionDetailEnvelope", sessionOnly: true, parameters: [stringPath("id")], requestSchema: "AccountDeletionUpdate", requestRequired: true },
  { method: "post", path: "/api/v1/admin/deletion-requests/:id/notification", operationId: "retryAccountDeletionNotification", summary: "Retry an unavailable or failed administrator notification", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountDeletionDetailEnvelope", sessionOnly: true, parameters: [stringPath("id")] },
];

const accountRetentionOperations: ApiContractOperation[] = [
  { method: "get", path: "/api/v1/profile/retention-policy", operationId: "getAccountRetentionPolicy", summary: "Read the operator's published erasure and retention disclosure", tag: "profile", responseStatus: 200, responseSchema: "AccountRetentionEnvelope", description: "Requires a staff session or a token with time_entries:read." },
  { method: "post", path: "/api/v1/admin/retention-policy", operationId: "publishAccountRetentionPolicy", summary: "Publish an operator erasure and retention policy version", tag: "admin-modules", responseStatus: 200, responseSchema: "AccountRetentionEnvelope", requestSchema: "AccountRetentionPublication", requestRequired: true, sessionOnly: true },
];

const signInMethodOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/admin/sign-in-methods",
    operationId: "listSignInMethods",
    summary: "List sign-in methods with their configured and enabled states",
    tag: "admin-modules",
    responseStatus: 200,
    responseSchema: "SignInMethodListEnvelope",
    sessionOnly: true,
  },
  {
    method: "patch",
    path: "/api/v1/admin/sign-in-methods/:method",
    operationId: "updateSignInMethod",
    summary: "Switch a sign-in method on or off",
    tag: "admin-modules",
    responseStatus: 200,
    responseSchema: "SignInMethodListEnvelope",
    requestSchema: "ModulePatch",
    requestRequired: true,
    sessionOnly: true,
    parameters: [stringPath("method")],
  },
];

/**
 * Backup status. Mounted only where the deployment composes a reader, which the
 * Worker does and the container does not -- the container's backups are the
 * operator's own filesystem concern and `RESTORE.md` is the contract there.
 * `entry-surface.ts` declares that difference; documenting the operation here is
 * what lets a generated client call it at all.
 */
const backupOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/backup/status",
    operationId: "getBackupStatus",
    summary: "The last completed and last failed backup run, and recent history",
    tag: "backup",
    responseStatus: 200,
    responseSchema: "BackupStatusEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/backup/runs",
    operationId: "listBackupRuns",
    summary: "List backup runs, newest first, a page at a time",
    description:
      "The history behind the backup status, which holds only the latest runs. " +
      "page.total counts everything the filters match, not only this page.",
    tag: "backup",
    responseStatus: 200,
    responseSchema: "BackupRunPage",
    sessionOnly: true,
    parameters: [
      ...pageParameters,
      query("status", { type: "string", enum: ["running", "completed", "failed"] }),
      query("trigger", { type: "string", enum: ["nightly", "manual"] }),
    ],
  },
];

/**
 * The QuickBooks connection. Mounted only where the deployment carries Intuit
 * keys, the way backup status is mounted only where a reader is composed --
 * offering a connect button that cannot connect is worse than offering none.
 *
 * The callback and the webhook are documented too, with `generateClient: false`
 * -- the same treatment the OIDC redirects get. Neither is a call a generated
 * client would ever make, but both are surface this deployment answers, and a
 * surface the document does not mention is one nobody can discover.
 */
const quickBooksOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/integrations/quickbooks",
    operationId: "getQuickBooksConnection",
    summary: "Whether QuickBooks is configured, and the connected company",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "QuickBooksStatusEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/integrations/quickbooks/authorize",
    operationId: "startQuickBooksAuthorization",
    summary: "Begin connecting a QuickBooks company",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "QuickBooksAuthorizeEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/integrations/quickbooks/settings",
    operationId: "updateQuickBooksSettings",
    summary: "Whether mirrored invoices offer QuickBooks payment links",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "QuickBooksConnectionEnvelope",
    requestSchema: "QuickBooksSettingsInput",
    // The body is the whole request -- without it there is no setting to
    // change -- and the generator uses this to decide whether the argument is
    // optional. Omitting it produced a client method whose default `{}` could
    // not satisfy its own type.
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/integrations/quickbooks",
    operationId: "disconnectQuickBooks",
    summary: "Disconnect the QuickBooks company and revoke the grant",
    tag: "integrations",
    responseStatus: 204,
    sessionOnly: true,
  },
  // Where one invoice stands with QuickBooks, and the button that mirrors it
  // now (issue 819). Gated with the connection routes: same keys, same
  // feature, and `entry-surface.ts` lists them together.
  {
    method: "get",
    path: "/api/v1/invoices/:id/quickbooks",
    operationId: "getInvoiceQuickBooks",
    summary: "Whether this invoice and its payments are mirrored in QuickBooks, and how the last attempt went",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "InvoiceQuickBooksEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/quickbooks/sync",
    operationId: "syncInvoiceQuickBooks",
    summary: "Mirror this invoice and its unmirrored payments to QuickBooks now",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "InvoiceQuickBooksEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/integrations/quickbooks/callback",
    operationId: "completeQuickBooksAuthorization",
    summary: "Where Intuit returns an administrator after they approve",
    tag: "integrations",
    responseStatus: 302,
    public: true,
    parameters: [query("code"), query("state"), query("realmId")],
    generateClient: false,
  },
];

/**
 * Wise, on the organisation's own API token (#543).
 *
 * Every one of these is about the organisation's money leaving the
 * organisation's account, chosen against a list only its token can see, so all
 * of them are administrator-and-accounting. An earlier pass had a per-person
 * OAuth connect flow here; it is gone.
 */
const wiseOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/integrations/wise",
    operationId: "getWiseConnection",
    summary: "Whether Wise is configured, and which profile pays",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "WiseStatusEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/integrations/wise/recipients",
    operationId: "listWiseRecipients",
    summary: "The Wise destinations the organisation can pay",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "WiseRecipientListEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/integrations/wise/recipients",
    operationId: "onboardWiseRecipient",
    summary: "Create a Wise destination from a contractor's email and link it",
    tag: "integrations",
    responseStatus: 201,
    responseSchema: "WiseLinkEnvelope",
    requestSchema: "WiseOnboardInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/integrations/wise/proposals",
    operationId: "listWisePayoutProposals",
    summary: "People with no payout destination, and who at Wise they might be",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "WiseProposalListEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/integrations/wise/destinations/:userId",
    operationId: "getWisePayoutDestination",
    summary: "Where one person is currently paid, if anywhere",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "WiseDestinationEnvelope",
    parameters: [path("userId")],
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/integrations/wise/destinations/:userId",
    operationId: "removeWisePayoutDestination",
    summary: "Remove a person's Wise payout destination",
    tag: "integrations",
    responseStatus: 204,
    parameters: [path("userId")],
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/integrations/wise/contacts",
    operationId: "shareWiseProfile",
    summary: "Point a person at their own Wise profile, found by a Wisetag",
    tag: "integrations",
    responseStatus: 201,
    responseSchema: "WiseContactEnvelope",
    requestSchema: "WiseContactInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/integrations/wise/recipients/link",
    operationId: "linkWiseRecipient",
    summary: "Point a person at the Wise destination they are paid through",
    tag: "integrations",
    responseStatus: 201,
    responseSchema: "WiseLinkEnvelope",
    requestSchema: "WiseLinkInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/integrations/wise/recipients/:accountId",
    operationId: "unlinkWiseRecipient",
    summary: "Detach a person's Wise payout destination",
    tag: "integrations",
    responseStatus: 204,
    parameters: [path("accountId")],
    sessionOnly: true,
  },
];

const ssoDomainOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/settings/sso-domains",
    operationId: "listSsoProvisioningDomains",
    summary: "List SSO provisioning domains and their DNS challenges",
    tag: "sso-domains",
    responseStatus: 200,
    responseSchema: "SsoDomainListEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/sso-domains",
    operationId: "addSsoProvisioningDomain",
    summary: "Claim a domain and issue its DNS challenge",
    tag: "sso-domains",
    responseStatus: 201,
    responseSchema: "SsoDomainEnvelope",
    requestSchema: "SsoDomainInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/settings/sso-domains/:id",
    operationId: "removeSsoProvisioningDomain",
    summary: "Remove a provisioning domain",
    tag: "sso-domains",
    responseStatus: 204,
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/settings/sso-domains/:id/verify",
    operationId: "verifySsoProvisioningDomain",
    summary: "Check the DNS challenge and record the result",
    tag: "sso-domains",
    responseStatus: 200,
    responseSchema: "SsoDomainCheckEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
];

// The upload is multipart and the browser sends it with `fetch` directly, so no
// client method is generated for it: a generated wrapper over `FormData` would
// be a second way to build the same request and only the hand-written one is
// exercised. The list is generated, because the settings screen reads it.
const brandAssetOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/brand",
    operationId: "getBrand",
    summary: "Get the organisation name and brand marks for any principal",
    tag: "brand-assets",
    responseStatus: 200,
    responseSchema: "BrandEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/settings/brand-assets",
    operationId: "listBrandAssets",
    summary: "List the brand marks stored on this instance",
    tag: "brand-assets",
    responseStatus: 200,
    responseSchema: "BrandAssetListEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/brand-assets/:slot",
    operationId: "uploadBrandAsset",
    summary: "Store a brand mark, replacing whatever the slot held",
    tag: "brand-assets",
    responseStatus: 201,
    responseSchema: "BrandAssetEnvelope",
    requestSchema: "BrandAssetUploadInput",
    requestRequired: true,
    requestContentType: "multipart/form-data",
    sessionOnly: true,
    generateClient: false,
    parameters: [stringPath("slot")],
  },
  {
    method: "delete",
    path: "/api/v1/settings/brand-assets/:slot",
    operationId: "removeBrandAsset",
    summary: "Discard a stored brand mark and fall back to configuration",
    tag: "brand-assets",
    responseStatus: 204,
    sessionOnly: true,
    parameters: [stringPath("slot")],
  },
];

const instanceThemeOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/settings/theme",
    operationId: "getInstanceTheme",
    summary: "The palette this instance wears, or null for the built-in theme",
    tag: "instance-theme",
    responseStatus: 200,
    responseSchema: "InstanceThemeEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/theme",
    operationId: "setInstanceTheme",
    summary: "Replace the instance palette, subject to the contrast rule",
    tag: "instance-theme",
    responseStatus: 200,
    responseSchema: "InstanceThemeEnvelope",
    requestSchema: "InstanceThemeInput",
    // The palette is the whole request, and the generator reads this to decide
    // whether the client argument may default to `{}`.
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/settings/theme",
    operationId: "clearInstanceTheme",
    summary: "Return this instance to the built-in theme",
    tag: "instance-theme",
    responseStatus: 204,
    sessionOnly: true,
  },
];

const stripeOperations: ApiContractOperation[] = [
  {
    method: "post",
    path: "/api/v1/invoices/:id/payment-link",
    operationId: "getInvoicePaymentLink",
    summary: "The URL a client pays this invoice at, minted once and reused",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoicePaymentLinkEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const invoiceTimeClaimOperations: ApiContractOperation[] = [
  {
    method: "post",
    path: "/api/v1/invoices/:id/released-time",
    operationId: "releaseInvoicedTime",
    summary: "Hand this invoice's time entries back, once it no longer stands",
    tag: "money",
    responseStatus: 200,
    responseSchema: "ReleasedTimeEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const recurringRepairOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/recurring-invoices/incomplete",
    operationId: "listIncompleteRecurringInvoices",
    summary: "Recurring definitions an import could not finish, and what bills against them",
    tag: "money",
    responseStatus: 200,
    responseSchema: "IncompleteRecurringInvoiceListEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/recurring-invoices/:id/completion",
    operationId: "completeRecurringInvoiceDefinition",
    summary: "Give an unfinished recurring definition its terms",
    tag: "money",
    responseStatus: 200,
    responseSchema: "RecurringInvoiceCompletionEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const invoiceThankYouPreferenceOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/invoices/:id/thank-you-preference",
    operationId: "getInvoiceThankYouPreference",
    summary: "Whether this invoice will thank its client when it settles, and why",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceThankYouPreferenceEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/thank-you-preference",
    operationId: "setInvoiceThankYouPreference",
    summary: "Thank this invoice's client, refuse to, or follow the organization",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceThankYouPreferenceEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/settings/invoice-thank-you",
    operationId: "getOrganizationInvoiceThankYou",
    summary: "Whether settled invoices thank their client by default",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceThankYouEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/invoice-thank-you",
    operationId: "setOrganizationInvoiceThankYou",
    summary: "Set whether settled invoices thank their client by default",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceThankYouEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/settings/invoice-reminders",
    operationId: "getOrganizationInvoiceReminders",
    summary: "The default payment reminder policy for overdue invoices",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceRemindersEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/invoice-reminders",
    operationId: "setOrganizationInvoiceReminders",
    summary: "Set, or switch off, the default payment reminder policy",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceRemindersEnvelope",
    requestSchema: "OrganizationInvoiceRemindersInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/invoices/:id/reminder-preference",
    operationId: "getInvoiceReminderPreference",
    summary: "Whether this invoice will be reminded, and when the next one is booked",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceReminderPreferenceEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/reminder-preference",
    operationId: "setInvoiceReminderPreference",
    summary: "Switch reminders off for this invoice, back on, or follow the organization",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceReminderPreferenceEnvelope",
    requestSchema: "InvoiceReminderPreferenceInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
];

// Invoices › Configure: company information and default values.
const invoiceDefaultsOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/settings/invoice-defaults",
    operationId: "getInvoiceDefaults",
    summary: "The company information invoices print and the values new drafts start with",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceDefaultsEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/invoice-defaults",
    operationId: "updateInvoiceDefaults",
    summary: "Change the company information or the default notes and subject",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceDefaultsEnvelope",
    requestSchema: "InvoiceDefaultsInput",
    requestRequired: true,
    sessionOnly: true,
  },
];

const invoiceDocumentPreferenceOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/invoices/:id/document-preference",
    operationId: "getInvoiceDocumentPreference",
    summary: "Whether this invoice will carry its document, and why",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceDocumentPreferenceEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/document-preference",
    operationId: "setInvoiceDocumentPreference",
    summary: "Attach this invoice's document, refuse it, or follow the organization",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceDocumentPreferenceEnvelope",
    requestSchema: "InvoiceDocumentPreferenceInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/invoices/:id/email-defaults",
    operationId: "getInvoiceEmailDefaults",
    summary:
      "What the Send dialog opens on for this invoice: subject, message, To, Cc, copies, and whether email can be delivered",
    tag: "money",
    responseStatus: 200,
    responseSchema: "InvoiceEmailDefaultsEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/clients/:id/invoice-sending",
    operationId: "getClientInvoiceSending",
    summary: "Who this client's invoices go to and what they carry",
    tag: "money",
    responseStatus: 200,
    responseSchema: "ClientInvoiceSendingEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/clients/:id/invoice-sending",
    operationId: "setClientInvoiceSending",
    summary: "Save who this client's invoices go to and what they carry",
    tag: "money",
    responseStatus: 200,
    responseSchema: "ClientInvoiceSendingEnvelope",
    requestSchema: "ClientInvoiceSendingInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/settings/invoice-sending",
    operationId: "getOrganizationInvoiceSending",
    summary: "The addresses copied on every invoice email",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceSendingEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/invoice-sending",
    operationId: "setOrganizationInvoiceSending",
    summary: "Set the addresses copied on every invoice email",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceSendingEnvelope",
    requestSchema: "OrganizationInvoiceSendingInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/settings/invoice-documents",
    operationId: "getOrganizationInvoiceDocuments",
    summary: "Whether invoices carry their document by default",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceDocumentsEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/settings/invoice-documents",
    operationId: "setOrganizationInvoiceDocuments",
    summary: "Set whether invoices carry their document by default",
    tag: "money",
    responseStatus: 200,
    responseSchema: "OrganizationInvoiceDocumentsEnvelope",
    requestSchema: "OrganizationInvoiceDocumentsInput",
    requestRequired: true,
    sessionOnly: true,
  },
  // The work journal as a file, on demand (issue 647): the email's journal
  // rendered from the same source, internal notes withheld the same way. Read
  // with the invoice's own authority, so a token with invoices:read may.
  {
    method: "get",
    path: "/api/v1/invoices/:id/hours-report",
    operationId: "downloadInvoiceHoursReport",
    summary: "Download the hours an invoice billed as a PDF, CSV or Excel workbook",
    tag: "money",
    responseStatus: 200,
    binaryResponse: true,
    parameters: [
      path("id"),
      {
        name: "format",
        location: "query",
        schema: { type: "string", enum: ["pdf", "csv", "xlsx"] },
        required: true,
      },
      // Absent is the invoice's own journal level, or detailed when its
      // journal is off.
      query("detail", { type: "string", enum: ["detailed", "summary"] }),
    ],
  },
];

const payoutAccountOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/users/:id/payout-accounts",
    operationId: "listPayoutAccounts",
    summary: "The payout accounts a person is currently payable through",
    tag: "payout-accounts",
    responseStatus: 200,
    responseSchema: "PayoutAccountListEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/users/:id/payout-accounts",
    operationId: "linkPayoutAccount",
    summary: "Link a person to their account at a payout provider",
    tag: "payout-accounts",
    responseStatus: 201,
    responseSchema: "PayoutAccountEnvelope",
    requestSchema: "PayoutAccountInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "delete",
    path: "/api/v1/payout-accounts/:id",
    operationId: "detachPayoutAccount",
    summary: "Detach a payout account; re-attaching is a new link",
    tag: "payout-accounts",
    responseStatus: 204,
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const billOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/integrations/bill",
    operationId: "getBillStatus",
    summary: "Whether this deployment can reach BILL, and how it can deliver",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "BillStatusEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/integrations/bill/clients/:id",
    operationId: "getBillClientDelivery",
    summary: "Whether this client is billed through BILL",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "BillClientDeliveryEnvelope",
    sessionOnly: true,
    parameters: [path("id")],
  },
  {
    method: "post",
    path: "/api/v1/integrations/bill/clients/:id",
    operationId: "setBillClientDelivery",
    summary: "Bill this client through BILL, or stop",
    tag: "integrations",
    responseStatus: 200,
    responseSchema: "BillClientDeliveryEnvelope",
    requestSchema: "BillClientDeliveryInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const twoFactorOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/two-factor",
    operationId: "getTwoFactorStatus",
    summary: "Report whether a second factor is enrolled, pending, or absent",
    tag: "two-factor",
    responseStatus: 200,
    responseSchema: "TwoFactorStatusEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/two-factor",
    operationId: "beginTwoFactorEnrolment",
    summary: "Issue a TOTP seed and recovery codes, pending confirmation",
    tag: "two-factor",
    responseStatus: 201,
    responseSchema: "TwoFactorEnrolmentEnvelope",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/two-factor/confirm",
    operationId: "confirmTwoFactorEnrolment",
    summary: "Prove the authenticator holds the seed and turn the factor on",
    tag: "two-factor",
    responseStatus: 200,
    responseSchema: "TwoFactorStatusEnvelope",
    requestSchema: "TwoFactorCodeInput",
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: "delete",
    path: "/api/v1/two-factor",
    operationId: "disableTwoFactor",
    summary: "Remove the second factor, on presentation of a current code",
    tag: "two-factor",
    responseStatus: 200,
    responseSchema: "TwoFactorStatusEnvelope",
    requestSchema: "TwoFactorCodeInput",
    requestRequired: true,
    sessionOnly: true,
  },
];

const userEmailOperations: ApiContractOperation[] = [
  {
    method: "post",
    path: "/api/v1/users/:id/emails",
    operationId: "addUserEmail",
    summary: "Add a second email address and send its verification",
    tag: "users",
    responseStatus: 202,
    responseSchema: "UserEmailAcceptedEnvelope",
    requestSchema: "UserEmailInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id")],
  },
];

const detailedTimeParameters: readonly ApiContractParameter[] = [
  query("self", booleanSchema),
  query("include_fixed_fee", booleanSchema),
  query("direct_client_only", booleanSchema),
  query("contractors_only", booleanSchema),
  query("currency", { type: "string", pattern: "^[A-Za-z]{3}$" }),
  query("project_status", { type: "string", enum: ["all", "active", "archived"] }),
  query("billing_method", { type: "string", enum: ["non_billable", "time_materials", "fixed_fee"] }),
  query("manager_id", integerSchema),
  ...requiredReportRange,
  query("client_id", integerSchema),
  query("project_id", integerSchema),
  query("task_id", integerSchema),
  query("user_id", integerSchema),
  query("role_id", integerSchema),
  query("tag_id", integerSchema),
  // The Show control. Not a pair of booleans: billable-and-uninvoiced is
  // one of the answers, and two flags would also spell the ones that
  // select nothing.
  //
  // `claimed` and `unclaimed` are the band question (#708) and are
  // deliberately not about billable: a fixed amount buys the period, so an
  // hour nobody ticked billable was absorbed by it all the same, and asking
  // "what has this band not taken yet" through `uninvoiced` hides it.
  query("hours", {
    type: "string",
    enum: [
      "all",
      "billable",
      "non_billable",
      "uninvoiced",
      "claimed",
      "unclaimed",
    ],
  }),
  // `entry` is one row per time entry with its id and notes; `day` (the
  // default) is the folded grain the report screen draws.
  query("grain", { type: "string", enum: ["day", "entry"] }),
  // Who reads the notes (D20). `client` withholds a note its entry, or the
  // organization's default, keeps internal -- for a reader such as the
  // client portal that shows them to a client. Absent is `internal` on the
  // report and `client` on its export, which is the file that gets sent.
  query("audience", { type: "string", enum: ["internal", "client"] }),
  query("invoice_state", {
    type: "string",
    enum: ["all", "invoiced", "uninvoiced"],
  }),
  query("active_projects_only", booleanSchema),
  // Entries whose note contains this text, case-insensitively. Under the
  // `client` audience only notes a client may read are searched.
  query("notes", { type: "string", maxLength: 200 }),
];

const reportOperations: ApiContractOperation[] = [
  {
    method: "get", path: "/api/v1/report-definitions/registry",
    operationId: "getReportDefinitionRegistry", summary: "List report builder fields and metrics",
    tag: "reports", responseStatus: 200, responseSchema: "ReportDefinitionRegistryEnvelope",
  },
  {
    method: "get", path: "/api/v1/report-definitions",
    operationId: "listSavedReports", summary: "List report definitions visible to the acting user",
    tag: "reports", responseStatus: 200, responseSchema: "SavedReportListEnvelope",
    parameters: [
      query("view", { type: "string", enum: ["all", "yours", "shared"] }),
      query("q", stringSchema), query("custom_only", booleanSchema),
    ],
  },
  {
    method: "post", path: "/api/v1/report-definitions",
    operationId: "createSavedReport", summary: "Save a report definition",
    tag: "reports", responseStatus: 201, responseSchema: "SavedReportEnvelope",
    requestSchema: "SavedReportInput", requestRequired: true,
  },
  {
    method: "post", path: "/api/v1/report-definitions/preview",
    operationId: "previewReportDefinition", summary: "Run an unsaved report definition",
    tag: "reports", responseStatus: 200, responseSchema: "ReportRunnerEnvelope",
    requestSchema: "SavedReportInput", requestRequired: true,
  },
  {
    method: "get", path: "/api/v1/report-definitions/:reportId",
    operationId: "getSavedReport", summary: "Read a saved report definition",
    tag: "reports", responseStatus: 200, responseSchema: "SavedReportEnvelope",
    parameters: [stringPath("reportId")],
  },
  {
    method: "patch", path: "/api/v1/report-definitions/:reportId",
    operationId: "updateSavedReport", summary: "Update a saved report at an expected version",
    tag: "reports", responseStatus: 200, responseSchema: "SavedReportEnvelope",
    requestSchema: "SavedReportUpdate", requestRequired: true,
    parameters: [stringPath("reportId")],
  },
  {
    method: "delete", path: "/api/v1/report-definitions/:reportId",
    operationId: "deleteSavedReport", summary: "Delete an owned saved report",
    tag: "reports", responseStatus: 204,
    parameters: [stringPath("reportId")],
  },
  {
    method: "post", path: "/api/v1/report-definitions/:reportId/duplicate",
    operationId: "duplicateSavedReport", summary: "Duplicate a visible report into the acting user's library",
    tag: "reports", responseStatus: 201, responseSchema: "SavedReportEnvelope",
    parameters: [stringPath("reportId")],
  },
  {
    method: "post", path: "/api/v1/report-definitions/:reportId/pin",
    operationId: "pinSavedReport", summary: "Pin a visible saved report",
    tag: "reports", responseStatus: 204, parameters: [stringPath("reportId")],
  },
  {
    method: "delete", path: "/api/v1/report-definitions/:reportId/pin",
    operationId: "unpinSavedReport", summary: "Unpin a visible saved report",
    tag: "reports", responseStatus: 204, parameters: [stringPath("reportId")],
  },
  {
    method: "post", path: "/api/v1/report-definitions/:reportId/shares/:userId",
    operationId: "shareSavedReport", summary: "Share an owned report with a teammate",
    tag: "reports", responseStatus: 204,
    parameters: [stringPath("reportId"), path("userId")],
  },
  {
    method: "delete", path: "/api/v1/report-definitions/:reportId/shares/:userId",
    operationId: "unshareSavedReport", summary: "Revoke a teammate's report share",
    tag: "reports", responseStatus: 204,
    parameters: [stringPath("reportId"), path("userId")],
  },
  {
    method: "post", path: "/api/v1/report-definitions/:reportId/run",
    operationId: "runSavedReport", summary: "Run the exact current version of a saved report",
    tag: "reports", responseStatus: 200, responseSchema: "ReportRunnerEnvelope",
    parameters: [stringPath("reportId")],
  },
  {
    method: "get",
    // "my" rather than a `user_id` parameter: whose hours these are comes from
    // the authenticated principal, so the address a member can edit holds no
    // value that points the report at anybody else.
    path: "/api/v1/reports/my-hours",
    operationId: "getMyHoursReport",
    summary: "Report the acting user's own tracked hours by project",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "MyHoursReportEnvelope",
    parameters: [...requiredReportRange, query("project_id", integerSchema)],
  },
  {
    method: "get",
    path: "/api/v1/reports/time",
    operationId: "getTimeReport",
    summary: "Report tracked time by client, project, task and teammate",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "TimeReportEnvelope",
    parameters: [...requiredReportRange, query("include_fixed_fee", booleanSchema)],
  },
  {
    method: "get",
    path: "/api/v1/reports/invoiced",
    operationId: "getInvoicedReport",
    summary: "List invoices issued in a period with paid and balance amounts",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "InvoicedReportEnvelope",
    parameters: [
      ...requiredReportRange,
      query("client_id", integerSchema),
      query("status", { type: "string", enum: ["draft", "open", "paid", "closed"] }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/reports/payments-received",
    operationId: "getPaymentsReceivedReport",
    summary: "List invoice payments received in a period",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "PaymentsReceivedReportEnvelope",
    parameters: [...requiredReportRange, query("client_id", integerSchema)],
  },
  {
    method: "get",
    path: "/api/v1/reports/receivables",
    operationId: "getReceivablesReport",
    summary: "Age outstanding invoice balances by client as of a date",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ReceivablesReportEnvelope",
    parameters: [
      { ...query("as_of", dateSchema), required: true },
      query("client_id", integerSchema),
      // Per invoice, before the aging columns and totals are built.
      query("due_state", { type: "string", enum: ["not_due", "past_due"] }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/reports/contractor",
    operationId: "getContractorCostReport",
    summary: "Total what each person cost over a period",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ContractorCostReportEnvelope",
    parameters: [...requiredReportRange],
  },
  {
    method: "get",
    path: "/api/v1/reports/month-end",
    operationId: "getMonthEndManifest",
    summary: "What a month-end pack would send, before anybody sends it",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "MonthEndManifestEnvelope",
    parameters: [...requiredReportRange],
  },
  {
    method: "get",
    path: "/api/v1/reports/banded-months",
    operationId: "getBandedMonthReport",
    summary: "What a banded month was worth at full rates, against what it charged",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "BandedMonthReportEnvelope",
    parameters: [...requiredReportRange],
  },
  {
    // The line every band's cost is read against (#710). Beside the report
    // rather than in a settings module of its own: it is one number, it exists
    // only because this report compares against it, and the caller who may read
    // the ratio is the caller who needs to set the line.
    method: "get",
    path: "/api/v1/reports/band-cost-alert",
    operationId: "getBandCostAlert",
    summary: "Read the organisation cost-share threshold for banded work",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "BandCostAlertEnvelope",
  },
  {
    method: "post",
    path: "/api/v1/reports/band-cost-alert",
    operationId: "setBandCostAlert",
    summary: "Set the organisation cost-share threshold for banded work",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "BandCostAlertEnvelope",
    requestSchema: "BandCostAlertInput",
    requestRequired: true,
  },
  {
    method: "get",
    path: "/api/v1/reports/profitability",
    operationId: "getProfitabilityReport",
    summary: "Revenue, cost and profit per project against the window before it",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ProfitabilityReportEnvelope",
    parameters: [
      ...requiredReportRange,
      query("project_status", { type: "string", enum: ["all", "active", "archived"] }),
      query("billing_method", {
        type: "string",
        enum: ["non_billable", "time_materials", "fixed_fee"],
      }),
      query("manager_id", integerSchema),
      query("tag_id", integerSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/reports/detailed-expense",
    operationId: "getDetailedExpenseReport",
    summary: "List every expense in a period, one row each",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "DetailedExpenseReportEnvelope",
    parameters: [
      ...requiredReportRange,
      query("client_id", integerSchema),
      query("project_id", integerSchema),
      query("category_id", integerSchema),
      query("user_id", integerSchema),
      query("billable", { type: "boolean" }),
      query("reimbursable", { type: "boolean" }),
      query("invoice_state", { type: "string", enum: ["all", "invoiced", "uninvoiced"] }),
      query("active_projects_only", { type: "boolean" }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/reports/uninvoiced",
    operationId: "getUninvoicedReport",
    summary: "Report uninvoiced tracked time and expenses",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "UninvoicedReportEnvelope",
    parameters: [
      ...requiredReportRange,
      query("client_id", integerSchema),
      query("project_id", integerSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/reports/detailed-time",
    operationId: "getDetailedTimeReport",
    summary: "List tracked time by date, task and person",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "DetailedTimeReportEnvelope",
    parameters: [...detailedTimeParameters],
  },
  // The report as a file (the PDF Harvest's "Detailed time report" was, or
  // the CSV or Excel beside it): the report's own filters, parser and
  // authority, plus `format`. Absent `audience` is `client` here, not
  // `internal`: a file is what is sent, and an internal note leaves only when
  // somebody asks for it by name.
  {
    method: "get",
    path: "/api/v1/reports/detailed-time/export",
    operationId: "downloadDetailedTimeReport",
    summary: "Download the detailed time report as a PDF, CSV or Excel workbook",
    description:
      `Takes every filter of getDetailedTimeReport, with the same defaults but one: an absent audience is client, so only the notes a client may read are in the file unless audience=internal is asked for. Hours only. The file is named detailed-time-<from>-to-<to>[-<client>].<format>. A PDF is refused above ${DETAILED_TIME_PDF_ROW_LIMIT} rows (422, field format); CSV and Excel take the report's whole range.`,
    tag: "reports",
    responseStatus: 200,
    binaryResponse: true,
    parameters: [
      ...detailedTimeParameters,
      {
        name: "format",
        location: "query",
        schema: { type: "string", enum: ["pdf", "csv", "xlsx"] },
        required: true,
      },
    ],
  },
  {
    method: "post",
    path: "/api/v1/reports/detailed-time/actions",
    operationId: "executeDetailedTimeAction",
    summary: "Apply a confirmed idempotent action to selected time rows",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ReportTimeActionEnvelope",
    requestSchema: "ReportTimeActionInput",
    requestRequired: true,
  },
  {
    method: "get",
    path: "/api/v1/reports/client-rollups/:clientId",
    operationId: "getClientRollupReport",
    summary: "Roll up reporting metrics through a client subtree",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ClientRollupReportEnvelope",
    parameters: [path("clientId"), ...requiredReportRange],
  },
  {
    method: "get",
    path: "/api/v1/reports/project-budgets",
    operationId: "listProjectBudgetSummaries",
    summary: "Report budget consumption for every visible project",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ProjectBudgetSummaryListEnvelope",
    parameters: [...requiredReportRange],
  },
  {
    method: "get",
    path: "/api/v1/reports/project-budget/:projectId",
    operationId: "getProjectBudgetReport",
    summary: "Report project budget consumption",
    tag: "reports",
    responseStatus: 200,
    responseSchema: "ProjectBudgetReportEnvelope",
    parameters: [path("projectId"), ...requiredReportRange],
  },
];

const clientTreeOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/clients/:id/ancestors",
    operationId: "listClientAncestors",
    summary: "List ancestors of a client in the hierarchy",
    tag: "client-tree",
    responseStatus: 200,
    responseSchema: "ClientHierarchyListEnvelope",
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/clients/:id/descendants",
    operationId: "listClientDescendants",
    summary: "List descendants of a client in the hierarchy",
    tag: "client-tree",
    responseStatus: 200,
    responseSchema: "ClientHierarchyListEnvelope",
    parameters: [path("id")],
  },
];

const teamOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/team/status",
    operationId: "getTeamStatus",
    summary: "Get Team module availability for navigation",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamStatusEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/team/people",
    operationId: "listTeamPeople",
    summary: "List Team people with authoritative utilization",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamPersonSummaryPage",
    parameters: [
      ...pageParameters,
      { ...query("from", dateSchema), required: true },
      { ...query("to", dateSchema), required: true },
      query("is_active", booleanSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/team/people/:id",
    operationId: "getTeamPerson",
    summary: "Get a Team person editor record",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamPersonEnvelope",
    parameters: [path("id")],
  },
  {
    method: "get",
    path: "/api/v1/team/catalog",
    operationId: "getTeamCatalog",
    summary: "Get roles, departments, and assignable projects",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamCatalogEnvelope",
  },
  {
    method: "patch",
    path: "/api/v1/team/people/:id",
    operationId: "updateTeamPerson",
    summary: "Update a Team person with optimistic concurrency",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamCommandReceiptEnvelope",
    requestSchema: "TeamPersonPatch",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/team/people/:id/project-assignments/replace",
    operationId: "replaceTeamPersonProjectAssignments",
    summary: "Replace a person's active project assignments",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamCommandReceiptEnvelope",
    requestSchema: "TeamAssignmentReplaceInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/team/people/:id/notifications",
    operationId: "updateTeamPersonNotifications",
    summary: "Persist inactive notification preferences; delivery is unavailable",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamCommandReceiptEnvelope",
    requestSchema: "TeamNotificationInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/team/people/:id/rates",
    operationId: "appendTeamPersonRate",
    summary: "Append an effective-dated person rate",
    tag: "team",
    responseStatus: 201,
    responseSchema: "TeamCommandReceiptEnvelope",
    requestSchema: "TeamRateInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    // A removal rather than a correcting append, because appending leaves the
    // wrong row in the history for ever -- and is no remedy at all when the
    // mistaken rate starts earlier than anything that could correct it, since
    // rates may only be appended forward. Which rates may go is the schema's
    // decision: only the current one, and only while nothing was priced from it.
    method: "delete",
    path: "/api/v1/team/people/:id/rates/:rateId",
    operationId: "removeTeamPersonRate",
    summary: "Remove a person rate that has priced nothing",
    tag: "team",
    responseStatus: 200,
    responseSchema: "TeamCommandReceiptEnvelope",
    requestSchema: "TeamRateRemovalInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), path("rateId"), header("Idempotency-Key")],
  },
  {
    // Pricing the cost of hours tracked before a person had a cost rate (#750).
    // Rehearsal is the default: a call writes nothing unless it says `apply`.
    // The rate and the range are always the caller's; the idempotency key names
    // the run recorded on every reprice row it writes.
    method: "post",
    path: "/api/v1/team/people/:id/cost-rate-backfill",
    operationId: "backfillTeamPersonCostRate",
    summary: "Rehearse or apply a cost rate over hours tracked before the person had one",
    tag: "team",
    responseStatus: 200,
    responseSchema: "CostRateBackfillEnvelope",
    requestSchema: "CostRateBackfillInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
];

export const apiContractOperations: readonly ApiContractOperation[] = [
  { method:"get",path:"/auth/apple/native-capabilities",operationId:"getNativeAppleCapabilities",summary:"Check explicit native Apple lifecycle protocol support",tag:"authentication",public:true,responseStatus:200,responseSchema:"NativeAppleCapabilities" },
  { method:"post",path:"/auth/apple",operationId:"signInNativeApple",summary:"Verify origin-bound Apple lifecycle custody and native identity before sign-in",tag:"authentication",public:true,responseStatus:200,responseSchema:"NativeAppleSignInEnvelope",requestSchema:"NativeAppleSignInInput",requestRequired:true },
  { method:"post",path:"/auth/apple/deletion-requests/:id/binding",operationId:"rebindAppleCleanup",summary:"Bind fresh cleanup-purpose Apple custody to a pending deletion request",tag:"authentication",public:true,responseStatus:204,requestSchema:"AppleLifecycleProofInput",requestRequired:true,parameters:[stringPath("id")] },
  { method:"post",path:"/auth/apple/deletion-requests/:id/revocation",operationId:"acceptAppleRevocation",summary:"Durably accept exact request-bound Apple invalidation evidence",tag:"authentication",public:true,responseStatus:204,requestSchema:"AppleLifecycleProofInput",requestRequired:true,parameters:[stringPath("id")] },
  {
    method: "get",
    path: "/auth/oidc/:provider",
    operationId: "startOidcSignIn",
    summary: "Start an OpenID Connect sign-in",
    tag: "authentication",
    responseStatus: 302,
    public: true,
    parameters: [stringPath("provider")],
    generateClient: false,
  },
  {
    method: "get",
    path: "/auth/oidc/:provider/callback",
    operationId: "completeOidcSignIn",
    summary: "Complete an OpenID Connect sign-in",
    tag: "authentication",
    responseStatus: 303,
    public: true,
    parameters: [stringPath("provider"), query("code"), query("state")],
    generateClient: false,
  },
  {
    method: "post",
    path: "/auth/oidc/exchange",
    operationId: "exchangeOidcAppCode",
    summary: "Exchange a native-app OIDC sign-in code for a session",
    tag: "authentication",
    responseStatus: 200,
    public: true,
    generateClient: false,
  },
  {
    method: "post",
    path: "/auth/signup",
    operationId: "signup",
    summary: "Create the first owner and send email verification",
    tag: "authentication",
    responseStatus: 202,
    responseSchema: "AuthAcceptedEnvelope",
    requestSchema: "SignupInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "post",
    path: "/auth/verify-email",
    operationId: "verifyEmail",
    summary: "Verify an email address",
    tag: "authentication",
    responseStatus: 200,
    responseSchema: "AuthPrincipalEnvelope",
    requestSchema: "AuthTokenInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "post",
    path: "/auth/sign-in",
    operationId: "signIn",
    summary: "Authenticate a verified email and password",
    tag: "authentication",
    responseStatus: 200,
    // Two shapes, because an enrolled user is not signed in yet: a principal
    // and a session cookie, or a two-factor challenge and no session at all.
    responseSchema: "SignInResultEnvelope",
    requestSchema: "PasswordSignInInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "post",
    path: "/auth/two-factor/challenge",
    operationId: "completeTwoFactorChallenge",
    summary: "Answer a two-factor challenge and receive the session",
    tag: "authentication",
    responseStatus: 200,
    responseSchema: "TwoFactorChallengeAcceptedEnvelope",
    requestSchema: "TwoFactorChallengeInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "post",
    path: "/auth/password/forgot",
    operationId: "requestPasswordReset",
    summary: "Request a password-reset email",
    tag: "authentication",
    responseStatus: 202,
    responseSchema: "AuthAcceptedEnvelope",
    requestSchema: "EmailInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "post",
    path: "/auth/password/reset",
    operationId: "resetPassword",
    summary: "Consume a password-reset token",
    tag: "authentication",
    responseStatus: 200,
    responseSchema: "AuthPrincipalEnvelope",
    requestSchema: "PasswordResetInput",
    requestRequired: true,
    public: true,
  },
  {
    method: "get",
    path: "/api/v1/sessions",
    operationId: "listSessions",
    summary: "List sessions for the acting user",
    tag: "authentication",
    responseStatus: 200,
    responseSchema: "SessionPage",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/email-log",
    operationId: "listEmailLog",
    summary: "List outbound email delivery outcomes",
    description:
      "Newest first, or oldest first with order=oldest, a page at a time. " +
      "The first page fixes the traversal to the mail that existed when it was read: mail sent after it does not appear on later pages of the same traversal. " +
      "The filters combine. from and to are calendar days in the organization's timezone, both included. " +
      "q matches part of a recipient's address or name in To or Cc, ignoring case. " +
      "page.total counts everything the filters match, not only this page.",
    tag: "email",
    responseStatus: 200,
    responseSchema: "EmailLogPage",
    sessionOnly: true,
    parameters: [
      ...pageParameters,
      query("status", {
        type: "string",
        enum: ["queued", "sent", "bounced", "complained", "failed"],
      }),
      query("kind", {
        type: "string",
        enum: ["invoice", "invoice_preview", "reminder", "thank_you", "sign_in", "account"],
      }),
      query("from", dateSchema),
      query("to", dateSchema),
      query("q", { type: "string", minLength: 1, maxLength: 200 }),
      query("order", { type: "string", enum: ["newest", "oldest"] }),
    ],
  },
  {
    method: "get",
    path: "/api/v1/email-health",
    operationId: "getEmailHealth",
    summary: "Get email reputation health with bounce and complaint rates",
    tag: "email",
    responseStatus: 200,
    responseSchema: "EmailHealthEnvelope",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/email-template-variables",
    operationId: "listEmailTemplateVariables",
    summary: "List the closed email-template variable vocabulary",
    tag: "email",
    responseStatus: 200,
    responseSchema: "EmailTemplateVariableCatalog",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/email-templates",
    operationId: "listEmailTemplates",
    summary: "List active versioned email templates",
    tag: "email",
    responseStatus: 200,
    responseSchema: "EmailTemplatePage",
    sessionOnly: true,
  },
  {
    method: "get",
    path: "/api/v1/email-templates/:kind/versions",
    operationId: "listEmailTemplateVersions",
    summary: "List immutable versions of an email template",
    tag: "email",
    responseStatus: 200,
    responseSchema: "EmailTemplatePage",
    sessionOnly: true,
    parameters: [stringPath("kind")],
  },
  {
    method: "post",
    path: "/api/v1/email-templates/:kind/versions",
    operationId: "createEmailTemplateVersion",
    summary: "Append an immutable email-template version",
    tag: "email",
    responseStatus: 201,
    responseSchema: "EmailTemplateEnvelope",
    requestSchema: "EmailTemplateVersionInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [stringPath("kind"), header("Idempotency-Key")],
  },
  {
    method: "get",
    path: "/api/v1/sender-identities",
    operationId: "listSenderIdentities",
    summary: "List organization sender identities and provider evidence",
    tag: "email",
    responseStatus: 200,
    responseSchema: "SenderIdentityPage",
    sessionOnly: true,
  },
  {
    method: "post",
    path: "/api/v1/sender-identities",
    operationId: "createSenderIdentity",
    summary: "Configure an unverified organization sender identity",
    tag: "email",
    responseStatus: 201,
    responseSchema: "SenderIdentityEnvelope",
    requestSchema: "SenderIdentityInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [header("Idempotency-Key")],
  },
  {
    method: "patch",
    path: "/api/v1/sender-identities/:id",
    operationId: "updateSenderIdentity",
    summary: "Update sender display and Reply-To configuration",
    tag: "email",
    responseStatus: 200,
    responseSchema: "SenderIdentityEnvelope",
    requestSchema: "SenderIdentityPatch",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/sender-identities/:id/default",
    operationId: "setDefaultSenderIdentity",
    summary: "Select a fully verified default sender identity",
    tag: "email",
    responseStatus: 200,
    responseSchema: "SenderIdentityEnvelope",
    requestSchema: "SenderIdentityVersionInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/sender-identities/:id/archive",
    operationId: "archiveSenderIdentity",
    summary: "Archive a non-default sender identity",
    tag: "email",
    responseStatus: 200,
    responseSchema: "SenderIdentityEnvelope",
    requestSchema: "SenderIdentityVersionInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/sender-identities/:id/refresh",
    operationId: "refreshSenderIdentityEvidence",
    summary: "Refresh authoritative sender verification evidence from its provider",
    tag: "email",
    responseStatus: 200,
    responseSchema: "SenderIdentityEnvelope",
    requestSchema: "SenderEvidenceRefreshInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "post",
    path: "/api/v1/sender-identities/:id/test-send",
    operationId: "testSendEmailTemplate",
    summary: "Queue a persisted organization-template test to the acting administrator",
    tag: "email",
    responseStatus: 202,
    responseSchema: "EmailTestSendEnvelope",
    requestSchema: "EmailTestSendInput",
    requestRequired: true,
    sessionOnly: true,
    parameters: [path("id"), header("Idempotency-Key")],
  },
  {
    method: "get",
    path: "/api/v1/activity-log",
    operationId: "listActivityLog",
    summary: "List activity recorded from delivered domain events",
    tag: "activity",
    responseStatus: 200,
    responseSchema: "ActivityLogPage",
    parameters: [
      query("per_page", { type: "integer", minimum: 1, maximum: 200 }),
      query("from", dateSchema),
      query("to", dateSchema),
      query("event_type", stringSchema),
      query("actor_id", integerSchema),
    ],
  },
  {
    method: "get",
    path: "/api/v1/outbox-deliveries",
    operationId: "listOutboxDeliveries",
    summary: "List domain-event subscriber delivery outcomes",
    description:
      "Newest first, or oldest first with order=oldest, a page at a time, by when the delivery was created. " +
      "from and to are calendar days in the organization's timezone, both included. " +
      "page.total counts everything the filters match, not only this page.",
    tag: "operations",
    responseStatus: 200,
    responseSchema: "OutboxDeliveryPage",
    sessionOnly: true,
    parameters: [
      ...pageParameters,
      query("status", {
        type: "string",
        enum: ["pending", "processing", "delivered", "failed"],
      }),
      query("event_type", stringSchema),
      query("from", dateSchema),
      query("to", dateSchema),
      query("order", { type: "string", enum: ["newest", "oldest"] }),
    ],
  },
  {
    method: "post",
    path: "/api/v1/outbox-deliveries/:subscriberId/:eventId/retry",
    operationId: "retryOutboxDelivery",
    summary: "Retry a failed domain-event subscriber delivery",
    tag: "operations",
    responseStatus: 200,
    responseSchema: "OutboxDeliveryEnvelope",
    sessionOnly: true,
    parameters: [stringPath("subscriberId"), stringPath("eventId")],
  },
  {
    method: "delete",
    path: "/api/v1/sessions/:sessionId",
    operationId: "revokeSession",
    summary: "Revoke a session for the acting user",
    tag: "authentication",
    responseStatus: 200,
    responseSchema: "SessionEnvelope",
    sessionOnly: true,
    parameters: [path("sessionId")],
  },
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
    path: "/api/v1/whoami",
    operationId: "getWhoami",
    summary: "Get the authenticated user and credential authority",
    tag: "identity",
    responseStatus: 200,
    responseSchema: "WhoamiEnvelope",
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
  {
    method: "get",
    path: "/api/v1/profile",
    operationId: "getProfile",
    summary: "The signed-in user's own profile",
    tag: "profile",
    responseStatus: 200,
    responseSchema: "ProfileEnvelope",
  },
  {
    method: "patch",
    path: "/api/v1/profile",
    operationId: "updateProfile",
    summary: "Update the signed-in user's own profile",
    tag: "profile",
    responseStatus: 200,
    responseSchema: "ProfileEnvelope",
    requestSchema: "ProfilePatch",
    requestRequired: true,
  },
  {
    // Durable requests on current runtimes; legacy adapters retain the base envelope.
    method: "post",
    path: "/api/v1/profile/deletion-request",
    operationId: "requestAccountDeletion",
    summary: "Ask the administrators to delete the signed-in user's own account",
    tag: "profile",
    responseStatus: 202,
    responseSchema: "AccountDeletionRequestEnvelope",
    requestSchema: "AccountDeletionSubmission",
  },
  ...generalOperations(),
  ...rateOperations(),
  ...timeEntryOperations,
  ...timesheetApprovalOperations,
  ...timesheetLockPolicyOperations,
  ...expenseOperations,
  ...moneyOperations,
  ...attachmentContractOperations,
  ...staffPaymentOperations,
  ...paymentRunOperations,
  ...reportOperations,
  ...moduleSettingsOperations,
  ...signInMethodOperations,
  ...accountRetentionOperations,
  ...accountDeletionOperations,
  ...backupOperations,
  ...quickBooksOperations,
  ...wiseOperations,
  ...ssoDomainOperations,
  ...brandAssetOperations,
  ...instanceThemeOperations,
  ...stripeOperations,
  ...invoiceTimeClaimOperations,
  ...invoiceDocumentPreferenceOperations,
  ...invoiceDefaultsOperations,
  ...invoiceThankYouPreferenceOperations,
  ...recurringRepairOperations,
  ...payoutAccountOperations,
  ...billOperations,
  ...twoFactorOperations,
  ...userEmailOperations,
  ...teamOperations,
  ...clientTreeOperations,
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

/** A page that also says how many rows its filters match (issue 929). */
const countedPage = (name: string): JsonSchema => ({
  type: "object",
  required: ["data", "links", "page"],
  properties: {
    data: { type: "array", items: reference(name) },
    links: reference("PageLinks"),
    page: reference("CountedPageMetadata"),
  },
  additionalProperties: false,
});

const retainerInputVariant = (
  denomination: "money" | "hours",
  locked: boolean,
): JsonSchema => ({
  type: "object",
  required: [
    "denomination",
    denomination === "money" ? "amount_cents" : "seconds",
    ...(locked ? ["locked_rate_cents", "rate_locked_at"] : []),
  ],
  properties: {
    client_id: nullable(integerSchema),
    project_id: nullable(integerSchema),
    denomination: { const: denomination },
    ...(denomination === "money"
      ? {
          amount_cents: {
            type: "integer",
            minimum: 0,
            maximum: 9_000_000_000_000,
          },
        }
      : {
          seconds: { type: "integer", minimum: 0 },
          ...(locked
            ? {
                locked_rate_cents: {
                  type: "integer",
                  minimum: 0,
                  maximum: 9_000_000_000_000,
                },
                rate_locked_at: timestampSchema,
              }
            : {}),
        }),
    period: nullable({ type: "string", maxLength: 64 }),
    rollover: nullable({ type: "string", enum: ["carry", "expire", "cap"] }),
    expires_at: nullable(dateSchema),
    on_exhaustion: { type: "string", enum: ["block", "warn", "overflow"] },
  },
  additionalProperties: false,
});

const retainerLedgerVariant = (
  kind: "deposit" | "drawdown" | "expiry" | "reset" | "adjustment",
  unit: "amount_cents" | "seconds",
): JsonSchema => {
  const requiresInvoice = kind === "deposit" || kind === "drawdown";
  const requiresNotes = kind === "adjustment";
  const signed = kind === "reset" || kind === "adjustment";
  return {
    type: "object",
    required: [
      "kind",
      unit,
      "occurred_on",
      ...(requiresInvoice ? ["invoice_id"] : []),
      ...(requiresNotes ? ["notes"] : []),
    ],
    properties: {
      kind: { const: kind },
      ...(requiresInvoice ? { invoice_id: integerSchema } : {}),
      [unit]: {
        type: "integer",
        ...(signed
          ? {
              minimum:
                unit === "amount_cents"
                  ? -9_000_000_000_000
                  : -9_007_199_254_740_991,
              maximum:
                unit === "amount_cents"
                  ? 9_000_000_000_000
                  : 9_007_199_254_740_991,
              not: { const: 0 },
            }
          : {
              minimum: 1,
              ...(unit === "amount_cents"
                ? { maximum: 9_000_000_000_000 }
                : {}),
            }),
      },
      occurred_on: dateSchema,
      notes: requiresNotes
        ? { type: "string", minLength: 1, pattern: "\\S" }
        : nullable(stringSchema),
    },
    additionalProperties: false,
  };
};

const recurringImportVariant = (
  mode: "time" | "expenses" | "both",
): JsonSchema => ({
  type: "object",
  required: [
    "schema_version",
    "type",
    "project_ids",
    ...(mode === "time" || mode === "both" ? ["time"] : []),
    ...(mode === "expenses" || mode === "both" ? ["expenses"] : []),
  ],
  properties: {
    schema_version: { const: 1 },
    type: { const: "line_items_import" },
    project_ids: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: integerSchema,
    },
    ...(mode === "time" || mode === "both"
      ? {
          time: {
            type: "object",
            required: ["summary_type"],
            properties: {
              summary_type: {
                type: "string",
                enum: ["project", "task", "people", "detailed"],
              },
            },
            additionalProperties: false,
          },
        }
      : {}),
    ...(mode === "expenses" || mode === "both"
      ? {
          expenses: {
            type: "object",
            required: ["summary_type"],
            properties: {
              summary_type: {
                type: "string",
                enum: ["project", "category", "people", "detailed"],
              },
            },
            additionalProperties: false,
          },
        }
      : {}),
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

/**
 * The five figures every Time report row -- and the Total above them -- carries.
 * Stated once because the four tabs are folds of a single dataset: a column
 * added to one tab and forgotten on the total row would be a report whose Total
 * does not total.
 *
 * `amounts` is optional rather than nullable because it is *absent* for a
 * viewer who may not see billable rates, the way every other report here
 * withholds money. An empty array would say "no billable work in this period",
 * which is a different claim.
 */
const timeReportTotalsProperties: Readonly<Record<string, JsonSchema>> = {
  // Tracked and rounded both: they differ on an account that rounds, and a
  // report carrying only one disagrees with the timesheet beside it.
  seconds: signedIntegerSchema,
  rounded_seconds: signedIntegerSchema,
  billable_seconds: signedIntegerSchema,
  time_entry_count: { type: "integer", minimum: 0 },
  unpriced_billable_entry_count: { type: "integer", minimum: 0 },
  amounts: { type: "array", items: reference("TimeReportAmount") },
};
const timeReportTotalsRequired: readonly string[] = [
  "seconds",
  "rounded_seconds",
  "billable_seconds",
  "time_entry_count",
  "unpriced_billable_entry_count",
];

export const apiContractSchemas: Readonly<Record<string, JsonSchema>> = {
  ...attachmentContractSchemas,
  ...staffPaymentSchemas,
  ...paymentRunSchemas,
  InvoiceReminderPolicy: {
    type: "object",
    required: ["first_after_days", "every_days"],
    properties: {
      first_after_days: { type: "integer", minimum: 0 },
      every_days: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  FieldError: {
    type: "object",
    required: ["field", "code", "message"],
    properties: {
      field: stringSchema,
      code: stringSchema,
      message: stringSchema,
      minimum_length: { type: "integer", minimum: 1, maximum: 10000 },
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
  SignupInput: {
    type: "object",
    required: [
      "organization_name",
      "first_name",
      "last_name",
      "email",
      "password",
    ],
    properties: {
      organization_name: stringSchema,
      first_name: stringSchema,
      last_name: stringSchema,
      email: { type: "string", format: "email" },
      password: stringSchema,
    },
    additionalProperties: false,
  },
  AuthTokenInput: {
    type: "object",
    required: ["token"],
    properties: { token: stringSchema },
    additionalProperties: false,
  },
  PasswordSignInInput: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: stringSchema,
    },
    additionalProperties: false,
  },
  EmailInput: {
    type: "object",
    required: ["email"],
    properties: { email: { type: "string", format: "email" } },
    additionalProperties: false,
  },
  PasswordResetInput: {
    type: "object",
    required: ["token", "password"],
    properties: { token: stringSchema, password: stringSchema },
    additionalProperties: false,
  },
  AuthAccepted: {
    type: "object",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["verification_sent", "reset_requested"],
      },
    },
    additionalProperties: false,
  },
  AuthAcceptedEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("AuthAccepted") },
    additionalProperties: false,
  },
  AuthPrincipal: {
    type: "object",
    required: ["status", "user_id", "profile", "manager_grants"],
    properties: {
      status: {
        type: "string",
        enum: ["verified", "authenticated", "password_reset"],
      },
      user_id: integerSchema,
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
      manager_grants: { type: "array", items: stringSchema },
    },
    additionalProperties: false,
  },
  AuthPrincipalEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("AuthPrincipal") },
    additionalProperties: false,
  },
  Session: {
    type: "object",
    required: [
      "id",
      "created_at",
      "last_seen_at",
      "idle_expires_at",
      "absolute_expires_at",
      "revoked_at",
      "revocation_reason",
      "current",
    ],
    properties: {
      id: integerSchema,
      created_at: timestampSchema,
      last_seen_at: timestampSchema,
      idle_expires_at: timestampSchema,
      absolute_expires_at: timestampSchema,
      revoked_at: nullable(timestampSchema),
      revocation_reason: nullable({
        type: "string",
        enum: [
          "user_revoked",
          "privilege_change",
          "password_reset",
          "user_disabled",
        ],
      }),
      current: booleanSchema,
    },
    additionalProperties: false,
  },
  SessionEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("Session") },
    additionalProperties: false,
  },
  SessionPage: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("Session") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  EmailRecipient: {
    type: "object",
    required: ["email"],
    properties: {
      email: stringSchema,
      name: stringSchema,
    },
    additionalProperties: false,
  },
  EmailLog: {
    type: "object",
    required: [
      "id",
      "from",
      "reply_to",
      "to",
      "cc",
      "template",
      "subject",
      "provider",
      "provider_message_id",
      "provider_request_id",
      "provider_latency_ms",
      "status",
      "related_type",
      "related_id",
      "attempt_count",
      "failure_code",
      "failure_reason",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      from: nullable(reference("EmailRecipient")),
      reply_to: { type: "array", items: reference("EmailRecipient") },
      to: { type: "array", items: reference("EmailRecipient") },
      cc: { type: "array", items: reference("EmailRecipient") },
      template: stringSchema,
      subject: stringSchema,
      provider: nullable(stringSchema),
      provider_message_id: nullable(stringSchema),
      provider_request_id: nullable(stringSchema),
      provider_latency_ms: nullable({
        type: "integer",
        minimum: 0,
        maximum: 3000000,
      }),
      status: {
        type: "string",
        enum: ["queued", "sent", "bounced", "complained", "failed"],
      },
      related_type: nullable(stringSchema),
      related_id: nullable(integerSchema),
      attempt_count: { type: "integer", minimum: 0 },
      failure_code: nullable({
        type: "string",
        enum: ["queue_unavailable", "provider_timeout", "provider_rejected"],
      }),
      failure_reason: nullable(stringSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  EmailLogPage: countedPage("EmailLog"),
  EmailReputationSnapshot: {
    type: "object",
    required: [
      "sent",
      "bounced",
      "complained",
      "failed",
      "bounce_rate_ppm",
      "complaint_rate_ppm",
    ],
    properties: {
      sent: { type: "integer", minimum: 0 },
      bounced: { type: "integer", minimum: 0 },
      complained: { type: "integer", minimum: 0 },
      failed: { type: "integer", minimum: 0 },
      bounce_rate_ppm: { type: "integer", minimum: 0, maximum: 1_000_000 },
      complaint_rate_ppm: { type: "integer", minimum: 0, maximum: 1_000_000 },
    },
    additionalProperties: false,
  },
  EmailHealth: {
    type: "object",
    required: ["reputation"],
    properties: {
      reputation: reference("EmailReputationSnapshot"),
    },
    additionalProperties: false,
  },
  EmailHealthEnvelope: envelope("EmailHealth"),
  EmailTemplateVariable: {
    type: "object",
    required: ["name", "token", "description", "compatibility"],
    properties: {
      name: stringSchema,
      token: { type: "string", pattern: "^%[a-z0-9_]+%$" },
      description: stringSchema,
      compatibility: { type: "string", enum: ["harvest", "native"] },
    },
    additionalProperties: false,
  },
  EmailTemplateVariableGroup: {
    type: "object",
    required: ["kind", "variables"],
    properties: {
      kind: {
        type: "string",
        enum: [
          "invoice",
          "reminder",
          "thank_you",
          "auth_email_verification",
          "auth_password_reset",
        ],
      },
      variables: { type: "array", items: reference("EmailTemplateVariable") },
    },
    additionalProperties: false,
  },
  EmailTemplateVariableCatalog: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("EmailTemplateVariableGroup") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  EmailTemplate: {
    type: "object",
    required: [
      "kind",
      "version",
      "subject_template",
      "text_template",
      "html_template",
      "unknown_variable_policy",
      "created_by_user_id",
      "created_at",
    ],
    properties: {
      kind: {
        type: "string",
        enum: [
          "invoice",
          "reminder",
          "thank_you",
          "auth_email_verification",
          "auth_password_reset",
        ],
      },
      version: integerSchema,
      subject_template: stringSchema,
      text_template: stringSchema,
      html_template: nullable(stringSchema),
      unknown_variable_policy: { type: "string", enum: ["error", "literal"] },
      created_by_user_id: nullable(integerSchema),
      created_at: timestampSchema,
    },
    additionalProperties: false,
  },
  EmailTemplatePage: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("EmailTemplate") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  EmailTemplateEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("EmailTemplate") },
    additionalProperties: false,
  },
  EmailTemplateVersionInput: {
    type: "object",
    required: ["expected_version", "subject_template", "text_template"],
    properties: {
      expected_version: integerSchema,
      subject_template: { type: "string", minLength: 1, maxLength: 998 },
      text_template: { type: "string", minLength: 1, maxLength: 1000000 },
      html_template: nullable({ type: "string", minLength: 1, maxLength: 2000000 }),
      unknown_variable_policy: { type: "string", enum: ["error", "literal"] },
    },
    additionalProperties: false,
  },
  SenderIdentityEvidence: {
    type: "object",
    required: [
      "version",
      "source",
      "identity_kind",
      "verification_status",
      "dkim_status",
      "mail_from_domain",
      "mail_from_status",
      "observed_at",
    ],
    properties: {
      version: integerSchema,
      source: {
        type: "string",
        enum: ["provider_api", "deployment_config"],
      },
      identity_kind: {
        type: "string",
        enum: ["email_address", "domain"],
      },
      verification_status: {
        type: "string",
        enum: [
          "pending",
          "verified",
          "failed",
          "temporary_failure",
          "operator_configured",
        ],
      },
      dkim_status: {
        type: "string",
        enum: ["pending", "verified", "failed", "not_applicable"],
      },
      mail_from_domain: nullable(stringSchema),
      mail_from_status: {
        type: "string",
        enum: ["pending", "verified", "failed", "not_configured"],
      },
      observed_at: timestampSchema,
    },
    additionalProperties: false,
  },
  SenderIdentity: {
    type: "object",
    required: [
      "id",
      "email",
      "display_name",
      "reply_to_email",
      "provider",
      "provider_identity",
      "is_default",
      "version",
      "archived_at",
      "evidence",
      "created_by_user_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      email: { type: "string", format: "email" },
      display_name: stringSchema,
      reply_to_email: nullable({ type: "string", format: "email" }),
      provider: stringSchema,
      provider_identity: stringSchema,
      is_default: booleanSchema,
      version: { type: "integer", minimum: 0 },
      archived_at: nullable(timestampSchema),
      evidence: nullable(reference("SenderIdentityEvidence")),
      created_by_user_id: integerSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  SenderIdentityPage: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("SenderIdentity") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  SenderIdentityEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("SenderIdentity") },
    additionalProperties: false,
  },
  SenderIdentityInput: {
    type: "object",
    required: ["email", "display_name", "provider", "provider_identity"],
    properties: {
      email: { type: "string", format: "email", maxLength: 254 },
      display_name: { type: "string", minLength: 1, maxLength: 200 },
      reply_to_email: nullable({ type: "string", format: "email", maxLength: 254 }),
      provider: { type: "string", minLength: 1, maxLength: 64 },
      provider_identity: { type: "string", minLength: 1, maxLength: 320 },
    },
    additionalProperties: false,
  },
  SenderIdentityPatch: {
    type: "object",
    required: ["expected_version"],
    minProperties: 2,
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      display_name: { type: "string", minLength: 1, maxLength: 200 },
      reply_to_email: nullable({ type: "string", format: "email", maxLength: 254 }),
    },
    additionalProperties: false,
  },
  SenderIdentityVersionInput: {
    type: "object",
    required: ["expected_version"],
    properties: { expected_version: { type: "integer", minimum: 0 } },
    additionalProperties: false,
  },
  BackupRun: {
    type: "object",
    required: [
      "id",
      "status",
      "trigger",
      "started_at",
      "completed_at",
      "r2_prefix",
      "table_count",
      "total_rows",
      "error_message",
    ],
    properties: {
      id: integerSchema,
      status: { type: "string", enum: ["running", "completed", "failed"] },
      trigger: { type: "string", enum: ["nightly", "manual"] },
      started_at: timestampSchema,
      completed_at: nullable(timestampSchema),
      r2_prefix: nullable(stringSchema),
      table_count: nullable(integerSchema),
      total_rows: nullable(integerSchema),
      error_message: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  BackupRunPage: countedPage("BackupRun"),
  BackupStatusEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: {
        type: "object",
        required: ["last_completed", "last_failed", "recent_runs", "has_failure"],
        properties: {
          last_completed: nullable(reference("BackupRun")),
          last_failed: nullable(reference("BackupRun")),
          recent_runs: { type: "array", items: reference("BackupRun") },
          has_failure: { type: "boolean" },
        },
        additionalProperties: false,
      },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  QuickBooksConnection: {
    type: "object",
    required: [
      "realm_id",
      "company_name",
      "scope",
      "allow_online_payment",
      "connected_at",
    ],
    properties: {
      realm_id: stringSchema,
      company_name: nullable(stringSchema),
      scope: stringSchema,
      allow_online_payment: { type: "boolean" },
      connected_at: stringSchema,
    },
    additionalProperties: false,
  },
  QuickBooksStatusEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["configured", "connection"],
        properties: {
          configured: { type: "boolean" },
          connection: nullable(reference("QuickBooksConnection")),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  QuickBooksAuthorizeEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["authorize_url"],
        properties: { authorize_url: stringSchema },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WiseConnection: {
    type: "object",
    required: ["profile_id", "profile_name", "payable_recipients", "webhooks_verifiable"],
    properties: {
      profile_id: stringSchema,
      profile_name: nullable(stringSchema),
      payable_recipients: { type: "integer" },
      // False is a connection that can send money and cannot be told what
      // became of it.
      webhooks_verifiable: { type: "boolean" },
    },
    additionalProperties: false,
  },
  WiseRecipient: {
    type: "object",
    required: ["id", "holder_name", "currency", "type", "masked_summary", "email"],
    properties: {
      id: stringSchema,
      holder_name: nullable(stringSchema),
      currency: stringSchema,
      type: stringSchema,
      // Masked. Wise's own `accountSummary` is the full account number despite
      // the name, and is deliberately not carried anywhere near this document.
      masked_summary: nullable(stringSchema),
      email: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  WiseStatusEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["configured", "connection"],
        properties: {
          configured: { type: "boolean" },
          connection: nullable(reference("WiseConnection")),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WiseRecipientListEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: { type: "array", items: reference("WiseRecipient") } },
    additionalProperties: false,
  },
  /**
   * Onboarding input, and the shape is the decision.
   *
   * An email address and a name, and nowhere at all to put an account number:
   * Wise collects the bank details from the contractor directly, so none ever
   * exists here to be logged, backed up or leaked.
   */
  WiseOnboardInput: {
    type: "object",
    required: ["user_id", "email", "legal_name", "currency"],
    properties: {
      user_id: { type: "integer" },
      email: stringSchema,
      legal_name: stringSchema,
      currency: stringSchema,
    },
    additionalProperties: false,
  },
  /**
   * The whole of what a person has to share to be paid: an identifier Wise
   * already knows them by. No account number, anywhere, ever.
   */
  WiseDestinationEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["configured", "destination"],
        properties: {
          configured: { type: "boolean" },
          destination: nullable({
            type: "object",
            required: ["id", "kind", "linked_at", "linked_by_user_id", "verified_at"],
            properties: {
              id: { type: "integer" },
              // No identifier. A contact id and a recipient id are both opaque,
              // and neither tells a person anything they could check.
              kind: { type: "string", enum: ["account", "contact"] },
              linked_at: stringSchema,
              linked_by_user_id: { type: "integer" },
              verified_at: nullable(stringSchema),
            },
            additionalProperties: false,
          }),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WiseProposal: {
    type: "object",
    required: ["user_id", "name", "payroll_email", "matches"],
    properties: {
      user_id: { type: "integer" },
      name: stringSchema,
      // Shown so whoever confirms can see what the guess was made on. A
      // proposal nobody can check is just a silent join with extra steps.
      payroll_email: nullable(stringSchema),
      matches: { type: "array", items: reference("WiseRecipient") },
    },
    additionalProperties: false,
  },
  WiseProposalListEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: { type: "array", items: reference("WiseProposal") } },
    additionalProperties: false,
  },
  WiseContactInput: {
    type: "object",
    required: ["user_id", "identifier", "currency"],
    properties: {
      user_id: { type: "integer" },
      identifier: stringSchema,
      currency: stringSchema,
    },
    additionalProperties: false,
  },
  WiseContactEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["user_id", "contact"],
        properties: {
          user_id: { type: "integer" },
          contact: {
            type: "object",
            required: ["id", "name"],
            properties: { id: stringSchema, name: nullable(stringSchema) },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WiseLinkInput: {
    type: "object",
    required: ["user_id", "recipient_id"],
    properties: {
      user_id: { type: "integer" },
      recipient_id: stringSchema,
    },
    additionalProperties: false,
  },
  WiseLinkEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["user_id", "recipient"],
        properties: {
          user_id: { type: "integer" },
          recipient: reference("WiseRecipient"),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  QuickBooksConnectionEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: nullable(reference("QuickBooksConnection")) },
    additionalProperties: false,
  },
  QuickBooksSettingsInput: {
    type: "object",
    required: ["allow_online_payment"],
    properties: { allow_online_payment: { type: "boolean" } },
    additionalProperties: false,
  },
  InvoiceQuickBooksEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["connected", "invoice", "payments", "last_outcome"],
        properties: {
          connected: booleanSchema,
          invoice: nullable({
            type: "object",
            required: ["quickbooks_id", "mirrored_at"],
            properties: { quickbooks_id: stringSchema, mirrored_at: timestampSchema },
            additionalProperties: false,
          }),
          payments: {
            type: "array",
            items: {
              type: "object",
              required: ["payment_id", "quickbooks_id", "mirrored_at"],
              properties: {
                payment_id: integerSchema,
                quickbooks_id: stringSchema,
                mirrored_at: timestampSchema,
              },
              additionalProperties: false,
            },
          },
          // The most recent mirror attempt, from the outbox or from Sync,
          // whichever way it went. `reason` is present for refused and failed.
          last_outcome: nullable({
            type: "object",
            required: ["kind", "reason", "at"],
            properties: {
              kind: {
                type: "string",
                enum: ["created", "updated", "adopted", "linked", "refused", "failed"],
              },
              reason: nullable(stringSchema),
              at: timestampSchema,
            },
            additionalProperties: false,
          }),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  SenderEvidenceRefreshInput: {
    type: "object",
    required: ["expected_evidence_version"],
    properties: {
      expected_evidence_version: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  EmailTestSendInput: {
    type: "object",
    required: ["template_kind", "template_version", "variables", "confirmed"],
    properties: {
      template_kind: {
        type: "string",
        enum: ["invoice", "reminder", "thank_you"],
      },
      template_version: { type: "integer", minimum: 1 },
      variables: {
        type: "object",
        maxProperties: 32,
        propertyNames: { pattern: "^[a-z][a-z0-9_]{0,63}$" },
        additionalProperties: { type: "string", minLength: 1, maxLength: 2000 },
      },
      confirmed: { const: true },
    },
    additionalProperties: false,
  },
  EmailTestSend: {
    type: "object",
    required: [
      "status",
      "delivery_id",
      "sender_identity_id",
      "template_kind",
      "template_version",
      "recipient_email",
    ],
    properties: {
      status: { const: "queued" },
      delivery_id: integerSchema,
      sender_identity_id: integerSchema,
      template_kind: {
        type: "string",
        enum: ["invoice", "reminder", "thank_you"],
      },
      template_version: { type: "integer", minimum: 1 },
      recipient_email: { type: "string", format: "email" },
    },
    additionalProperties: false,
  },
  EmailTestSendEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("EmailTestSend") },
    additionalProperties: false,
  },
  OutboxAggregate: {
    type: "object",
    required: ["type", "id", "sequence"],
    properties: {
      type: stringSchema,
      id: integerSchema,
      sequence: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  ActivityLogActor: {
    type: "object",
    description:
      "Who caused the event. type and id are what the event recorded; name is resolved when the log is read, so it is the person's current name. name is null for a system actor and for an id that no user or contact carries any more.",
    required: ["type", "id", "name"],
    properties: {
      type: { type: "string", enum: ["user", "contact", "system"] },
      id: nullable(integerSchema),
      name: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  ActivityLog: {
    type: "object",
    required: [
      "event_id",
      "event_type",
      "aggregate",
      "actor",
      "payload",
      "occurred_at",
      "available_at",
      "recorded_at",
    ],
    properties: {
      event_id: stringSchema,
      event_type: stringSchema,
      aggregate: reference("OutboxAggregate"),
      actor: nullable(reference("ActivityLogActor")),
      payload: { type: "object", additionalProperties: true },
      occurred_at: timestampSchema,
      available_at: timestampSchema,
      recorded_at: timestampSchema,
    },
    additionalProperties: false,
  },
  ActivityLogPage: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("ActivityLog") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  OutboxDelivery: {
    type: "object",
    required: [
      "subscriber_id",
      "event_id",
      "event_type",
      "aggregate",
      "status",
      "attempt_count",
      "next_attempt_at",
      "last_error_code",
      "delivered_at",
      "failed_at",
      "occurred_at",
      "created_at",
      "updated_at",
    ],
    properties: {
      subscriber_id: stringSchema,
      event_id: stringSchema,
      event_type: stringSchema,
      aggregate: reference("OutboxAggregate"),
      status: {
        type: "string",
        enum: ["pending", "processing", "delivered", "failed"],
      },
      attempt_count: { type: "integer", minimum: 0 },
      next_attempt_at: nullable(timestampSchema),
      last_error_code: nullable({
        type: "string",
        enum: ["subscriber_timeout", "subscriber_rejected"],
      }),
      delivered_at: nullable(timestampSchema),
      failed_at: nullable(timestampSchema),
      occurred_at: timestampSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  OutboxDeliveryPage: countedPage("OutboxDelivery"),
  OutboxDeliveryEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: reference("OutboxDelivery"),
      links: reference("Links"),
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
  CountedPageMetadata: {
    type: "object",
    required: ["per_page", "next_cursor", "total"],
    properties: {
      per_page: { type: "integer", minimum: 1, maximum: 200 },
      next_cursor: nullable(stringSchema),
      total: { type: "integer", minimum: 0 },
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
  TokenAuthentication: {
    type: "object",
    required: ["kind", "token_id", "scopes"],
    properties: {
      kind: { const: "token" },
      token_id: integerSchema,
      scopes: { type: "array", items: { type: "string", enum: apiScopes } },
    },
    additionalProperties: false,
  },
  SessionAuthentication: {
    type: "object",
    required: ["kind"],
    properties: { kind: { const: "session" } },
    additionalProperties: false,
  },
  Whoami: {
    type: "object",
    required: ["user_id", "profile", "manager_grants", "authentication"],
    properties: {
      user_id: integerSchema,
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
      manager_grants: { type: "array", items: stringSchema },
      authentication: {
        oneOf: [
          reference("TokenAuthentication"),
          reference("SessionAuthentication"),
        ],
      },
    },
    additionalProperties: false,
  },
  WhoamiEnvelope: envelope("Whoami"),
  GeneralResource: {
    type: "object",
    description: "Commercial fields are omitted without finance/admin authority or an explicit billable_rates_manager grant. The same authority is required to set them; resource read/write scopes still apply.",
    "x-commercial-fields": Object.fromEntries(Object.entries(commercialTermFields).map(([kind, fields]) => [kind, fields.map((field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))])),
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
    description: "Commercial fields listed on GeneralResource require the same commercial authority for create and update, in addition to resource write scope.",
    minProperties: 1,
    additionalProperties: true,
  },
  GeneralResourceEnvelope: envelope("GeneralResource"),
  GeneralResourcePage: page("GeneralResource"),
  ExpenseCategory: {
    type: "object",
    required: [
      "id",
      "name",
      "unit_name",
      "unit_price_cents",
      "is_active",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      name: stringSchema,
      unit_name: nullable(stringSchema),
      unit_price_cents: nullable({
        type: "integer",
        minimum: 0,
        maximum: 9_000_000_000_000,
      }),
      is_active: booleanSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  ExpenseCategoryInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: stringSchema,
      unit_name: nullable(stringSchema),
      unit_price_cents: nullable({
        type: "integer",
        minimum: 0,
        maximum: 9_000_000_000_000,
      }),
      is_active: booleanSchema,
    },
    additionalProperties: false,
  },
  ExpenseCategoryPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      name: stringSchema,
      unit_name: nullable(stringSchema),
      unit_price_cents: nullable({
        type: "integer",
        minimum: 0,
        maximum: 9_000_000_000_000,
      }),
      is_active: booleanSchema,
    },
    additionalProperties: false,
  },
  ExpenseCategoryEnvelope: envelope("ExpenseCategory"),
  ExpenseCategoryPage: page("ExpenseCategory"),
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
    required: ["expected_version", "amount_cents"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      amount_cents: { type: "integer", minimum: 0 },
      start_date: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  UserRateEnvelope: envelope("UserRate"),
  UserRatePage: page("UserRate"),
  TeamStatus: {
    type: "object",
    required: ["enabled"],
    properties: { enabled: booleanSchema },
    additionalProperties: false,
  },
  TeamStatusEnvelope: envelope("TeamStatus"),
  TeamNamedRelation: {
    type: "object",
    required: ["id", "name"],
    properties: { id: integerSchema, name: stringSchema },
    additionalProperties: false,
  },
  TeamPersonSummary: {
    type: "object",
    required: [
      "id", "first_name", "last_name", "email", "avatar_url", "profile",
      "is_owner", "is_contractor", "is_active", "weekly_capacity",
      "total_seconds", "billable_seconds", "nonbillable_seconds",
      "utilization_ppm", "running",
    ],
    properties: {
      id: integerSchema,
      first_name: stringSchema,
      last_name: stringSchema,
      email: nullable(stringSchema),
      avatar_url: nullable(stringSchema),
      profile: {
        type: "string",
        enum: ["member", "project_manager", "people_admin", "accounting", "executive_manager", "administrator"],
      },
      is_owner: booleanSchema,
      is_contractor: booleanSchema,
      is_active: booleanSchema,
      weekly_capacity: { type: "integer", minimum: 0 },
      total_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      nonbillable_seconds: signedIntegerSchema,
      utilization_ppm: nullable({ type: "integer", minimum: 0 }),
      running: booleanSchema,
    },
    additionalProperties: false,
  },
  TeamPersonSummaryPage: page("TeamPersonSummary"),
  TeamProjectAssignment: {
    type: "object",
    required: [
      "id", "project_id", "project_name", "project_code", "client_id", "client_name",
      "is_active", "is_project_manager", "use_default_rates", "budget_seconds", "updated_at",
    ],
    properties: {
      id: integerSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      project_code: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      is_active: booleanSchema,
      is_project_manager: booleanSchema,
      use_default_rates: booleanSchema,
      hourly_rate_cents: nullable({ type: "integer", minimum: 0 }),
      budget_seconds: nullable({ type: "integer", minimum: 0 }),
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TeamNotificationChannels: {
    type: "object",
    required: ["email", "desktop", "slack"],
    properties: { email: booleanSchema, desktop: booleanSchema, slack: booleanSchema },
    additionalProperties: false,
  },
  TeamInactiveNotificationChannels: {
    type: "object",
    required: ["email", "desktop", "slack"],
    properties: {
      email: { type: "boolean", enum: [false] },
      desktop: { type: "boolean", enum: [false] },
      slack: { type: "boolean", enum: [false] },
    },
    additionalProperties: false,
  },
  TeamNotificationPreference: {
    type: "object",
    required: [
      "delivery_active",
      "daily_reminder_enabled", "reminder_time", "reminder_days", "channels",
      "include_in_team_reminders", "weekly_digest", "notify_project_deleted", "updated_at",
    ],
    properties: {
      delivery_active: { type: "boolean", enum: [false] },
      daily_reminder_enabled: booleanSchema,
      reminder_time: nullable({ type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
      reminder_days: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
      },
      channels: reference("TeamNotificationChannels"),
      include_in_team_reminders: booleanSchema,
      weekly_digest: booleanSchema,
      notify_project_deleted: booleanSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TeamPerson: {
    type: "object",
    required: [
      "id", "first_name", "last_name", "email", "telephone", "employee_id", "timezone",
      "is_contractor", "is_active", "has_access_to_all_future_projects", "weekly_capacity",
      "profile", "is_owner", "avatar_url", "version", "created_at", "updated_at",
      "roles", "departments", "project_assignments", "notifications",
    ],
    properties: {
      id: integerSchema,
      first_name: stringSchema,
      last_name: stringSchema,
      email: nullable(stringSchema),
      telephone: nullable(stringSchema),
      employee_id: nullable(stringSchema),
      timezone: stringSchema,
      is_contractor: booleanSchema,
      is_active: booleanSchema,
      has_access_to_all_future_projects: booleanSchema,
      weekly_capacity: { type: "integer", minimum: 0 },
      profile: {
        type: "string",
        enum: ["member", "project_manager", "people_admin", "accounting", "executive_manager", "administrator"],
      },
      is_owner: booleanSchema,
      avatar_url: nullable(stringSchema),
      version: { type: "integer", minimum: 0 },
      created_at: timestampSchema,
      updated_at: timestampSchema,
      roles: { type: "array", items: reference("TeamNamedRelation") },
      departments: { type: "array", items: reference("TeamNamedRelation") },
      project_assignments: { type: "array", items: reference("TeamProjectAssignment") },
      billable_rates: { type: "array", items: reference("UserRate") },
      cost_rates: { type: "array", items: reference("UserRate") },
      notifications: reference("TeamNotificationPreference"),
    },
    additionalProperties: false,
  },
  TeamPersonEnvelope: envelope("TeamPerson"),
  TeamCatalogProject: {
    type: "object",
    required: ["id", "name", "code", "client_id", "client_name", "is_active"],
    properties: {
      id: integerSchema,
      name: stringSchema,
      code: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      is_active: booleanSchema,
    },
    additionalProperties: false,
  },
  TeamCatalog: {
    type: "object",
    required: ["roles", "departments", "projects"],
    properties: {
      roles: { type: "array", items: reference("TeamNamedRelation") },
      departments: { type: "array", items: reference("TeamNamedRelation") },
      projects: { type: "array", items: reference("TeamCatalogProject") },
    },
    additionalProperties: false,
  },
  TeamCatalogEnvelope: envelope("TeamCatalog"),
  TeamPersonPatch: {
    type: "object",
    required: ["expected_version"],
    minProperties: 2,
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      first_name: { type: "string", minLength: 1 },
      last_name: { type: "string", minLength: 1 },
      telephone: nullable(stringSchema),
      employee_id: nullable(stringSchema),
      timezone: { type: "string", minLength: 1 },
      is_contractor: booleanSchema,
      is_active: booleanSchema,
      has_access_to_all_future_projects: booleanSchema,
      weekly_capacity: { type: "integer", minimum: 0 },
      profile: {
        type: "string",
        enum: ["member", "project_manager", "people_admin", "accounting", "executive_manager", "administrator"],
      },
      role_ids: { type: "array", uniqueItems: true, items: integerSchema },
      department_ids: { type: "array", uniqueItems: true, items: integerSchema },
    },
    additionalProperties: false,
  },
  TeamAssignmentInput: {
    type: "object",
    required: ["project_id", "is_project_manager"],
    properties: { project_id: integerSchema, is_project_manager: booleanSchema },
    additionalProperties: false,
  },
  TeamAssignmentReplaceInput: {
    type: "object",
    required: ["expected_version", "assignments"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      assignments: { type: "array", uniqueItems: true, items: reference("TeamAssignmentInput") },
    },
    additionalProperties: false,
  },
  TeamNotificationInput: {
    type: "object",
    required: [
      "expected_version", "daily_reminder_enabled", "reminder_time", "reminder_days",
      "channels", "include_in_team_reminders", "weekly_digest", "notify_project_deleted",
    ],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      daily_reminder_enabled: { type: "boolean", enum: [false] },
      reminder_time: nullable({ type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
      reminder_days: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
      },
      channels: reference("TeamInactiveNotificationChannels"),
      include_in_team_reminders: { type: "boolean", enum: [false] },
      weekly_digest: { type: "boolean", enum: [false] },
      notify_project_deleted: { type: "boolean", enum: [false] },
    },
    additionalProperties: false,
  },
  TeamRateInput: {
    type: "object",
    required: ["expected_version", "kind", "amount_cents", "start_date"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      kind: { type: "string", enum: ["billable", "cost"] },
      amount_cents: { type: "integer", minimum: 0 },
      start_date: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  /**
   * Taking back a rate nobody meant to add (#727).
   *
   * No amount and no date: the rate being removed is named by the path, and a
   * body that restated it would be a second place for the two to disagree.
   * `kind` says which table, and is checked against what the acting profile may
   * set, so somebody who may not set a cost rate may not unset one either.
   */
  TeamRateRemovalInput: {
    type: "object",
    required: ["expected_version", "kind"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      kind: { type: "string", enum: ["billable", "cost"] },
    },
    additionalProperties: false,
  },
  CostRateBackfillInput: {
    type: "object",
    required: ["from", "to", "cost_rate_cents", "reason"],
    properties: {
      // Both ends are required: "all of history" is something somebody chooses.
      from: dateSchema,
      to: dateSchema,
      // The effective rate for the whole range. Nothing in the data can say what
      // a person cost in a past year, so it is supplied, never inferred.
      cost_rate_cents: { type: "integer", minimum: 0 },
      reason: { type: "string", minLength: 1, maxLength: 500 },
      // Also restamp entries carrying a different cost rate. Absent leaves them.
      replace_captured: booleanSchema,
      // Absent rehearses. A run writes nothing unless it says so.
      apply: booleanSchema,
    },
    additionalProperties: false,
  },
  CostRateBackfillPeriod: {
    type: "object",
    required: ["month", "entry_count", "seconds", "cost_cents"],
    properties: {
      month: stringSchema,
      entry_count: { type: "integer", minimum: 0 },
      seconds: signedIntegerSchema,
      cost_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  CostRateBackfill: {
    type: "object",
    required: [
      "run_id",
      "applied",
      "user_id",
      "from",
      "to",
      "cost_rate_cents",
      "entry_count",
      "seconds",
      "cost_cents",
      "periods",
      "captured_entry_count",
      "running_entry_count",
    ],
    properties: {
      run_id: stringSchema,
      applied: booleanSchema,
      user_id: integerSchema,
      from: dateSchema,
      to: dateSchema,
      cost_rate_cents: { type: "integer", minimum: 0 },
      // What the run stamps, or in a rehearsal would stamp.
      entry_count: { type: "integer", minimum: 0 },
      seconds: signedIntegerSchema,
      cost_cents: signedIntegerSchema,
      periods: { type: "array", items: reference("CostRateBackfillPeriod") },
      // In range but left alone: already priced, or the timer is still running.
      captured_entry_count: { type: "integer", minimum: 0 },
      running_entry_count: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  CostRateBackfillEnvelope: envelope("CostRateBackfill"),
  TeamCommandReceipt: {
    type: "object",
    required: ["target_user_id", "version", "resource_id", "occurred_at"],
    properties: {
      target_user_id: integerSchema,
      version: { type: "integer", minimum: 0 },
      resource_id: nullable(integerSchema),
      occurred_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TeamCommandReceiptEnvelope: envelope("TeamCommandReceipt"),
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
      "is_locked",
      "minimum_note_length",
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
      // Signed: an imported Harvest correction entry offsets an earlier one
      // (#279). The write schemas below stay non-negative — see TimeEntryInput.
      seconds: signedIntegerSchema,
      seconds_without_timer: signedIntegerSchema,
      rounded_seconds: signedIntegerSchema,
      is_running: booleanSchema,
      timer_started_at: nullable(timestampSchema),
      started_time: nullable({
        type: "string",
        pattern: "^[0-2][0-9]:[0-5][0-9]$",
      }),
      ended_time: nullable({
        type: "string",
        pattern: "^[0-2][0-9]:[0-5][0-9]$",
      }),
      notes: nullable(stringSchema),
      billable: booleanSchema,
      budgeted: booleanSchema,
      approval_status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      source_approval_status: nullable({
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      }),
      invoice_id: { ...nullable(integerSchema), description: "Omitted without invoices:read authority (profile and token)." },
      is_billed: { ...booleanSchema, description: "Omitted without invoices:read authority (profile and token)." },
      is_locked: booleanSchema,
      locked_reason_code: nullable(stringSchema),
      locked_reason: nullable(stringSchema),
      external_ref: nullable({ type: "object", additionalProperties: true }),
      calendar_event_ref: nullable({
        type: "object",
        additionalProperties: true,
      }),
      minimum_note_length: { type: "integer", minimum: 0, maximum: 10000 },
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
      user_id: {
        ...integerSchema,
        description:
          "Whose entry. Defaults to the acting user. Only an administrator may name somebody else, and only for stopped time: a timer is started by the person it tracks.",
      },
      project_id: integerSchema,
      task_id: integerSchema,
      spent_date: dateSchema,
      // Non-negative on the way in. A correction entry exists because Harvest
      // will not let a locked timesheet be edited; here the entry that was
      // wrong is the thing to edit, so there is nothing for a typed negative
      // to offset.
      seconds: {
        type: "integer",
        minimum: 0,
        description: "A duration entry's length. Not accepted with started_time or ended_time.",
      },
      started_time: {
        type: "string",
        description:
          "Canonical 24-hour HH:MM. With ended_time, a stopped start/end entry in either organization mode.",
      },
      ended_time: {
        type: "string",
        description: "Canonical 24-hour HH:MM. Requires started_time and spent_date.",
      },
      notes: nullable(stringSchema),
      budgeted: booleanSchema,
      external_ref: nullable({ type: "object", additionalProperties: true }),
      calendar_event_ref: nullable({
        type: "object",
        additionalProperties: true,
      }),
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
      calendar_event_ref: nullable({
        type: "object",
        additionalProperties: true,
      }),
    },
    additionalProperties: false,
  },
  TimeEntryEnvelope: envelope("TimeEntry"),
  TimeEntryPage: page("TimeEntry"),
  TimeEntrySettings: {
    type: "object",
    required: ["time_entry_mode", "time_format", "clock", "week_start_day", "time_rounding"],
    properties: {
      time_rounding: reference("TimeRounding"),
      time_entry_mode: { type: "string", enum: ["duration", "start_end"] },
      time_format: { type: "string", enum: ["decimal", "hours_minutes"] },
      clock: { type: "string", enum: ["12h", "24h"] },
      week_start_day: {
        type: "string",
        enum: ["saturday", "sunday", "monday"],
      },
    },
    additionalProperties: false,
  },
  TimeEntrySettingsEnvelope: envelope("TimeEntrySettings"),
  TimeRounding: {
    type: "object",
    required: ["mode", "minutes"],
    properties: {
      mode: { type: "string", enum: [...timeRoundingModes] },
      minutes: { type: "integer", enum: [...timeRoundingIncrements] },
    },
    additionalProperties: false,
  },
  TimeRoundingPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      mode: { type: "string", enum: [...timeRoundingModes] },
      minutes: { type: "integer", enum: [...timeRoundingIncrements] },
    },
    additionalProperties: false,
  },
  TimeRoundingEnvelope: envelope("TimeRounding"),
  EffectiveTimeRounding: {
    type: "object",
    required: ["mode", "minutes", "source"],
    description: "The rule an entry on a project is saved under, and whose it is.",
    properties: {
      mode: { type: "string", enum: [...timeRoundingModes] },
      minutes: { type: "integer", enum: [...timeRoundingIncrements] },
      source: { type: "string", enum: ["organization", "project"] },
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationScope: {
    type: "object",
    required: ["project_id", "from", "to"],
    properties: {
      project_id: nullable(integerSchema),
      from: nullable(dateSchema),
      to: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationProject: {
    type: "object",
    required: [
      "project_id",
      "project_name",
      "time_rounding",
      "changed_entries",
      "rounded_seconds_before",
      "rounded_seconds_after",
    ],
    properties: {
      project_id: integerSchema,
      project_name: stringSchema,
      time_rounding: reference("EffectiveTimeRounding"),
      changed_entries: { type: "integer", minimum: 0 },
      rounded_seconds_before: { type: "integer", minimum: 0 },
      rounded_seconds_after: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationPreview: {
    type: "object",
    required: [
      "scope",
      "open_entries",
      "changed_entries",
      "rounded_seconds_before",
      "rounded_seconds_after",
      "earliest_spent_date",
      "latest_spent_date",
      "projects",
      "kept",
      "fingerprint",
    ],
    properties: {
      scope: reference("TimeRoundingRecalculationScope"),
      open_entries: { type: "integer", minimum: 0 },
      changed_entries: { type: "integer", minimum: 0 },
      rounded_seconds_before: { type: "integer", minimum: 0 },
      rounded_seconds_after: { type: "integer", minimum: 0 },
      earliest_spent_date: nullable(dateSchema),
      latest_spent_date: nullable(dateSchema),
      projects: { type: "array", items: reference("TimeRoundingRecalculationProject") },
      kept: {
        type: "object",
        required: ["invoiced", "approved", "locked", "other"],
        properties: {
          invoiced: { type: "integer", minimum: 0 },
          approved: { type: "integer", minimum: 0 },
          locked: { type: "integer", minimum: 0 },
          other: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationPreviewEnvelope: envelope("TimeRoundingRecalculationPreview"),
  TimeRoundingRecalculationRequest: {
    type: "object",
    required: ["fingerprint"],
    properties: {
      project_id: integerSchema,
      from: dateSchema,
      to: dateSchema,
      fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationApplied: {
    type: "object",
    required: ["recalculated_entries", "preview"],
    properties: {
      recalculated_entries: { type: "integer", minimum: 0 },
      preview: reference("TimeRoundingRecalculationPreview"),
    },
    additionalProperties: false,
  },
  TimeRoundingRecalculationAppliedEnvelope: envelope("TimeRoundingRecalculationApplied"),
  TimeEntryNoteSettings: {
    type: "object",
    required: ["required", "minimum_length"],
    properties: {
      required: booleanSchema,
      minimum_length: { type: "integer", minimum: 1, maximum: 10000 },
    },
    additionalProperties: false,
  },
  TimeEntryNoteSettingsPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      required: booleanSchema,
      minimum_length: { type: "integer", minimum: 1, maximum: 10000 },
    },
    additionalProperties: false,
  },
  TimeEntryNoteSettingsEnvelope: envelope("TimeEntryNoteSettings"),
  Profile: {
    type: "object",
    required: ["user_id", "timezone"],
    properties: {
      user_id: integerSchema,
      // The person's own name and primary address, for the identity card.
      // Absent where the deployment does not compose the reader.
      first_name: stringSchema,
      last_name: stringSchema,
      email: nullable(stringSchema),
      timezone: { type: "string", minLength: 1 },
      // Whether this person is copied on the invoice emails they send. Absent
      // where the deployment sends no invoice email.
      invoice_copy_to_self: booleanSchema,
    },
    additionalProperties: false,
  },
  ProfilePatch: {
    type: "object",
    minProperties: 1,
    properties: {
      timezone: { type: "string", minLength: 1 },
      invoice_copy_to_self: booleanSchema,
    },
    additionalProperties: false,
  },
  ProfileEnvelope: envelope("Profile"),
  NativeAppleCapabilities: {type:"object",additionalProperties:false,required:["available","lifecycle_version"],properties:{available:booleanSchema,lifecycle_version:{type:"integer",const:1}}},
  NativeAppleSignInInput: {type:"object",additionalProperties:false,required:["identityToken","bindingReceipt"],properties:{identityToken:{type:"string",maxLength:16384},bindingReceipt:{type:"string",maxLength:16384},fullName:{type:"object",properties:{givenName:stringSchema,familyName:stringSchema}}}},
  NativeAppleSignInEnvelope: {type:"object",additionalProperties:false,required:["data"],properties:{data:{type:"object",required:["ok"],additionalProperties:false,properties:{ok:{type:"boolean",const:true}}}}},
  AppleLifecycleProofInput: {type:"object",additionalProperties:false,required:["receipt"],properties:{receipt:{type:"string",maxLength:16384}}},
  AppleCleanupStatus: {type:"string",enum:["not_linked","pending","revoked","manual_required"]},
  AccountClosureInventoryItem: { type: "object", additionalProperties: false, required: ["location", "count", "category"], properties: { location: stringSchema, count: integerSchema, category: { type: "string", enum: ["time_and_worker_attribution", "billing_and_payments", "audit_and_security", "legal_hold"] } } },
  AccountClosureRecord: { type: "object", additionalProperties: false, required: ["request_id", "user_id", "actor_user_id", "closed_at", "policy_version", "policy_snapshot", "inventory", "retained_identity", "apple_cleanup"], properties: { request_id: stringSchema, user_id: integerSchema, actor_user_id: integerSchema, closed_at: timestampSchema, policy_version: integerSchema, policy_snapshot: reference("AccountRetentionPolicy"), inventory: { type: "array", items: reference("AccountClosureInventoryItem") }, retained_identity: booleanSchema, apple_cleanup: reference("AppleCleanupStatus") } },
  AccountClosurePreview: { type: "object", additionalProperties: false, required: ["request_id", "user_id", "request_version", "review_token", "policy_version", "policy_snapshot", "inventory", "uncovered_categories", "owner_transfer_required", "running_timer", "closure"], properties: { apple_cleanup_retry_available:booleanSchema, request_id: stringSchema, user_id: integerSchema, request_version: integerSchema, review_token: { type: "string", pattern: "^[0-9a-f]{64}$" }, policy_version: nullable(integerSchema), policy_snapshot: nullable(reference("AccountRetentionPolicy")), inventory: { type: "array", items: reference("AccountClosureInventoryItem") }, uncovered_categories: { type: "array", items: { type: "string", enum: ["time_and_worker_attribution", "billing_and_payments", "audit_and_security", "legal_hold"] } }, owner_transfer_required: booleanSchema, running_timer: booleanSchema, closure: nullable(reference("AccountClosureRecord")) } },
  EmptyObject: {type:"object",additionalProperties:false,properties:{}},
  AppleCleanupStatusEnvelope: {type:"object",additionalProperties:false,required:["data"],properties:{data:{type:"object",additionalProperties:false,required:["apple_cleanup"],properties:{apple_cleanup:reference("AppleCleanupStatus")}}}},
  RetentionReview: {type:"object",additionalProperties:false,required:["request_id","area","kind","original_reason","original_period","decision","basis","release_condition","evidence","next_review_at","hold_active","version","reviewed_at","actor_user_id"],properties:{request_id:stringSchema,area:stringSchema,kind:{type:"string",enum:["retained_category","downstream"]},original_reason:stringSchema,original_period:stringSchema,decision:{type:"string",enum:["pending","retain","removed","not_applicable","failed","release_hold"]},basis:stringSchema,release_condition:stringSchema,evidence:stringSchema,next_review_at:nullable(timestampSchema),hold_active:booleanSchema,version:integerSchema,reviewed_at:nullable(timestampSchema),actor_user_id:nullable(integerSchema)}},
  RetentionReviewListEnvelope:{type:"object",required:["data"],additionalProperties:false,properties:{data:{type:"array",items:reference("RetentionReview")}}},
  RetentionReviewEnvelope:{type:"object",required:["data"],additionalProperties:false,properties:{data:reference("RetentionReview")}},
  RetentionReviewInput:{type:"object",additionalProperties:false,required:["expected_version","decision","basis","release_condition","evidence","next_review_at","acknowledged"],properties:{expected_version:{type:"integer",minimum:1},decision:{type:"string",enum:["retain","removed","not_applicable","failed","release_hold"]},basis:{type:"string",maxLength:2000},release_condition:{type:"string",maxLength:2000},evidence:{type:"string",maxLength:2000},next_review_at:nullable(timestampSchema),acknowledged:{type:"boolean",const:true}}},
  DeletionCompletionInput:{type:"object",additionalProperties:false,required:["expected_request_version","expected_reviews","acknowledged"],properties:{apple_historical_manual_verified:{type:"boolean"},expected_request_version:{type:"integer",minimum:1},expected_reviews:{type:"object",additionalProperties:{type:"integer",minimum:1}},acknowledged:{type:"boolean",const:true}}},
  DeletionCompletionEnvelope:{type:"object",additionalProperties:false,required:["data"],properties:{data:{type:"object",additionalProperties:false,required:["completed_at","confirmation"],properties:{completed_at:timestampSchema,confirmation:stringSchema}}}},
  AccountClosureInput: { type: "object", additionalProperties: false, required: ["expected_version", "expected_policy_version", "review_token", "acknowledged"], properties: { expected_version: { type: "integer", minimum: 1 }, expected_policy_version: { type: "integer", minimum: 1 }, review_token: { type: "string", pattern: "^[0-9a-f]{64}$" }, acknowledged: { type: "boolean", const: true } } },
  AccountClosurePreviewEnvelope: { type: "object", additionalProperties: false, required: ["data"], properties: { data: reference("AccountClosurePreview") } },
  AccountClosureRecordEnvelope: { type: "object", additionalProperties: false, required: ["data"], properties: { data: reference("AccountClosureRecord") } },
  AccountDeletionStatusAccess: { type: "object", required: ["token", "expires_at", "url"], additionalProperties: false, properties: { token: stringSchema, expires_at: timestampSchema, url: stringSchema } },
  AccountDeletionTrackingInput: { type: "object", required: ["token"], additionalProperties: false, properties: { token: { type: "string", maxLength: 100 } } },
  AccountDeletionRetainedDisclosure: { type: "object", additionalProperties: false, required: ["category", "reason", "period", "review_after_days", "review_due"], properties: { category: stringSchema, reason: stringSchema, period: stringSchema, review_after_days: integerSchema, review_due: timestampSchema } },
  AccountDeletionClosureDisclosure: { type: "object", additionalProperties: false, required: ["retained_records", "backup_handling", "user_notice", "operator_contact"], properties: { retained_records: { type: "array", items: reference("AccountDeletionRetainedDisclosure") }, backup_handling: stringSchema, user_notice: stringSchema, operator_contact: stringSchema } },
  AccountDeletionTrackingStatus: { type: "object", additionalProperties: false, required: ["request_id", "status", "requested_at", "expected_completion_at", "closed_at", "completed_at", "message", "completion_confirmation", "policy_version", "policy_snapshot", "policy_reviewed", "closure_disclosure", "operator_contact", "expires_at"], properties: { apple_cleanup: reference("AppleCleanupStatus"), request_id: stringSchema, status: { type: "string", enum: ["pending", "in_progress", "action_required", "completed"] }, requested_at: timestampSchema, expected_completion_at: nullable(timestampSchema), closed_at: nullable(timestampSchema), completed_at: nullable(timestampSchema), message: stringSchema, completion_confirmation: nullable(stringSchema), policy_version: nullable(integerSchema), policy_snapshot: nullable(reference("AccountRetentionPolicy")), policy_reviewed: booleanSchema, closure_disclosure: nullable(reference("AccountDeletionClosureDisclosure")), operator_contact: nullable(stringSchema), expires_at: timestampSchema } },
  AccountDeletionTrackingEnvelope: { type: "object", additionalProperties: false, required: ["data"], properties: { data: reference("AccountDeletionTrackingStatus") } },
  AccountDeletionSubmission: {
    type: "object", additionalProperties: false,
    properties: { expected_policy_version: nullable({ type: "integer", minimum: 1 }) },
  },
  AccountDeletionUpdate: {
    type: "object", additionalProperties: false, required: ["expected_version", "status", "message", "expected_completion_at"],
    properties: {
      expected_version: { type: "integer", minimum: 1, maximum: 9007199254740990 },
      status: { type: "string", enum: ["pending", "in_progress", "action_required"] },
      message: { type: "string", maxLength: 5000 },
      expected_completion_at: nullable(timestampSchema),
    },
  },
  AccountDeletionRecord: {
    type: "object", additionalProperties: false,
    required: ["id", "user_id", "requested_at", "policy_version", "policy_snapshot", "policy_reviewed", "status", "version", "message", "response_target_at", "expected_completion_at", "completed_at", "completion_confirmation", "notification", "notification_updated_at", "notification_delivery_id", "updated_at"],
    properties: {
      apple_cleanup: reference("AppleCleanupStatus"),
      id: stringSchema, user_id: integerSchema, requested_at: timestampSchema,
      policy_version: nullable(integerSchema), policy_snapshot: nullable(reference("AccountRetentionPolicy")), policy_reviewed: booleanSchema,
      status: { type: "string", enum: ["pending", "in_progress", "action_required", "completed"] },
      version: integerSchema, message: stringSchema, response_target_at: nullable(timestampSchema),
      expected_completion_at: nullable(timestampSchema), completed_at: nullable(timestampSchema), completion_confirmation: nullable(stringSchema),
      notification: { type: "string", enum: ["pending", "sending", "queued", "failed", "unavailable"] },
      notification_updated_at: timestampSchema, notification_delivery_id: nullable(integerSchema), updated_at: timestampSchema,
    },
  },
  AccountDeletionStatusEnvelope: { type: "object", required: ["data", "links"], additionalProperties: false, properties: { data: nullable(reference("AccountDeletionRecord")), links: reference("Links") } },
  AccountDeletionDetailEnvelope: envelope("AccountDeletionRecord"),
  AccountDeletionListEnvelope: { type: "object", required: ["data", "links"], additionalProperties: false, properties: { data: { type: "array", items: reference("AccountDeletionRecord") }, links: reference("Links") } },
  AccountDeletionRequest: {
    type: "object",
    required: ["user_id", "requested_at"],
    properties: {
      user_id: integerSchema,
      // When the person first asked. A later ask keeps it.
      requested_at: timestampSchema,
    },
    additionalProperties: false,
  },
  AccountDeletionRequestEnvelope: { type: "object", required: ["data", "links"], additionalProperties: false,
    properties: { data: { anyOf: [reference("AccountDeletionRecord"), reference("AccountDeletionRequest")] }, links: reference("Links"), status_access: reference("AccountDeletionStatusAccess") } },
  TimeEntryOption: {
    type: "object",
    required: ["project_id", "task_id", "minimum_note_length", "time_rounding"],
    properties: {
      project_id: integerSchema,
      task_id: integerSchema,
      time_rounding: reference("EffectiveTimeRounding"),
      minimum_note_length: { type: "integer", minimum: 0, maximum: 10000 },
    },
    additionalProperties: false,
  },
  TimeEntryOptionListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("TimeEntryOption") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  TimesheetSubmission: {
    type: "object",
    required: [
      "id",
      "user_id",
      "user_name",
      "period_start",
      "period_end",
      "status",
      "origin",
      "source_status",
      "source_observed_at",
      "submitted_by_user_id",
      "submitted_at",
      "reviewed_by_user_id",
      "reviewed_at",
      "rejection_reason",
      "version",
      "entry_count",
      "expense_count",
      "total_seconds",
      "billable_seconds",
      "nonbillable_seconds",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      user_name: stringSchema,
      period_start: dateSchema,
      period_end: dateSchema,
      status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      origin: {
        type: "string",
        enum: ["native", "harvest_import", "legacy_backfill"],
      },
      source_status: nullable({
        type: "string",
        enum: ["submitted", "approved"],
      }),
      source_observed_at: nullable(timestampSchema),
      submitted_by_user_id: nullable(integerSchema),
      submitted_at: nullable(timestampSchema),
      reviewed_by_user_id: nullable(integerSchema),
      reviewed_at: nullable(timestampSchema),
      rejection_reason: nullable(stringSchema),
      version: { type: "integer", minimum: 0 },
      entry_count: { type: "integer", minimum: 0 },
      expense_count: { type: "integer", minimum: 0 },
      total_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      nonbillable_seconds: signedIntegerSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TimesheetSubmissionInput: {
    type: "object",
    required: ["period_start", "period_end"],
    properties: {
      period_start: dateSchema,
      period_end: dateSchema,
    },
    additionalProperties: false,
  },
  TimesheetSubmissionEntry: {
    type: "object",
    required: [
      "id",
      "spent_date",
      "project_id",
      "project_name",
      "task_id",
      "task_name",
      "seconds",
      "notes",
    ],
    properties: {
      id: integerSchema,
      spent_date: dateSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      task_id: integerSchema,
      task_name: stringSchema,
      seconds: signedIntegerSchema,
      notes: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  TimesheetSubmissionExpense: {
    type: "object",
    required: [
      "id",
      "spent_date",
      "project_id",
      "project_name",
      "expense_category_id",
      "expense_category_name",
      "total_cost_cents",
      "currency",
      "notes",
    ],
    properties: {
      id: integerSchema,
      spent_date: dateSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      expense_category_id: integerSchema,
      expense_category_name: stringSchema,
      total_cost_cents: {
        type: "integer",
        minimum: -9000000000000,
        maximum: 9000000000000,
      },
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      notes: nullable(stringSchema),
    },
    additionalProperties: false,
  },
  TimesheetSubmissionDetail: {
    type: "object",
    required: [
      "id",
      "user_id",
      "user_name",
      "period_start",
      "period_end",
      "status",
      "origin",
      "source_status",
      "source_observed_at",
      "submitted_by_user_id",
      "submitted_at",
      "reviewed_by_user_id",
      "reviewed_at",
      "rejection_reason",
      "version",
      "entry_count",
      "expense_count",
      "total_seconds",
      "billable_seconds",
      "nonbillable_seconds",
      "created_at",
      "updated_at",
      "entries",
      "expenses",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      user_name: stringSchema,
      period_start: dateSchema,
      period_end: dateSchema,
      status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      origin: {
        type: "string",
        enum: ["native", "harvest_import", "legacy_backfill"],
      },
      source_status: nullable({
        type: "string",
        enum: ["submitted", "approved"],
      }),
      source_observed_at: nullable(timestampSchema),
      submitted_by_user_id: nullable(integerSchema),
      submitted_at: nullable(timestampSchema),
      reviewed_by_user_id: nullable(integerSchema),
      reviewed_at: nullable(timestampSchema),
      rejection_reason: nullable(stringSchema),
      version: { type: "integer", minimum: 0 },
      entry_count: { type: "integer", minimum: 0 },
      expense_count: { type: "integer", minimum: 0 },
      total_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      nonbillable_seconds: signedIntegerSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
      entries: {
        type: "array",
        items: reference("TimesheetSubmissionEntry"),
      },
      expenses: {
        type: "array",
        items: reference("TimesheetSubmissionExpense"),
      },
    },
    additionalProperties: false,
  },
  TimesheetRejectionInput: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 10000,
        pattern: "\\S",
      },
    },
    additionalProperties: false,
  },
  TimesheetWithdrawalInput: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 10000,
        pattern: "\\S",
      },
    },
    additionalProperties: false,
  },
  TimesheetBulkApprovalInput: {
    type: "object",
    required: ["submissions"],
    properties: {
      submissions: {
        type: "array",
        minItems: 1,
        maxItems: maximumBulkApprovalSelections,
        items: {
          type: "object",
          required: ["id", "expected_version"],
          properties: {
            id: integerSchema,
            expected_version: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  TimesheetBulkApprovalResult: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("TimesheetSubmission") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  TimesheetSubmissionEnvelope: envelope("TimesheetSubmission"),
  TimesheetSubmissionDetailEnvelope: envelope("TimesheetSubmissionDetail"),
  TimesheetSubmissionPage: page("TimesheetSubmission"),
  TimesheetDeadline: {
    type: "object",
    required: ["day", "time"],
    properties: {
      day: {
        type: "string",
        enum: [
          "sunday",
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
        ],
      },
      time: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
    },
    additionalProperties: false,
  },
  TimesheetLockPolicy: {
    type: "object",
    required: [
      "auto_lock",
      "timesheet_deadline",
      "timezone",
      "week_start_day",
      "updated_at",
    ],
    properties: {
      auto_lock: booleanSchema,
      timesheet_deadline: nullable(reference("TimesheetDeadline")),
      timezone: stringSchema,
      week_start_day: {
        type: "string",
        enum: ["saturday", "sunday", "monday"],
      },
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  TimesheetLockPolicyPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      auto_lock: booleanSchema,
      timesheet_deadline: nullable(reference("TimesheetDeadline")),
      timezone: stringSchema,
    },
    additionalProperties: false,
  },
  TimesheetLockPolicyEnvelope: envelope("TimesheetLockPolicy"),
  TimesheetLockWindow: {
    type: "object",
    required: [
      "id",
      "kind",
      "period_start",
      "period_end",
      "reason",
      "locked_by_user_id",
      "locked_at",
      "unlocked_by_user_id",
      "unlocked_at",
      "unlock_reason",
      "active",
    ],
    properties: {
      id: integerSchema,
      kind: { type: "string", enum: ["manual", "auto"] },
      period_start: nullable(dateSchema),
      period_end: dateSchema,
      reason: stringSchema,
      locked_by_user_id: nullable(integerSchema),
      locked_at: timestampSchema,
      unlocked_by_user_id: nullable(integerSchema),
      unlocked_at: nullable(timestampSchema),
      unlock_reason: nullable(stringSchema),
      active: booleanSchema,
    },
    additionalProperties: false,
  },
  TimesheetManualLockInput: {
    type: "object",
    required: ["locked_through", "reason"],
    properties: {
      locked_through: dateSchema,
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 10000,
        pattern: "\\S",
      },
    },
    additionalProperties: false,
  },
  TimesheetUnlockInput: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 10000,
        pattern: "\\S",
      },
    },
    additionalProperties: false,
  },
  TimesheetLockWindowEnvelope: envelope("TimesheetLockWindow"),
  TimesheetLockWindowPage: page("TimesheetLockWindow"),
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
      total_cost_cents: {
        type: "integer",
        minimum: -9000000000000,
        maximum: 9000000000000,
      },
      billable: booleanSchema,
      approval_status: {
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      },
      source_approval_status: nullable({
        type: "string",
        enum: ["unsubmitted", "submitted", "approved"],
      }),
      invoice_id: { ...nullable(integerSchema), description: "Omitted without invoices:read authority (profile and token)." },
      is_billed: { ...booleanSchema, description: "Omitted without invoices:read authority (profile and token)." },
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
  InvoiceLine: {
    type: "object",
    required: [
      "id",
      "invoice_id",
      "position",
      "kind",
      "description",
      "quantity",
      "unit_price_cents",
      "amount_cents",
      "taxed",
      "taxed2",
      "project_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      invoice_id: integerSchema,
      position: { type: "integer", minimum: 0 },
      kind: stringSchema,
      description: nullable(stringSchema),
      quantity: { type: "number" },
      unit_price_cents: { type: "integer" },
      amount_cents: { type: "integer" },
      taxed: booleanSchema,
      taxed2: booleanSchema,
      project_id: nullable(integerSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  Invoice: {
    type: "object",
    required: [
      "id",
      "client_id",
      "created_by_user_id",
      "number",
      "subject",
      "purchase_order",
      "notes",
      "currency",
      "issue_date",
      "due_date",
      "payment_terms",
      "state",
      "version",
      "close_reason",
      "close_write_off_cents",
      "sent_at",
      "paid_at",
      "paid_date",
      "closed_at",
      "period_start",
      "period_end",
      "project_id",
      "retainer_id",
      "recurring_invoice_id",
      "estimate_id",
      "reminder_policy",
      "tax_rate_ppm",
      "tax2_rate_ppm",
      "discount_rate_ppm",
      "amount_cents",
      "due_amount_cents",
      "tax_amount_cents",
      "tax2_amount_cents",
      "discount_amount_cents",
      "written_off_cents",
      "payment_options",
      "reference_token",
      "created_at",
      "updated_at",
      "line_items",
    ],
    properties: {
      id: integerSchema,
      client_id: integerSchema,
      created_by_user_id: nullable(integerSchema),
      number: stringSchema,
      subject: nullable(stringSchema),
      purchase_order: nullable(stringSchema),
      notes: nullable(stringSchema),
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      issue_date: dateSchema,
      due_date: dateSchema,
      payment_terms: {
        type: "string",
        enum: [
          "upon_receipt",
          "net_15",
          "net_30",
          "net_45",
          "net_60",
          "custom",
        ],
      },
      state: { type: "string", enum: ["draft", "open", "paid", "closed"] },
      version: { type: "integer", minimum: 0 },
      close_reason: nullable({
        type: "string",
        enum: ["cancelled", "written_off", "source_closed"],
      }),
      close_write_off_cents: { type: "integer", minimum: 0 },
      sent_at: nullable(timestampSchema),
      paid_at: nullable(timestampSchema),
      paid_date: nullable(dateSchema),
      closed_at: nullable(timestampSchema),
      period_start: nullable(dateSchema),
      period_end: nullable(dateSchema),
      project_id: nullable(integerSchema),
      retainer_id: nullable(integerSchema),
      recurring_invoice_id: nullable(integerSchema),
      estimate_id: nullable(integerSchema),
      reminder_policy: nullable(reference("InvoiceReminderPolicy")),
      tax_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      tax2_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      discount_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      amount_cents: { type: "integer" },
      due_amount_cents: { type: "integer", minimum: 0 },
      tax_amount_cents: { type: "integer" },
      tax2_amount_cents: { type: "integer" },
      discount_amount_cents: { type: "integer" },
      written_off_cents: { type: "integer", minimum: 0 },
      payment_options: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "stripe_checkout",
            "paypal_checkout",
            "quickbooks_checkout",
            "mercury_transfer",
            "wise_transfer",
          ],
        },
      },
      reference_token: nullable(stringSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
      line_items: { type: "array", items: reference("InvoiceLine") },
    },
    additionalProperties: false,
  },
  InvoiceEnvelope: envelope("Invoice"),
  InvoicePage: page("Invoice"),
  EstimateLine: {
    type: "object",
    required: [
      "id",
      "estimate_id",
      "position",
      "kind",
      "description",
      "quantity",
      "unit_price_cents",
      "amount_cents",
      "taxed",
      "taxed2",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      estimate_id: integerSchema,
      position: { type: "integer", minimum: 0 },
      kind: stringSchema,
      description: nullable(stringSchema),
      quantity: { type: "number" },
      unit_price_cents: { type: "integer" },
      amount_cents: { type: "integer" },
      taxed: booleanSchema,
      taxed2: booleanSchema,
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  Estimate: {
    type: "object",
    required: [
      "id",
      "client_id",
      "created_by_user_id",
      "number",
      "purchase_order",
      "subject",
      "notes",
      "currency",
      "state",
      "version",
      "issue_date",
      "sent_at",
      "accepted_at",
      "declined_at",
      "tax_rate_ppm",
      "tax2_rate_ppm",
      "discount_rate_ppm",
      "amount_cents",
      "tax_amount_cents",
      "tax2_amount_cents",
      "discount_amount_cents",
      "created_at",
      "updated_at",
      "line_items",
    ],
    properties: {
      id: integerSchema,
      client_id: integerSchema,
      created_by_user_id: nullable(integerSchema),
      number: stringSchema,
      purchase_order: nullable(stringSchema),
      subject: nullable(stringSchema),
      notes: nullable(stringSchema),
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      state: {
        type: "string",
        enum: ["draft", "sent", "accepted", "declined"],
      },
      version: { type: "integer", minimum: 0 },
      issue_date: dateSchema,
      sent_at: nullable(timestampSchema),
      accepted_at: nullable(timestampSchema),
      declined_at: nullable(timestampSchema),
      tax_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      tax2_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      discount_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      amount_cents: { type: "integer" },
      tax_amount_cents: { type: "integer" },
      tax2_amount_cents: { type: "integer" },
      discount_amount_cents: { type: "integer" },
      created_at: timestampSchema,
      updated_at: timestampSchema,
      line_items: { type: "array", items: reference("EstimateLine") },
    },
    additionalProperties: false,
  },
  EstimateEnvelope: envelope("Estimate"),
  EstimatePage: page("Estimate"),
  EstimateMessage: {
    type: "object",
    required: [
      "id",
      "estimate_id",
      "sent_by",
      "sent_by_email",
      "sent_from",
      "sent_from_email",
      "recipients",
      "subject",
      "body",
      "send_me_a_copy",
      "event_type",
      "delivery_status",
      "provider_message_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      estimate_id: integerSchema,
      sent_by: nullable(stringSchema),
      sent_by_email: nullable(stringSchema),
      sent_from: nullable(stringSchema),
      sent_from_email: nullable(stringSchema),
      recipients: { type: "array", items: reference("InvoiceRecipient") },
      subject: nullable(stringSchema),
      body: nullable(stringSchema),
      send_me_a_copy: booleanSchema,
      event_type: nullable({
        type: "string",
        enum: ["send", "accept", "decline", "re-open", "view", "invoice"],
      }),
      delivery_status: nullable({
        type: "string",
        enum: ["queued", "sent", "bounced", "complained", "failed"],
      }),
      provider_message_id: nullable(stringSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  EstimateMessageListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("EstimateMessage") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  EstimateMessageInput: {
    oneOf: [
      {
        type: "object",
        required: ["expected_version", "event_type", "recipients"],
        properties: {
          expected_version: { type: "integer", minimum: 0 },
          event_type: { const: "send" },
          recipients: {
            type: "array",
            minItems: 1,
            maxItems: 1_000,
            items: reference("InvoiceRecipient"),
          },
          subject: nullable(stringSchema),
          body: nullable(stringSchema),
          send_me_a_copy: booleanSchema,
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["expected_version", "event_type"],
        properties: {
          expected_version: { type: "integer", minimum: 0 },
          event_type: {
            type: "string",
            enum: ["accept", "decline", "re-open"],
          },
          recipients: {
            type: "array",
            maxItems: 1_000,
            items: reference("InvoiceRecipient"),
          },
          subject: nullable(stringSchema),
          body: nullable(stringSchema),
          send_me_a_copy: booleanSchema,
        },
        additionalProperties: false,
      },
    ],
  },
  EstimateMessageCommandResponse: {
    type: "object",
    required: ["estimate", "message"],
    properties: {
      estimate: reference("Estimate"),
      message: reference("EstimateMessage"),
    },
    additionalProperties: false,
  },
  EstimateMessageCommandEnvelope: envelope("EstimateMessageCommandResponse"),
  EstimateConversionInput: {
    type: "object",
    required: [
      "expected_version",
      "number",
      "issue_date",
      "due_date",
      "payment_terms",
    ],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      number: { type: "string", minLength: 1, maxLength: 255, pattern: "\\S" },
      issue_date: dateSchema,
      due_date: dateSchema,
      payment_terms: {
        type: "string",
        enum: [
          "upon_receipt",
          "net_15",
          "net_30",
          "net_45",
          "net_60",
          "custom",
        ],
      },
    },
    additionalProperties: false,
  },
  EstimateConversion: {
    type: "object",
    required: ["invoice", "event"],
    properties: {
      invoice: reference("Invoice"),
      event: reference("EstimateMessage"),
    },
    additionalProperties: false,
  },
  EstimateConversionEnvelope: envelope("EstimateConversion"),
  InvoiceGenerationInput: {
    oneOf: [
      {
        type: "object",
        required: [
          "client_id",
          "to",
          "project_ids",
          "time_summary_type",
          "expense_summary_type",
        ],
        properties: {
          // Absent means tracked, which is every request sent before blank drafts.
          kind: { const: "tracked" },
          client_id: integerSchema,
          // Absent or null takes every uninvoiced billable row up to `to`; the
          // invoice's period then starts on the earliest row it bills.
          from: nullable(dateSchema),
          to: dateSchema,
          project_ids: {
            type: "array",
            minItems: 1,
            maxItems: 10_000,
            uniqueItems: true,
            items: integerSchema,
          },
          time_summary_type: nullable({
            type: "string",
            enum: ["project", "task", "people", "detailed"],
          }),
          expense_summary_type: nullable({
            type: "string",
            enum: ["project", "category", "people", "detailed"],
          }),
        },
        additionalProperties: false,
      },
      {
        // A blank draft for the client: no lines, no period, nothing claimed.
        type: "object",
        required: ["kind", "client_id"],
        properties: {
          kind: { const: "free_form" },
          client_id: integerSchema,
        },
        additionalProperties: false,
      },
      {
        // A flat fee covering tracked time. The draft takes every uninvoiced
        // billable hour on the projects in the period; the fee covers all of
        // them, or the oldest whole entries up to a ceiling in seconds or in
        // cents of billable value, and the rest are billed after the fee at
        // each person's rate, grouped by `overage_summary_type`. Expenses are
        // left alone.
        type: "object",
        required: [
          "kind",
          "client_id",
          "to",
          "project_ids",
          "line_items",
          "claim_mode",
        ],
        properties: {
          kind: { const: "banded" },
          client_id: integerSchema,
          from: nullable(dateSchema),
          to: dateSchema,
          project_ids: {
            type: "array",
            minItems: 1,
            maxItems: 10_000,
            uniqueItems: true,
            items: integerSchema,
          },
          // The fee, written as free-form lines are.
          line_items: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              required: ["kind", "quantity", "unit_price_cents"],
              properties: {
                kind: { type: "string", minLength: 1, maxLength: 255 },
                description: nullable(stringSchema),
                quantity: { type: "number" },
                unit_price_cents: {
                  type: "integer",
                  minimum: -9_000_000_000_000,
                  maximum: 9_000_000_000_000,
                },
                project_id: nullable(integerSchema),
              },
              additionalProperties: false,
            },
          },
          claim_mode: { type: "string", enum: ["all", "ceiling"] },
          // Exactly one on a ceiling; neither on `all`.
          claim_ceiling_seconds: nullable(integerSchema),
          claim_ceiling_cents: nullable(integerSchema),
          // Required on a ceiling; refused on `all`.
          overage_summary_type: nullable({
            type: "string",
            enum: ["project", "task", "people", "detailed"],
          }),
        },
        additionalProperties: false,
      },
    ],
  },
  InvoiceBandClaim: {
    type: "object",
    required: [
      "claimed_entry_count",
      "claimed_seconds",
      "billed_entry_count",
      "billed_seconds",
    ],
    properties: {
      claimed_entry_count: { type: "integer", minimum: 0 },
      claimed_seconds: signedIntegerSchema,
      billed_entry_count: { type: "integer", minimum: 0 },
      billed_seconds: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  InvoiceGenerationEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: reference("Invoice"),
      // Only on a banded draft: what its fee covered and what it billed past
      // the ceiling. Zero covered hours is an answer, not a refusal.
      band: reference("InvoiceBandClaim"),
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  InvoiceCommandSnapshot: {
    type: "object",
    required: [
      "id",
      "version",
      "updated_at",
      "state",
      "close_reason",
      "close_write_off_cents",
      "sent_at",
      "paid_at",
      "paid_date",
      "closed_at",
      "amount_cents",
      "due_amount_cents",
      "written_off_cents",
      "payment_count",
      "payment_status",
    ],
    properties: {
      id: integerSchema,
      version: { type: "integer", minimum: 0 },
      updated_at: timestampSchema,
      state: { type: "string", enum: ["draft", "open", "paid", "closed"] },
      close_reason: nullable({
        type: "string",
        enum: ["cancelled", "written_off", "source_closed"],
      }),
      close_write_off_cents: { type: "integer", minimum: 0 },
      sent_at: nullable(timestampSchema),
      paid_at: nullable(timestampSchema),
      paid_date: nullable(dateSchema),
      closed_at: nullable(timestampSchema),
      amount_cents: { type: "integer" },
      due_amount_cents: { type: "integer", minimum: 0 },
      written_off_cents: { type: "integer", minimum: 0 },
      payment_count: { type: "integer", minimum: 0 },
      payment_status: { type: "string", enum: ["unpaid", "partial", "paid"] },
    },
    additionalProperties: false,
  },
  InvoiceCommandResult: {
    type: "object",
    required: [
      "schema_version",
      "event_ids",
      "first_aggregate_sequence",
      "event_count",
      "invoice",
    ],
    properties: {
      schema_version: { const: 1 },
      event_ids: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: stringSchema,
      },
      first_aggregate_sequence: { type: "integer", minimum: 1 },
      event_count: { type: "integer", minimum: 1, maximum: 2 },
      invoice: reference("InvoiceCommandSnapshot"),
    },
    additionalProperties: false,
  },
  InvoiceCommandResponse: {
    type: "object",
    required: ["invoice", "command"],
    properties: {
      invoice: reference("Invoice"),
      command: reference("InvoiceCommandResult"),
    },
    additionalProperties: false,
  },
  InvoiceCommandEnvelope: envelope("InvoiceCommandResponse"),
  InvoiceEditInput: {
    type: "object",
    required: ["expected_version"],
    minProperties: 2,
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      client_id: integerSchema,
      number: { type: "string", minLength: 1, maxLength: 255 },
      subject: nullable(stringSchema),
      purchase_order: nullable(stringSchema),
      notes: nullable(stringSchema),
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      issue_date: dateSchema,
      due_date: dateSchema,
      payment_terms: {
        type: "string",
        enum: [
          "upon_receipt",
          "net_15",
          "net_30",
          "net_45",
          "net_60",
          "custom",
        ],
      },
      project_id: nullable(integerSchema),
      // The retainer this invoice moves against. `retainer_ledger` refuses a
      // deposit or a drawdown whose invoice is not linked to the same retainer,
      // so until this existed a retainer could be created, shown, and never
      // moved. Editable only until a movement names it: the schema freezes the
      // link at that point.
      retainer_id: nullable(integerSchema),
      reminder_policy: nullable(reference("InvoiceReminderPolicy")),
      payment_options: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "stripe_checkout",
            "paypal_checkout",
            "quickbooks_checkout",
            "mercury_transfer",
            "wise_transfer",
          ],
        },
      },
      tax_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      tax2_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
      discount_rate_ppm: nullable({
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
      }),
    },
    additionalProperties: false,
  },
  InvoiceLineInput: {
    type: "object",
    required: [
      "expected_version",
      "position",
      "kind",
      "quantity",
      "unit_price_cents",
    ],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      position: { type: "integer", minimum: 0 },
      kind: { type: "string", minLength: 1, maxLength: 255 },
      description: nullable(stringSchema),
      quantity: { type: "number" },
      unit_price_cents: {
        type: "integer",
        minimum: -9_000_000_000_000,
        maximum: 9_000_000_000_000,
      },
      taxed: booleanSchema,
      taxed2: booleanSchema,
      project_id: nullable(integerSchema),
    },
    additionalProperties: false,
  },
  InvoiceLineUpdateInput: {
    type: "object",
    required: [
      "expected_version",
      "expected_updated_at",
      "position",
      "kind",
      "quantity",
      "unit_price_cents",
    ],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      expected_updated_at: timestampSchema,
      position: { type: "integer", minimum: 0 },
      kind: { type: "string", minLength: 1, maxLength: 255 },
      description: nullable(stringSchema),
      quantity: { type: "number" },
      unit_price_cents: {
        type: "integer",
        minimum: -9_000_000_000_000,
        maximum: 9_000_000_000_000,
      },
      taxed: booleanSchema,
      taxed2: booleanSchema,
      project_id: nullable(integerSchema),
    },
    additionalProperties: false,
  },
  VersionedRowDeleteInput: {
    type: "object",
    required: ["expected_version", "expected_updated_at"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      expected_updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  InvoiceRecipient: {
    type: "object",
    required: ["name", "email"],
    properties: {
      name: { type: "string", maxLength: 1_000 },
      email: { type: "string", minLength: 3, maxLength: 320 },
    },
    additionalProperties: false,
  },
  InvoiceMessage: {
    type: "object",
    required: [
      "id",
      "invoice_id",
      "sent_by",
      "sent_by_email",
      "sent_from",
      "sent_from_email",
      "recipients",
      "cc",
      "subject",
      "body",
      "attach_pdf",
      "send_me_a_copy",
      "thank_you",
      "reminder",
      "send_reminder_on",
      "event_type",
      "delivery_status",
      "provider_message_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      invoice_id: integerSchema,
      sent_by: nullable(stringSchema),
      sent_by_email: nullable(stringSchema),
      sent_from: nullable(stringSchema),
      sent_from_email: nullable(stringSchema),
      recipients: { type: "array", items: reference("InvoiceRecipient") },
      // Who the email was copied to; empty for a message that copied nobody.
      cc: { type: "array", items: reference("InvoiceRecipient") },
      subject: nullable(stringSchema),
      body: nullable(stringSchema),
      attach_pdf: booleanSchema,
      send_me_a_copy: booleanSchema,
      thank_you: booleanSchema,
      reminder: booleanSchema,
      send_reminder_on: nullable(dateSchema),
      event_type: nullable(stringSchema),
      delivery_status: nullable(stringSchema),
      provider_message_id: nullable(stringSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  InvoiceMessageListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("InvoiceMessage") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  InvoiceMessageInput: {
    type: "object",
    required: ["event_type", "expected_version"],
    properties: {
      event_type: {
        type: "string",
        enum: ["send", "draft", "cancel", "write_off", "reopen", "re-open"],
      },
      expected_version: { type: "integer", minimum: 0 },
      recipients: {
        type: "array",
        maxItems: 1_000,
        items: reference("InvoiceRecipient"),
      },
      subject: nullable(stringSchema),
      body: nullable(stringSchema),
      attach_pdf: booleanSchema,
      send_me_a_copy: booleanSchema,
      thank_you: booleanSchema,
      reminder: booleanSchema,
      send_reminder_on: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  InvoiceTransitionInput: {
    type: "object",
    required: ["command", "expected_version"],
    properties: {
      command: {
        type: "string",
        enum: ["send", "draft", "cancel", "write_off", "reopen", "re-open"],
      },
      expected_version: { type: "integer", minimum: 0 },
      recipients: {
        type: "array",
        maxItems: 1_000,
        items: reference("InvoiceRecipient"),
      },
      subject: nullable(stringSchema),
      body: nullable(stringSchema),
      attach_pdf: booleanSchema,
      send_me_a_copy: booleanSchema,
      thank_you: booleanSchema,
      reminder: booleanSchema,
      send_reminder_on: nullable(dateSchema),
    },
    additionalProperties: false,
  },
  InvoiceEmailDeliveryInput: {
    type: "object",
    required: ["expected_version", "recipients", "confirmed"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      // The To header.
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: 1_000,
        items: reference("InvoiceRecipient"),
      },
      // The Cc header, never an address already in To.
      cc: { type: "array", maxItems: 99, items: reference("InvoiceRecipient") },
      // Templates over the invoice's variables. Absent takes the
      // organization's invoice template.
      subject: { type: "string", maxLength: 998 },
      message: { type: "string", maxLength: 100_000 },
      // Copies the person sending on this email.
      send_me_a_copy: booleanSchema,
      sender_identity_id: { type: "integer", minimum: 1 },
      template_version: { type: "integer", minimum: 1 },
      confirmed: { type: "boolean", enum: [true] },
    },
    additionalProperties: false,
  },
  // The delivery's fields, with the Send dialog's unsaved attachment choices
  // laid over the invoice's own. A preview changes nothing, so it names no
  // version.
  InvoiceEmailPreviewInput: {
    type: "object",
    required: ["recipients"],
    properties: {
      expected_version: { type: "integer", minimum: 0 },
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: 1_000,
        items: reference("InvoiceRecipient"),
      },
      cc: { type: "array", maxItems: 99, items: reference("InvoiceRecipient") },
      subject: { type: "string", maxLength: 998 },
      message: { type: "string", maxLength: 100_000 },
      send_me_a_copy: booleanSchema,
      sender_identity_id: { type: "integer", minimum: 1 },
      template_version: { type: "integer", minimum: 1 },
      attach_pdf: booleanSchema,
      attach_files: booleanSchema,
      append_pdfs: booleanSchema,
      attach_journal: {
        oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean", enum: [false] }],
      },
      journal_formats: reference("JournalFormats"),
    },
    additionalProperties: false,
  },
  InvoiceEmailPreviewAttachment: {
    type: "object",
    required: ["kind", "filename", "content_type", "byte_size", "appended", "not_appended"],
    properties: {
      kind: { type: "string", enum: ["invoice", "journal", "file"] },
      filename: stringSchema,
      content_type: stringSchema,
      byte_size: { type: "integer", minimum: 0 },
      // The invoice document's own: the files bound into its back, in order.
      appended: { type: "array", items: stringSchema },
      // A file meant for the back of the document that goes beside it, and why.
      not_appended: nullable({
        type: "string",
        enum: ["encrypted", "unreadable", "empty", "too_large"],
      }),
    },
    additionalProperties: false,
  },
  InvoiceEmailPreviewEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: {
        type: "object",
        required: [
          "invoice_id",
          "from",
          "reply_to",
          "to",
          "cc",
          "send_me_a_copy",
          "subject",
          "text",
          "html",
          "attachments",
        ],
        properties: {
          invoice_id: integerSchema,
          from: reference("InvoiceRecipient"),
          reply_to: nullable(stringSchema),
          to: { type: "array", items: reference("InvoiceRecipient") },
          cc: { type: "array", items: reference("InvoiceRecipient") },
          send_me_a_copy: booleanSchema,
          subject: stringSchema,
          text: stringSchema,
          // The invoice email is one plain-text part.
          html: nullable(stringSchema),
          attachments: { type: "array", items: reference("InvoiceEmailPreviewAttachment") },
        },
        additionalProperties: false,
      },
      links: {
        type: "object",
        required: ["document"],
        properties: { document: stringSchema },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  InvoiceEmailPreviewSentEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["invoice_id", "delivery_id", "to", "subject"],
        properties: {
          invoice_id: integerSchema,
          delivery_id: integerSchema,
          to: { type: "array", items: reference("InvoiceRecipient") },
          subject: stringSchema,
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  InvoiceEmailDefaultsEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: [
          "invoice_id",
          "client_id",
          "company_name",
          "client_name",
          "template_version",
          "subject",
          "message",
          "to",
          "cc",
          "recipients_source",
          "always_cc",
          "sender",
          "send_me_a_copy",
          "delivery",
        ],
        properties: {
          invoice_id: integerSchema,
          client_id: integerSchema,
          company_name: stringSchema,
          client_name: stringSchema,
          template_version: integerSchema,
          subject: stringSchema,
          message: stringSchema,
          to: { type: "array", items: reference("InvoiceRecipient") },
          cc: { type: "array", items: reference("InvoiceRecipient") },
          // Where To and Cc came from: the client's saved lists, or its
          // contacts' invoice routing.
          recipients_source: { type: "string", enum: ["client", "contacts"] },
          always_cc: { type: "array", items: reference("InvoiceRecipient") },
          sender: {
            type: "object",
            required: ["name", "email"],
            properties: { name: stringSchema, email: nullable(stringSchema) },
            additionalProperties: false,
          },
          send_me_a_copy: booleanSchema,
          // Whether the email can leave now: a mail transport, and a default
          // sender the provider vouched for. Where it cannot, the code and
          // message a send would be refused with; both null where it can.
          delivery: {
            type: "object",
            required: ["available", "code", "message"],
            properties: {
              available: booleanSchema,
              code: nullable(stringSchema),
              message: nullable(stringSchema),
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  InvoiceRecipientLists: {
    type: "object",
    required: ["to", "cc"],
    properties: {
      to: { type: "array", maxItems: 50, items: reference("InvoiceRecipient") },
      cc: { type: "array", maxItems: 50, items: reference("InvoiceRecipient") },
    },
    additionalProperties: false,
  },
  ClientInvoiceSendingEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: [
          "client_id",
          "recipients",
          "contacts",
          "attach_pdf",
          "append_pdfs",
          "attach_files",
          "attach_journal",
          "journal_formats",
          "organization",
        ],
        properties: {
          client_id: integerSchema,
          // Null follows the contacts' invoice routing.
          recipients: nullable(reference("InvoiceRecipientLists")),
          contacts: reference("InvoiceRecipientLists"),
          // Null on any rule follows the organization.
          attach_pdf: nullable({ type: "boolean" }),
          append_pdfs: nullable({ type: "boolean" }),
          attach_files: nullable({ type: "boolean" }),
          attach_journal: nullable({
            oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }],
          }),
          journal_formats: nullable(reference("JournalFormats")),
          organization: {
            type: "object",
            required: ["attach_pdf", "append_pdfs", "attach_files", "attach_journal", "journal_formats"],
            properties: {
              attach_pdf: booleanSchema,
              append_pdfs: booleanSchema,
              attach_files: booleanSchema,
              attach_journal: { oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] },
              journal_formats: reference("JournalFormats"),
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  // Any combination, at least one. Null hands recipients back to the contacts
  // and a rule back to the organization.
  ClientInvoiceSendingInput: {
    type: "object",
    minProperties: 1,
    properties: {
      recipients: nullable(reference("InvoiceRecipientLists")),
      attach_pdf: nullable({ type: "boolean" }),
      append_pdfs: nullable({ type: "boolean" }),
      attach_files: nullable({ type: "boolean" }),
      attach_journal: nullable({
        oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean", enum: [false] }],
      }),
      journal_formats: nullable(reference("JournalFormats")),
    },
    additionalProperties: false,
  },
  OrganizationInvoiceSendingEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["always_cc"],
        properties: { always_cc: { type: "array", items: reference("InvoiceRecipient") } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  OrganizationInvoiceSendingInput: {
    type: "object",
    required: ["always_cc"],
    properties: {
      always_cc: { type: "array", maxItems: 20, items: reference("InvoiceRecipient") },
    },
    additionalProperties: false,
  },
  InvoicePayment: {
    type: "object",
    required: [
      "id",
      "invoice_id",
      "currency",
      "amount_cents",
      "paid_at",
      "paid_date",
      "notes",
      "recorded_by_user_id",
      "provider",
      "provider_shape",
      "provider_account_id",
      "provider_transaction_id",
      "bank_deposit_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      invoice_id: integerSchema,
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      amount_cents: { type: "integer", minimum: 1 },
      paid_at: nullable(timestampSchema),
      paid_date: nullable(dateSchema),
      notes: nullable(stringSchema),
      recorded_by_user_id: nullable(integerSchema),
      provider: stringSchema,
      provider_shape: stringSchema,
      provider_account_id: nullable(integerSchema),
      provider_transaction_id: nullable(stringSchema),
      bank_deposit_id: nullable(integerSchema),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  InvoicePaymentListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("InvoicePayment") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  InvoicePaymentInput: {
    oneOf: ["paid_at", "paid_date"].map((field) => ({
      type: "object",
      required: ["expected_version", "amount_cents", "currency", field],
      properties: {
        expected_version: { type: "integer", minimum: 0 },
        amount_cents: {
          type: "integer",
          minimum: 1,
          maximum: 9_000_000_000_000,
        },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        ...(field === "paid_at"
          ? { paid_at: timestampSchema }
          : { paid_date: dateSchema }),
        notes: nullable(stringSchema),
      },
      additionalProperties: false,
    })),
  },
  InvoicePaymentUpdateInput: {
    oneOf: ["paid_at", "paid_date"].map((field) => ({
      type: "object",
      required: [
        "expected_version",
        "expected_updated_at",
        "amount_cents",
        field,
      ],
      properties: {
        expected_version: { type: "integer", minimum: 0 },
        expected_updated_at: timestampSchema,
        amount_cents: {
          type: "integer",
          minimum: 1,
          maximum: 9_000_000_000_000,
        },
        ...(field === "paid_at"
          ? { paid_at: timestampSchema }
          : { paid_date: dateSchema }),
        notes: nullable(stringSchema),
      },
      additionalProperties: false,
    })),
  },
  Retainer: {
    type: "object",
    required: [
      "id",
      "client_id",
      "project_id",
      "state",
      "denomination",
      "amount_cents",
      "seconds",
      "locked_rate_cents",
      "rate_locked_at",
      "period",
      "rollover",
      "expires_at",
      "on_exhaustion",
      "balance",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      client_id: nullable(integerSchema),
      project_id: nullable(integerSchema),
      state: { type: "string", enum: ["ongoing", "closed"] },
      denomination: { type: "string", enum: ["money", "hours"] },
      amount_cents: nullable({ type: "integer", minimum: 0 }),
      seconds: nullable({ type: "integer", minimum: 0 }),
      locked_rate_cents: nullable({ type: "integer", minimum: 0 }),
      rate_locked_at: nullable(timestampSchema),
      period: nullable(stringSchema),
      rollover: nullable({ type: "string", enum: ["carry", "expire", "cap"] }),
      expires_at: nullable(dateSchema),
      on_exhaustion: { type: "string", enum: ["block", "warn", "overflow"] },
      balance: { type: "integer" },
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  RetainerEnvelope: envelope("Retainer"),
  RetainerPage: page("Retainer"),
  RetainerInput: {
    oneOf: [
      retainerInputVariant("money", false),
      retainerInputVariant("hours", false),
      retainerInputVariant("hours", true),
    ],
  },
  RetainerPatch: {
    type: "object",
    minProperties: 1,
    properties: {
      state: { type: "string", enum: ["ongoing", "closed"] },
      period: nullable({ type: "string", maxLength: 64 }),
      rollover: nullable({ type: "string", enum: ["carry", "expire", "cap"] }),
      expires_at: nullable(dateSchema),
      on_exhaustion: { type: "string", enum: ["block", "warn", "overflow"] },
    },
    additionalProperties: false,
  },
  RetainerLedgerEntry: {
    type: "object",
    required: [
      "id",
      "retainer_id",
      "kind",
      "unit",
      "amount",
      "invoice_id",
      "occurred_on",
      "notes",
      "created_at",
    ],
    properties: {
      id: stringSchema,
      retainer_id: integerSchema,
      kind: {
        type: "string",
        enum: ["deposit", "drawdown", "expiry", "reset", "adjustment"],
      },
      unit: { type: "string", enum: ["cents", "seconds"] },
      amount: { type: "integer" },
      invoice_id: nullable(integerSchema),
      occurred_on: dateSchema,
      notes: nullable(stringSchema),
      created_at: timestampSchema,
    },
    additionalProperties: false,
  },
  RetainerLedgerListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("RetainerLedgerEntry") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  RetainerLedgerMutation: {
    type: "object",
    required: ["entry", "balance", "denomination"],
    properties: {
      entry: reference("RetainerLedgerEntry"),
      balance: { type: "integer" },
      denomination: { type: "string", enum: ["money", "hours"] },
    },
    additionalProperties: false,
  },
  RetainerLedgerMutationEnvelope: envelope("RetainerLedgerMutation"),
  RetainerLedgerInput: {
    oneOf: ["deposit", "drawdown", "expiry", "reset", "adjustment"].flatMap(
      (kind) =>
        (["amount_cents", "seconds"] as const).map((unit) =>
          retainerLedgerVariant(
            kind as "deposit" | "drawdown" | "expiry" | "reset" | "adjustment",
            unit,
          ),
        ),
    ),
  },
  RetainerDrawdownInput: {
    oneOf: (["amount_cents", "seconds"] as const).map((unit) => {
      const variant = retainerLedgerVariant("drawdown", unit) as Record<
        string,
        unknown
      >;
      const properties = variant.properties as Record<string, unknown>;
      const drawdownProperties = { ...properties };
      delete drawdownProperties.kind;
      return {
        ...variant,
        required: (variant.required as string[]).filter(
          (field) => field !== "kind",
        ),
        properties: drawdownProperties,
      };
    }),
  },
  RecurringFixedLine: {
    type: "object",
    required: [
      "kind",
      "description",
      "quantity",
      "unit_price_cents",
      "taxed",
      "taxed2",
      "project_id",
    ],
    properties: {
      kind: stringSchema,
      description: nullable(stringSchema),
      quantity: { type: "number" },
      unit_price_cents: { type: "integer" },
      taxed: booleanSchema,
      taxed2: booleanSchema,
      project_id: nullable(integerSchema),
      // Optional because 0041 and 0044 added them that way: a line written
      // before either migration carries neither key and still means what it
      // always meant. `additionalProperties: false` was silently making this
      // document disagree with the storage it describes -- the database has
      // accepted `through` since 0041 and `installments` since 0044, and a
      // client generated from this contract could neither read one back nor
      // send one, which is why no screen could offer either.
      through: nullable(dateSchema),
      installments: nullable(integerSchema),
    },
    additionalProperties: false,
  },
  RecurringAmountConfig: {
    oneOf: [
      {
        type: "object",
        required: ["schema_version", "type", "line_items"],
        properties: {
          schema_version: { const: 1 },
          type: { const: "fixed_lines" },
          line_items: {
            type: "array",
            minItems: 1,
            items: reference("RecurringFixedLine"),
          },
        },
        additionalProperties: false,
      },
      recurringImportVariant("time"),
      recurringImportVariant("expenses"),
      recurringImportVariant("both"),
    ],
  },
  RecurringInvoice: {
    type: "object",
    required: [
      "id",
      "client_id",
      "subject_template",
      "notes_template",
      "every_n_months",
      "day_of_month",
      "next_issue_on",
      "amount_config",
      "can_draw_from_retainer_id",
      "claims_project_ids",
      "claim_mode",
      "claim_ceiling_seconds",
      "claim_ceiling_cents",
      "claim_scope",
      "cost_alert_basis_points",
      "purchase_order",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      client_id: integerSchema,
      subject_template: stringSchema,
      notes_template: stringSchema,
      every_n_months: { type: "integer", minimum: 1 },
      day_of_month: { type: "integer", minimum: 1, maximum: 31 },
      next_issue_on: dateSchema,
      amount_config: reference("RecurringAmountConfig"),
      can_draw_from_retainer_id: nullable(integerSchema),
      /**
       * The projects whose time this flat amount covers (#484).
       *
       * Null is the ordinary recurring invoice: a fixed amount that ignores
       * tracked time. A non-empty list makes it a *banded* engagement -- the
       * amount stays flat and the named projects' unbilled hours are claimed by
       * it, so they stop reading as uninvoiced and cannot be billed twice.
       *
       * Without this field the whole model was unreachable: the engine has
       * implemented it since 0060 and nothing could turn it on without a SQL
       * statement, which is the same defect #485 catalogued as columns with no
       * control.
       */
      claims_project_ids: nullable({ type: "array", items: integerSchema }),
      /**
       * How much of the period a band takes, and in which unit (#707).
       *
       * `all` is the #484 behaviour: every unbilled hour on the claimed
       * projects. `ceiling` claims the oldest hours up to a limit and leaves
       * the overflow to be invoiced as ordinary time and materials -- the two
       * contracts a band actually writes, a capacity promise in
       * `claim_ceiling_seconds` or a budget in `claim_ceiling_cents` measured
       * as billable value at list. Exactly one is set, and only for a ceiling.
       */
      claim_mode: { type: "string", enum: ["all", "ceiling"] },
      claim_ceiling_seconds: nullable({ type: "integer", minimum: 1 }),
      claim_ceiling_cents: nullable({ type: "integer", minimum: 1 }),
      /**
       * Whether the band absorbs every tracked hour on those projects or only
       * the billable ones (#708). Under a fixed amount the client bought the
       * period, so a firm that logs internal work against the client's project
       * wants it counted against what the band paid for; one that keeps that
       * work elsewhere does not. `billable` is what every definition did before
       * the setting existed.
       */
      claim_scope: { type: "string", enum: ["billable", "tracked"] },
      /**
       * The cost share this engagement is read against (#710), in basis points
       * -- 8000 is 80%. Null takes the organisation's default: deals differ, so
       * a single global number would be either too loose to catch anything or
       * tight enough to cry wolf.
       */
      cost_alert_basis_points: nullable({
        type: "integer",
        minimum: 1,
        maximum: 20000,
      }),
      // Copied onto every invoice the definition issues.
      purchase_order: nullable({ type: "string", maxLength: 1000 }),
      created_at: timestampSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  RecurringInvoiceEnvelope: envelope("RecurringInvoice"),
  RecurringGeneration: {
    type: "object",
    required: ["definition_id", "period", "next_issue_on", "retainer_drawdown_cents"],
    properties: {
      definition_id: integerSchema,
      period: stringSchema,
      // Where the definition lands next. Returned so a caller knows the
      // cadence advanced without reading the definition back.
      next_issue_on: stringSchema,
      retainer_drawdown_cents: nullable({ type: "integer" }),
    },
    additionalProperties: false,
  },
  RecurringGenerationEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: {
        type: "object",
        required: ["invoice", "generation"],
        properties: {
          invoice: reference("Invoice"),
          generation: reference("RecurringGeneration"),
        },
        additionalProperties: false,
      },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  RecurringInvoicePage: page("RecurringInvoice"),
  BandClaimBackfillInput: {
    type: "object",
    required: ["invoice_ids"],
    properties: {
      // Named, never inferred: an import can leave a definition's link null on
      // invoices that plainly belong to the band, so inferring the list would
      // silently do the wrong amount of work.
      invoice_ids: { type: "array", items: integerSchema, minItems: 1 },
      // Optional: absent takes what the definition says it claims, which is
      // configuration rather than a guess.
      project_ids: { type: "array", items: integerSchema },
      // Absent rehearses. A run writes nothing unless it says so.
      apply: booleanSchema,
    },
    additionalProperties: false,
  },
  BandClaimBackfillLine: {
    type: "object",
    required: [
      "invoice_id",
      "number",
      "issue_date",
      "state",
      "amount_cents",
      "entry_count",
      "seconds",
      "billable_value_cents",
      "entries_without_billable_rate",
      "foregone_billable_cents",
    ],
    properties: {
      invoice_id: integerSchema,
      number: stringSchema,
      issue_date: dateSchema,
      state: stringSchema,
      amount_cents: signedIntegerSchema,
      entry_count: { type: "integer", minimum: 0 },
      seconds: signedIntegerSchema,
      // Value at list of what this invoice would absorb, and how much of it
      // could not be priced -- so a low figure is readable as partial rather
      // than as a band that absorbed little.
      billable_value_cents: signedIntegerSchema,
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      foregone_billable_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  BandClaimBackfill: {
    type: "object",
    required: [
      "run_id",
      "applied",
      "invoices",
      "remaining_entry_count",
      "remaining_seconds",
    ],
    properties: {
      run_id: stringSchema,
      applied: booleanSchema,
      invoices: { type: "array", items: reference("BandClaimBackfillLine") },
      // Still unbilled on those projects afterwards: work no named invoice
      // covers, which belongs to the next generation rather than to this run.
      remaining_entry_count: { type: "integer", minimum: 0 },
      remaining_seconds: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  BandClaimBackfillEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("BandClaimBackfill") },
    additionalProperties: false,
  },
  RecurringInvoiceInput: {
    type: "object",
    required: [
      "client_id",
      "subject_template",
      "notes_template",
      "every_n_months",
      "day_of_month",
      "next_issue_on",
      "amount_config",
    ],
    properties: {
      client_id: integerSchema,
      subject_template: { type: "string", minLength: 1 },
      notes_template: stringSchema,
      every_n_months: { type: "integer", minimum: 1 },
      day_of_month: { type: "integer", minimum: 1, maximum: 31 },
      next_issue_on: dateSchema,
      amount_config: reference("RecurringAmountConfig"),
      can_draw_from_retainer_id: nullable(integerSchema),
      /**
       * The projects whose time this flat amount covers (#484).
       *
       * Null is the ordinary recurring invoice: a fixed amount that ignores
       * tracked time. A non-empty list makes it a *banded* engagement -- the
       * amount stays flat and the named projects' unbilled hours are claimed by
       * it, so they stop reading as uninvoiced and cannot be billed twice.
       *
       * Without this field the whole model was unreachable: the engine has
       * implemented it since 0060 and nothing could turn it on without a SQL
       * statement, which is the same defect #485 catalogued as columns with no
       * control.
       */
      claims_project_ids: nullable({ type: "array", items: integerSchema }),
      /**
       * How much of the period a band takes, and in which unit (#707).
       *
       * `all` is the #484 behaviour: every unbilled hour on the claimed
       * projects. `ceiling` claims the oldest hours up to a limit and leaves
       * the overflow to be invoiced as ordinary time and materials -- the two
       * contracts a band actually writes, a capacity promise in
       * `claim_ceiling_seconds` or a budget in `claim_ceiling_cents` measured
       * as billable value at list. Exactly one is set, and only for a ceiling.
       */
      claim_mode: { type: "string", enum: ["all", "ceiling"] },
      claim_ceiling_seconds: nullable({ type: "integer", minimum: 1 }),
      claim_ceiling_cents: nullable({ type: "integer", minimum: 1 }),
      /**
       * Whether the band absorbs every tracked hour on those projects or only
       * the billable ones (#708). Under a fixed amount the client bought the
       * period, so a firm that logs internal work against the client's project
       * wants it counted against what the band paid for; one that keeps that
       * work elsewhere does not. `billable` is what every definition did before
       * the setting existed.
       */
      claim_scope: { type: "string", enum: ["billable", "tracked"] },
      /**
       * The cost share this engagement is read against (#710), in basis points
       * -- 8000 is 80%. Null takes the organisation's default: deals differ, so
       * a single global number would be either too loose to catch anything or
       * tight enough to cry wolf.
       */
      cost_alert_basis_points: nullable({
        type: "integer",
        minimum: 1,
        maximum: 20000,
      }),
      // Absent leaves the stored purchase order as it is; null or blank clears it.
      purchase_order: nullable({ type: "string", maxLength: 1000 }),
    },
    additionalProperties: false,
  },
  MyHoursProject: {
    type: "object",
    required: [
      "project_id",
      "project_name",
      "project_code",
      "client_id",
      "client_name",
      "seconds",
      "rounded_seconds",
      "billable_seconds",
      "time_entry_count",
    ],
    properties: {
      project_id: integerSchema,
      project_name: stringSchema,
      project_code: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      // Tracked and rounded both, because they are different numbers on an
      // account that rounds, and a report holding only the rounded one
      // disagrees with the timesheet the reader just came from.
      seconds: signedIntegerSchema,
      rounded_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      time_entry_count: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  MyHoursReport: {
    type: "object",
    required: [
      "from",
      "to",
      "user_id",
      "project_id",
      "seconds",
      "rounded_seconds",
      "billable_seconds",
      "time_entry_count",
      "projects",
    ],
    properties: {
      from: dateSchema,
      to: dateSchema,
      // Echoed so the response says whose hours it holds. The request cannot
      // set it; it is the authenticated principal, every time.
      user_id: integerSchema,
      project_id: nullable(integerSchema),
      seconds: signedIntegerSchema,
      rounded_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      time_entry_count: { type: "integer", minimum: 0 },
      projects: { type: "array", items: reference("MyHoursProject") },
    },
    additionalProperties: false,
  },
  MyHoursReportEnvelope: envelope("MyHoursReport"),
  DetailedTimeRow: {
    type: "object",
    required: [
      "spent_date",
      "client_id",
      "client_name",
      "project_id",
      "project_name",
      "project_code",
      "task_id",
      "task_name",
      "user_id",
      "user_name",
      "roles",
      "currency",
      "seconds",
      "rounded_seconds",
      "billable_seconds",
      "uninvoiced_billable_seconds",
      "time_entry_count",
      "entries_without_billable_rate",
      "claimed",
    ],
    properties: {
      spent_date: dateSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      // Empty string, never null: `projects.code` is NOT NULL DEFAULT ''.
      project_code: stringSchema,
      task_id: integerSchema,
      task_name: stringSchema,
      user_id: integerSchema,
      user_name: stringSchema,
      roles: { type: "array", items: stringSchema },
      currency: stringSchema,
      // Tracked seconds. The Hours column is what the timesheet recorded;
      // `rounded_seconds` is what the money below was priced from.
      seconds: signedIntegerSchema,
      rounded_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      uninvoiced_billable_seconds: signedIntegerSchema,
      time_entry_count: { type: "integer", minimum: 0 },
      // Absent for a profile that cannot read billable rates; null when an
      // entry folded into the row carries no rate at all.
      billable_amount_cents: nullable(signedIntegerSchema),
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      // Whether an invoice has taken this work (#708). Part of the row's
      // grain, not a summary of it: a day, task and person partly claimed
      // folds into two rows, one of each, so grouping the table by it is the
      // same re-fold as grouping it by project or person.
      claimed: booleanSchema,
      // Present at `entry` grain only: the row is that one entry.
      time_entry_id: integerSchema,
      // The invoice that claimed the entry, at `entry` grain. Null where
      // nothing has.
      invoice_id: nullable(integerSchema),
      // That invoice's number, the one printed on it and in its address
      // (/invoices/<number>), beside its internal id. Null where nothing has
      // claimed the entry.
      invoice_number: nullable(stringSchema),
      notes: nullable(stringSchema),
      project_active: booleanSchema,
    },
    additionalProperties: false,
  },
  DetailedTimeCurrencyTotal: {
    type: "object",
    required: ["currency", "entries_without_billable_rate"],
    properties: {
      currency: stringSchema,
      billable_amount_cents: nullable(signedIntegerSchema),
      entries_without_billable_rate: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  DetailedTimeReport: {
    type: "object",
    required: [
      "from",
      "to",
      "client_id",
      "project_id",
      "task_id",
      "user_id",
      "role_id",
      "tag_id",
      "invoice_state",
      "hours",
      "grain",
      "active_projects_only",
      "seconds",
      "rounded_seconds",
      "billable_seconds",
      "uninvoiced_billable_seconds",
      "claimed_seconds",
      "unclaimed_seconds",
      "time_entry_count",
      "currencies",
      "facets",
      "rows",
    ],
    properties: {
      from: dateSchema,
      to: dateSchema,
      client_id: nullable(integerSchema),
      project_id: nullable(integerSchema),
      task_id: nullable(integerSchema),
      user_id: nullable(integerSchema),
      role_id: nullable(integerSchema),
      tag_id: nullable(integerSchema),
      invoice_state: { type: "string", enum: ["all", "invoiced", "uninvoiced"] },
      // Echoed so a saved or shared address renders the filter recap it was
      // built with, rather than the defaults.
      hours: {
        type: "string",
        enum: [
          "all",
          "billable",
          "non_billable",
          "uninvoiced",
          "claimed",
          "unclaimed",
        ],
      },
      grain: { type: "string", enum: ["day", "entry"] },
      active_projects_only: booleanSchema,
      seconds: signedIntegerSchema,
      rounded_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      uninvoiced_billable_seconds: signedIntegerSchema,
      // Tracked seconds an invoice has taken, and tracked seconds still open
      // (#708). Billable and non-billable alike, so these two add to `seconds`
      // where `uninvoiced_billable_seconds` does not.
      claimed_seconds: signedIntegerSchema,
      unclaimed_seconds: signedIntegerSchema,
      time_entry_count: { type: "integer", minimum: 0 },
      currencies: {
        type: "array",
        items: reference("DetailedTimeCurrencyTotal"),
      },
      facets: reference("DetailedTimeFacets"),
      rows: { type: "array", items: reference("DetailedTimeRow") },
    },
    additionalProperties: false,
  },
  DetailedTimeFacet: {
    type: "object",
    required: ["id", "name"],
    properties: { id: integerSchema, name: { type: "string" } },
    additionalProperties: false,
  },
  // What each picker can narrow the report to, each list computed with every
  // filter but its own applied.
  DetailedTimeFacets: {
    type: "object",
    required: ["people", "tasks", "roles", "tags"],
    properties: {
      people: { type: "array", items: reference("DetailedTimeFacet") },
      tasks: { type: "array", items: reference("DetailedTimeFacet") },
      roles: { type: "array", items: reference("DetailedTimeFacet") },
      tags: { type: "array", items: reference("DetailedTimeFacet") },
    },
    additionalProperties: false,
  },
  DetailedTimeReportEnvelope: envelope("DetailedTimeReport"),
  ReportTimeActionInput: {
    type: "object",
    required: ["command_id", "action", "entry_ids", "confirmed"],
    properties: {
      command_id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
      action: { type: "string", enum: ["mark_invoiced", "mark_uninvoiced", "move"] },
      entry_ids: { type: "array", minItems: 1, maxItems: 1000, uniqueItems: true, items: integerSchema },
      confirmed: { const: true },
      invoice_id: integerSchema,
      project_id: integerSchema,
      task_id: integerSchema,
    },
    additionalProperties: false,
  },
  ReportTimeAction: {
    type: "object",
    required: ["command_id", "action", "requested", "changed_entry_ids", "ineligible_entry_ids", "replayed"],
    properties: {
      command_id: stringSchema,
      action: { type: "string", enum: ["mark_invoiced", "mark_uninvoiced", "move"] },
      requested: { type: "integer", minimum: 1 },
      changed_entry_ids: { type: "array", items: integerSchema },
      ineligible_entry_ids: { type: "array", items: integerSchema },
      replayed: booleanSchema,
    },
    additionalProperties: false,
  },
  ReportTimeActionEnvelope: envelope("ReportTimeAction"),
  TimeReportAmount: {
    type: "object",
    required: ["currency", "billable_cents", "uninvoiced_cents"],
    properties: {
      currency: stringSchema,
      billable_cents: signedIntegerSchema,
      // The part of billable_cents not yet invoiced, on the uninvoiced report's
      // own predicate -- so the summary strip and that report agree.
      uninvoiced_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  TimeReportTotals: {
    type: "object",
    required: [...timeReportTotalsRequired],
    properties: { ...timeReportTotalsProperties },
    additionalProperties: false,
  },
  TimeReportClientRow: {
    type: "object",
    required: [...timeReportTotalsRequired, "client_id", "client_name"],
    properties: {
      ...timeReportTotalsProperties,
      client_id: integerSchema,
      client_name: stringSchema,
    },
    additionalProperties: false,
  },
  TimeReportProjectRow: {
    type: "object",
    required: [
      ...timeReportTotalsRequired,
      "project_id",
      "project_name",
      "project_code",
      "client_id",
      "client_name",
    ],
    properties: {
      ...timeReportTotalsProperties,
      project_id: integerSchema,
      project_name: stringSchema,
      // Never null: projects.code is NOT NULL DEFAULT '', so a project with no
      // code carries the empty string and the row renders as the bare name.
      project_code: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
    },
    additionalProperties: false,
  },
  TimeReportTaskRow: {
    type: "object",
    required: [...timeReportTotalsRequired, "task_id", "task_name"],
    properties: {
      ...timeReportTotalsProperties,
      task_id: integerSchema,
      task_name: stringSchema,
    },
    additionalProperties: false,
  },
  TimeReportTeammateRow: {
    type: "object",
    required: [
      ...timeReportTotalsRequired,
      "user_id",
      "user_name",
      "is_contractor",
      "capacity_seconds",
      "utilization_ppm",
    ],
    properties: {
      ...timeReportTotalsProperties,
      user_id: integerSchema,
      user_name: stringSchema,
      is_contractor: { type: "boolean" },
      // Weekly capacity prorated across the reported days, carried so the
      // screen can say what the utilization was divided by.
      capacity_seconds: { type: "integer", minimum: 0 },
      // Null where capacity is zero: no utilization can be stated.
      utilization_ppm: nullable(signedIntegerSchema),
    },
    additionalProperties: false,
  },
  TimeReport: {
    type: "object",
    required: [
      "from",
      "to",
      "fixed_fee_included",
      "totals",
      "clients",
      "projects",
      "tasks",
      "teammates",
    ],
    properties: {
      from: dateSchema,
      to: dateSchema,
      // The exact population predicate used by all four folds. False by
      // default so hourly value is never presented as fixed-fee revenue.
      fixed_fee_included: { type: "boolean" },
      totals: reference("TimeReportTotals"),
      clients: { type: "array", items: reference("TimeReportClientRow") },
      projects: { type: "array", items: reference("TimeReportProjectRow") },
      tasks: { type: "array", items: reference("TimeReportTaskRow") },
      teammates: { type: "array", items: reference("TimeReportTeammateRow") },
    },
    additionalProperties: false,
  },
  TimeReportEnvelope: envelope("TimeReport"),
  UninvoicedCurrencyTotal: {
    type: "object",
    required: [
      "currency",
      "rounded_seconds",
      "time_entry_count",
      "unpriced_time_entry_count",
      "expense_count",
    ],
    properties: {
      currency: stringSchema,
      rounded_seconds: signedIntegerSchema,
      time_entry_count: { type: "integer", minimum: 0 },
      unpriced_time_entry_count: { type: "integer", minimum: 0 },
      expense_count: { type: "integer", minimum: 0 },
      time_cents: signedIntegerSchema,
      expense_cents: { type: "integer", minimum: 0 },
      total_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  UninvoicedProjectRow: {
    type: "object",
    required: [
      "client_id",
      "client_name",
      "project_id",
      "project_name",
      "project_code",
      "totals",
    ],
    properties: {
      client_id: integerSchema,
      client_name: stringSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      // Empty string, never null: `projects.code` is NOT NULL DEFAULT ''.
      project_code: stringSchema,
      totals: { type: "array", items: reference("UninvoicedCurrencyTotal") },
    },
    additionalProperties: false,
  },
  UninvoicedReport: {
    type: "object",
    required: ["from", "to", "client_id", "project_id", "totals", "projects"],
    properties: {
      from: dateSchema,
      to: dateSchema,
      client_id: nullable(integerSchema),
      project_id: nullable(integerSchema),
      totals: { type: "array", items: reference("UninvoicedCurrencyTotal") },
      // The same candidates per project, priced by the same preview, so the
      // rows sum to `totals` to the cent. Client name, project name, id order.
      projects: { type: "array", items: reference("UninvoicedProjectRow") },
    },
    additionalProperties: false,
  },
  UninvoicedReportEnvelope: envelope("UninvoicedReport"),
  ContractorCostRow: {
    type: "object",
    required: [
      "user_id",
      "name",
      "payroll_email",
      "is_contractor",
      "currency",
      "rounded_seconds",
      "utilization_ppm",
      "cost_cents",
      "cost_rate_cents",
      "cost_rate_is_mixed",
      "entry_count",
      "entries_without_rate",
    ],
    properties: {
      user_id: integerSchema,
      name: stringSchema,
      // A proposal for matching the person at a payout provider, never the join
      // itself -- see #421. Null where the person has no primary address.
      payroll_email: nullable(stringSchema),
      is_contractor: { type: "boolean" },
      // The organization's currency, always: a cost rate carries none of its own.
      currency: stringSchema,
      rounded_seconds: { type: "integer", minimum: 0 },
      utilization_ppm: nullable(signedIntegerSchema),
      // Null when any entry in the row has no cost rate. A number that silently
      // omitted those hours would look payable and underpay.
      cost_cents: nullable(signedIntegerSchema),
      // The rate the cost was worked out at, where there is a single one. Null
      // in two different situations, which is why the flag sits beside it
      // rather than a sentinel doing double duty: the rate moved inside the
      // period, or there never was one. A payroll run pastes a rate into
      // another system, and an average nobody agreed to is not an answer.
      cost_rate_cents: nullable(signedIntegerSchema),
      cost_rate_is_mixed: { type: "boolean" },
      // How many entries the figures came from, for spot-checking a row that
      // looks wrong against something.
      entry_count: { type: "integer", minimum: 0 },
      entries_without_rate: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  ContractorCostReport: {
    type: "object",
    required: ["from", "to", "rows"],
    properties: {
      from: stringSchema,
      to: stringSchema,
      rows: { type: "array", items: { $ref: "#/components/schemas/ContractorCostRow" } },
    },
    additionalProperties: false,
  },
  ContractorCostReportEnvelope: envelope("ContractorCostReport"),
  InvoicedReportTotal: {
    type: "object",
    required: ["currency", "invoice_count"],
    properties: {
      currency: stringSchema,
      invoice_count: { type: "integer", minimum: 0 },
      invoiced_cents: signedIntegerSchema,
      paid_cents: signedIntegerSchema,
      balance_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  InvoicedReportRow: {
    type: "object",
    required: [
      "invoice_id", "number", "state", "close_reason", "issue_date", "due_date",
      "client_id", "client_name", "subject", "currency",
    ],
    properties: {
      invoice_id: integerSchema,
      number: stringSchema,
      state: { type: "string", enum: ["draft", "open", "paid", "closed"] },
      close_reason: nullable({
        type: "string",
        enum: ["cancelled", "written_off", "source_closed"],
      }),
      issue_date: dateSchema,
      due_date: dateSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      subject: nullable(stringSchema),
      currency: stringSchema,
      invoiced_cents: signedIntegerSchema,
      paid_cents: signedIntegerSchema,
      balance_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  InvoicedReport: {
    type: "object",
    required: ["from", "to", "client_id", "status", "totals", "rows"],
    properties: {
      from: dateSchema,
      to: dateSchema,
      client_id: nullable(integerSchema),
      status: nullable({ type: "string", enum: ["draft", "open", "paid", "closed"] }),
      totals: { type: "array", items: { $ref: "#/components/schemas/InvoicedReportTotal" } },
      rows: { type: "array", items: { $ref: "#/components/schemas/InvoicedReportRow" } },
    },
    additionalProperties: false,
  },
  InvoicedReportEnvelope: envelope("InvoicedReport"),
  PaymentsReceivedReportTotal: {
    type: "object",
    required: ["currency", "payment_count"],
    properties: {
      currency: stringSchema,
      payment_count: { type: "integer", minimum: 0 },
      payment_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  PaymentReceivedReportRow: {
    type: "object",
    required: [
      "payment_id", "payment_date", "invoice_id", "invoice_number", "client_id",
      "client_name", "currency", "provider",
    ],
    properties: {
      payment_id: integerSchema,
      payment_date: dateSchema,
      invoice_id: integerSchema,
      invoice_number: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      currency: stringSchema,
      provider: stringSchema,
      invoice_total_cents: signedIntegerSchema,
      payment_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  PaymentsReceivedReport: {
    type: "object",
    required: ["from", "to", "client_id", "totals", "rows"],
    properties: {
      from: dateSchema,
      to: dateSchema,
      client_id: nullable(integerSchema),
      totals: {
        type: "array",
        items: { $ref: "#/components/schemas/PaymentsReceivedReportTotal" },
      },
      rows: {
        type: "array",
        items: { $ref: "#/components/schemas/PaymentReceivedReportRow" },
      },
    },
    additionalProperties: false,
  },
  PaymentsReceivedReportEnvelope: envelope("PaymentsReceivedReport"),
  ReceivablesReportTotal: {
    type: "object",
    required: ["currency", "invoice_count"],
    properties: {
      currency: stringSchema,
      invoice_count: { type: "integer", minimum: 0 },
      invoiced_cents: signedIntegerSchema,
      outstanding_cents: signedIntegerSchema,
      not_due_cents: signedIntegerSchema,
      days_1_to_30_cents: signedIntegerSchema,
      days_31_to_60_cents: signedIntegerSchema,
      days_61_to_90_cents: signedIntegerSchema,
      days_90_plus_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  ReceivablesReportRow: {
    type: "object",
    required: ["client_id", "client_name", "currency", "invoice_count"],
    properties: {
      client_id: integerSchema,
      client_name: stringSchema,
      currency: stringSchema,
      invoice_count: { type: "integer", minimum: 0 },
      invoiced_cents: signedIntegerSchema,
      outstanding_cents: signedIntegerSchema,
      not_due_cents: signedIntegerSchema,
      days_1_to_30_cents: signedIntegerSchema,
      days_31_to_60_cents: signedIntegerSchema,
      days_61_to_90_cents: signedIntegerSchema,
      days_90_plus_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  ReceivablesReport: {
    type: "object",
    required: ["as_of", "client_id", "totals", "rows"],
    properties: {
      as_of: dateSchema,
      client_id: nullable(integerSchema),
      totals: { type: "array", items: { $ref: "#/components/schemas/ReceivablesReportTotal" } },
      rows: { type: "array", items: { $ref: "#/components/schemas/ReceivablesReportRow" } },
    },
    additionalProperties: false,
  },
  ReceivablesReportEnvelope: envelope("ReceivablesReport"),
  ReportDefinitionPresentation: {
    type: "object",
    required: ["result", "grouped", "include_zero_values"],
    properties: {
      result: { type: "string", enum: ["summary", "detailed"] },
      grouped: booleanSchema,
      include_zero_values: booleanSchema,
    },
    additionalProperties: false,
  },
  SavedReportInput: {
    type: "object",
    required: ["name", "fields", "metrics", "filters", "group_by", "presentation"],
    properties: {
      name: stringSchema,
      fields: { type: "array", items: { type: "object", additionalProperties: true } },
      metrics: { type: "array", items: { type: "string" } },
      filters: { type: "array", items: { type: "object", additionalProperties: true } },
      group_by: nullable({ type: "object", additionalProperties: true }),
      presentation: { $ref: "#/components/schemas/ReportDefinitionPresentation" },
    },
    additionalProperties: false,
  },
  SavedReportUpdate: {
    type: "object",
    required: ["version"],
    properties: {
      version: integerSchema,
      name: stringSchema,
      fields: { type: "array", items: { type: "object", additionalProperties: true } },
      metrics: { type: "array", items: { type: "string" } },
      filters: { type: "array", items: { type: "object", additionalProperties: true } },
      group_by: nullable({ type: "object", additionalProperties: true }),
      presentation: { $ref: "#/components/schemas/ReportDefinitionPresentation" },
    },
    additionalProperties: false,
  },
  SavedReport: {
    type: "object",
    required: ["id", "name", "version", "fields", "metrics", "filters", "group_by", "presentation", "owner", "is_custom", "pinned", "shared", "created_at", "updated_at"],
    properties: {
      id: stringSchema, name: stringSchema, version: integerSchema,
      fields: { type: "array", items: { type: "object", additionalProperties: true } },
      metrics: { type: "array", items: { type: "string" } },
      filters: { type: "array", items: { type: "object", additionalProperties: true } },
      group_by: nullable({ type: "object", additionalProperties: true }),
      presentation: { $ref: "#/components/schemas/ReportDefinitionPresentation" },
      owner: { type: "object", additionalProperties: true },
      is_custom: booleanSchema, pinned: booleanSchema, shared: booleanSchema,
      created_at: timestampSchema, updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  SavedReportEnvelope: envelope("SavedReport"),
  SavedReportListEnvelope: {
    type: "object", required: ["data"],
    properties: { data: { type: "array", items: { $ref: "#/components/schemas/SavedReport" } } },
    additionalProperties: false,
  },
  ReportRunnerResult: {
    type: "object", required: ["definitionId", "definitionVersion", "state", "rows"],
    properties: {
      definitionId: stringSchema, definitionVersion: integerSchema,
      state: { type: "string", enum: ["ready", "empty", "too_many_rows"] },
      rows: { type: "array", items: { type: "object", additionalProperties: true } },
    }, additionalProperties: false,
  },
  ReportRunnerEnvelope: envelope("ReportRunnerResult"),
  ReportDefinitionRegistry: {
    type: "object", required: ["fields", "metrics"],
    properties: {
      fields: { type: "array", items: { type: "object", additionalProperties: true } },
      metrics: { type: "array", items: { type: "object", additionalProperties: true } },
    }, additionalProperties: false,
  },
  ReportDefinitionRegistryEnvelope: envelope("ReportDefinitionRegistry"),
  DetailedExpenseRow: {
    type: "object",
    required: [
      "expense_id",
      "spent_date",
      "client_id",
      "client_name",
      "project_id",
      "project_name",
      "project_code",
      "category_id",
      "category_name",
      "user_id",
      "user_name",
      "notes",
      "units",
      "billable",
      "reimbursable",
      "invoice_id",
      "currency",
    ],
    properties: {
      expense_id: integerSchema,
      spent_date: dateSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      project_code: stringSchema,
      category_id: integerSchema,
      category_name: stringSchema,
      user_id: integerSchema,
      user_name: stringSchema,
      notes: nullable(stringSchema),
      units: nullable({ type: "integer", minimum: 0 }),
      billable: { type: "boolean" },
      reimbursable: { type: "boolean" },
      // Null while the expense sits on no invoice.
      invoice_id: nullable(integerSchema),
      currency: stringSchema,
      // Absent, not null, for a viewer refused billable money: the rest of the
      // row still answers who expensed what, when and against which project.
      total_cost_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  DetailedExpenseTotal: {
    type: "object",
    required: ["currency", "expense_count"],
    properties: {
      currency: stringSchema,
      expense_count: { type: "integer", minimum: 0 },
      // Per currency and never summed across them: two amounts in different
      // currencies are two numbers.
      total_cost_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  DetailedExpenseReport: {
    type: "object",
    required: [
      "from",
      "to",
      "client_id",
      "project_id",
      "category_id",
      "user_id",
      "billable",
      "reimbursable",
      "invoice_state",
      "active_projects_only",
      "totals",
      "rows",
    ],
    properties: {
      from: dateSchema,
      to: dateSchema,
      client_id: nullable(integerSchema),
      project_id: nullable(integerSchema),
      category_id: nullable(integerSchema),
      user_id: nullable(integerSchema),
      billable: nullable({ type: "boolean" }),
      reimbursable: nullable({ type: "boolean" }),
      invoice_state: { type: "string", enum: ["all", "invoiced", "uninvoiced"] },
      active_projects_only: { type: "boolean" },
      totals: {
        type: "array",
        items: { $ref: "#/components/schemas/DetailedExpenseTotal" },
      },
      rows: {
        type: "array",
        items: { $ref: "#/components/schemas/DetailedExpenseRow" },
      },
    },
    additionalProperties: false,
  },
  DetailedExpenseReportEnvelope: envelope("DetailedExpenseReport"),
  /**
   * A month of tracked work against what an invoice charged for it (#484).
   *
   * A band below cost is losing money and a band near list is barely a band,
   * and neither is visible from the invoice on its own.
   */
  MonthEndItem: {
    type: "object",
    required: ["subject_type", "subject_id", "description", "amount_cents", "currency", "target", "brand_name", "cost_cents", "margin_cents"],
    properties: {
      subject_type: stringSchema,
      subject_id: integerSchema,
      description: stringSchema,
      amount_cents: nullable(signedIntegerSchema),
      currency: nullable(stringSchema),
      // Where it would go. Null is an item with nowhere to send it, which is a
      // different problem from one that has not been sent.
      target: nullable(stringSchema),
      brand_name: nullable(stringSchema),
      cost_cents: nullable(signedIntegerSchema),
      margin_cents: nullable(signedIntegerSchema),
    },
    additionalProperties: false,
  },
  MonthEndExclusion: {
    type: "object",
    required: ["invoice_id", "number", "reason"],
    properties: {
      invoice_id: integerSchema,
      number: stringSchema,
      reason: stringSchema,
    },
    additionalProperties: false,
  },
  MonthEndManifest: {
    type: "object",
    required: ["period_start", "period_end", "items", "excluded"],
    properties: {
      period_start: dateSchema,
      period_end: dateSchema,
      items: { type: "array", items: { $ref: "#/components/schemas/MonthEndItem" } },
      // Beside the items rather than dropped: a pack of nine where eleven were
      // expected is a question about the other two.
      excluded: { type: "array", items: { $ref: "#/components/schemas/MonthEndExclusion" } },
    },
    additionalProperties: false,
  },
  MonthEndManifestEnvelope: envelope("MonthEndManifest"),
  BandedMonthRow: {
    type: "object",
    required: [
      "period_start",
      "period_end",
      "project_id",
      "project_name",
      "client_id",
      "client_name",
      "currency",
      "rounded_seconds",
      "billable_value_cents",
      "cost_value_cents",
      "entries_without_billable_rate",
      "entries_without_cost_rate",
      "claimed_in_other_currency",
      "billed_cents",
      "foregone_cents",
      "cost_ratio_basis_points",
      "cost_alert_basis_points",
      "cost_ratio_state",
    ],
    properties: {
      // The billing cycle, not the calendar month (#709). Generation takes
      // every unbilled hour with `spent_date <= issue_date`, so a cycle ends on
      // an issue date and starts the day after the one before it: a band
      // issuing on the 10th runs the 11th to the 10th, which is the window the
      // invoice beside it covers. The same rule gives a band issuing on the 1st
      // the 2nd to the 1st rather than the calendar month, and there is no
      // special case for it. A project no definition claims keeps months.
      period_start: dateSchema,
      period_end: dateSchema,
      project_id: integerSchema,
      project_name: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      currency: stringSchema,
      rounded_seconds: { type: "integer", minimum: 0 },
      // Null rather than zero where a rate is missing; the counts beside them
      // say how much. A month priced at nothing and a month nobody could price
      // are different answers.
      billable_value_cents: nullable(signedIntegerSchema),
      cost_value_cents: nullable(signedIntegerSchema),
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      entries_without_cost_rate: { type: "integer", minimum: 0 },
      // Non-zero means `billed_cents` is partial rather than low: an invoice
      // claimed this month's time in another currency and is not added in,
      // because adding it would invent a rate this system does not hold.
      claimed_in_other_currency: { type: "integer", minimum: 0 },
      // Null when no invoice has claimed any of the month. An unbilled month
      // is not a band priced at zero.
      billed_cents: nullable(signedIntegerSchema),
      foregone_cents: nullable(signedIntegerSchema),
      // What the period cost to deliver as a share of what it charged (#710).
      // 8000 is 80%. Basis points rather than a percentage because this is
      // compared against a ratio of two money amounts, and a float threshold
      // invites a comparison that answers differently depending on which side
      // rounded.
      //
      // Null wherever either side is missing, never a smaller number: an entry
      // with no cost rate contributes nothing to the numerator, so counting it
      // as free would make the deal look healthier exactly where the data is
      // least trustworthy. `cost_ratio_state` says which side was missing.
      cost_ratio_basis_points: nullable({ type: "integer", minimum: 0 }),
      cost_alert_basis_points: { type: "integer", minimum: 1 },
      // A state, not a colour: a caller that is not a screen has to be able to
      // act on it, and neither `unpriced` nor `unbilled` means "fine".
      cost_ratio_state: {
        type: "string",
        enum: ["within", "over", "unpriced", "unbilled"],
      },
    },
    additionalProperties: false,
  },
  BandedMonthReport: {
    type: "object",
    required: ["from", "to", "rows"],
    properties: {
      from: dateSchema,
      to: dateSchema,
      rows: { type: "array", items: { $ref: "#/components/schemas/BandedMonthRow" } },
    },
    additionalProperties: false,
  },
  BandedMonthReportEnvelope: envelope("BandedMonthReport"),
  // Basis points rather than a percentage, because this is compared against a
  // ratio of two money amounts and a float threshold invites a comparison that
  // answers differently depending on which side rounded. 8000 is 80%.
  BandCostAlert: {
    type: "object",
    required: ["basis_points"],
    properties: {
      basis_points: { type: "integer", minimum: 1, maximum: 20000 },
    },
    additionalProperties: false,
  },
  BandCostAlertEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("BandCostAlert") },
    additionalProperties: false,
  },
  BandCostAlertInput: {
    type: "object",
    required: ["basis_points"],
    properties: {
      basis_points: { type: "integer", minimum: 1, maximum: 20000 },
    },
    additionalProperties: false,
  },
  ProfitabilityRow: {
    type: "object",
    required: [
      "project_id",
      "project_name",
      "project_code",
      "client_id",
      "client_name",
      "currency",
      "rounded_seconds",
      "revenue_cents",
      "cost_cents",
      "profit_cents",
      "return_on_cost_ppm",
      "revenue_fee_cents",
      "fees_included_in_delivery_cost_cents",
      "entries_without_billable_rate",
      "entries_without_cost_rate",
    ],
    properties: {
      project_id: integerSchema,
      project_name: stringSchema,
      project_code: stringSchema,
      client_id: integerSchema,
      client_name: stringSchema,
      // The project's billing currency; revenue is denominated in it.
      currency: stringSchema,
      rounded_seconds: { type: "integer", minimum: 0 },
      // Null when any billable entry has no rate. A number that silently
      // omitted those hours would read as a healthier margin than the account
      // has.
      revenue_cents: nullable(signedIntegerSchema),
      // The organization's currency, always: a cost rate carries none of its
      // own. Null when any entry has no cost rate.
      cost_cents: nullable(signedIntegerSchema),
      // Null when either side is missing, and also when the project bills in a
      // currency the cost figure is not denominated in -- that subtraction
      // would cross units. See #522.
      profit_cents: nullable(signedIntegerSchema),
      return_on_cost_ppm: nullable(signedIntegerSchema),
      revenue_fee_cents: { type: "integer", minimum: 0 },
      fees_included_in_delivery_cost_cents: { type: "integer", minimum: 0 },
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      entries_without_cost_rate: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  ProfitabilityTotals: {
    type: "object",
    required: [
      "rounded_seconds",
      "revenue_cents",
      "cost_cents",
      "profit_cents",
      "return_on_cost_ppm",
      "revenue_fee_cents",
      "fees_included_in_delivery_cost_cents",
      "entries_without_billable_rate",
      "entries_without_cost_rate",
      "projects_not_converted",
    ],
    properties: {
      rounded_seconds: { type: "integer", minimum: 0 },
      revenue_cents: nullable(signedIntegerSchema),
      cost_cents: nullable(signedIntegerSchema),
      profit_cents: nullable(signedIntegerSchema),
      return_on_cost_ppm: nullable(signedIntegerSchema),
      revenue_fee_cents: { type: "integer", minimum: 0 },
      fees_included_in_delivery_cost_cents: { type: "integer", minimum: 0 },
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      entries_without_cost_rate: { type: "integer", minimum: 0 },
      // How much of the account the headline leaves out, so a total that
      // excludes another currency's projects cannot be read as the whole firm.
      projects_not_converted: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  ProfitabilityDimensionRow: {
    type: "object",
    required: [
      "dimension_id",
      "dimension_name",
      "currency",
      "rounded_seconds",
      "revenue_cents",
      "cost_cents",
      "profit_cents",
      "return_on_cost_ppm",
      "revenue_fee_cents",
      "fees_included_in_delivery_cost_cents",
      "entries_without_billable_rate",
      "entries_without_cost_rate",
      "included_in_headline",
    ],
    properties: {
      dimension_id: integerSchema,
      dimension_name: stringSchema,
      currency: stringSchema,
      rounded_seconds: { type: "integer", minimum: 0 },
      revenue_cents: nullable(signedIntegerSchema),
      cost_cents: nullable(signedIntegerSchema),
      profit_cents: nullable(signedIntegerSchema),
      return_on_cost_ppm: nullable(signedIntegerSchema),
      revenue_fee_cents: { type: "integer", minimum: 0 },
      fees_included_in_delivery_cost_cents: { type: "integer", minimum: 0 },
      entries_without_billable_rate: { type: "integer", minimum: 0 },
      entries_without_cost_rate: { type: "integer", minimum: 0 },
      included_in_headline: booleanSchema,
    },
    additionalProperties: false,
  },
  ProfitabilityTrendRow: {
    allOf: [
      { $ref: "#/components/schemas/ProfitabilityDimensionRow" },
      {
        type: "object",
        required: ["period_start", "period_end", "current"],
        properties: {
          period_start: dateSchema,
          period_end: dateSchema,
          current: booleanSchema,
        },
      },
    ],
  },
  ProfitabilityFilters: {
    type: "object",
    required: ["project_status", "billing_method", "manager_id", "tag_id"],
    properties: {
      project_status: { type: "string", enum: ["all", "active", "archived"] },
      billing_method: nullable({
        type: "string",
        enum: ["non_billable", "time_materials", "fixed_fee"],
      }),
      manager_id: nullable(integerSchema),
      tag_id: nullable(integerSchema),
    },
    additionalProperties: false,
  },
  ProfitabilityReport: {
    type: "object",
    required: [
      "from",
      "to",
      "organization_currency",
      "rows",
      "clients",
      "teammates",
      "tasks",
      "trend",
      "totals",
      "filters",
      "previous_from",
      "previous_to",
      "previous_totals",
    ],
    properties: {
      from: dateSchema,
      to: dateSchema,
      organization_currency: stringSchema,
      rows: { type: "array", items: { $ref: "#/components/schemas/ProfitabilityRow" } },
      clients: {
        type: "array",
        items: { $ref: "#/components/schemas/ProfitabilityDimensionRow" },
      },
      teammates: {
        type: "array",
        items: { $ref: "#/components/schemas/ProfitabilityDimensionRow" },
      },
      tasks: {
        type: "array",
        items: { $ref: "#/components/schemas/ProfitabilityDimensionRow" },
      },
      trend: {
        type: "array",
        items: { $ref: "#/components/schemas/ProfitabilityTrendRow" },
      },
      totals: { $ref: "#/components/schemas/ProfitabilityTotals" },
      filters: { $ref: "#/components/schemas/ProfitabilityFilters" },
      // The window of equal length ending the day before this one starts.
      previous_from: dateSchema,
      previous_to: dateSchema,
      previous_totals: { $ref: "#/components/schemas/ProfitabilityTotals" },
    },
    additionalProperties: false,
  },
  ProfitabilityReportEnvelope: envelope("ProfitabilityReport"),
  ClientRollupCurrency: {
    type: "object",
    required: ["currency", "expense_cents"],
    properties: {
      currency: stringSchema,
      expense_cents: { type: "integer", minimum: 0 },
      uninvoiced_time_cents: signedIntegerSchema,
      uninvoiced_expense_cents: { type: "integer", minimum: 0 },
      uninvoiced_total_cents: signedIntegerSchema,
      money_budget_cents: { type: "integer", minimum: 0 },
      cost_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  ClientRollupMetrics: {
    type: "object",
    required: [
      "time_entry_count",
      "expense_count",
      "rounded_seconds",
      "billable_seconds",
      "budgeted_seconds",
      "time_budget_seconds",
      "unpriced_billable_entry_count",
      "unpriced_cost_entry_count",
      "currencies",
    ],
    properties: {
      time_entry_count: { type: "integer", minimum: 0 },
      expense_count: { type: "integer", minimum: 0 },
      rounded_seconds: signedIntegerSchema,
      billable_seconds: signedIntegerSchema,
      budgeted_seconds: signedIntegerSchema,
      time_budget_seconds: { type: "integer", minimum: 0 },
      unpriced_billable_entry_count: { type: "integer", minimum: 0 },
      unpriced_cost_entry_count: { type: "integer", minimum: 0 },
      currencies: { type: "array", items: reference("ClientRollupCurrency") },
    },
    additionalProperties: false,
  },
  ClientRollupNode: {
    type: "object",
    required: [
      "client_id",
      "name",
      "parent_client_id",
      "depth",
      "direct",
      "rollup",
    ],
    properties: {
      client_id: integerSchema,
      name: stringSchema,
      parent_client_id: nullable(integerSchema),
      depth: { type: "integer", minimum: 0 },
      direct: reference("ClientRollupMetrics"),
      rollup: reference("ClientRollupMetrics"),
    },
    additionalProperties: false,
  },
  ClientRollupReport: {
    type: "object",
    required: ["root_client_id", "from", "to", "nodes"],
    properties: {
      root_client_id: integerSchema,
      from: dateSchema,
      to: dateSchema,
      nodes: { type: "array", items: reference("ClientRollupNode") },
    },
    additionalProperties: false,
  },
  ClientRollupReportEnvelope: envelope("ClientRollupReport"),
  ProjectBudgetGrain: {
    type: "object",
    required: [
      "source",
      "source_id",
      "unit",
      "calculation",
      "unpriced_entry_count",
    ],
    properties: {
      source: {
        type: "string",
        enum: ["project", "task_assignment", "user_assignment"],
      },
      source_id: integerSchema,
      unit: { type: "string", enum: ["seconds", "cents"] },
      calculation: { type: "string", enum: ["time", "billable", "cost"] },
      unpriced_entry_count: { type: "integer", minimum: 0 },
      budget_seconds: nullable({ type: "integer", minimum: 0 }),
      spent_seconds: signedIntegerSchema,
      remaining_seconds: nullable({ type: "integer" }),
      budget_cents: nullable({ type: "integer", minimum: 0 }),
      spent_cents: signedIntegerSchema,
      remaining_cents: nullable({ type: "integer" }),
    },
    additionalProperties: false,
  },
  ProjectBudgetReport: {
    type: "object",
    required: [
      "project_id",
      "budget_by",
      "expenses_included",
      "from",
      "to",
      "grains",
    ],
    properties: {
      project_id: integerSchema,
      budget_by: {
        type: "string",
        enum: [
          "project",
          "project_cost",
          "task",
          "task_fees",
          "person",
          "none",
        ],
      },
      expenses_included: booleanSchema,
      from: dateSchema,
      to: dateSchema,
      grains: { type: "array", items: reference("ProjectBudgetGrain") },
    },
    additionalProperties: false,
  },
  ProjectBudgetReportEnvelope: envelope("ProjectBudgetReport"),
  ProjectBudgetSummary: {
    type: "object",
    required: [
      "project_id",
      "currency",
      "budget_by",
      "unit",
      "unpriced_entry_count",
    ],
    properties: {
      project_id: integerSchema,
      // The project's billing currency, or its client's. Required, because a
      // reader holding the amount without it has to guess, and the only guess
      // available is the account default.
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      budget_by: {
        type: "string",
        enum: [
          "project",
          "project_cost",
          "task",
          "task_fees",
          "person",
          "none",
        ],
      },
      // null where the project has no budget to denominate.
      unit: { type: ["string", "null"], enum: ["seconds", "cents", null] },
      unpriced_entry_count: integerSchema,
      // Seconds are visible wherever the project is; the cents fields follow
      // the same per-field money gating the per-project report applies, so a
      // list cannot become a way to read a budget the detail page would hide.
      budget_seconds: nullable(integerSchema),
      spent_seconds: signedIntegerSchema,
      remaining_seconds: nullable(integerSchema),
      budget_cents: nullable(integerSchema),
      spent_cents: signedIntegerSchema,
      remaining_cents: nullable(integerSchema),
      cost_cents: signedIntegerSchema,
    },
    additionalProperties: false,
  },
  ProjectBudgetSummaryListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("ProjectBudgetSummary") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  ClientHierarchyNode: {
    type: "object",
    required: ["ancestor_id", "descendant_id", "depth"],
    properties: {
      ancestor_id: integerSchema,
      descendant_id: integerSchema,
      depth: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  ClientHierarchyListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("ClientHierarchyNode") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  ModuleState: {
    type: "object",
    required: ["module", "enabled"],
    properties: {
      module: { type: "string", enum: ["approval", "expenses", "own_money"] },
      enabled: booleanSchema,
    },
    additionalProperties: false,
  },
  ModuleListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("ModuleState") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  AccountRetentionRule: {
    type: "object", additionalProperties: false,
    required: ["category", "reason", "period", "review_after_days"],
    properties: {
      category: { type: "string", enum: ["time_and_worker_attribution", "billing_and_payments", "audit_and_security", "legal_hold"] },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      period: { type: "string", minLength: 1, maxLength: 1000 },
      review_after_days: { type: "integer", minimum: 1, maximum: 365 },
    },
  },
  AccountRetentionPolicy: {
    type: "object", additionalProperties: false,
    required: ["frameworks", "retained_records", "response_target_days", "operator_contact", "user_notice", "backup_handling", "acknowledged"],
    properties: {
      frameworks: { type: "array", uniqueItems: true, items: { type: "string", enum: [...ACCOUNT_PRIVACY_FRAMEWORKS] } },
      retained_records: { type: "array", maxItems: 4, items: reference("AccountRetentionRule") },
      response_target_days: { type: "integer", minimum: 1, maximum: 90 },
      operator_contact: { type: "string", format: "email", maxLength: 254 },
      user_notice: { type: "string", minLength: 1, maxLength: 5000 },
      backup_handling: { type: "string", minLength: 1, maxLength: 5000 },
      acknowledged: { type: "boolean", enum: [true] },
    },
  },
  AccountRetentionPublication: {
    type: "object", additionalProperties: false, required: ["expected_version", "policy"],
    properties: { expected_version: { type: "integer", minimum: 0, maximum: 9007199254740990 }, policy: reference("AccountRetentionPolicy") },
  },
  AccountRetentionRecord: {
    type: "object", additionalProperties: false, required: ["version", "policy", "published_at"],
    properties: { version: { type: "integer", minimum: 1 }, policy: reference("AccountRetentionPolicy"), published_at: { type: "string", format: "date-time" } },
  },
  AccountRetentionEnvelope: {
    type: "object", additionalProperties: false, required: ["data", "links"],
    properties: { data: { anyOf: [reference("AccountRetentionRecord"), { type: "null" }] }, links: reference("Links") },
  },
  SignInMethodState: {
    type: "object",
    required: ["method", "configured", "enabled"],
    properties: {
      method: {
        type: "string",
        enum: ["password", "magic_link", "google", "github", "apple"],
      },
      // Two states, deliberately separate: the deployment supplies the
      // credentials, the operator supplies the permission, and an
      // administrator needs to tell "never set up" from "switched off".
      configured: booleanSchema,
      enabled: booleanSchema,
    },
    additionalProperties: false,
  },
  SignInMethodListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("SignInMethodState") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  SsoDomain: {
    type: "object",
    required: [
      "id",
      "domain",
      "verified",
      "verified_at",
      "last_checked_at",
      "record_name",
      "record_type",
      "record_value",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: integerSchema,
      domain: stringSchema,
      verified: booleanSchema,
      verified_at: nullable(stringSchema),
      last_checked_at: nullable(stringSchema),
      record_name: stringSchema,
      record_type: { const: "TXT" },
      record_value: stringSchema,
      created_at: stringSchema,
      updated_at: stringSchema,
    },
    additionalProperties: false,
  },
  SsoDomainCheck: {
    allOf: [
      reference("SsoDomain"),
      {
        type: "object",
        required: ["dnssec_validated"],
        properties: { dnssec_validated: booleanSchema },
      },
    ],
  },
  SsoDomainListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("SsoDomain") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  SsoDomainEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("SsoDomain") },
    additionalProperties: false,
  },
  SsoDomainCheckEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("SsoDomainCheck") },
    additionalProperties: false,
  },
  BrandAsset: {
    type: "object",
    required: [
      "slot",
      "content_hash",
      "content_type",
      "byte_size",
      "url",
      "updated_at",
    ],
    properties: {
      slot: { enum: ["wordmark_light", "wordmark_dark", "favicon"] },
      content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      // A closed set, and the reason is in `brand-assets.ts`: these bytes are
      // served to an anonymous browser from this origin, so nothing
      // script-capable may name itself here.
      content_type: { enum: ["image/png", "image/jpeg", "image/webp"] },
      byte_size: { type: "integer", minimum: 1 },
      url: stringSchema,
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  BrandAssetListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("BrandAsset") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  // The mark as a consumer wears it: no hash or byte size beyond what the
  // public URL already carries.
  BrandMark: {
    type: "object",
    required: ["slot", "url", "content_type", "updated_at"],
    properties: {
      slot: { enum: ["wordmark_light", "wordmark_dark", "favicon"] },
      url: stringSchema,
      content_type: { enum: ["image/png", "image/jpeg", "image/webp"] },
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  Brand: {
    type: "object",
    required: ["organization_name", "assets"],
    properties: {
      organization_name: stringSchema,
      assets: { type: "array", items: reference("BrandMark") },
      // Present only where the instance composes a theme surface, so a caller
      // can tell "this instance has set nothing" (`{}`) from "this deployment
      // cannot tell me" (absent).
      palette: reference("InstancePalette"),
    },
    additionalProperties: false,
  },
  BrandEnvelope: envelope("Brand"),
  BrandAssetEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("BrandAsset") },
    additionalProperties: false,
  },
  BrandAssetUploadInput: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string", format: "binary" } },
    additionalProperties: false,
  },
  // Slot name to colour. The slot names are the web shell's design tokens and
  // are deliberately not enumerated here: the shell owns that list, and a copy
  // in the contract would be a second source able to drift from the stylesheet
  // a browser actually loads. The value pattern is enumerable and is enforced,
  // in the route, in the schema, and again on the way out.
  InstancePalette: {
    type: "object",
    additionalProperties: { type: "string", pattern: "^#[0-9A-F]{6}$" },
  },
  InstanceTheme: {
    type: "object",
    required: ["palette", "updated_at"],
    properties: {
      palette: reference("InstancePalette"),
      updated_at: timestampSchema,
    },
    additionalProperties: false,
  },
  InstanceThemeEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: nullable(reference("InstanceTheme")) },
    additionalProperties: false,
  },
  InstanceThemeInput: {
    type: "object",
    required: ["palette"],
    properties: { palette: reference("InstancePalette") },
    additionalProperties: false,
  },
  BillStatus: {
    type: "object",
    required: [
      "configured",
      "company_id",
      "environment",
      "can_send_from_bill",
    ],
    properties: {
      configured: booleanSchema,
      company_id: nullable(stringSchema),
      environment: { enum: ["sandbox", "production"] },
      // A sync token cannot have BILL send the invoice email. The screen has to
      // say which it is, or an operator is told their client will be emailed
      // when nobody will email them.
      can_send_from_bill: booleanSchema,
    },
    additionalProperties: false,
  },
  BillStatusEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("BillStatus") },
    additionalProperties: false,
  },
  BillClientDelivery: {
    type: "object",
    required: ["client_id", "deliver_via_bill"],
    properties: {
      client_id: integerSchema,
      deliver_via_bill: booleanSchema,
    },
    additionalProperties: false,
  },
  BillClientDeliveryEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("BillClientDelivery") },
    additionalProperties: false,
  },
  InvoicePaymentLinkEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["invoice_id", "url"],
        properties: { invoice_id: integerSchema, url: stringSchema },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  IncompleteRecurringInvoiceListEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "harvest_id",
            "client_id",
            "client_name",
            "invoice_count",
            "created_at",
            "updated_at",
          ],
          properties: {
            id: integerSchema,
            harvest_id: { type: "integer", nullable: true },
            client_id: integerSchema,
            client_name: { type: "string" },
            // What is riding on the stub. A definition with invoices against it
            // is a billing relationship somebody is still in.
            invoice_count: integerSchema,
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  RecurringInvoiceCompletionEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["id", "completed"],
        properties: { id: integerSchema, completed: { type: "boolean" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  InvoiceThankYouPreferenceEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["invoice_id", "auto_thank_you", "organization_auto_thank_you", "effective"],
        properties: {
          invoice_id: integerSchema,
          // Null is a third answer, not a missing one: it means this invoice
          // follows the organization.
          auto_thank_you: { type: "boolean", nullable: true },
          organization_auto_thank_you: { type: "boolean" },
          effective: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  OrganizationInvoiceThankYouEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["auto_thank_you"],
        properties: { auto_thank_you: { type: "boolean" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  ReminderPolicy: {
    type: "object",
    required: ["first_after_days", "every_days"],
    properties: {
      first_after_days: { type: "integer", minimum: 0, maximum: 3650 },
      every_days: { type: "integer", minimum: 1, maximum: 365 },
    },
    additionalProperties: false,
  },
  InvoiceReminderPreferenceInput: {
    type: "object",
    required: ["reminders"],
    properties: {
      // false switches reminders off for this invoice; null follows the organization.
      reminders: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    },
    additionalProperties: false,
  },
  InvoiceReminderPreferenceEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["invoice_id", "reminders", "organization_reminder_policy", "effective", "next_reminder_at"],
        properties: {
          invoice_id: integerSchema,
          reminders: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          organization_reminder_policy: {
            anyOf: [{ $ref: "#/components/schemas/ReminderPolicy" }, { type: "null" }],
          },
          effective: { type: "boolean" },
          next_reminder_at: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  OrganizationInvoiceRemindersInput: {
    type: "object",
    required: ["reminder_policy"],
    properties: {
      reminder_policy: { anyOf: [{ $ref: "#/components/schemas/ReminderPolicy" }, { type: "null" }] },
    },
    additionalProperties: false,
  },
  OrganizationInvoiceRemindersEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["reminder_policy"],
        properties: {
          reminder_policy: {
            anyOf: [{ $ref: "#/components/schemas/ReminderPolicy" }, { type: "null" }],
          },
          // On a set only: how many open invoices with nothing pending the
          // new policy was booked for (issue 850).
          applied_to_open_invoices: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  // The files the work journal goes as (issue 647): a non-empty set, held in
  // this order, which is the order they attach in. One level serves them all.
  JournalFormats: {
    type: "array",
    items: { type: "string", enum: ["pdf", "csv", "xlsx"] },
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  },
  // The route takes any combination of the four, at least one. Null on any of
  // them hands that choice back to the organization.
  InvoiceDocumentPreferenceInput: {
    type: "object",
    minProperties: 1,
    properties: {
      attach_pdf: nullable({ type: "boolean" }),
      attach_files: nullable({ type: "boolean" }),
      append_pdfs: nullable({ type: "boolean" }),
      attach_journal: nullable({
        oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean", enum: [false] }],
      }),
      journal_formats: nullable(reference("JournalFormats")),
    },
    additionalProperties: false,
  },
  // The organization's answers are complete, so none of them can be null.
  OrganizationInvoiceDocumentsInput: {
    type: "object",
    minProperties: 1,
    properties: {
      attach_pdf: { type: "boolean" },
      attach_files: { type: "boolean" },
      append_pdfs: { type: "boolean" },
      attach_journal: {
        oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean", enum: [false] }],
      },
      journal_formats: reference("JournalFormats"),
    },
    additionalProperties: false,
  },
  InvoiceDefaults: {
    type: "object",
    required: ["company_name", "company_address", "notes", "subject"],
    properties: {
      company_name: { type: "string" },
      company_address: nullable({ type: "string" }),
      // Harvest's lightweight markup (*bold*, _italic_) is kept verbatim.
      notes: nullable({ type: "string" }),
      subject: nullable({ type: "string" }),
    },
    additionalProperties: false,
  },
  InvoiceDefaultsEnvelope: envelope("InvoiceDefaults"),
  // Any combination, at least one. Null clears a default; the name cannot be.
  InvoiceDefaultsInput: {
    type: "object",
    minProperties: 1,
    properties: {
      company_name: { type: "string", minLength: 1, maxLength: 255 },
      company_address: nullable({ type: "string", maxLength: 2000 }),
      notes: nullable({ type: "string", maxLength: 100000 }),
      subject: nullable({ type: "string", maxLength: 998 }),
    },
    additionalProperties: false,
  },
  InvoiceDocumentPreferenceEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: [
          "invoice_id",
          "attach_pdf",
          "client_attach_pdf",
          "organization_attach_pdf",
          "effective",
          "attach_files",
          "client_attach_files",
          "organization_attach_files",
          "effective_files",
          "append_pdfs",
          "client_append_pdfs",
          "organization_append_pdfs",
          "effective_append_pdfs",
          "attach_journal",
          "client_attach_journal",
          "organization_attach_journal",
          "effective_journal",
          "journal_formats",
          "client_journal_formats",
          "organization_journal_formats",
          "effective_journal_formats",
        ],
        properties: {
          invoice_id: integerSchema,
          // Null is a third answer, not a missing one: it means this invoice
          // follows the organization.
          attach_pdf: { type: "boolean", nullable: true },
          // The client's standing rule; null follows the organization.
          client_attach_pdf: nullable({ type: "boolean" }),
          organization_attach_pdf: { type: "boolean" },
          effective: { type: "boolean" },
          // The files staged against the invoice are a separate choice from
          // the invoice document itself.
          attach_files: { type: "boolean", nullable: true },
          client_attach_files: nullable({ type: "boolean" }),
          organization_attach_files: { type: "boolean" },
          effective_files: { type: "boolean" },
          // The invoice's PDF files bound into the back of its document.
          append_pdfs: nullable({ type: "boolean" }),
          client_append_pdfs: nullable({ type: "boolean" }),
          organization_append_pdfs: { type: "boolean" },
          effective_append_pdfs: { type: "boolean" },
          // Not a boolean: the journal renders detailed or summary, which is
          // the value a fourth boolean pair could not have carried.
          attach_journal: { ...{ oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] }, nullable: true },
          client_attach_journal: nullable({ oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] }),
          organization_attach_journal: { oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] },
          effective_journal: { oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] },
          // Null when this invoice follows the organization's set.
          journal_formats: nullable(reference("JournalFormats")),
          client_journal_formats: nullable(reference("JournalFormats")),
          organization_journal_formats: reference("JournalFormats"),
          effective_journal_formats: reference("JournalFormats"),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  OrganizationInvoiceDocumentsEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["attach_pdf", "attach_files", "append_pdfs", "attach_journal", "journal_formats"],
        properties: {
          attach_pdf: { type: "boolean" },
          attach_files: { type: "boolean" },
          append_pdfs: { type: "boolean" },
          attach_journal: { oneOf: [{ type: "string", enum: ["detailed", "summary"] }, { type: "boolean" }] },
          // The PDF alone until somebody chooses otherwise.
          journal_formats: reference("JournalFormats"),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  ReleasedTimeEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["invoice_id", "released"],
        properties: { invoice_id: integerSchema, released: integerSchema },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  PayoutAccount: {
    type: "object",
    required: [
      "id",
      "user_id",
      "provider",
      "external_id",
      "linked_by_user_id",
      "linked_at",
      "verified_at",
    ],
    properties: {
      id: integerSchema,
      user_id: integerSchema,
      provider: { enum: ["deel", "wise"] },
      // The provider's own identifier, verbatim -- not parsed and not
      // normalised, because what it means is theirs to define.
      external_id: stringSchema,
      linked_by_user_id: integerSchema,
      linked_at: timestampSchema,
      // Null until the provider itself confirmed the id resolves to this
      // person. A link nobody checked is a claim.
      verified_at: nullable(timestampSchema),
    },
    additionalProperties: false,
  },
  PayoutAccountListEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: { type: "array", items: reference("PayoutAccount") } },
    additionalProperties: false,
  },
  PayoutAccountEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("PayoutAccount") },
    additionalProperties: false,
  },
  PayoutAccountInput: {
    type: "object",
    required: ["provider", "external_id"],
    properties: {
      provider: { enum: ["deel", "wise"] },
      external_id: stringSchema,
    },
    additionalProperties: false,
  },
  BillClientDeliveryInput: {
    type: "object",
    required: ["deliver_via_bill"],
    properties: { deliver_via_bill: booleanSchema },
    additionalProperties: false,
  },
  SsoDomainInput: {
    type: "object",
    required: ["domain"],
    properties: { domain: stringSchema },
    additionalProperties: false,
  },
  TwoFactorStatus: {
    type: "object",
    required: ["enrolled", "pending_confirmation", "recovery_codes_remaining"],
    properties: {
      enrolled: booleanSchema,
      pending_confirmation: booleanSchema,
      // Counts down as codes are spent, so zero is a real answer.
      recovery_codes_remaining: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  TwoFactorStatusEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: reference("TwoFactorStatus"),
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  TwoFactorEnrolment: {
    type: "object",
    required: ["secret", "otpauth_uri", "recovery_codes"],
    properties: {
      secret: stringSchema,
      otpauth_uri: stringSchema,
      // The only time these are readable. The server keeps their hashes.
      recovery_codes: { type: "array", items: stringSchema },
    },
    additionalProperties: false,
  },
  TwoFactorEnrolmentEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: reference("TwoFactorEnrolment"),
      links: reference("Links"),
    },
    additionalProperties: false,
  },
  TwoFactorCodeInput: {
    type: "object",
    required: ["code"],
    // A TOTP code or a recovery code. Which one is the server's business:
    // saying so here would tell an attacker which kind was just refused.
    properties: { code: stringSchema },
    additionalProperties: false,
  },
  // Issue 731. What a sign-in returns instead of a principal when the user has
  // a confirmed second factor. No session accompanies it.
  TwoFactorChallengeIssued: {
    type: "object",
    required: ["status", "challenge", "expires_at"],
    properties: {
      status: { type: "string", enum: ["two_factor_required"] },
      // Also set as an HttpOnly cookie. Named here for clients that keep none.
      challenge: stringSchema,
      expires_at: stringSchema,
    },
    additionalProperties: false,
  },
  TwoFactorChallengeInput: {
    type: "object",
    required: ["code"],
    properties: {
      code: stringSchema,
      // Omitted by anything that kept the cookie the sign-in set.
      challenge: stringSchema,
    },
    additionalProperties: false,
  },
  TwoFactorChallengeAccepted: {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", enum: ["authenticated"] } },
    additionalProperties: false,
  },
  TwoFactorChallengeAcceptedEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("TwoFactorChallengeAccepted") },
    additionalProperties: false,
  },
  SignInResult: {
    oneOf: [reference("AuthPrincipal"), reference("TwoFactorChallengeIssued")],
  },
  SignInResultEnvelope: {
    type: "object",
    required: ["data"],
    properties: { data: reference("SignInResult") },
    additionalProperties: false,
  },
  UserEmailInput: {
    type: "object",
    required: ["email"],
    properties: { email: stringSchema },
    additionalProperties: false,
  },
  UserEmailAcceptedEnvelope: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["status", "email"],
        properties: {
          status: { const: "verification_sent" },
          email: stringSchema,
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  ModulePatch: {
    type: "object",
    required: ["enabled"],
    properties: {
      enabled: booleanSchema,
    },
    additionalProperties: false,
  },
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

const successResponse = (
  operation: ApiContractOperation,
): Record<string, unknown> => {
  if (operation.responseStatus === 204) return { description: "No content" };
  if (operation.responseStatus >= 300 && operation.responseStatus < 400) {
    return {
      description: "Redirect response",
      headers: {
        Location: {
          description: "Redirect target",
          schema: stringSchema,
        },
      },
    };
  }
  if (operation.binaryResponse === true) {
    return {
      description: "Attachment content",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    };
  }
  return schemaResponse(operation.responseSchema ?? "ErrorEnvelope");
};

export const generateOpenApiDocument = (): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of apiContractOperations) {
    const route = openApiPath(operation.path);
    const responses: Record<string, unknown> = {
      [operation.responseStatus]: successResponse(operation),
      "400": { $ref: "#/components/responses/MalformedRequest" },
      "401": { $ref: "#/components/responses/AuthenticationRequired" },
      "403": { $ref: "#/components/responses/InsufficientPermission" },
      "404": { $ref: "#/components/responses/ResourceNotFound" },
      "409": { $ref: "#/components/responses/StateConflict" },
      "413": { $ref: "#/components/responses/PayloadTooLarge" },
      "422": { $ref: "#/components/responses/ValidationFailed" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "503": { $ref: "#/components/responses/ServiceUnavailable" },
    };
    for (const status of operation.additionalResponseStatuses ?? []) {
      responses[status] = successResponse(operation);
    }
    const entry: Record<string, unknown> = {
      operationId: operation.operationId,
      summary: operation.summary,
      ...(operation.description === undefined
        ? {}
        : { description: operation.description }),
      tags: [operation.tag],
      security: operation.public
        ? []
        : operation.sessionOnly
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
          [operation.requestContentType ?? "application/json"]: {
            schema: reference(operation.requestSchema),
          },
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
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-ezacto_session",
        },
      },
      responses: {
        MalformedRequest: errorResponse("Malformed request"),
        AuthenticationRequired: errorResponse("Authentication required"),
        InsufficientPermission: errorResponse("Insufficient permission"),
        ResourceNotFound: errorResponse("Resource not found"),
        StateConflict: errorResponse("State conflict"),
        PayloadTooLarge: errorResponse("Payload too large"),
        ValidationFailed: errorResponse("Validation failed"),
        RateLimited: errorResponse("Rate limited"),
        ServiceUnavailable: errorResponse("Service unavailable"),
      },
      schemas: apiContractSchemas,
    },
  };
};
