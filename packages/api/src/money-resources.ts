import {
  calculateInvoiceLineAmountCents,
  interpolateEmailTemplate,
  invoiceLineItemsBlock,
  type EmailTemplateBlockValue,
  type InvoiceActorType,
  type InvoiceLifecycleCommand,
} from "@ezacto/core";
import {
  SenderIdentityUnavailableError,
  type SenderBoundQueuedMailer,
  type EmailAttachmentRef,
} from "@ezacto/mailer";
import type { EmailConfigurationService } from "./email-configuration.js";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext, UserPrincipal } from "./context.js";
import { ApiError, validationError, type FieldError } from "./errors.js";
import { cursorPage, type CursorWindow } from "./pagination.js";
import {
  assertFields,
  isCanonicalDate,
  isCanonicalTimestamp,
  isJsonObject,
  readObjectBody,
  resourceId,
  unknownFieldErrors,
} from "./resources/support.js";

type JsonObject = Record<string, unknown>;

interface IdentifiedResource {
  id: number;
}

interface InvoiceResource extends IdentifiedResource {
  version: number;
  currency: string;
}

export interface InvoiceDeliveryLine {
  kind: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface InvoiceDeliveryContext {
  invoiceId: number;
  number: string;
  subject: string | null;
  currency: string;
  amountCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  tax2AmountCents: number;
  issueDate: string;
  dueDate: string;
  organizationName: string;
  clientName: string;
  lineItems: readonly InvoiceDeliveryLine[];
}

export interface InvoiceDeliveryJob {
  deliveryId: number;
  senderIdentityId: number;
  senderIdentityVersion: number;
  senderEvidenceVersion: number;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  recipientName: string;
  recipientEmail: string;
  templateVersion: number;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  invoiceMessageId: number;
}

interface EstimateResource extends IdentifiedResource {
  version: number;
  state: "draft" | "sent" | "accepted" | "declined";
}

type EstimateMessageResource = IdentifiedResource;

interface EstimateMessageCommandInput {
  estimateId: number;
  commandId: string;
  actorUserId: number;
  messageId: number;
  expectedVersion: number;
  eventType: "send" | "accept" | "decline" | "re-open";
  sentBy: string | null;
  sentByEmail: string | null;
  sentFrom: string | null;
  sentFromEmail: string | null;
  recipients: readonly { name: string; email: string }[];
  subject: string | null;
  body: string | null;
  sendMeACopy: boolean;
  occurredAt: string;
}

interface EstimateConversionInput {
  estimateId: number;
  commandId: string;
  invoiceId: number;
  messageId: number;
  eventId: string;
  expectedVersion: number;
  createdByUserId: number;
  number: string;
  issueDate: string;
  dueDate: string;
  paymentTerms:
    "upon_receipt" | "net_15" | "net_30" | "net_45" | "net_60" | "custom";
  occurredAt: string;
}

type InvoiceMessageResource = IdentifiedResource;
type InvoicePaymentResource = IdentifiedResource;
interface RetainerResource extends IdentifiedResource {
  denomination: "money" | "hours";
}
type RecurringResource = IdentifiedResource;

interface CreateRetainerInput {
  resourceId: number;
  commandId: string;
  actorUserId: number;
  clientId: number | null;
  projectId: number | null;
  denomination: "money" | "hours";
  amountCents: number | null;
  seconds: number | null;
  lockedRateCents: number | null;
  rateLockedAt: string | null;
  period: string | null;
  rollover: "carry" | "expire" | "cap" | null;
  expiresAt: string | null;
  onExhaustion: "block" | "warn" | "overflow";
  occurredAt: string;
}

interface UpdateRetainerInput {
  state?: "ongoing" | "closed";
  period?: string | null;
  rollover?: "carry" | "expire" | "cap" | null;
  expiresAt?: string | null;
  onExhaustion?: "block" | "warn" | "overflow";
  occurredAt: string;
}

type AppendRetainerLedgerInput = {
  id: string;
  retainerId: number;
  kind: "deposit" | "drawdown" | "expiry" | "reset" | "adjustment";
  invoiceId?: number | null;
  occurredOn: string;
  notes?: string | null;
  createdAt: string;
} & (
  | { amountCents: number; seconds?: never }
  | { amountCents?: never; seconds: number }
);

interface RetainerLedgerResource {
  id: string;
  retainerId: number;
  kind: string;
  unit: "cents" | "seconds";
  amount: number;
  invoiceId: number | null;
  occurredOn: string;
  notes: string | null;
  createdAt: string;
}

interface RecurringFixedLine {
  kind: string;
  description: string | null;
  quantity: number;
  unit_price_cents: number;
  taxed: boolean;
  taxed2: boolean;
  project_id: number | null;
}

type RecurringAmountConfig =
  | {
      schema_version: 1;
      type: "fixed_lines";
      line_items: RecurringFixedLine[];
    }
  | {
      schema_version: 1;
      type: "line_items_import";
      project_ids: number[];
      time?: { summary_type: "project" | "task" | "people" | "detailed" };
      expenses?: {
        summary_type: "project" | "category" | "people" | "detailed";
      };
    };

interface RecurringInput {
  resourceId?: number;
  commandId?: string;
  actorUserId?: number;
  clientId: number;
  subjectTemplate: string;
  notesTemplate: string;
  everyNMonths: number;
  dayOfMonth: number;
  nextIssueOn: string;
  amountConfig: RecurringAmountConfig;
  canDrawFromRetainerId: number | null;
  /**
   * The projects whose time this flat amount covers (#484).
   *
   * Null is the ordinary recurring invoice: a fixed amount that ignores tracked
   * time. A non-empty list makes it a banded engagement, and the named
   * projects' unbilled hours are claimed by the invoice rather than priced into
   * it -- so they stop reading as uninvoiced and cannot be billed twice.
   */
  claimsProjectIds: readonly number[] | null;
  /**
   * How much of the period the band takes (#707).
   *
   * `all` claims every unbilled hour on those projects. `ceiling` claims the
   * oldest hours up to a limit and leaves the overflow to be billed as
   * ordinary time and materials -- the limit being either a duration in
   * `claimCeilingSeconds` or billable value at list in `claimCeilingCents`,
   * exactly one of which is set.
   */
  claimMode: "all" | "ceiling";
  claimCeilingSeconds: number | null;
  claimCeilingCents: number | null;
  /**
   * Whether the band absorbs every tracked hour on those projects or only the
   * billable ones (#708). Under a fixed amount the client bought the period, so
   * "tracked" is the honest unit for a firm that logs internal work against the
   * client's project; "billable" is what every definition did before the
   * setting existed.
   */
  claimScope: "billable" | "tracked";
  /**
   * The cost share this engagement is read against (#710), in basis points --
   * 8000 is 80%. Null takes the organisation's default: deals differ, and a
   * single global number would be either too loose to catch anything or tight
   * enough to cry wolf.
   */
  costAlertBasisPoints: number | null;
  occurredAt: string;
}

interface InvoiceCommandResult {
  schema_version: 1;
  event_ids: string[];
  first_aggregate_sequence: number;
  event_count: number;
  invoice: object;
}

interface InvoiceCommandActor {
  type: InvoiceActorType;
  id: number | null;
}

interface LifecycleMessage {
  sentBy: string | null;
  sentByEmail: string | null;
  sentFrom: string | null;
  sentFromEmail: string | null;
  recipients: readonly Readonly<{ name: string; email: string }>[];
  subject: string | null;
  body: string | null;
  attachPdf: boolean;
  sendMeACopy: boolean;
  thankYou: boolean;
  reminder: boolean;
  sendReminderOn: string | null;
}

type InvoiceEdit =
  | {
      type: "header";
      clientId?: number;
      number?: string;
      subject?: string | null;
      purchaseOrder?: string | null;
      notes?: string | null;
      currency?: string;
      issueDate?: string;
      dueDate?: string;
      paymentTerms?:
        "upon_receipt" | "net_15" | "net_30" | "net_45" | "net_60" | "custom";
      projectId?: number | null;
      reminderPolicy?: Readonly<Record<string, unknown>> | null;
    }
  | { type: "payment_options"; paymentOptions: readonly string[] }
  | {
      type: "financials";
      taxRatePpm: number | null;
      tax2RatePpm: number | null;
      discountRatePpm: number | null;
    }
  | {
      type: "line_insert";
      lineId: number;
      position: number;
      kind: string;
      description?: string | null;
      quantity: number;
      unitPriceCents: number;
      amountCents: number;
      taxed?: boolean;
      taxed2?: boolean;
      projectId?: number | null;
    }
  | {
      type: "line_update";
      lineId: number;
      expectedLineUpdatedAt: string;
      position: number;
      kind: string;
      description?: string | null;
      quantity: number;
      unitPriceCents: number;
      amountCents: number;
      taxed: boolean;
      taxed2: boolean;
      projectId?: number | null;
    }
  | { type: "line_delete"; lineId: number; expectedLineUpdatedAt: string };

interface CommonCommand {
  invoiceId: number;
  commandId: string;
  actor: InvoiceCommandActor;
  occurredAt: string;
  authorize: (
    actor: InvoiceCommandActor,
    invoiceId: number,
  ) => boolean | Promise<boolean>;
}

export type InvoiceState = "draft" | "open" | "paid" | "closed";

const invoiceStates: readonly InvoiceState[] = ["draft", "open", "paid", "closed"];

export interface InvoiceCursorWindow extends CursorWindow {
  states?: readonly InvoiceState[];
  clientIds?: readonly number[];
}

export interface RetainerCursorWindow extends CursorWindow {
  clientIds?: readonly number[];
}

/**
 * The `state` query parameter: a comma-separated set, also accepted repeated.
 * Absent means every state, which is what this endpoint answered before it
 * could be asked anything else, so an existing caller sees no change.
 *
 * Deduplicated, because `state=open,open` would otherwise put the same
 * placeholder in the IN list twice. Unknown values are rejected rather than
 * ignored: a typo that silently widens the answer back to the whole book is
 * the exact failure this parameter exists to prevent.
 */
const invoiceStateFilter = (
  requestUrl: URL,
): readonly InvoiceState[] | undefined => {
  const raw = requestUrl.searchParams.getAll("state");
  if (raw.length === 0) return undefined;
  const wanted = new Set<InvoiceState>();
  for (const value of raw.flatMap((entry) => entry.split(","))) {
    if (!(invoiceStates as readonly string[]).includes(value)) {
      throw validationError([
        {
          field: "state",
          code: "invalid",
          message: `state must be one or more of ${invoiceStates.join(", ")}`,
        },
      ]);
    }
    wanted.add(value as InvoiceState);
  }
  return [...wanted];
};

/**
 * The `client_id` query parameter, read the same way `state` is: a
 * comma-separated set, also accepted repeated, absent meaning every client.
 *
 * A set rather than one id because the caller this exists for is a client 360,
 * which is a rollup over a subtree -- it holds every id in the tree at once, and
 * one request per node would put a holding company's whole hierarchy on the
 * wire one row at a time.
 *
 * Deduplicated for the same reason states are, and anything that is not a
 * positive integer is rejected rather than dropped: an id silently discarded
 * would widen the answer to a set the caller did not ask for, which on a money
 * endpoint is another client's book.
 */
const clientIdFilter = (requestUrl: URL): readonly number[] | undefined => {
  const raw = requestUrl.searchParams.getAll("client_id");
  if (raw.length === 0) return undefined;
  const wanted = new Set<number>();
  for (const value of raw.flatMap((entry) => entry.split(","))) {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw validationError([
        {
          field: "client_id",
          code: "invalid",
          message: "client_id must be one or more positive integer client ids",
        },
      ]);
    }
    wanted.add(Number(value));
  }
  return [...wanted];
};

