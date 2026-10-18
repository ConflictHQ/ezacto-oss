import {
  calculateInvoiceLineAmountCents,
  compareInvoiceListPositions,
  composeInvoiceEmail,
  EmailTemplateVariableError,
  invoiceEmailCopies,
  invoiceEmailPreview,
  parseJournalFormats,
  type InvoiceActorType,
  type InvoiceAddress,
  type InvoiceLifecycleCommand,
  type InvoiceListPosition,
  type InvoicePaymentTerms,
  type JournalFormat,
} from "@ezacto/core";
import {
  SenderIdentityUnavailableError,
  type SenderBoundQueuedMailer,
  type EmailAttachmentRef,
} from "@ezacto/mailer";
import type {
  EmailConfigurationService,
  SenderEvidenceConfigurationRecord,
  SenderIdentityConfigurationRecord,
} from "./email-configuration.js";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext, UserPrincipal } from "./context.js";
import { ApiError, validationError, type FieldError } from "./errors.js";
import {
  cursorPage,
  keysetCursorPage,
  type CursorWindow,
  type KeysetOrder,
  type KeysetWindow,
} from "./pagination.js";
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
  number: string;
  issue_date: string;
  created_at: string;
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
  purchaseOrder: string | null;
  notes: string | null;
  paymentTerms: InvoicePaymentTerms;
  dueAmountCents: number;
  /** Null on a free-form invoice, which bills no period (issue 925). */
  periodStart: string | null;
  periodEnd: string | null;
  organizationTimeZone: string;
}

/**
 * One email to queue. Every recipient of a message is a header of it -- To or
 * Cc -- so a message is exactly one job however many people it went to.
 */