interface MoneyResourceService {
  /** Null for an empty collection -- see CursorSource, which cursorPage reads. */
  highWatermark(
    kind: "invoices" | "estimates" | "retainers" | "recurring-invoices",
  ): Promise<number | null>;
  listInvoices(window: InvoiceCursorWindow): Promise<InvoiceResource[]>;
  getInvoice(id: number): Promise<InvoiceResource | null>;
  getInvoiceDeliveryContext(id: number): Promise<InvoiceDeliveryContext | null>;
  listInvoiceDeliveryJobs(eventId: string): Promise<InvoiceDeliveryJob[]>;
  listEstimates(window: CursorWindow): Promise<EstimateResource[]>;
  getEstimate(id: number): Promise<EstimateResource | null>;
  listEstimateMessages(
    estimateId: number,
  ): Promise<EstimateMessageResource[] | null>;
  executeEstimateMessage(input: EstimateMessageCommandInput): Promise<{
    estimate: EstimateResource;
    message: EstimateMessageResource;
  }>;
  convertEstimate(input: EstimateConversionInput): Promise<{
    invoice: InvoiceResource;
    event: EstimateMessageResource;
  }>;
  listMessages(invoiceId: number): Promise<InvoiceMessageResource[] | null>;
  listPayments(invoiceId: number): Promise<InvoicePaymentResource[] | null>;
  senderSnapshot(
    userId: number,
  ): Promise<{ name: string; email: string | null } | null>;
  executeLifecycle(
    input: CommonCommand & {
      command: InvoiceLifecycleCommand;
      expectedVersion?: number;
      messageId: number;
      eventId: string;
      message?: LifecycleMessage;
      delivery?: {
        templateVersion: number;
        senderIdentityId: number;
        senderIdentityVersion: number;
        senderEvidenceVersion: number;
        fromName: string;
        fromEmail: string;
        replyToEmail: string | null;
        subject: string;
        textBody: string;
        htmlBody: string | null;
        recipients: readonly { deliveryId: number; name: string; email: string }[];
      };
    },
  ): Promise<InvoiceCommandResult>;
  executeEdit(
    input: CommonCommand & {
      expectedVersion: number;
      eventIds: readonly string[];
      edit: InvoiceEdit;
    },
  ): Promise<InvoiceCommandResult>;
  recordPayment(
    input: CommonCommand & {
      expectedVersion: number;
      eventIds: readonly string[];
      payment: {
        type: "manual";
        id: number;
        currency: string;
        amountCents: number;
        paidAt: string | null;
        paidDate: string | null;
        notes?: string | null;
        recordedByUserId?: number | null;
      };
    },
  ): Promise<InvoiceCommandResult>;
  updatePayment(
    input: CommonCommand & {
      expectedVersion: number;
      eventIds: readonly string[];
      paymentId: number;
      expectedPaymentUpdatedAt: string;
      amountCents: number;
      paidAt: string | null;
      paidDate: string | null;
      notes?: string | null;
      recordedByUserId?: number | null;
    },
  ): Promise<InvoiceCommandResult>;
  deletePayment(
    input: CommonCommand & {
      expectedVersion: number;
      eventIds: readonly string[];
      paymentId: number;
      expectedPaymentUpdatedAt: string;
    },
  ): Promise<InvoiceCommandResult>;
  listRetainers(window: RetainerCursorWindow): Promise<RetainerResource[]>;
  getRetainer(id: number): Promise<RetainerResource | null>;
  createRetainer(input: CreateRetainerInput): Promise<RetainerResource>;
  updateRetainer(
    id: number,
    input: UpdateRetainerInput,
  ): Promise<RetainerResource | null>;
  listRetainerLedger(
    retainerId: number,
  ): Promise<RetainerLedgerResource[] | null>;
  appendRetainerLedger(input: AppendRetainerLedgerInput): Promise<{
    entry: RetainerLedgerResource;
    balance: number;
    denomination: "money" | "hours";
  }>;
  listRecurring(window: CursorWindow): Promise<RecurringResource[]>;
  getRecurring(id: number): Promise<RecurringResource | null>;
  createRecurring(input: RecurringInput): Promise<RecurringResource>;
  updateRecurring(
    id: number,
    input: RecurringInput,
  ): Promise<RecurringResource | null>;
  deleteRecurring(id: number): Promise<boolean>;
}

export type InvoiceGenerationTimeSummary =
  "project" | "task" | "people" | "detailed";

export type InvoiceGenerationExpenseSummary =
  "project" | "category" | "people" | "detailed";

export interface InvoiceGenerationRequest {
  clientId: number;
  from: string;
  to: string;
  projectIds: readonly number[];
  timeSummaryType: InvoiceGenerationTimeSummary | null;
  expenseSummaryType: InvoiceGenerationExpenseSummary | null;
}

export interface InvoiceGenerationCommand {
  commandId: string;
  principal: UserPrincipal;
  request: InvoiceGenerationRequest;
}

/** Implemented by #50; this API story only owns validation and delegation. */
export interface InvoiceGenerationPort {
  generate(input: InvoiceGenerationCommand): Promise<InvoiceResource>;
}

/**
 * Issues the invoice a recurring definition is due for. Implemented by the
 * engine in `@ezacto/db`, which this package does not depend on -- so the port
 * is declared here for the same reason `InvoiceGenerationPort` is.
 */
export interface RecurringGenerationPort {
  generate(
    definitionId: number,
    asOfDate: string,
    // Tagged because the engine writes the tag into the command ledger as
    // `actor_type`, and the untagged shape this port used to declare would
    // reach the engine as neither branch. A route always has a user; the
    // scheduled pass, which is the other writer, does not go through here.
    principal: { type: "user"; userId: number; profile: string },
  ): Promise<{
    invoiceId: number;
    definitionId: number;
    period: string;
    nextIssueOn: string;
    retainerDrawdownCents: number | null;
  }>;
}

/**
 * Filling in the claims a band was issued too early to make (#712).
 *
 * A port rather than a direct call, like every other engine this module
 * reaches: the API package holds no dependency on the database package, and the
 * seam is the shape both sides agree on.
 *
 * `apply` is the caller's, and defaults to false everywhere -- the figures this
 * moves are large enough that nobody should approve them from a description.
 */
export interface BandClaimBackfillPort {
  backfill(input: {
    invoiceIds: readonly number[];
    projectIds: readonly number[];
    actorUserId: number;
    runId: string;
    occurredAt: string;
    recurringInvoiceId: number | null;
    apply: boolean;
  }): Promise<{
    runId: string;
    applied: boolean;
    invoices: readonly {
      invoiceId: number;
      number: string;
      issueDate: string;
      state: string;
      amountCents: number;
      entryCount: number;
      seconds: number;
      billableValueCents: number;
      entriesWithoutBillableRate: number;
      foregoneBillableCents: number;
    }[];
    remainingEntryCount: number;
    remainingSeconds: number;
  }>;
}

export interface MoneyResourceRouteOptions {
  service: MoneyResourceService;
  cursorSigningKey: Uint8Array;
  clock?: () => string;
  generation?: InvoiceGenerationPort;
  recurringGeneration?: RecurringGenerationPort;
  bandClaimBackfill?: BandClaimBackfillPort;
  invoiceDelivery?: {
    configuration: Pick<
      EmailConfigurationService,
      "getTemplate" | "getSenderIdentity" | "listSenderIdentities"
    >;
    mailer: SenderBoundQueuedMailer;
  };
  /**
   * Where this invoice can be paid online, resolved just before the email body
   * is composed (#102).
   *
   * Optional, and its absence is ordinary: a deployment with no Stripe key
   * simply sends the invoice it always sent. It returns null rather than
   * throwing for an invoice that cannot have one -- nothing owed, or no
   * provider -- because failing to mint a convenience must never be why an
   * invoice does not go out.
   */
  invoicePaymentUrl?: (invoiceId: number) => Promise<string | null>;
}

type ResolvedMoneyResourceRouteOptions = Omit<
  MoneyResourceRouteOptions,
  "clock"
> & {
  clock: () => string;
};

interface InvoiceOutboxEvent {
  id: string;
  eventType: string;
  /**
   * The invoice this event is about. Already what the outbox record carries for
   * an invoice event, so the document port is given the id the drain already
   * has rather than a second name for the same thing.
   */
  aggregateId: number;
}

/**
 * Prepares the document that goes with an invoice message (issue 626).
 *
 * A port rather than an implementation, because rendering a PDF and writing it
 * to object storage are the entry's concerns -- this package knows what an
 * invoice message is, not what a bucket is. It answers with a reference, never
 * bytes: the job it lands on is serialised onto a queue with a 128 KB ceiling.
 *
 * `null` means nothing is attached, which is the ordinary answer whenever the
 * preference says so.
 */
export interface InvoiceDocumentPort {
  /**
   * Every file this message carries, in the order they should appear. A list
   * rather than one, because an invoice can go out with its own document and
   * with what an operator staged against it -- a purchase order, a signed
   * order form -- and those are separate choices.
   */
  prepare(input: {
    readonly invoiceId: number;
    readonly invoiceMessageId: number;
  }): Promise<readonly EmailAttachmentRef[]>;
}

/** Subscriber registration used by both runtimes; provider I/O remains in the queue consumer. */
export const createInvoiceEmailOutboxSubscriber = (
  service: Pick<MoneyResourceService, "listInvoiceDeliveryJobs">,
  mailer?: SenderBoundQueuedMailer,
  documents?: InvoiceDocumentPort,
): {
  readonly id: "invoice_email";
  deliver(event: Readonly<InvoiceOutboxEvent>): Promise<void>;
} => ({
  id: "invoice_email",
  async deliver(event) {
    if (event.eventType !== "invoice.sent") return;
    const jobs = await service.listInvoiceDeliveryJobs(event.id);
    if (jobs.length > 0 && mailer?.enqueuePersisted === undefined) {
      throw new Error("invoice email durable enqueue is unavailable");
    }
    // One document per message, prepared once however many recipients the
    // message has. Each recipient is its own delivery and its own queue job,
    // and rendering per recipient would put several identical objects in the
    // bucket for one send.
    const seen = new Map<number, readonly EmailAttachmentRef[]>();
    for (const job of jobs) {
      if (documents !== undefined && !seen.has(job.invoiceMessageId)) {
        seen.set(
          job.invoiceMessageId,
          await documents.prepare({
            invoiceId: event.aggregateId,
            invoiceMessageId: job.invoiceMessageId,
          }),
        );
      }
      const attachments = seen.get(job.invoiceMessageId) ?? [];
      await mailer!.enqueuePersisted!(
        job.deliveryId,
        {
          senderIdentityId: job.senderIdentityId,
          senderIdentityVersion: job.senderIdentityVersion,
          senderEvidenceVersion: job.senderEvidenceVersion,
          from: { email: job.fromEmail, name: job.fromName },
          ...(job.replyToEmail === null
            ? {}
            : { replyTo: [{ email: job.replyToEmail }] }),
        },
        {
          to: [
            job.recipientName === ""
              ? { email: job.recipientEmail }
              : { email: job.recipientEmail, name: job.recipientName },
          ],
          template: `invoice:${job.templateVersion}`,
          subject: job.subject,
          text: job.textBody,
          ...(job.htmlBody === null ? {} : { html: job.htmlBody }),
          related: { type: "invoice_message", id: job.invoiceMessageId },
        },
        attachments.length === 0 ? undefined : attachments,
      );
    }
  },
});

const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const paymentTerms = [
  "upon_receipt",
  "net_15",
  "net_30",
  "net_45",
  "net_60",
  "custom",
] as const;
const paymentOptions = [
  "stripe_checkout",
  "paypal_checkout",
  "quickbooks_checkout",
  "mercury_transfer",
  "wise_transfer",
] as const;
const lifecycleCommands = [
  "send",
  "draft",
  "cancel",
  "write_off",
  "reopen",
] as const;
const timeSummaryTypes = ["project", "task", "people", "detailed"] as const;
const expenseSummaryTypes = [
  "project",
  "category",
  "people",
  "detailed",
] as const;

const requireRead = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): UserPrincipal => {
  requireApiScope(context, "invoices:read");
  return context.get("principal");
};

const requireWrite = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): UserPrincipal => {
  requireApiScope(context, "invoices:write");
  return context.get("principal");
};

const idempotencyKey = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): string => {
  const value = context.req.header("idempotency-key");
  if (value === undefined || !commandIdPattern.test(value)) {
    throw validationError([
      {
        field: "Idempotency-Key",
        code: value === undefined ? "required" : "invalid_command_id",
        message:
          "Idempotency-Key must use 1-128 ASCII letters, digits, dot, underscore, colon, or dash.",
      },
    ]);
  }
  return value;
};

const stableDigest = async (
  ...parts: readonly (string | number)[]
): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(parts.join("\u001f")),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const stableId = async (
  namespace: string,
  parentId: number,
  commandId: string,
): Promise<number> => {
  const digest = await stableDigest(namespace, parentId, commandId);
  return Number.parseInt(digest.slice(0, 13), 16) + 1;
};

const eventIds = async (
  invoiceId: number,
  commandId: string,
): Promise<[string, string]> => {
  const digest = await stableDigest("invoice-event", invoiceId, commandId);
  return [`evt_${digest.slice(0, 32)}_0`, `evt_${digest.slice(32)}_1`];
};

const stringValue = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
  options: { required?: boolean; nullable?: boolean; max?: number } = {},
): string | null | undefined => {
  if (!Object.hasOwn(body, field)) {
    if (options.required === true)
      errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  const value = body[field];
  if (value === null && options.nullable === true) return null;
  if (typeof value !== "string" || value.length > (options.max ?? 100_000)) {
    errors.push({
      field,
      code: "invalid_string",
      message: `${field} must be a bounded string${options.nullable === true ? " or null" : ""}`,
    });
    return undefined;
  }
  return value;
};

const integerValue = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
  options: {
    required?: boolean;
    nullable?: boolean;
    minimum?: number;
    maximum?: number;
  } = {},
): number | null | undefined => {
  if (!Object.hasOwn(body, field)) {
    if (options.required === true)
      errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  const value = body[field];
  if (value === null && options.nullable === true) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (options.minimum ?? Number.MIN_SAFE_INTEGER) ||
    (value as number) > (options.maximum ?? Number.MAX_SAFE_INTEGER)
  ) {
    errors.push({
      field,
      code: "invalid_integer",
      message: `${field} must be a bounded integer${options.nullable === true ? " or null" : ""}`,
    });
    return undefined;
  }
  return value as number;
};

const booleanValue = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
  fallback?: boolean,
): boolean | undefined => {
  if (!Object.hasOwn(body, field)) return fallback;
  if (typeof body[field] !== "boolean") {
    errors.push({
      field,
      code: "invalid_boolean",
      message: `${field} must be a boolean`,
    });
    return undefined;
  }
  return body[field] as boolean;
};

const enumValue = <Value extends string>(
  body: JsonObject,
  field: string,
  values: readonly Value[],
  errors: FieldError[],
  required = false,
): Value | undefined => {
  if (!Object.hasOwn(body, field)) {
    if (required)
      errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  const value = body[field];
  if (typeof value !== "string" || !values.includes(value as Value)) {
    errors.push({
      field,
      code: "unsupported",
      message: `${field} must be one of ${values.join(", ")}`,
    });
    return undefined;
  }
  return value as Value;
};

const nullableEnumValue = <Value extends string>(
  body: JsonObject,
  field: string,
  values: readonly Value[],
  errors: FieldError[],
): Value | null | undefined => {
  if (!Object.hasOwn(body, field)) {
    errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  if (body[field] === null) return null;
  return enumValue(body, field, values, errors);
};

const dateValue = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
  options: { required?: boolean; nullable?: boolean } = {},
): string | null | undefined => {
  if (!Object.hasOwn(body, field)) {
    if (options.required === true)
      errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  if (body[field] === null && options.nullable === true) return null;
  if (
    typeof body[field] !== "string" ||
    !isCanonicalDate(body[field] as string)
  ) {
    errors.push({
      field,
      code: "invalid_date",
      message: `${field} must be a real canonical date${options.nullable === true ? " or null" : ""}`,
    });
    return undefined;
  }
  return body[field] as string;
};

const timestampValue = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
  options: { required?: boolean; nullable?: boolean } = {},
): string | null | undefined => {
  if (!Object.hasOwn(body, field)) {
    if (options.required === true)
      errors.push({ field, code: "required", message: `${field} is required` });
    return undefined;
  }
  if (body[field] === null && options.nullable === true) return null;
  if (
    typeof body[field] !== "string" ||
    !isCanonicalTimestamp(body[field] as string)
  ) {
    errors.push({
      field,
      code: "invalid_timestamp",
      message: `${field} must be a real canonical UTC timestamp${options.nullable === true ? " or null" : ""}`,
    });
    return undefined;
  }
  return body[field] as string;
};

const commonCommand = (
  principal: UserPrincipal,
  invoiceId: number,
  commandId: string,
  occurredAt: string,
): CommonCommand => ({
  invoiceId,
  commandId,
  occurredAt,
  actor: { type: "user", id: principal.userId },
  authorize: (actor) => actor.type === "user" && actor.id === principal.userId,
});

const expectedVersion = (
  body: JsonObject,
  errors: FieldError[],
): number | undefined =>
  integerValue(body, "expected_version", errors, {
    required: true,
    minimum: 0,
  }) as number | undefined;

const notFound = (label: string): ApiError =>
  new ApiError({
    status: 404,
    code: "not_found",
    message: `The requested ${label} does not exist.`,
  });

const translateMoneyError = (error: unknown): never => {
  if (error instanceof ApiError) throw error;
  const code =
    isJsonObject(error) && typeof error.code === "string" ? error.code : null;
  const databaseMessage =
    isJsonObject(error) && typeof error.message === "string"
      ? error.message
      : "";
  if (code === "forbidden") {
    throw new ApiError({
      status: 403,
      code: "profile_forbidden",
      message: "The acting user cannot mutate this invoice.",
    });
  }
  if (code === "invoice_not_found") throw notFound("invoice");
  if (code === "estimate_not_found") throw notFound("estimate");
  if (code === "definition_not_found") throw notFound("recurring invoice");
  if (code === "not_due") {
    // Not an error in the request -- the caller asked early. 409 so a retry
    // after the due date is the obvious next move, and the message carries it.
    throw new ApiError({
      status: 409,
      code,
      message:
        databaseMessage === ""
          ? "The recurring definition is not due yet."
          : databaseMessage,
    });
  }
  if (code === "already_generated") {
    throw new ApiError({
      status: 409,
      code,
      message: "This period has already been generated for this definition.",
    });
  }
  if (code === "invalid_command_input") {
    throw validationError([
      {
        field: "command",
        code,
        message:
          databaseMessage === ""
            ? "The invoice generation request is not valid."
            : databaseMessage,
      },
    ]);
  }
  if (
    code === "invoice_version_conflict" ||
    code === "estimate_version_conflict" ||
    code === "estimate_state_conflict" ||
    code === "estimate_already_converted" ||
    code === "trigger_row_conflict" ||
    code === "command_id_reused" ||
    code === "command_incomplete" ||
    code === "generation_conflict" ||
    code === "command_storage_conflict"
  ) {
    throw new ApiError({
      status: 409,
      code,
      message: "The financial command conflicts with current state.",
    });
  }
  if (
    /FOREIGN KEY|UNIQUE constraint|constraint failed|retainer balance cannot overdraw|retainer ledger .* guard/i.test(
      databaseMessage,
    )
  ) {
    throw new ApiError({
      status: 409,
      code: "resource_conflict",
      message: "The financial resource conflicts with related state.",
    });
  }
  if (
    code !== null ||
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    throw validationError([
      {
        field: "command",
        code: code ?? "invalid",
        message: "The financial command is not valid for the current document.",
      },
    ]);
  }
  throw error;
};

const invoiceEnvelope = async (
  service: MoneyResourceService,
  invoiceId: number,
  result: InvoiceCommandResult,
) => {
  const invoice = await service.getInvoice(invoiceId);
  if (invoice === null) throw notFound("invoice");
  return {
    data: { invoice, command: result },
    links: { self: `/api/v1/invoices/${invoiceId}` },
  };
};

const serializeRetainerLedgerEntry = (
  entry: Readonly<RetainerLedgerResource>,
) => ({
  id: entry.id,
  retainer_id: entry.retainerId,
  kind: entry.kind,
  unit: entry.unit,
  amount: entry.amount,
  invoice_id: entry.invoiceId,
  occurred_on: entry.occurredOn,
  notes: entry.notes,
  created_at: entry.createdAt,
});

const parseGenerationRequest = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<InvoiceGenerationRequest> => {
  const body = await readObjectBody(context);
  const errors = unknownFieldErrors(
    body,
    new Set([
      "client_id",
      "from",
      "to",
      "project_ids",
      "time_summary_type",
      "expense_summary_type",
    ]),
  );
  const clientId = integerValue(body, "client_id", errors, {
    required: true,
    minimum: 1,
  });
  const from = dateValue(body, "from", errors, { required: true });
  const to = dateValue(body, "to", errors, { required: true });
  if (typeof from === "string" && typeof to === "string" && from > to) {
    errors.push({
      field: "to",
      code: "inverted_range",
      message: "to must be on or after from",
    });
  }

  const projectIds = body.project_ids;
  if (
    !Array.isArray(projectIds) ||
    projectIds.length === 0 ||
    projectIds.length > 10_000 ||
    projectIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(projectIds).size !== projectIds.length
  ) {
    errors.push({
      field: "project_ids",
      code: "invalid_project_selection",
      message: "project_ids must be a non-empty unique array of positive ids",
    });
  }
  const timeSummaryType = nullableEnumValue(
    body,
    "time_summary_type",
    timeSummaryTypes,
    errors,
  );
  const expenseSummaryType = nullableEnumValue(
    body,
    "expense_summary_type",
    expenseSummaryTypes,
    errors,
  );
  if (timeSummaryType === null && expenseSummaryType === null) {
    errors.push({
      field: "summary_types",
      code: "one_required",
      message:
        "time_summary_type or expense_summary_type must select generation content",
    });
  }
  assertFields(errors);
  return {
    clientId: clientId!,
    from: from!,
    to: to!,
    projectIds: projectIds as number[],
    timeSummaryType: timeSummaryType!,
    expenseSummaryType: expenseSummaryType!,
  };
};

const installGeneration = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: MoneyResourceRouteOptions,
): void => {
  api.post("/invoice-generations", async (context) => {
    const principal = requireWrite(context);
    const commandId = idempotencyKey(context);
    const request = await parseGenerationRequest(context);
    if (options.generation === undefined) {
      throw new ApiError({
        status: 503,
        code: "service_unavailable",
        message: "Invoice generation is not available in this deployment.",
      });
    }
    let invoice: InvoiceResource;
    try {
      invoice = await options.generation.generate({
        commandId,
        principal,
        request,
      });
    } catch (error) {
      return translateMoneyError(error);
    }
    return context.json(
      {
        data: invoice,
        links: { self: `/api/v1/invoices/${invoice.id}` },
      },
      201,
    );
  });
};