export interface InvoiceDeliveryJob {
  deliveryId: number;
  senderIdentityId: number;
  senderIdentityVersion: number;
  senderEvidenceVersion: number;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  to: readonly { name: string; email: string }[];
  cc: readonly { name: string; email: string }[];
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
  /**
   * The client's purchase order, copied onto each invoice the definition
   * issues. Absent leaves the stored one as it is; null clears it.
   */
  purchaseOrder?: string | null;
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
  /** Who the email was copied to. Absent is nobody. */
  cc?: readonly Readonly<{ name: string; email: string }>[];
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

export interface InvoiceListWindow extends KeysetWindow<InvoiceListPosition> {
  states?: readonly InvoiceState[];
  clientIds?: readonly number[];
  number?: string;
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

/**
 * The `number` query parameter: the invoice with exactly this number. It is how
 * the web app opens `/invoices/4021` -- the address carries the number, and the
 * page needs the record behind it.
 *
 * Compared as text, exactly as given: nothing is trimmed or parsed, so "089"
 * is not "89". Numbers are unique, so the answer is that invoice or an empty
 * page. One number, unlike `state` and `client_id`: a repeated parameter would
 * be a set, and this one does not answer for a set. Bounded the way the
 * contract bounds it, in characters rather than UTF-16 units.
 */
const invoiceNumberFilter = (requestUrl: URL): string | undefined => {
  const raw = requestUrl.searchParams.getAll("number");
  if (raw.length === 0) return undefined;
  if (raw.length > 1) {
    throw validationError([
      { field: "number", code: "duplicate", message: "number may appear once" },
    ]);
  }
  const value = raw[0]!;
  const length = Array.from(value).length;
  if (length < 1 || length > 64) {
    throw validationError([
      {
        field: "number",
        code: "invalid",
        message: "number must be an invoice number of 1 to 64 characters",
      },
    ]);
  }
  return value;
};

interface MoneyResourceService {
  /** Null for an empty collection -- see CursorSource, which cursorPage reads. */
  highWatermark(
    kind: "estimates" | "retainers" | "recurring-invoices",
  ): Promise<number | null>;
  /** Null for an empty collection -- see KeysetSource, which keysetCursorPage reads. */
  invoiceListSnapshot(): Promise<string | null>;
  /** Newest first: see `compareInvoiceListPositions` in `@ezacto/core`. */
  listInvoices(window: InvoiceListWindow): Promise<InvoiceResource[]>;
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
        /** The one email this send is; every recipient is a header of it. */
        deliveryId: number;
        recipients: readonly {
          name: string;
          email: string;
          role: "to" | "cc";
        }[];
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
  /** Absent is "tracked"; the route leaves it absent either way. */
  kind?: "tracked";
  clientId: number;
  /** Null takes every uninvoiced billable row up to and including `to`. */
  from: string | null;
  to: string;
  projectIds: readonly number[];
  timeSummaryType: InvoiceGenerationTimeSummary | null;
  expenseSummaryType: InvoiceGenerationExpenseSummary | null;
}

/** A blank draft for one client: no lines, no period, nothing claimed. */
export interface InvoiceGenerationFreeFormRequest {
  kind: "free_form";
  clientId: number;
}

/** One line of a band's fee, written as a free-form line is. */
export interface InvoiceGenerationFeeLine {
  kind: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  projectId: number | null;
}

/**
 * A flat fee covering tracked time: the fee lines, and the uninvoiced time on
 * the projects in the period, all of which the draft takes. The band covers it
 * all, or the oldest up to a ceiling in hours or in value; what it leaves is
 * billed after the fee, grouped by `overageSummaryType`.
 */
export interface InvoiceGenerationBandedRequest {
  kind: "banded";
  clientId: number;
  from: string | null;
  to: string;
  projectIds: readonly number[];
  lineItems: readonly InvoiceGenerationFeeLine[];
  claimMode: "all" | "ceiling";
  claimCeilingSeconds: number | null;
  claimCeilingCents: number | null;
  overageSummaryType: InvoiceGenerationTimeSummary | null;
}

export interface InvoiceGenerationCommand {
  commandId: string;
  principal: UserPrincipal;
  request:
    | InvoiceGenerationRequest
    | InvoiceGenerationFreeFormRequest
    | InvoiceGenerationBandedRequest;
}

/** What a banded draft's fee covered, and what it billed past its ceiling. */
export interface InvoiceBandClaimResource {
  claimed_entry_count: number;
  claimed_seconds: number;
  billed_entry_count: number;
  billed_seconds: number;
}

/** Implemented by #50; this API story only owns validation and delegation. */
export interface InvoiceGenerationPort {
  generate(
    input: InvoiceGenerationCommand,
  ): Promise<InvoiceResource & { band?: InvoiceBandClaimResource }>;
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
    /**
     * The entry's document composer: whether the invoice PDF goes with an
     * email, and the preview of what would. Absent where the deployment keeps
     * no files, in which case nothing is attached and nothing is promised.
     */
    documents?: InvoiceDocumentPort;
    /** Who an invoice email copies besides the people the sender typed. */
    sending?: InvoiceSendingPort;
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
  /**
   * Whether the invoice PDF goes with an email sent now. Asked when the body is
   * composed, because the body says so: the sentence that promises a document
   * is only written where one goes.
   */
  attachesPdf(invoiceId: number): Promise<boolean>;
  /**
   * What an email sent now would carry, with the Send dialog's choices laid
   * over the invoice's own, rendered by the same code a real send uses and
   * stored nowhere. The invoice document is measured as it would go -- with
   * the files bound into its back where that is the rule.
   */
  preview(input: {
    readonly invoiceId: number;
    readonly choices: InvoiceAttachmentChoices;
  }): Promise<readonly InvoiceAttachmentPreview[]>;
  /**
   * The invoice document exactly as an email sent now would carry it, stamped
   * PREVIEW on every page. `null` for no such invoice.
   */
  previewDocument(input: {
    readonly invoiceId: number;
    readonly choices: InvoiceAttachmentChoices;
  }): Promise<{ readonly filename: string; readonly bytes: Uint8Array } | null>;
  /**
   * Stores what a preview email carries -- the stamped document and the files
   * beside it -- under keys of its own, so nothing a real send keeps is
   * touched, and names them for the queue.
   */
  stagePreview(input: {
    readonly invoiceId: number;
    readonly previewId: string;
    readonly choices: InvoiceAttachmentChoices;
  }): Promise<readonly EmailAttachmentRef[]>;
}

/**
 * The Send dialog's attachment choices, laid over what the invoice would do
 * anyway. Absent is "as the invoice, its client and the organization say".
 */
export interface InvoiceAttachmentChoices {
  readonly document?: boolean;
  readonly files?: boolean;
  readonly append?: boolean;
  readonly journal?: "detailed" | "summary" | false;
  readonly journalFormats?: readonly JournalFormat[];
}

/** One file an email would carry, as the preview lists it. */
export interface InvoiceAttachmentPreview {
  readonly kind: "invoice" | "journal" | "file";
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** The invoice document's own: the files bound into its back, in order. */
  readonly appended: readonly string[];
  /** A file meant for the back of the document that goes beside it instead, and why. */
  readonly notAppended: "encrypted" | "unreadable" | "empty" | "too_large" | null;
}

/** Who an invoice email copies besides the people the sender typed. */
export interface InvoiceSendingPort {
  /** The organization's own mailboxes, copied on every invoice email. */
  alwaysCc(): Promise<readonly InvoiceAddress[]>;
  /** Whether this person is copied on what they send, and where. */
  senderCopy(userId: number): Promise<{
    readonly copy: boolean;
    readonly name: string;
    readonly email: string | null;
  } | null>;
  /** Preview emails this invoice has sent since the instant given. */
  previewsSince(invoiceId: number, since: string): Promise<number>;
}

/** Subscriber registration used by both runtimes; provider I/O remains in the queue consumer. */
export const createInvoiceEmailOutboxSubscriber = (
  service: Pick<MoneyResourceService, "listInvoiceDeliveryJobs">,
  mailer?: SenderBoundQueuedMailer,
  documents?: Pick<InvoiceDocumentPort, "prepare">,
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
    // One document per message, prepared once. A message is one email now, but
    // one sent before copies existed wrote an email per recipient, and those
    // still share the message's single document.
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
      const mailbox = (person: { name: string; email: string }) =>
        person.name === ""
          ? { email: person.email }
          : { email: person.email, name: person.name };
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
          to: job.to.map(mailbox),
          ...(job.cc.length === 0 ? {} : { cc: job.cc.map(mailbox) }),
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
const generationKinds = ["tracked", "free_form", "banded"] as const;
const claimModes = ["all", "ceiling"] as const;
/** A fee is a handful of lines; the hours it covers are what can run long. */
const maximumFeeLines = 100;
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
  if (code === "payment_exceeds_balance") {
    // A field error on the amount, so a form can put it beside the input. The
    // version check ran first, so this is the balance the payment would land
    // on, not a stale one: re-reading the invoice will not change the answer.
    const maximumCents =
      isJsonObject(error) && typeof error.maximumCents === "number"
        ? error.maximumCents
        : null;
    throw validationError([
      {
        field: "amount_cents",
        code: "exceeds_balance",
        message:
          maximumCents === null || maximumCents <= 0
            ? "This invoice has nothing left to pay, so the payment would overpay it."
            : `amount_cents must not exceed ${maximumCents}, the amount this invoice still owes.`,
      },
    ]);
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

/** The client, period and projects a tracked or banded request selects. */
const parseGenerationSelection = (
  body: JsonObject,
  errors: FieldError[],
): {
  clientId: number | undefined;
  from: string | null | undefined;
  to: string | null | undefined;
  projectIds: unknown;
} => {
  const clientId = integerValue(body, "client_id", errors, {
    required: true,
    minimum: 1,
  });
  // Absent or null: everything uninvoiced up to `to`.
  const from = dateValue(body, "from", errors, { nullable: true });
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
  return { clientId: clientId ?? undefined, from, to, projectIds };
};

/** The fee: free-form lines, each priced as the line editor prices one. */
const parseFeeLines = (
  body: JsonObject,
  errors: FieldError[],
): InvoiceGenerationFeeLine[] => {
  const lines = body.line_items;
  if (
    !Array.isArray(lines) ||
    lines.length === 0 ||
    lines.length > maximumFeeLines
  ) {
    errors.push({
      field: "line_items",
      code: "invalid_fee",
      message: `line_items must hold the fee in 1-${maximumFeeLines} lines`,
    });
    return [];
  }
  return lines.flatMap((line, index) => {
    const field = `line_items[${index}]`;
    if (!isJsonObject(line)) {
      errors.push({
        field,
        code: "invalid_line",
        message: `${field} must be an object`,
      });
      return [];
    }
    const lineErrors = unknownFieldErrors(
      line,
      new Set([
        "kind",
        "description",
        "quantity",
        "unit_price_cents",
        "project_id",
      ]),
    );
    const kind = stringValue(line, "kind", lineErrors, {
      required: true,
      max: 255,
    });
    if (typeof kind === "string" && kind.trim() === "") {
      lineErrors.push({
        field: "kind",
        code: "invalid_string",
        message: "kind must not be blank",
      });
    }
    const description = stringValue(line, "description", lineErrors, {
      nullable: true,
    });
    const quantity = line.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
      lineErrors.push({
        field: "quantity",
        code: "invalid_number",
        message: "quantity must be a finite JSON number",
      });
    }
    const unitPriceCents = integerValue(line, "unit_price_cents", lineErrors, {
      required: true,
      minimum: -9_000_000_000_000,
      maximum: 9_000_000_000_000,
    });
    const projectId = integerValue(line, "project_id", lineErrors, {
      nullable: true,
      minimum: 1,
    });
    if (
      lineErrors.length === 0 &&
      typeof quantity === "number" &&
      typeof unitPriceCents === "number"
    ) {
      try {
        calculateInvoiceLineAmountCents(quantity, unitPriceCents);
      } catch {
        lineErrors.push({
          field: "quantity",
          code: "amount_out_of_range",
          message: "quantity and unit_price_cents produce an invalid amount",
        });
      }
    }
    if (lineErrors.length > 0) {
      errors.push(
        ...lineErrors.map((error) => ({
          ...error,
          field: `${field}.${error.field}`,
        })),
      );
      return [];
    }
    return [
      {
        kind: kind!,
        description: description ?? null,
        quantity: quantity as number,
        unitPriceCents: unitPriceCents!,
        projectId: projectId ?? null,
      },
    ];
  });
};

/**
 * A band's terms. Everything, or a ceiling in exactly one unit with a grouping
 * for what is billed past it -- and a term that does not apply is refused
 * rather than ignored, since a limit on a band that takes everything would
 * read as one that does not.
 */
const parseBandTerms = (body: JsonObject, errors: FieldError[]) => {
  const claimMode = enumValue(body, "claim_mode", claimModes, errors, true);
  const seconds = integerValue(body, "claim_ceiling_seconds", errors, {
    nullable: true,
    minimum: 1,
  });
  const cents = integerValue(body, "claim_ceiling_cents", errors, {
    nullable: true,
    minimum: 1,
  });
  const overage = Object.hasOwn(body, "overage_summary_type")
    ? nullableEnumValue(body, "overage_summary_type", timeSummaryTypes, errors)
    : null;
  if (claimMode === "all") {
    for (const [field, value] of [
      ["claim_ceiling_seconds", seconds],
      ["claim_ceiling_cents", cents],
      ["overage_summary_type", overage],
    ] as const) {
      if (value !== undefined && value !== null) {
        errors.push({
          field,
          code: "not_applicable",
          message: `${field} applies only to a band with a ceiling`,
        });
      }
    }
  }
  if (claimMode === "ceiling") {
    const inSeconds = seconds !== undefined && seconds !== null;
    const inCents = cents !== undefined && cents !== null;
    if (inSeconds === inCents) {
      errors.push({
        field: "claim_ceiling",
        code: "one_required",
        message:
          "a ceiling needs one of claim_ceiling_seconds or claim_ceiling_cents",
      });
    }
    if (overage === null) {
      errors.push({
        field: "overage_summary_type",
        code: "required",
        message: "a ceiling needs overage_summary_type for the hours past it",
      });
    }
  }
  return {
    claimMode: claimMode!,
    claimCeilingSeconds: seconds ?? null,
    claimCeilingCents: cents ?? null,
    overageSummaryType: overage ?? null,
  };
};

const parseGenerationRequest = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<InvoiceGenerationCommand["request"]> => {
  const body = await readObjectBody(context);
  const kindErrors: FieldError[] = [];
  const kind =
    enumValue(body, "kind", generationKinds, kindErrors) ?? "tracked";
  assertFields(kindErrors);
  if (kind === "free_form") {
    // The client is the whole request. A range, a project or a summary type
    // would describe tracked work a blank draft never reads, so each is
    // refused rather than ignored.
    const errors = unknownFieldErrors(body, new Set(["kind", "client_id"]));
    const clientId = integerValue(body, "client_id", errors, {
      required: true,
      minimum: 1,
    });
    assertFields(errors);
    return { kind, clientId: clientId! };
  }
  if (kind === "banded") {
    // A band bills its fee and leaves expenses alone, so the summary types a
    // tracked request prices its selection with are refused here.
    const errors = unknownFieldErrors(
      body,
      new Set([
        "kind",
        "client_id",
        "from",
        "to",
        "project_ids",
        "line_items",
        "claim_mode",
        "claim_ceiling_seconds",
        "claim_ceiling_cents",
        "overage_summary_type",
      ]),
    );
    const selection = parseGenerationSelection(body, errors);
    const lineItems = parseFeeLines(body, errors);
    const terms = parseBandTerms(body, errors);
    assertFields(errors);
    return {
      kind,
      clientId: selection.clientId!,
      from: selection.from ?? null,
      to: selection.to!,
      projectIds: selection.projectIds as number[],
      lineItems,
      ...terms,
    };
  }
  const errors = unknownFieldErrors(
    body,
    new Set([
      "kind",
      "client_id",
      "from",
      "to",
      "project_ids",
      "time_summary_type",
      "expense_summary_type",
    ]),
  );
  const { clientId, from, to, projectIds } = parseGenerationSelection(
    body,
    errors,
  );
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
    from: from ?? null,
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
    let generated: InvoiceResource & { band?: InvoiceBandClaimResource };
    try {
      generated = await options.generation.generate({
        commandId,
        principal,
        request,
      });
    } catch (error) {
      return translateMoneyError(error);
    }
    // What a band covered is the command's answer, not part of the invoice.
    const { band, ...invoice } = generated;
    return context.json(
      {
        data: invoice,
        ...(band === undefined ? {} : { band }),
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

const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The invoice list's order, as the keyset chassis needs it: where a row sits,
 * how two places compare, and how a place travels in a cursor -- issue date,
 * number and id, which is the whole sort key and names exactly one row.
 */
const invoiceListOrder: KeysetOrder<InvoiceResource, InvoiceListPosition> = {
  positionOf: (invoice) => ({
    issueDate: invoice.issue_date,
    number: invoice.number,
    id: invoice.id,
  }),
  compare: compareInvoiceListPositions,
  encode: (position) => [position.issueDate, position.number, position.id],
  decode: (value) => {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [issueDate, number, id] = value as unknown[];
    if (
      typeof issueDate !== "string" ||
      !canonicalDatePattern.test(issueDate) ||
      typeof number !== "string" ||
      number.length === 0 ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1
    ) {
      return null;
    }
    return { issueDate, number, id };
  },
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
    const number = invoiceNumberFilter(requestUrl);
    return context.json(
      await keysetCursorPage({
        requestUrl,
        cursorSigningKey: options.cursorSigningKey,
        viewer: principal,
        serializer: (invoice: Readonly<InvoiceResource>) => ({ ...invoice }),
        // Newest first. By id, ascending, a new invoice sat behind every page
        // of an imported book, whose ids run newest first.
        order: invoiceListOrder,
        source: {
          // The snapshot stays the whole collection's. It bounds the
          // traversal against later inserts; it is not a count of what
          // matches, and narrowing it to the filtered set would make the
          // cursor mean something different on each page.
          snapshot: () => options.service.invoiceListSnapshot(),
          list: (window) =>
            options.service.listInvoices({
              ...window,
              ...(states === undefined ? {} : { states }),
              ...(clientIds === undefined ? {} : { clientIds }),
              ...(number === undefined ? {} : { number }),
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

/**
 * Cc addresses as the Send dialog gives them: optional, the same shape and the
 * same normalization as the To list, never an address that is already To.
 */
const parseCopies = (
  body: JsonObject,
  to: readonly { name: string; email: string }[],
  errors: FieldError[],
): Array<{ name: string; email: string }> => {
  if (!Object.hasOwn(body, "cc")) return [];
  const raw = body.cc;
  if (!Array.isArray(raw) || raw.length > 99) {
    errors.push({
      field: "cc",
      code: "invalid_array",
      message: "cc must be an array of at most 99 recipients",
    });
    return [];
  }
  const addressed = new Set(to.map(({ email }) => email));
  const seen = new Set<string>();
  return raw.flatMap((entry, index) => {
    if (
      !isJsonObject(entry) ||
      Object.keys(entry).some((field) => field !== "name" && field !== "email") ||
      typeof entry.name !== "string" ||
      typeof entry.email !== "string"
    ) {
      errors.push({
        field: `cc[${index}]`,
        code: "invalid_recipient",
        message: "each cc recipient requires exact name and email strings",
      });
      return [];
    }
    const name = entry.name.normalize("NFC").trim();
    const email = entry.email.normalize("NFC").trim().toLowerCase();
    if (name.length > 200 || email.length > 254 || !deliveryEmailPattern.test(email)) {
      errors.push({
        field: `cc[${index}]`,
        code: "invalid_email",
        message: "cc recipient must contain a valid bounded email address",
      });
      return [];
    }
    if (addressed.has(email) || seen.has(email)) {
      errors.push({
        field: `cc[${index}]`,
        code: "duplicate",
        message: addressed.has(email)
          ? "a cc recipient is already a To recipient"
          : "cc email addresses must be unique",
      });
      return [];
    }
    seen.add(email);
    return [{ name, email }];
  });
};

/**
 * A subject or message the Send dialog typed, as a template. Absent takes the
 * organization's invoice template; present must be text.
 */
const templateText = (
  body: JsonObject,
  field: "subject" | "message",
  maximum: number,
  errors: FieldError[],
): string | undefined => {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (typeof value !== "string" || value.length > maximum) {
    errors.push({
      field,
      code: "invalid_string",
      message: `${field} must be a string of at most ${maximum} characters`,
    });
    return undefined;
  }
  return value;
};

const booleanField = (
  body: JsonObject,
  field: string,
  errors: FieldError[],
): boolean | undefined => {
  if (!Object.hasOwn(body, field)) return undefined;
  if (typeof body[field] !== "boolean") {
    errors.push({ field, code: "invalid_boolean", message: `${field} must be true or false` });
    return undefined;
  }
  return body[field] as boolean;
};

/**
 * The Send dialog's attachment choices, for a preview. Each is optional and
 * laid over what the invoice would do anyway, so a preview shows the choices
 * on screen before anything is saved.
 */
const parseAttachmentChoices = (
  body: JsonObject,
  errors: FieldError[],
): InvoiceAttachmentChoices => {
  const document = booleanField(body, "attach_pdf", errors);
  const files = booleanField(body, "attach_files", errors);
  const append = booleanField(body, "append_pdfs", errors);
  let journal: InvoiceAttachmentChoices["journal"];
  if (Object.hasOwn(body, "attach_journal")) {
    const value = body.attach_journal;
    if (value === "detailed" || value === "summary" || value === false) journal = value;
    else
      errors.push({
        field: "attach_journal",
        code: "invalid",
        message: 'attach_journal must be "detailed", "summary", or false',
      });
  }
  let journalFormats: readonly JournalFormat[] | undefined;
  if (Object.hasOwn(body, "journal_formats")) {
    const parsed = parseJournalFormats(body.journal_formats);
    if (parsed === null)
      errors.push({
        field: "journal_formats",
        code: "invalid",
        message: 'journal_formats must be a non-empty list of distinct "pdf", "csv" and "xlsx"',
      });
    else journalFormats = parsed;
  }
  return {
    ...(document === undefined ? {} : { document }),
    ...(files === undefined ? {} : { files }),
    ...(append === undefined ? {} : { append }),
    ...(journal === undefined ? {} : { journal }),
    ...(journalFormats === undefined ? {} : { journalFormats }),
  };
};

const deliveryFields = [
  "expected_version",
  "recipients",
  "cc",
  "subject",
  "message",
  "send_me_a_copy",
  "sender_identity_id",
  "template_version",
] as const;

const previewChoiceFields = [
  "attach_pdf",
  "attach_files",
  "append_pdfs",
  "attach_journal",
  "journal_formats",
] as const;

interface DeliveryRequest {
  readonly version: number | undefined;
  readonly to: readonly { name: string; email: string }[];
  readonly cc: readonly { name: string; email: string }[];
  readonly subject: string | undefined;
  readonly message: string | undefined;
  readonly sendMeACopy: boolean;
  readonly senderIdentityId: number | undefined;
  readonly templateVersion: number | undefined;
}

const parseDeliveryRequest = (
  body: JsonObject,
  errors: FieldError[],
  /** A preview changes nothing, so it names no version to change. */
  purpose: "send" | "preview" = "send",
): DeliveryRequest => {
  const to = parseDeliveryRecipients(body, errors);
  return {
    version:
      purpose === "send" || Object.hasOwn(body, "expected_version")
        ? expectedVersion(body, errors)
        : undefined,
    to,
    cc: parseCopies(body, to, errors),
    subject: templateText(body, "subject", 998, errors),
    message: templateText(body, "message", 100_000, errors),
    sendMeACopy: booleanField(body, "send_me_a_copy", errors) ?? false,
    senderIdentityId:
      integerValue(body, "sender_identity_id", errors, { minimum: 1 }) ?? undefined,
    templateVersion:
      integerValue(body, "template_version", errors, { minimum: 1 }) ?? undefined,
  };
};

/**
 * The email one Send dialog submission produces, composed once for the send
 * and for its preview, so the preview cannot drift from what goes.
 */
interface ComposedDelivery {
  readonly invoice: InvoiceDeliveryContext;
  readonly template: { readonly version: number };
  readonly sender: {
    readonly id: number;
    readonly version: number;
    readonly evidenceVersion: number;
    readonly displayName: string;
    readonly email: string;
    readonly replyToEmail: string | null;
  };
  readonly author: { readonly name: string; readonly email: string | null };
  readonly to: readonly { name: string; email: string }[];
  readonly cc: readonly { name: string; email: string }[];
  /** Whether the sender's own address is among the copies. */
  readonly senderCopied: boolean;
  readonly subject: string;
  readonly text: string;
  readonly pdfAttached: boolean;
}

/** The refusal for a deployment that composes no organization mail at all. */
const deliveryUnavailable = (): ApiError =>
  new ApiError({
    status: 503,
    code: "email_delivery_unavailable",
    message: "Invoice email delivery is not configured.",
  });

/** The sender an email that names none leaves from: the default, unless archived. */
const defaultSender = (
  senders: readonly SenderIdentityConfigurationRecord[],
): SenderIdentityConfigurationRecord | null =>
  senders.find((candidate) => candidate.isDefault && candidate.archivedAt === null) ?? null;

/**
 * The sender, once it is one an invoice email may leave from: there is one,
 * the provider has vouched for it, and the mailer accepts it. Otherwise the
 * refusal a send meets. The send and the Send dialog's readiness both ask
 * here, so the dialog cannot offer an email the send would then refuse.
 */
const usableSender = async (
  mailer: Pick<SenderBoundQueuedMailer, "assertAvailable">,
  sender: SenderIdentityConfigurationRecord | null,
): Promise<SenderIdentityConfigurationRecord & { evidence: SenderEvidenceConfigurationRecord }> => {
  if (sender === null || sender.evidence === null) {
    throw new ApiError({
      status: 409,
      code: "sender_identity_missing",
      message: "Configure and verify an organization sender before sending.",
    });
  }
  try {
    await mailer.assertAvailable(sender.id);
  } catch (error) {
    if (error instanceof SenderIdentityUnavailableError) {
      throw new ApiError({ status: 409, code: error.code, message: error.message });
    }
    throw error;
  }
  return { ...sender, evidence: sender.evidence };
};

/** What the readiness read needs: the senders, and the mailer that would send. */
export interface InvoiceEmailReadinessPorts {
  readonly configuration: Pick<EmailConfigurationService, "listSenderIdentities">;
  readonly mailer: Pick<SenderBoundQueuedMailer, "assertAvailable">;
}

/**
 * Whether an invoice email could leave right now. `code` and `message` are the
 * refusal a send would meet, and both are null when it would not meet one.
 */
export interface InvoiceEmailReadiness {
  readonly available: boolean;
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * The questions a send that names no sender asks -- is there a mail transport,
 * a default sender the provider vouched for, a mailer that accepts it -- asked
 * without sending anything. The Send dialog opens on the answer: delivering by
 * email whenever it can, and saying why not when it cannot.
 */
export const invoiceEmailReadiness = async (
  ports: InvoiceEmailReadinessPorts | undefined,
): Promise<InvoiceEmailReadiness> => {
  try {
    if (ports === undefined) throw deliveryUnavailable();
    await usableSender(
      ports.mailer,
      defaultSender(await ports.configuration.listSenderIdentities()),
    );
    return { available: true, code: null, message: null };
  } catch (error) {
    // A refusal is the answer. Anything else is a failure to find it out, and
    // says so rather than reading as "email is off".
    if (!(error instanceof ApiError)) throw error;
    return { available: false, code: error.code, message: error.message };
  }
};

const composeDelivery = async (
  options: ResolvedMoneyResourceRouteOptions,
  principal: UserPrincipal,
  invoiceId: number,
  request: DeliveryRequest,
  pdfAttached: (invoiceId: number) => Promise<boolean>,
): Promise<ComposedDelivery> => {
  if (options.invoiceDelivery === undefined) throw deliveryUnavailable();
  const delivery = options.invoiceDelivery;
  const configuration = delivery.configuration;
  const [invoice, template, author, senderList, alwaysCc, copy] = await Promise.all([
    options.service.getInvoiceDeliveryContext(invoiceId),
    configuration.getTemplate("invoice", request.templateVersion),
    options.service.senderSnapshot(principal.userId),
    request.senderIdentityId === undefined
      ? configuration.listSenderIdentities()
      : Promise.resolve([]),
    delivery.sending?.alwaysCc() ?? Promise.resolve([]),
    request.sendMeACopy
      ? (delivery.sending?.senderCopy(principal.userId) ?? Promise.resolve(null))
      : Promise.resolve(null),
  ]);
  if (invoice === null) throw notFound("invoice");
  if (template === null) throw notFound("invoice email template version");
  if (author === null) {
    throw new ApiError({
      status: 403,
      code: "principal_unavailable",
      message: "The acting user is no longer available.",
    });
  }
  const sender = await usableSender(
    delivery.mailer,
    request.senderIdentityId === undefined
      ? defaultSender(senderList)
      : await configuration.getSenderIdentity(request.senderIdentityId),
  );
  // Copied on the actual email -- the same message the client reads -- rather
  // than sent a second one: the sender sees exactly what went.
  const self =
    request.sendMeACopy && copy !== null && copy.email !== null
      ? { name: copy.name, email: copy.email }
      : null;
  if (request.sendMeACopy && self === null) {
    throw validationError([
      {
        field: "send_me_a_copy",
        code: "no_address",
        message: "You have no email address to be copied at.",
      },
    ]);
  }
  const cc = invoiceEmailCopies({ to: request.to, cc: request.cc, alwaysCc, sender: self });
  if (request.to.length + cc.length > 100) {
    throw validationError([
      {
        field: "cc",
        code: "too_many_recipients",
        message: "An invoice email can go to at most 100 addresses.",
      },
    ]);
  }

  // Minted before the body is composed, because the body is persisted at
  // send time and the link has to be inside it. A deployment without a pay
  // provider, or an invoice with nothing owed, gets no link rather than a
  // failed send -- collecting online is an option, not a precondition.
  const paymentUrl =
    options.invoicePaymentUrl === undefined
      ? null
      : await options.invoicePaymentUrl(invoiceId).catch(() => null);
  const attached = await pdfAttached(invoiceId);
  let composed: { subject: string; text: string };
  try {
    composed = composeInvoiceEmail({
      invoice,
      subjectTemplate: request.subject ?? template.subjectTemplate,
      messageTemplate: request.message ?? template.textTemplate,
      paymentUrl,
      pdfAttached: attached,
      // The send and its preview both read the weekday at the moment they are
      // composed, which for the send is the moment it is recorded.
      sentAt: options.clock(),
    });
  } catch (error) {
    if (error instanceof EmailTemplateVariableError) {
      const inSubject = (request.subject ?? template.subjectTemplate).includes(`%${error.variable}%`);
      throw validationError([
        { field: inSubject ? "subject" : "message", code: error.code, message: error.message },
      ]);
    }
    throw error;
  }
  // A header is one line. A subject that came out blank, or carries a line
  // break a variable brought in, would be refused by the mailer after the
  // invoice was marked sent; it is refused here, before anything is.
  if (composed.subject === "" || composed.subject.length > 998 || /[\r\n]/u.test(composed.subject)) {
    throw validationError([
      {
        field: "subject",
        code: "invalid_subject",
        message: "The subject must come out as one line of 1 to 998 characters.",
      },
    ]);
  }
  return {
    invoice,
    template: { version: template.version },
    sender: {
      id: sender.id,
      version: sender.version,
      evidenceVersion: sender.evidence.version,
      displayName: sender.displayName,
      email: sender.email,
      replyToEmail: sender.replyToEmail,
    },
    author,
    to: request.to,
    cc,
    senderCopied: self !== null && cc.some(({ email }) => email === self.email),
    subject: composed.subject,
    text: composed.text,
    pdfAttached: attached,
  };
};

const addressData = (people: readonly { name: string; email: string }[]) =>
  people.map(({ name, email }) => ({ name, email }));

/** How many preview emails one invoice may send in an hour. */
const previewEmailsPerHour = 5;

const installInvoiceDelivery = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ResolvedMoneyResourceRouteOptions,
): void => {
  const documents = () => options.invoiceDelivery?.documents;

  api.post("/invoices/:id/deliveries", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const commandId = idempotencyKey(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(body, new Set([...deliveryFields, "confirmed"]));
    const request = parseDeliveryRequest(body, errors);
    if (body.confirmed !== true) {
      errors.push({
        field: "confirmed",
        code: "confirmation_required",
        message: "confirmed must be true to send this invoice email",
      });
    }
    assertFields(errors);
    const composed = await composeDelivery(
      options,
      principal,
      invoiceId,
      request,
      (id) => documents()?.attachesPdf(id) ?? Promise.resolve(false),
    );
    const eventId = (await eventIds(invoiceId, commandId))[0];
    try {
      const result = await options.service.executeLifecycle({
        ...commonCommand(principal, invoiceId, commandId, options.clock()),
        command: "send",
        expectedVersion: request.version!,
        messageId: await stableId("invoice-message", invoiceId, commandId),
        eventId,
        message: {
          sentBy: composed.author.name,
          sentByEmail: composed.author.email,
          sentFrom: composed.sender.displayName,
          sentFromEmail: composed.sender.email,
          recipients: request.to,
          ...(composed.cc.length === 0 ? {} : { cc: composed.cc }),
          subject: composed.subject,
          body: composed.text,
          attachPdf: composed.pdfAttached,
          sendMeACopy: composed.senderCopied,
          thankYou: false,
          reminder: false,
          sendReminderOn: null,
        },
        delivery: {
          templateVersion: composed.template.version,
          senderIdentityId: composed.sender.id,
          senderIdentityVersion: composed.sender.version,
          senderEvidenceVersion: composed.sender.evidenceVersion,
          fromName: composed.sender.displayName,
          fromEmail: composed.sender.email,
          replyToEmail: composed.sender.replyToEmail,
          subject: composed.subject,
          textBody: composed.text,
          // One plain-text part, as Harvest's invoice email was: nothing can
          // render differently in a client that prefers HTML.
          htmlBody: null,
          // The derivation the first recipient's delivery always had, so a
          // send keeps the identity it would have had before copies existed.
          deliveryId: await stableId("invoice-email-0", invoiceId, commandId),
          recipients: [
            ...request.to.map((person) => ({ ...person, role: "to" as const })),
            ...composed.cc.map((person) => ({ ...person, role: "cc" as const })),
          ],
        },
      });
      return context.json(await invoiceEnvelope(options.service, invoiceId, result), 202);
    } catch (error) {
      return translateMoneyError(error);
    }
  });

  /**
   * What the Send dialog would send, without sending it: the same request, the
   * same composition, and the attachments the entry would build -- with no
   * message, no delivery, no event and nothing stored.
   */
  api.post("/invoices/:id/deliveries/preview", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(body, new Set([...deliveryFields, ...previewChoiceFields]));
    const request = parseDeliveryRequest(body, errors, "preview");
    const choices = parseAttachmentChoices(body, errors);
    assertFields(errors);
    const port = documents();
    const attachments =
      port === undefined ? [] : await port.preview({ invoiceId, choices });
    const composed = await composeDelivery(options, principal, invoiceId, request, async () =>
      attachments.some(({ kind }) => kind === "invoice"),
    );
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          from: { name: composed.sender.displayName, email: composed.sender.email },
          reply_to: composed.sender.replyToEmail,
          to: addressData(composed.to),
          cc: addressData(composed.cc),
          send_me_a_copy: composed.senderCopied,
          subject: composed.subject,
          text: composed.text,
          html: null,
          attachments: attachments.map((attachment) => ({
            kind: attachment.kind,
            filename: attachment.filename,
            content_type: attachment.contentType,
            byte_size: attachment.byteSize,
            appended: [...attachment.appended],
            not_appended: attachment.notAppended,
          })),
        },
        links: {
          document: `/api/v1/invoices/${invoiceId}/deliveries/preview/document${
            choices.append === undefined ? "" : `?append_pdfs=${String(choices.append)}`
          }`,
        },
      },
      200,
    );
  });

  /**
   * The invoice document a send would carry, stamped PREVIEW on every page, for
   * the dialog's download link. Rendered on request and stored nowhere.
   */
  api.get("/invoices/:id/deliveries/preview/document", async (context) => {
    requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const appendQuery = context.req.query("append_pdfs");
    if (appendQuery !== undefined && appendQuery !== "true" && appendQuery !== "false") {
      throw validationError([
        { field: "append_pdfs", code: "invalid_boolean", message: "append_pdfs must be true or false" },
      ]);
    }
    const port = documents();
    if (port === undefined) {
      throw new ApiError({
        status: 503,
        code: "invoice_documents_unavailable",
        message: "Invoice documents are not available in this deployment.",
      });
    }
    const document = await port.previewDocument({
      invoiceId,
      choices: appendQuery === undefined ? {} : { append: appendQuery === "true" },
    });
    if (document === null) throw notFound("invoice");
    return new Response(document.bytes as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(document.bytes.byteLength),
        "content-disposition": `attachment; filename="${document.filename.replace(/[^\x20-\x7e]|["\\]/gu, "_")}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  /**
   * The same email, stamped PREVIEW, to the person asking and nobody else --
   * through the real mailer, so the attachments arrive as a client would get
   * them. Not a send: no message, no delivery, no event, no reminder. Logged
   * by the mailer as the preview it is, and limited per invoice per hour.
   */
  api.post("/invoices/:id/deliveries/preview/send", async (context) => {
    const principal = requireWrite(context);
    const invoiceId = resourceId(context.req.param("id")!, "invoice");
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(body, new Set([...deliveryFields, ...previewChoiceFields]));
    const request = parseDeliveryRequest(body, errors, "preview");
    const choices = parseAttachmentChoices(body, errors);
    assertFields(errors);
    const sending = options.invoiceDelivery?.sending;
    if (options.invoiceDelivery === undefined || sending === undefined) {
      throw new ApiError({
        status: 503,
        code: "email_delivery_unavailable",
        message: "Invoice email delivery is not configured.",
      });
    }
    const self = await sending.senderCopy(principal.userId);
    if (self === null || self.email === null) {
      throw new ApiError({
        status: 409,
        code: "no_address",
        message: "You have no email address to send a preview to.",
      });
    }
    const now = options.clock();
    const since = new Date(Date.parse(now) - 3_600_000).toISOString();
    if ((await sending.previewsSince(invoiceId, since)) >= previewEmailsPerHour) {
      throw new ApiError({
        status: 429,
        code: "preview_rate_limited",
        message: `An invoice can send ${previewEmailsPerHour} previews an hour. Try again later.`,
      });
    }
    const port = documents();
    const manifest = port === undefined ? [] : await port.preview({ invoiceId, choices });
    const composed = await composeDelivery(options, principal, invoiceId, request, async () =>
      manifest.some(({ kind }) => kind === "invoice"),
    );
    const stamped = invoiceEmailPreview({
      subject: composed.subject,
      text: composed.text,
      to: composed.to,
      cc: composed.cc,
    });
    const previewId = `${invoiceId}-${now.replace(/[^0-9]/gu, "")}-${crypto.randomUUID()}`;
    const attachments =
      port === undefined ? [] : await port.stagePreview({ invoiceId, previewId, choices });
    const log = await options.invoiceDelivery.mailer.enqueue(
      {
        senderIdentityId: composed.sender.id,
        to: [self.name === "" ? { email: self.email } : { email: self.email, name: self.name }],
        template: `invoice_preview:${composed.template.version}`,
        subject: stamped.subject,
        text: stamped.text,
        html: stamped.html,
        related: { type: "invoice_preview", id: invoiceId },
      },
      ...(attachments.length === 0 ? [] : [attachments]),
    );
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          delivery_id: log.id,
          to: [{ name: self.name, email: self.email }],
          subject: stamped.subject,
        },
      },
      202,
    );
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
    "purchase_order",
  ]);
  const errors = unknownFieldErrors(body, allowed);
  const amountConfig = body.amount_config;
  // Trimmed, and blank is none: a purchase order of spaces is a field
  // somebody cleared, and "none" has one spelling.
  const rawPurchaseOrder = Object.hasOwn(body, "purchase_order")
    ? stringValue(body, "purchase_order", errors, { nullable: true, max: 1_000 })
    : undefined;
  const purchaseOrder =
    rawPurchaseOrder === undefined
      ? undefined
      : rawPurchaseOrder === null || rawPurchaseOrder.trim() === ""
        ? null
        : rawPurchaseOrder.trim();
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
    ...(purchaseOrder === undefined ? {} : { purchaseOrder }),
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