const parseRecipients = (
  body: JsonObject,
  errors: FieldError[],
): Array<{ name: string; email: string }> => {
  if (!Object.hasOwn(body, "recipients")) return [];
  const recipients = body.recipients;
  if (!Array.isArray(recipients) || recipients.length > 1_000) {
    errors.push({
      field: "recipients",
      code: "invalid_array",
      message: "recipients must be a bounded array",
    });
    return [];
  }
  return recipients.flatMap((recipient, index) => {
    if (
      !isJsonObject(recipient) ||
      Object.keys(recipient).some(
        (field) => field !== "name" && field !== "email",
      ) ||
      typeof recipient.name !== "string" ||
      recipient.name.length > 1_000 ||
      typeof recipient.email !== "string" ||
      recipient.email.length < 3 ||
      recipient.email.length > 320
    ) {
      errors.push({
        field: `recipients[${index}]`,
        code: "invalid_recipient",
        message: "each recipient requires exact bounded name and email strings",
      });
      return [];
    }
    return [{ name: recipient.name, email: recipient.email }];
  });
};

const deliveryEmailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;

const parseDeliveryRecipients = (
  body: JsonObject,
  errors: FieldError[],
): Array<{ name: string; email: string }> => {
  const parsed = parseRecipients(body, errors);
  if (parsed.length === 0) {
    errors.push({
      field: "recipients",
      code: "required",
      message: "at least one recipient is required",
    });
  }
  const seen = new Set<string>();
  return parsed.flatMap((recipient, index) => {
    const name = recipient.name.normalize("NFC").trim();
    const email = recipient.email.normalize("NFC").trim().toLowerCase();
    if (
      name.length > 200 ||
      email.length > 254 ||
      !deliveryEmailPattern.test(email)
    ) {
      errors.push({
        field: `recipients[${index}]`,
        code: "invalid_email",
        message: "recipient must contain a valid bounded email address",
      });
      return [];
    }
    if (seen.has(email)) {
      errors.push({
        field: `recipients[${index}]`,
        code: "duplicate",
        message: "recipient email addresses must be unique",
      });
      return [];
    }
    seen.add(email);
    return [{ name, email }];
  });
};

const installInvoiceReads = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.get("/invoices", async (context) => {
    const principal = requireRead(context);
    const requestUrl = new URL(context.req.url);
    const states = invoiceStateFilter(requestUrl);
    const clientIds = clientIdFilter(requestUrl);
    return context.json(
      await cursorPage({
        requestUrl,
        cursorSigningKey: options.cursorSigningKey,
        viewer: principal,
        serializer: (invoice: Readonly<InvoiceResource>) => ({ ...invoice }),
        source: {
          // The watermark stays the whole collection's. It bounds the
          // traversal against later inserts; it is not a count of what
          // matches, and narrowing it to the filtered set would make the
          // cursor mean something different on each page.
          highWatermark: () => options.service.highWatermark("invoices"),
          list: (window) =>
            options.service.listInvoices({
              ...window,
              ...(states === undefined ? {} : { states }),
              ...(clientIds === undefined ? {} : { clientIds }),
            }),
        },
      }),
    );
  });
  api.get("/invoices/:id", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "invoice");
    const invoice = await options.service.getInvoice(id);
    if (invoice === null) throw notFound("invoice");
    return context.json({
      data: invoice,
      links: { self: `/api/v1/invoices/${id}` },
    });
  });
  api.get("/invoices/:id/messages", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "invoice");
    const messages = await options.service.listMessages(id);
    if (messages === null) throw notFound("invoice");
    return context.json({
      data: messages,
      links: { self: `/api/v1/invoices/${id}/messages` },
    });
  });
  api.get("/invoices/:id/payments", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "invoice");
    const payments = await options.service.listPayments(id);
    if (payments === null) throw notFound("invoice");
    return context.json({
      data: payments,
      links: { self: `/api/v1/invoices/${id}/payments` },
    });
  });
};

const installEstimates = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.get("/estimates", async (context) => {
    const principal = requireRead(context);
    return context.json(
      await cursorPage({
        requestUrl: new URL(context.req.url),
        cursorSigningKey: options.cursorSigningKey,
        viewer: principal,
        serializer: (estimate: Readonly<EstimateResource>) => ({ ...estimate }),
        source: {
          highWatermark: () => options.service.highWatermark("estimates"),
          list: (window) => options.service.listEstimates(window),
        },
      }),
    );
  });

  api.get("/estimates/:id", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "estimate");
    const estimate = await options.service.getEstimate(id);
    if (estimate === null) throw notFound("estimate");
    return context.json({
      data: estimate,
      links: { self: `/api/v1/estimates/${id}` },
    });
  });

  api.get("/estimates/:id/messages", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "estimate");
    const messages = await options.service.listEstimateMessages(id);
    if (messages === null) throw notFound("estimate");
    return context.json({
      data: messages,
      links: { self: `/api/v1/estimates/${id}/messages` },
    });
  });

  api.post("/estimates/:id/messages", async (context) => {
    const principal = requireWrite(context);
    const estimateId = resourceId(context.req.param("id"), "estimate");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set([
        "expected_version",
        "event_type",
        "recipients",
        "subject",
        "body",
        "send_me_a_copy",
      ]),
    );
    const version = expectedVersion(body, errors);
    const eventType = enumValue(
      body,
      "event_type",
      ["send", "accept", "decline", "re-open"] as const,
      errors,
      true,
    );
    const recipients = parseRecipients(body, errors);
    if (eventType === "send" && recipients.length === 0) {
      errors.push({
        field: "recipients",
        code: "required",
        message: "send requires at least one recipient",
      });
    }
    const subject =
      stringValue(body, "subject", errors, { nullable: true }) ?? null;
    const messageBody =
      stringValue(body, "body", errors, { nullable: true }) ?? null;
    const sendMeACopy =
      booleanValue(body, "send_me_a_copy", errors, false) ?? false;
    assertFields(errors);
    const sender = await options.service.senderSnapshot(principal.userId);
    if (sender === null) {
      throw new ApiError({
        status: 403,
        code: "principal_unavailable",
        message: "The acting user is no longer available.",
      });
    }
    try {
      const result = await options.service.executeEstimateMessage({
        estimateId,
        commandId,
        actorUserId: principal.userId,
        messageId: await stableId("estimate-message", estimateId, commandId),
        expectedVersion: version!,
        eventType: eventType!,
        sentBy: sender.name,
        sentByEmail: sender.email,
        sentFrom: sender.name,
        sentFromEmail: sender.email,
        recipients,
        subject,
        body: messageBody,
        sendMeACopy,
        occurredAt: options.clock(),
      });
      return context.json(
        {
          data: result,
          links: {
            self: `/api/v1/estimates/${estimateId}`,
            messages: `/api/v1/estimates/${estimateId}/messages`,
          },
        },
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.post("/estimates/:id/convert", async (context) => {
    const principal = requireWrite(context);
    const estimateId = resourceId(context.req.param("id"), "estimate");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set([
        "expected_version",
        "number",
        "issue_date",
        "due_date",
        "payment_terms",
      ]),
    );
    const version = expectedVersion(body, errors);
    const number = stringValue(body, "number", errors, {
      required: true,
      max: 255,
    });
    if (typeof number === "string" && number.trim().length === 0) {
      errors.push({
        field: "number",
        code: "nonblank",
        message: "number must be nonblank",
      });
    }
    const issueDate = dateValue(body, "issue_date", errors, { required: true });
    const dueDate = dateValue(body, "due_date", errors, { required: true });
    if (
      typeof issueDate === "string" &&
      typeof dueDate === "string" &&
      dueDate < issueDate
    ) {
      errors.push({
        field: "due_date",
        code: "before_issue_date",
        message: "due_date cannot precede issue_date",
      });
    }
    const terms = enumValue(body, "payment_terms", paymentTerms, errors, true);
    assertFields(errors);
    try {
      const invoiceId = await stableId(
        "estimate-invoice",
        estimateId,
        commandId,
      );
      const result = await options.service.convertEstimate({
        estimateId,
        commandId,
        invoiceId,
        messageId: await stableId(
          "estimate-invoice-event",
          estimateId,
          commandId,
        ),
        eventId: (await eventIds(invoiceId, commandId))[0],
        expectedVersion: version!,
        createdByUserId: principal.userId,
        number: number!,
        issueDate: issueDate!,
        dueDate: dueDate!,
        paymentTerms: terms!,
        occurredAt: options.clock(),
      });
      return context.json(
        {
          data: result,
          links: {
            self: `/api/v1/invoices/${result.invoice.id}`,
            estimate: `/api/v1/estimates/${estimateId}`,
          },
        },
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });
};

const headerFields = new Set([
  "expected_version",
  "client_id",
  "number",
  "subject",
  "purchase_order",
  "notes",
  "currency",
  "issue_date",
  "due_date",
  "payment_terms",
  "project_id",
  "retainer_id",
  "reminder_policy",
  "payment_options",
  "tax_rate_ppm",
  "tax2_rate_ppm",
  "discount_rate_ppm",
]);

const parseInvoiceEdit = (
  body: JsonObject,
): { expectedVersion: number; edit: InvoiceEdit } => {
  const errors = unknownFieldErrors(body, headerFields);
  const version = expectedVersion(body, errors);
  const documentKeys = [
    "client_id",
    "number",
    "subject",
    "purchase_order",
    "notes",
    "currency",
    "issue_date",
    "due_date",
    "payment_terms",
    "project_id",
    "retainer_id",
    "reminder_policy",
  ].filter((key) => Object.hasOwn(body, key));
  const optionKeys = Object.hasOwn(body, "payment_options") ? 1 : 0;
  const financialKeys = [
    "tax_rate_ppm",
    "tax2_rate_ppm",
    "discount_rate_ppm",
  ].filter((key) => Object.hasOwn(body, key));
  if (
    [documentKeys.length > 0, optionKeys > 0, financialKeys.length > 0].filter(
      Boolean,
    ).length !== 1
  ) {
    errors.push({
      field: "body",
      code: "one_edit_kind",
      message:
        "change exactly one of header fields, payment_options, or the complete financial rate set",
    });
  }

  let edit: InvoiceEdit;
  if (optionKeys > 0) {
    const value = body.payment_options;
    if (
      !Array.isArray(value) ||
      value.some(
        (item) =>
          typeof item !== "string" || !paymentOptions.includes(item as never),
      ) ||
      new Set(value).size !== value.length
    ) {
      errors.push({
        field: "payment_options",
        code: "invalid_options",
        message: `payment_options must be a unique array of ${paymentOptions.join(", ")}`,
      });
    }
    edit = {
      type: "payment_options",
      paymentOptions: Array.isArray(value) ? (value as string[]) : [],
    };
  } else if (financialKeys.length > 0) {
    if (financialKeys.length !== 3)
      errors.push({
        field: "financials",
        code: "complete_set_required",
        message: "all three rate fields are required together",
      });
    edit = {
      type: "financials",
      taxRatePpm:
        integerValue(body, "tax_rate_ppm", errors, {
          required: true,
          nullable: true,
          minimum: 0,
          maximum: 1_000_000,
        }) ?? null,
      tax2RatePpm:
        integerValue(body, "tax2_rate_ppm", errors, {
          required: true,
          nullable: true,
          minimum: 0,
          maximum: 1_000_000,
        }) ?? null,
      discountRatePpm:
        integerValue(body, "discount_rate_ppm", errors, {
          required: true,
          nullable: true,
          minimum: 0,
          maximum: 1_000_000,
        }) ?? null,
    };
  } else {
    const reminder = body.reminder_policy;
    if (
      Object.hasOwn(body, "reminder_policy") &&
      reminder !== null &&
      !isJsonObject(reminder)
    ) {
      errors.push({
        field: "reminder_policy",
        code: "invalid_object",
        message: "reminder_policy must be an object or null",
      });
    }
    if (
      Object.hasOwn(body, "number") &&
      typeof body.number === "string" &&
      !body.number.trim()
    ) {
      errors.push({
        field: "number",
        code: "non_blank_required",
        message: "number must contain a non-whitespace character",
      });
    }
    edit = {
      type: "header",
      ...(Object.hasOwn(body, "client_id")
        ? {
            clientId: integerValue(body, "client_id", errors, {
              required: true,
              minimum: 1,
            }) as number,
          }
        : {}),
      ...(Object.hasOwn(body, "number")
        ? {
            number: stringValue(body, "number", errors, {
              required: true,
              max: 255,
            }) as string,
          }
        : {}),
      ...(Object.hasOwn(body, "subject")
        ? {
            subject: stringValue(body, "subject", errors, {
              nullable: true,
            }) as string | null,
          }
        : {}),
      ...(Object.hasOwn(body, "purchase_order")
        ? {
            purchaseOrder: stringValue(body, "purchase_order", errors, {
              nullable: true,
            }) as string | null,
          }
        : {}),
      ...(Object.hasOwn(body, "notes")
        ? {
            notes: stringValue(body, "notes", errors, { nullable: true }) as
              string | null,
          }
        : {}),
      ...(Object.hasOwn(body, "currency")
        ? {
            currency: stringValue(body, "currency", errors, {
              required: true,
              max: 3,
            }) as string,
          }
        : {}),
      ...(Object.hasOwn(body, "issue_date")
        ? {
            issueDate: dateValue(body, "issue_date", errors, {
              required: true,
            }) as string,
          }
        : {}),
      ...(Object.hasOwn(body, "due_date")
        ? {
            dueDate: dateValue(body, "due_date", errors, {
              required: true,
            }) as string,
          }
        : {}),
      ...(Object.hasOwn(body, "payment_terms")
        ? {
            paymentTerms: enumValue(
              body,
              "payment_terms",
              paymentTerms,
              errors,
              true,
            ) as (typeof paymentTerms)[number],
          }
        : {}),
      ...(Object.hasOwn(body, "project_id")
        ? {
            projectId: integerValue(body, "project_id", errors, {
              nullable: true,
              minimum: 1,
            }) as number | null,
          }
        : {}),
      // The link a retainer movement has to name. Without it `retainer_ledger`
      // refuses every deposit and drawdown, which is what left a retainer
      // creatable, viewable and unable to move (#449).
      ...(Object.hasOwn(body, "retainer_id")
        ? {
            retainerId: integerValue(body, "retainer_id", errors, {
              nullable: true,
              minimum: 1,
            }) as number | null,
          }
        : {}),
      ...(Object.hasOwn(body, "reminder_policy")
        ? { reminderPolicy: reminder as JsonObject | null }
        : {}),
    };
  }
  assertFields(errors);
  return { expectedVersion: version!, edit };
};

const installInvoiceEdits = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.patch("/invoices/:id", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id"), "invoice");
    const commandId = idempotencyKey(context);
    const parsed = parseInvoiceEdit(await readObjectBody(context));
    try {
      const result = await options.service.executeEdit({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: parsed.expectedVersion,
        eventIds: await eventIds(invoiceId, commandId),
        edit: parsed.edit,
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  const parseLine = (
    body: JsonObject,
    update: boolean,
    lineId: number,
  ): { expectedVersion: number; edit: InvoiceEdit } => {
    const allowed = new Set([
      "expected_version",
      ...(update ? ["expected_updated_at"] : []),
      "position",
      "kind",
      "description",
      "quantity",
      "unit_price_cents",
      "taxed",
      "taxed2",
      "project_id",
    ]);
    const errors = unknownFieldErrors(body, allowed);
    const version = expectedVersion(body, errors);
    const position = integerValue(body, "position", errors, {
      required: true,
      minimum: 0,
    });
    const kind = stringValue(body, "kind", errors, {
      required: true,
      max: 255,
    });
    const description = stringValue(body, "description", errors, {
      nullable: true,
    });
    const quantity = body.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity))
      errors.push({
        field: "quantity",
        code: "invalid_number",
        message: "quantity must be a finite JSON number",
      });
    const unitPriceCents = integerValue(body, "unit_price_cents", errors, {
      required: true,
      minimum: -9_000_000_000_000,
      maximum: 9_000_000_000_000,
    });
    const taxed = booleanValue(body, "taxed", errors, false);
    const taxed2 = booleanValue(body, "taxed2", errors, false);
    const projectId = integerValue(body, "project_id", errors, {
      nullable: true,
      minimum: 1,
    });
    const updatedAt = update
      ? timestampValue(body, "expected_updated_at", errors, { required: true })
      : undefined;
    let amountCents = 0;
    if (
      typeof quantity === "number" &&
      Number.isFinite(quantity) &&
      typeof unitPriceCents === "number"
    ) {
      try {
        amountCents = calculateInvoiceLineAmountCents(quantity, unitPriceCents);
      } catch {
        errors.push({
          field: "quantity",
          code: "amount_out_of_range",
          message: "quantity and unit_price_cents produce an invalid amount",
        });
      }
    }
    assertFields(errors);
    return {
      expectedVersion: version!,
      edit: update
        ? {
            type: "line_update",
            lineId,
            expectedLineUpdatedAt: updatedAt!,
            position: position!,
            kind: kind!,
            ...(description === undefined ? {} : { description }),
            quantity: quantity as number,
            unitPriceCents: unitPriceCents!,
            amountCents,
            taxed: taxed!,
            taxed2: taxed2!,
            ...(projectId === undefined ? {} : { projectId }),
          }
        : {
            type: "line_insert",
            lineId,
            position: position!,
            kind: kind!,
            ...(description === undefined ? {} : { description }),
            quantity: quantity as number,
            unitPriceCents: unitPriceCents!,
            amountCents,
            taxed: taxed!,
            taxed2: taxed2!,
            ...(projectId === undefined ? {} : { projectId }),
          },
    };
  };

  api.post("/invoices/:id/line-items", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const commandId = idempotencyKey(context);
    const lineId = await stableId("invoice-line", invoiceId, commandId);
    const parsed = parseLine(await readObjectBody(context), false, lineId);
    try {
      const result = await options.service.executeEdit({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: parsed.expectedVersion,
        eventIds: await eventIds(invoiceId, commandId),
        edit: parsed.edit,
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.patch("/invoices/:id/line-items/:lineId", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const lineId = resourceId(context.req.param("lineId"), "invoice line");
    const commandId = idempotencyKey(context);
    const parsed = parseLine(await readObjectBody(context), true, lineId);
    try {
      const result = await options.service.executeEdit({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: parsed.expectedVersion,
        eventIds: await eventIds(invoiceId, commandId),
        edit: parsed.edit,
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.delete("/invoices/:id/line-items/:lineId", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id"), "invoice");
    const lineId = resourceId(context.req.param("lineId"), "invoice line");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["expected_version", "expected_updated_at"]),
    );
    const version = expectedVersion(body, errors);
    const updatedAt = timestampValue(body, "expected_updated_at", errors, {
      required: true,
    });
    assertFields(errors);
    try {
      const result = await options.service.executeEdit({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: version!,
        eventIds: await eventIds(invoiceId, commandId),
        edit: {
          type: "line_delete",
          lineId,
          expectedLineUpdatedAt: updatedAt!,
        },
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });
};

const installLifecycle = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  const execute = async (
    context: Context<ApiContext<Bindings>>,
    spelling: "command" | "event_type",
  ) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const allowed = new Set([
      spelling,
      "expected_version",
      "recipients",
      "subject",
      "body",
      "attach_pdf",
      "send_me_a_copy",
      "thank_you",
      "reminder",
      "send_reminder_on",
    ]);
    const errors = unknownFieldErrors(body, allowed);
    const rawCommand = body[spelling] === "re-open" ? "reopen" : body[spelling];
    if (
      typeof rawCommand !== "string" ||
      !lifecycleCommands.includes(rawCommand as never)
    )
      errors.push({
        field: spelling,
        code: "unsupported",
        message: `${spelling} must be one of send, draft, cancel, write_off, reopen`,
      });
    const version = expectedVersion(body, errors);
    const recipients = parseRecipients(body, errors);
    const subject =
      stringValue(body, "subject", errors, { nullable: true }) ?? null;
    const messageBody =
      stringValue(body, "body", errors, { nullable: true }) ?? null;
    const attachPdf = booleanValue(body, "attach_pdf", errors, false) ?? false;
    const sendMeACopy =
      booleanValue(body, "send_me_a_copy", errors, false) ?? false;
    const thankYou = booleanValue(body, "thank_you", errors, false) ?? false;
    const reminder = booleanValue(body, "reminder", errors, false) ?? false;
    const sendReminderOn =
      dateValue(body, "send_reminder_on", errors, { nullable: true }) ?? null;
    assertFields(errors);
    const sender = await options.service.senderSnapshot(principal.userId);
    if (sender === null)
      throw new ApiError({
        status: 403,
        code: "principal_unavailable",
        message: "The acting user is no longer available.",
      });
    try {
      const result = await options.service.executeLifecycle({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        command: rawCommand as InvoiceLifecycleCommand,
        expectedVersion: version!,
        messageId: await stableId("invoice-message", invoiceId, commandId),
        eventId: (await eventIds(invoiceId, commandId))[0],
        message: {
          sentBy: sender.name,
          sentByEmail: sender.email,
          sentFrom: sender.name,
          sentFromEmail: sender.email,
          recipients,
          subject,
          body: messageBody,
          attachPdf,
          sendMeACopy,
          thankYou,
          reminder,
          sendReminderOn,
        },
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  };
  api.post("/invoices/:id/messages", (context) =>
    execute(context, "event_type"),
  );
  api.post("/invoices/:id/transitions", (context) =>
    execute(context, "command"),
  );
};

const lineItemsToken = "%invoice_line_items%";

/**
 * Where the lines go in the message the client receives.
 *
 * A template that names the variable places them itself. A template that does
 * not -- which is every template written before the variable existed, including
 * the one seeded in migration 0030 -- gets them after the body instead of not
 * at all: an invoice email that states an amount owed and nothing about what it
 * is for is the defect being closed here, and the persisted template versions
 * are immutable, so waiting for an operator to edit theirs would leave every
 * existing organization sending exactly what it sends today.
 */
const withLineItems = (
  body: string,
  template: string,
  block: string,
  separator: string,
): string =>
  template.includes(lineItemsToken) ? body : `${body}${separator}${block}`;

const installInvoiceDelivery = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.post("/invoices/:id/deliveries", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set([
        "expected_version",
        "recipients",
        "sender_identity_id",
        "template_version",
        "confirmed",
      ]),
    );
    const version = expectedVersion(body, errors);
    const recipients = parseDeliveryRecipients(body, errors);
    const senderIdentityId = integerValue(body, "sender_identity_id", errors, {
      minimum: 1,
    });
    const templateVersion = integerValue(body, "template_version", errors, {
      minimum: 1,
    });
    if (body.confirmed !== true) {
      errors.push({
        field: "confirmed",
        code: "confirmation_required",
        message: "confirmed must be true to send this invoice email",
      });
    }
    assertFields(errors);
    if (options.invoiceDelivery === undefined) {
      throw new ApiError({
        status: 503,
        code: "email_delivery_unavailable",
        message: "Invoice email delivery is not configured.",
      });
    }

    const configuration = options.invoiceDelivery.configuration;
    const [invoice, template, senderSnapshot, senderList] = await Promise.all([
      options.service.getInvoiceDeliveryContext(invoiceId),
      configuration.getTemplate("invoice", templateVersion ?? undefined),
      options.service.senderSnapshot(principal.userId),
      typeof senderIdentityId !== "number"
        ? configuration.listSenderIdentities()
        : Promise.resolve([]),
    ]);
    if (invoice === null) throw notFound("invoice");
    if (template === null) throw notFound("invoice email template version");
    if (senderSnapshot === null) {
      throw new ApiError({
        status: 403,
        code: "principal_unavailable",
        message: "The acting user is no longer available.",
      });
    }
    const sender =
      typeof senderIdentityId !== "number"
        ? senderList.find((candidate) => candidate.isDefault && candidate.archivedAt === null) ?? null
        : await configuration.getSenderIdentity(senderIdentityId);
    if (sender === null || sender.evidence === null) {
      throw new ApiError({
        status: 409,
        code: "sender_identity_missing",
        message: "Configure and verify an organization sender before sending.",
      });
    }
    try {
      await options.invoiceDelivery.mailer.assertAvailable(sender.id);
    } catch (error) {
      if (error instanceof SenderIdentityUnavailableError) {
        throw new ApiError({
          status: 409,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    const issue = new Date(`${invoice.issueDate}T00:00:00.000Z`);
    const lineItems: EmailTemplateBlockValue = invoiceLineItemsBlock(
      invoice.lineItems,
      {
        currency: invoice.currency,
        totalCents: invoice.amountCents,
        discountCents: invoice.discountAmountCents,
        taxCents: invoice.taxAmountCents + invoice.tax2AmountCents,
      },
    );

    // Minted before the body is composed, because the body is persisted at
    // send time and the link has to be inside it. A deployment without Stripe,
    // or an invoice with nothing owed, gets an empty string rather than a
    // failed send -- collecting online is an option, not a precondition.
    const paymentUrl = options.invoicePaymentUrl === undefined
      ? ''
      : ((await options.invoicePaymentUrl(invoiceId).catch(() => null)) ?? '')
    const values = {
      company_name: invoice.organizationName,
      invoice_id: String(invoice.invoiceId),
      invoice_issue_month_name: new Intl.DateTimeFormat("en-US", {
        month: "long",
        timeZone: "UTC",
      }).format(issue),
      invoice_issue_year: String(issue.getUTCFullYear()),
      invoice_number: invoice.number,
      invoice_subject: invoice.subject ?? "",
      invoice_amount: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: invoice.currency,
      }).format(invoice.amountCents / 100),
      invoice_currency: invoice.currency,
      invoice_issue_date: invoice.issueDate,
      invoice_due_date: invoice.dueDate,
      client_name: invoice.clientName,
      // Always supplied, empty when there is no link. The interpolator throws
      // on a variable it was promised and not given, so a deployment without
      // Stripe must still hand it something -- and a template that references
      // it then renders an empty line rather than failing the send.
      invoice_payment_url: paymentUrl,
      invoice_line_items: lineItems,
    } as const;
    const interpolation = { unknownVariable: template.unknownVariablePolicy } as const;
    const subject = interpolateEmailTemplate(
      "invoice",
      template.subjectTemplate,
      values,
      interpolation,
    );
    const textBody = withLineItems(
      interpolateEmailTemplate(
        "invoice",
        template.textTemplate,
        values,
        interpolation,
      ),
      template.textTemplate,
      lineItems.text,
      "\n\n",
    );
    const htmlBody =
      template.htmlTemplate === null
        ? null
        : withLineItems(
            interpolateEmailTemplate("invoice", template.htmlTemplate, values, {
              ...interpolation,
              output: "html",
            }),
            template.htmlTemplate,
            lineItems.html,
            "\n",
          );
    const eventId = (await eventIds(invoiceId, commandId))[0];
    const deliveryRecipients = await Promise.all(
      recipients.map(async (recipient, index) => ({
        ...recipient,
        deliveryId: await stableId(`invoice-email-${index}`, invoiceId, commandId),
      })),
    );
    try {
      const result = await options.service.executeLifecycle({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        command: "send",
        expectedVersion: version!,
        messageId: await stableId("invoice-message", invoiceId, commandId),
        eventId,
        message: {
          sentBy: senderSnapshot.name,
          sentByEmail: senderSnapshot.email,
          sentFrom: sender.displayName,
          sentFromEmail: sender.email,
          recipients,
          subject,
          body: textBody,
          attachPdf: false,
          sendMeACopy: false,
          thankYou: false,
          reminder: false,
          sendReminderOn: null,
        },
        delivery: {
          templateVersion: template.version,
          senderIdentityId: sender.id,
          senderIdentityVersion: sender.version,
          senderEvidenceVersion: sender.evidence.version,
          fromName: sender.displayName,
          fromEmail: sender.email,
          replyToEmail: sender.replyToEmail,
          subject,
          textBody,
          htmlBody,
          recipients: deliveryRecipients,
        },
      });
      return context.json(await invoiceEnvelope(options.service, invoiceId, result), 202);
    } catch (error) {
      return translateMoneyError(error);
    }
  });
};

const installPayments = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  const paymentFields = new Set([
    "expected_version",
    "amount_cents",
    "paid_at",
    "paid_date",
    "notes",
  ]);
  const parsePayment = (body: JsonObject, update: boolean) => {
    const allowed = new Set([
      ...paymentFields,
      ...(update ? ["expected_updated_at"] : ["currency"]),
    ]);
    const errors = unknownFieldErrors(body, allowed);
    const version = expectedVersion(body, errors);
    const amountCents = integerValue(body, "amount_cents", errors, {
      required: true,
      minimum: 1,
      maximum: 9_000_000_000_000,
    });
    const currency = update
      ? undefined
      : stringValue(body, "currency", errors, { required: true, max: 3 });
    if (typeof currency === "string" && !/^[A-Z]{3}$/.test(currency))
      errors.push({
        field: "currency",
        code: "invalid_currency",
        message: "currency must be three uppercase letters",
      });
    const hasPaidAt = Object.hasOwn(body, "paid_at");
    const hasPaidDate = Object.hasOwn(body, "paid_date");
    const paidAt = hasPaidAt
      ? (timestampValue(body, "paid_at", errors, { required: true }) ?? null)
      : null;
    const paidDate = hasPaidDate
      ? (dateValue(body, "paid_date", errors, { required: true }) ?? null)
      : null;
    if (hasPaidAt === hasPaidDate)
      errors.push({
        field: "paid_at",
        code: "exclusive_timestamp",
        message: "provide exactly one non-null paid_at or paid_date field",
      });
    const notes = stringValue(body, "notes", errors, { nullable: true });
    const expectedUpdatedAt = update
      ? timestampValue(body, "expected_updated_at", errors, { required: true })
      : undefined;
    assertFields(errors);
    return {
      version: version!,
      amountCents: amountCents!,
      currency,
      paidAt,
      paidDate,
      notes,
      expectedUpdatedAt,
    };
  };

  api.post("/invoices/:id/payments", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id"), "invoice");
    const commandId = idempotencyKey(context);
    const parsed = parsePayment(await readObjectBody(context), false);
    try {
      const result = await options.service.recordPayment({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: parsed.version,
        eventIds: await eventIds(invoiceId, commandId),
        payment: {
          type: "manual",
          id: await stableId("invoice-payment", invoiceId, commandId),
          currency: parsed.currency!,
          amountCents: parsed.amountCents,
          paidAt: parsed.paidAt,
          paidDate: parsed.paidDate,
          ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
          recordedByUserId: principal.userId,
        },
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.patch("/invoices/:id/payments/:paymentId", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id"), "invoice");
    const paymentId = resourceId(
      context.req.param("paymentId"),
      "invoice payment",
    );
    const commandId = idempotencyKey(context);
    const parsed = parsePayment(await readObjectBody(context), true);
    try {
      const result = await options.service.updatePayment({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: parsed.version,
        eventIds: await eventIds(invoiceId, commandId),
        paymentId,
        expectedPaymentUpdatedAt: parsed.expectedUpdatedAt!,
        amountCents: parsed.amountCents,
        paidAt: parsed.paidAt,
        paidDate: parsed.paidDate,
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        recordedByUserId: principal.userId,
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.delete("/invoices/:id/payments/:paymentId", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id"), "invoice");
    const paymentId = resourceId(
      context.req.param("paymentId"),
      "invoice payment",
    );
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["expected_version", "expected_updated_at"]),
    );
    const version = expectedVersion(body, errors);
    const updatedAt = timestampValue(body, "expected_updated_at", errors, {
      required: true,
    });
    assertFields(errors);
    try {
      const result = await options.service.deletePayment({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        expectedVersion: version!,
        eventIds: await eventIds(invoiceId, commandId),
        paymentId,
        expectedPaymentUpdatedAt: updatedAt!,
      });
      return context.json(
        await invoiceEnvelope(options.service, invoiceId, result),
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });
};

const parseRetainer = (
  body: JsonObject,
  occurredAt: string,
): Omit<CreateRetainerInput, "resourceId" | "commandId" | "actorUserId"> => {
  const allowed = new Set([
    "client_id",
    "project_id",
    "denomination",
    "amount_cents",
    "seconds",
    "locked_rate_cents",
    "rate_locked_at",
    "period",
    "rollover",
    "expires_at",
    "on_exhaustion",
  ]);
  const errors = unknownFieldErrors(body, allowed);
  const denomination = enumValue(
    body,
    "denomination",
    ["money", "hours"] as const,
    errors,
    true,
  );
  const amountCents =
    integerValue(body, "amount_cents", errors, {
      nullable: true,
      minimum: 0,
      maximum: 9_000_000_000_000,
    }) ?? null;
  const seconds =
    integerValue(body, "seconds", errors, { nullable: true, minimum: 0 }) ??
    null;
  const lockedRateCents =
    integerValue(body, "locked_rate_cents", errors, {
      nullable: true,
      minimum: 0,
      maximum: 9_000_000_000_000,
    }) ?? null;
  const rateLockedAt =
    timestampValue(body, "rate_locked_at", errors, { nullable: true }) ?? null;
  const clientId =
    integerValue(body, "client_id", errors, {
      nullable: true,
      minimum: 1,
    }) ?? null;
  const projectId =
    integerValue(body, "project_id", errors, {
      nullable: true,
      minimum: 1,
    }) ?? null;
  const period =
    stringValue(body, "period", errors, { nullable: true, max: 64 }) ?? null;
  const rollover = Object.hasOwn(body, "rollover")
    ? body.rollover === null
      ? null
      : enumValue(
          body,
          "rollover",
          ["carry", "expire", "cap"] as const,
          errors,
          true,
        )
    : null;
  const expiresAt =
    dateValue(body, "expires_at", errors, { nullable: true }) ?? null;
  const onExhaustion = Object.hasOwn(body, "on_exhaustion")
    ? enumValue(
        body,
        "on_exhaustion",
        ["block", "warn", "overflow"] as const,
        errors,
        true,
      )
    : "block";
  const hasAmountCents = Object.hasOwn(body, "amount_cents");
  const hasSeconds = Object.hasOwn(body, "seconds");
  const hasLockedRateCents = Object.hasOwn(body, "locked_rate_cents");
  const hasRateLockedAt = Object.hasOwn(body, "rate_locked_at");
  if (
    denomination === "money" &&
    (!hasAmountCents ||
      amountCents === null ||
      hasSeconds ||
      hasLockedRateCents ||
      hasRateLockedAt)
  )
    errors.push({
      field: "denomination",
      code: "invalid_shape",
      message:
        "money retainers require amount_cents and reject hours/rate fields",
    });
  if (
    denomination === "hours" &&
    (!hasSeconds ||
      seconds === null ||
      hasAmountCents ||
      hasLockedRateCents !== hasRateLockedAt ||
      (hasLockedRateCents &&
        (lockedRateCents === null || rateLockedAt === null)))
  )
    errors.push({
      field: "denomination",
      code: "invalid_shape",
      message:
        "hours retainers require seconds and paired optional locked rate fields",
    });
  assertFields(errors);
  return {
    clientId,
    projectId,
    denomination: denomination!,
    amountCents,
    seconds,
    lockedRateCents,
    rateLockedAt,
    period,
    rollover: rollover ?? null,
    expiresAt,
    onExhaustion: onExhaustion!,
    occurredAt,
  };
};

const installRetainers = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.get("/retainers", async (context) => {
    const principal = requireRead(context);
    const requestUrl = new URL(context.req.url);
    const clientIds = clientIdFilter(requestUrl);
    return context.json(
      await cursorPage({
        requestUrl,
        cursorSigningKey: options.cursorSigningKey,
        viewer: principal,
        serializer: (value: Readonly<RetainerResource>) => ({ ...value }),
        source: {
          // The watermark stays the whole collection's, as it does for
          // invoices: it bounds the traversal against later inserts and is not
          // a count of what matches.
          highWatermark: () => options.service.highWatermark("retainers"),
          list: (window) =>
            options.service.listRetainers(
              clientIds === undefined ? window : { ...window, clientIds },
            ),
        },
      }),
    );
  });
  api.post("/retainers", async (context) => {
    const principal = requireWrite(context);
    const commandId = idempotencyKey(context);
    try {
      const created = await options.service.createRetainer({
        ...parseRetainer(await readObjectBody(context), options.clock()),
        resourceId: await stableId("retainer", 0, commandId),
        commandId,
        actorUserId: principal.userId,
      });
      return context.json(
        { data: created, links: { self: `/api/v1/retainers/${created.id}` } },
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });
  api.get("/retainers/:id", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "retainer");
    const value = await options.service.getRetainer(id);
    if (value === null) throw notFound("retainer");
    return context.json({
      data: value,
      links: { self: `/api/v1/retainers/${id}` },
    });
  });
  api.patch("/retainers/:id", async (context) => {
    requireWrite(context);
    const id = resourceId(context.req.param("id"), "retainer");
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["state", "period", "rollover", "expires_at", "on_exhaustion"]),
    );
    const input: UpdateRetainerInput = {
      ...(Object.hasOwn(body, "state")
        ? {
            state: enumValue(
              body,
              "state",
              ["ongoing", "closed"] as const,
              errors,
              true,
            ) as "ongoing" | "closed",
          }
        : {}),
      ...(Object.hasOwn(body, "period")
        ? {
            period: stringValue(body, "period", errors, {
              nullable: true,
              max: 64,
            }) as string | null,
          }
        : {}),
      ...(Object.hasOwn(body, "rollover")
        ? {
            rollover:
              body.rollover === null
                ? null
                : (enumValue(
                    body,
                    "rollover",
                    ["carry", "expire", "cap"] as const,
                    errors,
                    true,
                  ) as "carry" | "expire" | "cap"),
          }
        : {}),
      ...(Object.hasOwn(body, "expires_at")
        ? {
            expiresAt: dateValue(body, "expires_at", errors, {
              nullable: true,
            }) as string | null,
          }
        : {}),
      ...(Object.hasOwn(body, "on_exhaustion")
        ? {
            onExhaustion: enumValue(
              body,
              "on_exhaustion",
              ["block", "warn", "overflow"] as const,
              errors,
              true,
            ) as "block" | "warn" | "overflow",
          }
        : {}),
      occurredAt: options.clock(),
    };
    if (Object.keys(body).length === 0)
      errors.push({
        field: "body",
        code: "empty",
        message: "provide at least one mutable retainer policy field",
      });
    assertFields(errors);
    try {
      const value = await options.service.updateRetainer(id, input);
      if (value === null) throw notFound("retainer");
      return context.json({
        data: value,
        links: { self: `/api/v1/retainers/${id}` },
      });
    } catch (error) {
      return translateMoneyError(error);
    }
  });
  api.get("/retainers/:id/ledger", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "retainer");
    const ledger = await options.service.listRetainerLedger(id);
    if (ledger === null) throw notFound("retainer");
    return context.json({
      data: ledger.map(serializeRetainerLedgerEntry),
      links: { self: `/api/v1/retainers/${id}/ledger` },
    });
  });

  const append = async (
    context: Context<ApiContext<Bindings>>,
    drawdownOnly: boolean,
  ) => {
    requireWrite(context);
    const retainerId = resourceId(context.req.param("id")!, "retainer");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const allowed = new Set([
      ...(drawdownOnly ? [] : ["kind"]),
      "invoice_id",
      "amount_cents",
      "seconds",
      "occurred_on",
      "notes",
    ]);
    const errors = unknownFieldErrors(body, allowed);
    const kind = drawdownOnly
      ? "drawdown"
      : enumValue(
          body,
          "kind",
          ["deposit", "drawdown", "expiry", "reset", "adjustment"] as const,
          errors,
          true,
        );
    const invoiceId =
      integerValue(body, "invoice_id", errors, {
        nullable: true,
        minimum: 1,
      }) ?? null;
    const acceptsSignedAmount = kind === "reset" || kind === "adjustment";
    const cents = integerValue(body, "amount_cents", errors, {
      minimum: acceptsSignedAmount ? -9_000_000_000_000 : 1,
      maximum: 9_000_000_000_000,
    });
    const seconds = integerValue(body, "seconds", errors, {
      minimum: acceptsSignedAmount ? -Number.MAX_SAFE_INTEGER : 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    if ((cents === undefined) === (seconds === undefined))
      errors.push({
        field: "amount_cents",
        code: "exclusive_amount",
        message: acceptsSignedAmount
          ? "provide exactly one non-zero signed amount_cents or seconds value"
          : "provide exactly one positive amount_cents or seconds value",
      });
    if (acceptsSignedAmount && (cents === 0 || seconds === 0))
      errors.push({
        field: cents === 0 ? "amount_cents" : "seconds",
        code: "non_zero",
        message: `${cents === 0 ? "amount_cents" : "seconds"} must be non-zero`,
      });
    const occurredOn = dateValue(body, "occurred_on", errors, {
      required: true,
    });
    const notes =
      stringValue(body, "notes", errors, { nullable: true }) ?? null;
    if ((kind === "deposit" || kind === "drawdown") && invoiceId === null)
      errors.push({
        field: "invoice_id",
        code: "required",
        message: `${kind} requires invoice_id`,
      });
    if (
      kind !== undefined &&
      kind !== "deposit" &&
      kind !== "drawdown" &&
      invoiceId !== null
    )
      errors.push({
        field: "invoice_id",
        code: "forbidden",
        message: `${kind} does not accept invoice_id`,
      });
    if (kind === "adjustment" && (notes ?? "").trim().length === 0)
      errors.push({
        field: "notes",
        code: "required",
        message: "adjustment requires notes",
      });
    assertFields(errors);
    const sign = kind === "drawdown" || kind === "expiry" ? -1 : 1;
    try {
      const result = await options.service.appendRetainerLedger({
        id: `ret_${(await stableDigest(retainerId, commandId)).slice(0, 40)}`,
        retainerId,
        kind: kind!,
        invoiceId,
        occurredOn: occurredOn!,
        notes,
        createdAt: options.clock(),
        ...(typeof cents !== "number"
          ? { seconds: sign * seconds! }
          : { amountCents: sign * cents }),
      });
      return context.json(
        {
          data: {
            entry: serializeRetainerLedgerEntry(result.entry),
            balance: result.balance,
            denomination: result.denomination,
          },
          links: {
            self: `/api/v1/retainers/${retainerId}/ledger/${result.entry.id}`,
          },
        },
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  };
  api.post("/retainers/:id/ledger", (context) => append(context, false));
  api.post("/retainers/:id/drawdowns", (context) => append(context, true));
};

/**
 * The projects a banded definition claims (#484).
 *
 * Absent and null are the same answer -- an ordinary recurring invoice -- and
 * an empty list is refused rather than quietly treated as a third one: the
 * column's own CHECK forbids it, and a caller that sent `[]` meant something,
 * which is worth saying back to them instead of storing a null they did not ask
 * for.
 */
const claimsValue = (
  body: Record<string, unknown>,
  errors: FieldError[],
): readonly number[] | null => {
  const raw = body["claims_project_ids"];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    errors.push({
      field: "claims_project_ids",
      code: "invalid",
      message: "claims_project_ids must be an array of project ids, or null.",
    });
    return null;
  }
  if (raw.length === 0) {
    errors.push({
      field: "claims_project_ids",
      code: "invalid",
      message: "claims_project_ids must name at least one project, or be null.",
    });
    return null;
  }
  const ids: number[] = [];
  for (const entry of raw) {
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
      errors.push({
        field: "claims_project_ids",
        code: "invalid",
        message: "Every claims_project_ids entry must be a positive integer.",
      });
      return null;
    }
    ids.push(entry as number);
  }
  // Deduplicated: claiming a project twice is the same claim, and the engine's
  // IN clause would not notice, so the stored value would differ from what it
  // means for no reason.
  return [...new Set(ids)];
};

/**
 * How much of the period a band takes, and in which unit (#707).
 *
 * The store and the schema both refuse the ambiguous combinations. Reading
 * them here as well is what turns a constraint failure into a field error the
 * caller can act on, naming the field they got wrong rather than a trigger.
 */
const claimValues = (
  body: Record<string, unknown>,
  errors: FieldError[],
): {
  claimMode: "all" | "ceiling";
  claimCeilingSeconds: number | null;
  claimCeilingCents: number | null;
  /**
   * Whether the band absorbs every tracked hour on those projects or only the
   * billable ones (#708). Under a fixed amount the client bought the period, so
   * "tracked" is the honest unit for a firm that logs internal work against the
   * client's project; "billable" is what every definition did before the
   * setting existed.
   */
  claimScope: "billable" | "tracked";
  /**
   * The cost share this engagement is read against (#710), in basis points --
   * 8000 is 80%. Null takes the organisation's default: deals differ, and a
   * single global number would be either too loose to catch anything or tight
   * enough to cry wolf.
   */
  costAlertBasisPoints: number | null;
} => {
  const rawMode = body["claim_mode"];
  const mode =
    rawMode === undefined || rawMode === null
      ? "all"
      : rawMode === "all" || rawMode === "ceiling"
        ? rawMode
        : null;
  if (mode === null) {
    errors.push({
      field: "claim_mode",
      code: "invalid",
      message: 'claim_mode must be "all" or "ceiling".',
    });
  }
  const seconds =
    integerValue(body, "claim_ceiling_seconds", errors, {
      nullable: true,
      minimum: 1,
    }) ?? null;
  const cents =
    integerValue(body, "claim_ceiling_cents", errors, {
      nullable: true,
      minimum: 1,
    }) ?? null;
  const stated = [seconds, cents].filter((value) => value !== null).length;
  if (mode === "ceiling" && stated !== 1) {
    errors.push({
      field: "claim_ceiling_seconds",
      code: "invalid",
      message:
        "A ceiling claim needs exactly one ceiling: claim_ceiling_seconds for a duration, or claim_ceiling_cents for billable value at list.",
    });
  }
  if (mode === "all" && stated > 0) {
    errors.push({
      field: "claim_mode",
      code: "invalid",
      message: "Only a ceiling claim may carry a ceiling.",
    });
  }
  if (mode === "ceiling" && body["claims_project_ids"] == null) {
    errors.push({
      field: "claims_project_ids",
      code: "invalid",
      message: "A ceiling claim must name the projects it claims from.",
    });
  }
  const rawScope = body["claim_scope"];
  const scope =
    rawScope === undefined || rawScope === null
      ? "billable"
      : rawScope === "billable" || rawScope === "tracked"
        ? rawScope
        : null;
  if (scope === null) {
    errors.push({
      field: "claim_scope",
      code: "invalid",
      message: 'claim_scope must be "billable" or "tracked".',
    });
  }
  if (scope === "tracked" && body["claims_project_ids"] == null) {
    errors.push({
      field: "claims_project_ids",
      code: "invalid",
      message: "A claim scope must name the projects it claims from.",
    });
  }
  const alert =
    integerValue(body, "cost_alert_basis_points", errors, {
      nullable: true,
      minimum: 1,
      maximum: 20_000,
    }) ?? null;
  if (alert !== null && body["claims_project_ids"] == null) {
    errors.push({
      field: "claims_project_ids",
      code: "invalid",
      message: "A cost alert must name the projects it claims from.",
    });
  }
  return {
    claimMode: mode ?? "all",
    claimCeilingSeconds: seconds,
    claimCeilingCents: cents,
    claimScope: scope ?? "billable",
    costAlertBasisPoints: alert,
  };
};

const parseRecurring = (
  body: JsonObject,
  occurredAt: string,
): RecurringInput => {
  const allowed = new Set([
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
  ]);
  const errors = unknownFieldErrors(body, allowed);
  const amountConfig = body.amount_config;
  if (!isJsonObject(amountConfig))
    errors.push({
      field: "amount_config",
      code: "invalid_object",
      message: "amount_config must be a versioned object",
    });
  const value = {
    clientId: integerValue(body, "client_id", errors, {
      required: true,
      minimum: 1,
    }),
    subjectTemplate: stringValue(body, "subject_template", errors, {
      required: true,
    }),
    notesTemplate: stringValue(body, "notes_template", errors, {
      required: true,
    }),
    everyNMonths: integerValue(body, "every_n_months", errors, {
      required: true,
      minimum: 1,
    }),
    dayOfMonth: integerValue(body, "day_of_month", errors, {
      required: true,
      minimum: 1,
      maximum: 31,
    }),
    nextIssueOn: dateValue(body, "next_issue_on", errors, { required: true }),
    amountConfig,
    canDrawFromRetainerId:
      integerValue(body, "can_draw_from_retainer_id", errors, {
        nullable: true,
        minimum: 1,
      }) ?? null,
    claimsProjectIds: claimsValue(body, errors),
    ...claimValues(body, errors),
    occurredAt,
  };
  assertFields(errors);
  return {
    clientId: value.clientId!,
    subjectTemplate: value.subjectTemplate!,
    notesTemplate: value.notesTemplate!,
    everyNMonths: value.everyNMonths!,
    dayOfMonth: value.dayOfMonth!,
    nextIssueOn: value.nextIssueOn!,
    amountConfig: value.amountConfig as unknown as RecurringAmountConfig,
    canDrawFromRetainerId: value.canDrawFromRetainerId,
    claimsProjectIds: value.claimsProjectIds,
    claimMode: value.claimMode,
    claimCeilingSeconds: value.claimCeilingSeconds,
    claimCeilingCents: value.claimCeilingCents,
    claimScope: value.claimScope,
    costAlertBasisPoints: value.costAlertBasisPoints,
    occurredAt: value.occurredAt,
  };
};

const installRecurring = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  api.get("/recurring-invoices", async (context) => {
    const principal = requireRead(context);
    return context.json(
      await cursorPage({
        requestUrl: new URL(context.req.url),
        cursorSigningKey: options.cursorSigningKey,
        viewer: principal,
        serializer: (value: Readonly<RecurringResource>) => ({ ...value }),
        source: {
          highWatermark: () =>
            options.service.highWatermark("recurring-invoices"),
          list: (window) => options.service.listRecurring(window),
        },
      }),
    );
  });
  api.post("/recurring-invoices", async (context) => {
    const principal = requireWrite(context);
    const commandId = idempotencyKey(context);
    try {
      const value = await options.service.createRecurring({
        ...parseRecurring(await readObjectBody(context), options.clock()),
        resourceId: await stableId("recurring-invoice", 0, commandId),
        commandId,
        actorUserId: principal.userId,
      });
      return context.json(
        {
          data: value,
          links: { self: `/api/v1/recurring-invoices/${value.id}` },
        },
        201,
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });
  /**
   * Filling in the claims a band was issued too early to make (#712).
   *
   * Rehearsal is the default: a call writes nothing unless it says `apply`,
   * because the figures are large enough that nobody should approve them from
   * a description. The actor comes from the session rather than the body, so
   * the audit rows name who really did it.
   *
   * The invoices are named rather than inferred. A definition's own invoices
   * are not reliably linked to it -- an import can leave the link null on
   * invoices that plainly belong to the band -- so inferring the list would
   * silently do the wrong amount of work. The projects may be left out, and
   * then come from what the definition says it claims, which is configuration
   * rather than a guess.
   */
  api.post("/recurring-invoices/:id/claim-backfill", async (context) => {
    const principal = requireWrite(context);
    const id = resourceId(context.req.param("id"), "recurring invoice");
    if (options.bandClaimBackfill === undefined) {
      throw new ApiError({
        status: 503,
        code: "service_unavailable",
        message: "Claim backfill is not available in this deployment.",
      });
    }
    const definition = await options.service.getRecurring(id);
    if (definition === null) throw notFound("recurring invoice");
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["invoice_ids", "project_ids", "apply"]),
    );
    const ids = (field: string): number[] => {
      const raw = body[field];
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw)) {
        errors.push({
          field,
          code: "invalid",
          message: `${field} must be an array of positive integers.`,
        });
        return [];
      }
      for (const entry of raw) {
        if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
          errors.push({
            field,
            code: "invalid",
            message: `Every ${field} entry must be a positive integer.`,
          });
          return [];
        }
      }
      return [...new Set(raw as number[])];
    };
    const invoiceIds = ids("invoice_ids");
    if (invoiceIds.length === 0) {
      errors.push({
        field: "invoice_ids",
        code: "invalid",
        message: "Name the invoices to fill; they are not inferred.",
      });
    }
    let projectIds = ids("project_ids");
    if (projectIds.length === 0) {
      const claimed = (definition as { claims_project_ids?: readonly number[] | null })
        .claims_project_ids;
      if (claimed !== undefined && claimed !== null) projectIds = [...claimed];
    }
    if (projectIds.length === 0) {
      errors.push({
        field: "project_ids",
        code: "invalid",
        message:
          "Name the projects the band covers, or set them on the definition first.",
      });
    }
    const apply = body["apply"];
    if (apply !== undefined && typeof apply !== "boolean") {
      errors.push({
        field: "apply",
        code: "invalid",
        message: "apply must be true or false.",
      });
    }
    assertFields(errors);
    try {
      const report = await options.bandClaimBackfill.backfill({
        invoiceIds,
        projectIds,
        actorUserId: principal.userId,
        // The idempotency key names the run, so the audit rows a run wrote can
        // be read back together and a retry is recognisable as one.
        runId: idempotencyKey(context),
        occurredAt: options.clock(),
        recurringInvoiceId: id,
        apply: apply === true,
      });
      return context.json(
        {
          data: {
            run_id: report.runId,
            applied: report.applied,
            remaining_entry_count: report.remainingEntryCount,
            remaining_seconds: report.remainingSeconds,
            invoices: report.invoices.map((line) => ({
              invoice_id: line.invoiceId,
              number: line.number,
              issue_date: line.issueDate,
              state: line.state,
              amount_cents: line.amountCents,
              entry_count: line.entryCount,
              seconds: line.seconds,
              billable_value_cents: line.billableValueCents,
              entries_without_billable_rate: line.entriesWithoutBillableRate,
              foregone_billable_cents: line.foregoneBillableCents,
            })),
          },
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  api.post("/recurring-invoices/:id/generations", async (context) => {
    const principal = requireWrite(context);
    const id = resourceId(context.req.param("id"), "recurring invoice");
    if (options.recurringGeneration === undefined) {
      throw new ApiError({
        status: 503,
        code: "service_unavailable",
        message:
          "Recurring invoice generation is not available in this deployment.",
      });
    }
    let result: Awaited<
      ReturnType<RecurringGenerationPort["generate"]>
    >;
    try {
      // The engine takes a date, not a timestamp, and decides for itself
      // whether the definition is due on it. Passing today rather than the
      // definition's own next_issue_on is what makes "not_due" reachable
      // instead of making every call succeed by construction.
      result = await options.recurringGeneration.generate(
        id,
        options.clock().slice(0, 10),
        { type: "user", userId: principal.userId, profile: principal.profile },
      );
    } catch (error) {
      return translateMoneyError(error);
    }
    const invoice = await options.service.getInvoice(result.invoiceId);
    if (invoice === null) throw notFound("invoice");
    return context.json(
      {
        data: {
          invoice,
          generation: {
            definition_id: result.definitionId,
            period: result.period,
            next_issue_on: result.nextIssueOn,
            retainer_drawdown_cents: result.retainerDrawdownCents,
          },
        },
        links: { self: `/api/v1/invoices/${result.invoiceId}` },
      },
      201,
    );
  });
  api.get("/recurring-invoices/:id", async (context) => {
    requireRead(context);
    const id = resourceId(context.req.param("id"), "recurring invoice");
    const value = await options.service.getRecurring(id);
    if (value === null) throw notFound("recurring invoice");
    return context.json({
      data: value,
      links: { self: `/api/v1/recurring-invoices/${id}` },
    });
  });
  api.patch("/recurring-invoices/:id", async (context) => {
    requireWrite(context);
    const id = resourceId(context.req.param("id"), "recurring invoice");
    try {
      const value = await options.service.updateRecurring(
        id,
        parseRecurring(await readObjectBody(context), options.clock()),
      );
      if (value === null) throw notFound("recurring invoice");
      return context.json({
        data: value,
        links: { self: `/api/v1/recurring-invoices/${id}` },
      });
    } catch (error) {
      return translateMoneyError(error);
    }
  });
  api.delete("/recurring-invoices/:id", async (context) => {
    requireWrite(context);
    const id = resourceId(context.req.param("id"), "recurring invoice");
    try {
      if (!(await options.service.deleteRecurring(id)))
        throw notFound("recurring invoice");
      return context.body(null, 204);
    } catch (error) {
      return translateMoneyError(error);
    }
  });
};

export const installMoneyResourceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  supplied: MoneyResourceRouteOptions,
): void => {
  const options = {
    ...supplied,
    clock: supplied.clock ?? (() => new Date().toISOString()),
  };
  const preventFinancialCaching: MiddlewareHandler<
    ApiContext<Bindings>
  > = async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
  };
  for (const resource of [
    "invoices",
    "estimates",
    "retainers",
    "recurring-invoices",
  ]) {
    api.use(`/${resource}`, preventFinancialCaching);
    api.use(`/${resource}/*`, preventFinancialCaching);
  }
  api.use("/invoice-generations", preventFinancialCaching);
  installInvoiceReads(api, options);
  installEstimates(api, options);
  installInvoiceEdits(api, options);
  installLifecycle(api, options);
  installInvoiceDelivery(api, options);
  installPayments(api, options);
  installRetainers(api, options);
  installRecurring(api, options);
  installGeneration(api, options);
};
