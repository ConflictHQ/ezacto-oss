export const invoiceStates = ["draft", "open", "paid", "closed"] as const;
export const invoiceCloseReasons = [
  "cancelled",
  "written_off",
  "source_closed",
] as const;
export const invoicePaymentStatuses = ["unpaid", "partial", "paid"] as const;
export const invoiceLifecycleCommands = [
  "send",
  "view",
  "draft",
  "cancel",
  "write_off",
  "reopen",
  "source_close",
] as const;
export const invoiceEventTypes = [
  "invoice.sent",
  "invoice.viewed",
  "invoice.updated",
  "invoice.drafted",
  "invoice.reopened",
  "invoice.cancelled",
  "invoice.written_off",
  "invoice.closed",
  "invoice.unpaid",
  "invoice.partially_paid",
  "invoice.paid",
  "payment.recorded",
  "payment.updated",
  "payment.deleted",
] as const;

export type InvoiceState = (typeof invoiceStates)[number];
export type InvoiceCloseReason = (typeof invoiceCloseReasons)[number];
export type InvoicePaymentStatus = (typeof invoicePaymentStatuses)[number];
export type InvoiceLifecycleCommand = (typeof invoiceLifecycleCommands)[number];
export type InvoiceEventType = (typeof invoiceEventTypes)[number];
export type InvoiceActorType = "user" | "contact" | "system";
export type InvoicePaymentMutationKind = "record" | "update" | "delete";

export interface InvoicePaymentFacts {
  dueAmountCents: number;
  paymentCount: number;
}

export interface InvoiceLifecycleSnapshot extends InvoicePaymentFacts {
  state: InvoiceState;
  closeReason: InvoiceCloseReason | null;
  closeWriteOffCents: number;
  writtenOffCents: number;
  sentAt: string | null;
  paidAt: string | null;
  paidDate: string | null;
  closedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface InvoicePaidTimestamp {
  paidAt: string | null;
  paidDate: string | null;
}

export interface InvoiceCommandInput {
  command: InvoiceLifecycleCommand;
  actorType: InvoiceActorType;
  occurredAt: string;
}

export interface InvoicePaymentMutationInput {
  kind: InvoicePaymentMutationKind;
  occurredAt: string;
  afterDueAmountCents: number;
  afterPaymentCount: number;
  /** The post-mutation payment for record/update; null for delete. */
  paymentTimestamp: InvoicePaidTimestamp | null;
}

export interface InvoiceEditInput {
  occurredAt: string;
  afterDueAmountCents: number;
}

export interface InvoiceStateReduction {
  invoice: InvoiceLifecycleSnapshot;
  events: readonly InvoiceEventType[];
}

export type InvoiceLifecycleErrorCode =
  | "invalid_invoice_snapshot"
  | "invalid_mutation_input"
  | "illegal_invoice_transition"
  | "system_actor_required"
  | "invoice_payment_not_allowed"
  | "invoice_closed";

export class InvoiceLifecycleError extends Error {
  readonly code: InvoiceLifecycleErrorCode;

  constructor(code: InvoiceLifecycleErrorCode, message: string) {
    super(message);
    this.name = "InvoiceLifecycleError";
    this.code = code;
  }
}

/**
 * Compute a native line's authoritative cents from the JSON decimal quantity
 * without floating-point multiplication. The number's shortest decimal form is
 * converted to an integer ratio and rounded half away from zero per D21.
 */
export const calculateInvoiceLineAmountCents = (
  quantity: number,
  unitPriceCents: number,
): number => {
  if (!Number.isFinite(quantity)) {
    throw new RangeError("invoice line quantity must be finite");
  }
  if (
    !Number.isSafeInteger(unitPriceCents) ||
    Math.abs(unitPriceCents) > 9_000_000_000_000
  ) {
    throw new RangeError(
      "invoice line unit price must be bounded integer cents",
    );
  }

  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(
    quantity.toString(),
  );
  if (match === null)
    throw new RangeError("invoice line quantity is not a decimal number");
  const fractional = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError("invoice line quantity exponent is out of range");
  }
  let numerator = BigInt(`${match[2]}${fractional}`);
  if (match[1] === "-") numerator = -numerator;
  const scale = fractional.length - exponent;
  let denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  if (scale < 0) numerator *= 10n ** BigInt(-scale);

  const product = numerator * BigInt(unitPriceCents);
  const magnitude = product < 0n ? -product : product;
  let rounded = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) rounded += 1n;
  if (product < 0n) rounded = -rounded;
  if (rounded < -9_000_000_000_000n || rounded > 9_000_000_000_000n) {
    throw new RangeError("invoice line amount exceeds the cents limit");
  }
  return Number(rounded);
};

const centsLimit = 9_000_000_000_000;
const canonicalTimestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const canonicalDate = /^(\d{4})-(\d{2})-(\d{2})$/;

const fail = (code: InvoiceLifecycleErrorCode, message: string): never => {
  throw new InvoiceLifecycleError(code, message);
};

const assertCanonicalTimestamp = (
  value: string,
  field: string,
  code: InvoiceLifecycleErrorCode,
): void => {
  const match = canonicalTimestamp.exec(value);
  const parts =
    match ?? fail(code, `${field} must be a canonical UTC timestamp with Z`);
  const normalized = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.${(parts[7] ?? "").padEnd(3, "0")}Z`;
  const milliseconds = Date.parse(normalized);
  if (
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== normalized
  ) {
    fail(code, `${field} must be a real canonical UTC instant`);
  }
};

const assertNullableTimestamp = (
  value: string | null,
  field: string,
  code: InvoiceLifecycleErrorCode,
): void => {
  if (value !== null) assertCanonicalTimestamp(value, field, code);
};

const assertCanonicalDate = (
  value: string,
  field: string,
  code: InvoiceLifecycleErrorCode,
): void => {
  const match = canonicalDate.exec(value);
  if (match === null) fail(code, `${field} must be a canonical date`);
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    fail(code, `${field} must be a real canonical date`);
  }
};

const assertCents = (
  value: number,
  field: string,
  code: InvoiceLifecycleErrorCode,
  nonNegative = false,
): void => {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > centsLimit ||
    (nonNegative && value < 0)
  ) {
    fail(
      code,
      `${field} must be ${nonNegative ? "a non-negative " : ""}integer within the cents limit`,
    );
  }
};

const assertPaymentCount = (
  value: number,
  field: string,
  code: InvoiceLifecycleErrorCode,
): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${field} must be a non-negative safe integer`);
  }
};

const hasOnePaidTimestamp = (invoice: InvoicePaidTimestamp): boolean =>
  (invoice.paidAt === null) !== (invoice.paidDate === null);

const assertPaidTimestamp = (
  value: InvoicePaidTimestamp,
  field: string,
  code: InvoiceLifecycleErrorCode,
): void => {
  if (!hasOnePaidTimestamp(value)) {
    fail(code, `${field} must have exactly one of paidAt or paidDate`);
  }
  assertNullableTimestamp(value.paidAt, `${field}.paidAt`, code);
  if (value.paidDate !== null) {
    assertCanonicalDate(value.paidDate, `${field}.paidDate`, code);
  }
};

export const deriveInvoicePaymentStatus = (
  facts: InvoicePaymentFacts,
): InvoicePaymentStatus => {
  assertCents(facts.dueAmountCents, "dueAmountCents", "invalid_mutation_input");
  assertPaymentCount(
    facts.paymentCount,
    "paymentCount",
    "invalid_mutation_input",
  );
  if (facts.paymentCount === 0) return "unpaid";
  return facts.dueAmountCents <= 0 ? "paid" : "partial";
};

export const assertInvoiceLifecycleSnapshot = (
  invoice: InvoiceLifecycleSnapshot,
): void => {
  assertCents(
    invoice.dueAmountCents,
    "dueAmountCents",
    "invalid_invoice_snapshot",
  );
  assertCents(
    invoice.writtenOffCents,
    "writtenOffCents",
    "invalid_invoice_snapshot",
    true,
  );
  assertCents(
    invoice.closeWriteOffCents,
    "closeWriteOffCents",
    "invalid_invoice_snapshot",
    true,
  );
  assertPaymentCount(
    invoice.paymentCount,
    "paymentCount",
    "invalid_invoice_snapshot",
  );
  if (!Number.isSafeInteger(invoice.version) || invoice.version < 0) {
    fail(
      "invalid_invoice_snapshot",
      "version must be a non-negative safe integer",
    );
  }
  assertCanonicalTimestamp(
    invoice.updatedAt,
    "updatedAt",
    "invalid_invoice_snapshot",
  );
  assertNullableTimestamp(invoice.sentAt, "sentAt", "invalid_invoice_snapshot");
  assertNullableTimestamp(invoice.paidAt, "paidAt", "invalid_invoice_snapshot");
  if (invoice.paidDate !== null) {
    assertCanonicalDate(
      invoice.paidDate,
      "paidDate",
      "invalid_invoice_snapshot",
    );
  }
  assertNullableTimestamp(
    invoice.closedAt,
    "closedAt",
    "invalid_invoice_snapshot",
  );

  const isClosed = invoice.state === "closed";
  if (isClosed !== (invoice.closeReason !== null)) {
    fail(
      "invalid_invoice_snapshot",
      "state is closed exactly when closeReason is present",
    );
  }
  // 0006 preserves historical source timestamps exactly. A pre-0006 Harvest
  // close can therefore be terminal without closedAt evidence, while every
  // online D22 close still writes occurredAt in reduceInvoiceCommand below.
  if (!isClosed && invoice.closedAt !== null) {
    fail("invalid_invoice_snapshot", "only a closed invoice may have closedAt");
  }
  if (invoice.closeReason === "written_off") {
    if (
      invoice.closeWriteOffCents <= 0 ||
      invoice.closeWriteOffCents > invoice.writtenOffCents
    ) {
      fail(
        "invalid_invoice_snapshot",
        "a written-off close requires a positive bounded closure adjustment",
      );
    }
  } else if (invoice.closeWriteOffCents !== 0) {
    fail(
      "invalid_invoice_snapshot",
      "only a written-off close may retain a closure adjustment",
    );
  }

  if (invoice.paidAt !== null && invoice.paidDate !== null) {
    fail(
      "invalid_invoice_snapshot",
      "an invoice cannot have both paidAt and paidDate",
    );
  }
  const paymentStatus = deriveInvoicePaymentStatus(invoice);
  if (invoice.state === "draft") {
    if (invoice.paymentCount !== 0) {
      fail("invalid_invoice_snapshot", "a draft invoice cannot have payments");
    }
    if (invoice.paidAt !== null || invoice.paidDate !== null) {
      fail(
        "invalid_invoice_snapshot",
        "a draft invoice cannot have a paid timestamp",
      );
    }
  } else if (invoice.state === "open") {
    if (paymentStatus === "paid") {
      fail(
        "invalid_invoice_snapshot",
        "an active invoice with paid payment status must be stored as paid",
      );
    }
    if (invoice.paidAt !== null || invoice.paidDate !== null) {
      fail(
        "invalid_invoice_snapshot",
        "an open invoice cannot have a paid timestamp",
      );
    }
  } else if (invoice.state === "paid") {
    if (paymentStatus !== "paid") {
      fail(
        "invalid_invoice_snapshot",
        "a paid invoice must have non-positive due and at least one payment",
      );
    }
    if (!hasOnePaidTimestamp(invoice)) {
      fail(
        "invalid_invoice_snapshot",
        "a paid invoice must have exactly one paid timestamp",
      );
    }
  }
};

const mutationBase = (
  invoice: InvoiceLifecycleSnapshot,
  occurredAt: string,
): InvoiceLifecycleSnapshot => {
  assertCanonicalTimestamp(occurredAt, "occurredAt", "invalid_mutation_input");
  if (invoice.version === Number.MAX_SAFE_INTEGER) {
    fail(
      "invalid_mutation_input",
      "invoice version cannot be incremented safely",
    );
  }
  return {
    ...invoice,
    version: invoice.version + 1,
    updatedAt: occurredAt,
  };
};

const outcomeEvent = (
  before: InvoicePaymentStatus,
  after: InvoicePaymentStatus,
): InvoiceEventType | null => {
  if (before === after) return null;
  switch (after) {
    case "unpaid":
      return "invoice.unpaid";
    case "partial":
      return "invoice.partially_paid";
    case "paid":
      return "invoice.paid";
  }
};

const withActivePaymentState = (
  invoice: InvoiceLifecycleSnapshot,
  beforeStatus: InvoicePaymentStatus,
  occurredAt: string,
  paidTimestamp: InvoicePaidTimestamp,
  paidTimestampSource: "payment" | "mutation",
): InvoiceLifecycleSnapshot => {
  const afterStatus = deriveInvoicePaymentStatus(invoice);
  if (invoice.state === "draft") return invoice;
  if (invoice.state === "closed") return invoice;
  if (afterStatus === "paid") {
    if (beforeStatus === "paid" && hasOnePaidTimestamp(invoice)) {
      return { ...invoice, state: "paid" };
    }
    if (paidTimestampSource === "payment") {
      assertPaidTimestamp(
        paidTimestamp,
        "paymentTimestamp",
        "invalid_mutation_input",
      );
      return {
        ...invoice,
        state: "paid",
        paidAt: paidTimestamp.paidAt,
        paidDate: paidTimestamp.paidDate,
      };
    }
    return {
      ...invoice,
      state: "paid",
      paidAt: occurredAt,
      paidDate: null,
    };
  }
  return { ...invoice, state: "open", paidAt: null, paidDate: null };
};

const illegalTransition = (
  state: InvoiceState,
  command: InvoiceLifecycleCommand,
): never =>
  fail(
    "illegal_invoice_transition",
    `invoice command ${command} is illegal from ${state}`,
  );

/**
 * Applies one online lifecycle command without mutating its input. Persistence,
 * optimistic concurrency, and outbox insertion stay in the database operation.
 */
export const reduceInvoiceCommand = (
  invoice: InvoiceLifecycleSnapshot,
  input: InvoiceCommandInput,
): InvoiceStateReduction => {
  assertInvoiceLifecycleSnapshot(invoice);
  assertCanonicalTimestamp(
    input.occurredAt,
    "occurredAt",
    "invalid_mutation_input",
  );

  if (input.command === "view") {
    if (input.actorType !== "system") {
      fail("system_actor_required", "invoice view is a system-only command");
    }
    if (
      invoice.state !== "open" &&
      invoice.state !== "paid" &&
      invoice.state !== "closed"
    ) {
      return illegalTransition(invoice.state, input.command);
    }
    return { invoice: { ...invoice }, events: ["invoice.viewed"] };
  }

  const next = mutationBase(invoice, input.occurredAt);
  switch (input.command) {
    case "send":
      if (invoice.state !== "draft" && invoice.state !== "open") {
        return illegalTransition(invoice.state, input.command);
      }
      return {
        invoice: {
          ...next,
          state: "open",
          sentAt: invoice.sentAt ?? input.occurredAt,
        },
        events: ["invoice.sent"],
      };
    case "draft":
      if (invoice.state !== "open") {
        return illegalTransition(invoice.state, input.command);
      }
      if (invoice.paymentCount !== 0 || invoice.writtenOffCents !== 0) {
        fail(
          "illegal_invoice_transition",
          "draft requires no payments and zero write-off",
        );
      }
      return {
        invoice: { ...next, state: "draft" },
        events: ["invoice.drafted"],
      };
    case "cancel":
      if (invoice.state !== "draft" && invoice.state !== "open") {
        return illegalTransition(invoice.state, input.command);
      }
      return {
        invoice: {
          ...next,
          state: "closed",
          closeReason: "cancelled",
          closeWriteOffCents: 0,
          closedAt: input.occurredAt,
        },
        events: ["invoice.cancelled"],
      };
    case "write_off": {
      if (invoice.state !== "open") {
        return illegalTransition(invoice.state, input.command);
      }
      if (invoice.dueAmountCents <= 0) {
        fail(
          "illegal_invoice_transition",
          "write_off requires a positive due amount",
        );
      }
      const writtenOffCents = invoice.writtenOffCents + invoice.dueAmountCents;
      assertCents(
        writtenOffCents,
        "writtenOffCents after write_off",
        "invalid_mutation_input",
        true,
      );
      return {
        invoice: {
          ...next,
          state: "closed",
          closeReason: "written_off",
          closeWriteOffCents: invoice.dueAmountCents,
          writtenOffCents,
          dueAmountCents: 0,
          closedAt: input.occurredAt,
        },
        events: ["invoice.written_off"],
      };
    }
    case "reopen": {
      if (invoice.state !== "closed") {
        return illegalTransition(invoice.state, input.command);
      }
      const writtenOffCents =
        invoice.writtenOffCents - invoice.closeWriteOffCents;
      const dueAmountCents =
        invoice.dueAmountCents + invoice.closeWriteOffCents;
      assertCents(
        writtenOffCents,
        "writtenOffCents after reopen",
        "invalid_mutation_input",
        true,
      );
      assertCents(
        dueAmountCents,
        "dueAmountCents after reopen",
        "invalid_mutation_input",
      );
      const reopened: InvoiceLifecycleSnapshot = {
        ...next,
        state: "open",
        closeReason: null,
        closeWriteOffCents: 0,
        writtenOffCents,
        dueAmountCents,
        closedAt: null,
      };
      const status = deriveInvoicePaymentStatus(reopened);
      if (status === "paid") {
        reopened.state = "paid";
        if (!hasOnePaidTimestamp(reopened)) {
          reopened.paidAt = input.occurredAt;
          reopened.paidDate = null;
        }
      } else {
        reopened.paidAt = null;
        reopened.paidDate = null;
      }
      return { invoice: reopened, events: ["invoice.reopened"] };
    }
    case "source_close":
      if (
        invoice.state !== "draft" &&
        invoice.state !== "open" &&
        invoice.state !== "paid"
      ) {
        return illegalTransition(invoice.state, input.command);
      }
      return {
        invoice: {
          ...next,
          state: "closed",
          closeReason: "source_closed",
          closeWriteOffCents: 0,
          closedAt: input.occurredAt,
        },
        events: ["invoice.closed"],
      };
  }
};

/** Reconciles lifecycle after one persisted payment mutation. */
export const reduceInvoicePaymentMutation = (
  invoice: InvoiceLifecycleSnapshot,
  input: InvoicePaymentMutationInput,
): InvoiceStateReduction => {
  assertInvoiceLifecycleSnapshot(invoice);
  if (invoice.state !== "open" && invoice.state !== "paid") {
    fail(
      "invoice_payment_not_allowed",
      `payments are not allowed on a ${invoice.state} invoice`,
    );
  }
  assertCents(
    input.afterDueAmountCents,
    "afterDueAmountCents",
    "invalid_mutation_input",
  );
  assertPaymentCount(
    input.afterPaymentCount,
    "afterPaymentCount",
    "invalid_mutation_input",
  );
  const expectedCount =
    input.kind === "record"
      ? invoice.paymentCount + 1
      : input.kind === "delete"
        ? invoice.paymentCount - 1
        : invoice.paymentCount;
  if (input.afterPaymentCount !== expectedCount || expectedCount < 0) {
    fail(
      "invalid_mutation_input",
      `${input.kind} payment count does not match the mutation`,
    );
  }
  if (input.kind === "delete") {
    if (input.paymentTimestamp !== null) {
      fail(
        "invalid_mutation_input",
        "a deleted payment has no post-mutation timestamp",
      );
    }
  } else if (input.paymentTimestamp === null) {
    fail(
      "invalid_mutation_input",
      `${input.kind} requires the post-mutation payment timestamp`,
    );
  } else {
    assertPaidTimestamp(
      input.paymentTimestamp,
      "paymentTimestamp",
      "invalid_mutation_input",
    );
  }

  const beforeStatus = deriveInvoicePaymentStatus(invoice);
  let next = mutationBase(invoice, input.occurredAt);
  next = {
    ...next,
    dueAmountCents: input.afterDueAmountCents,
    paymentCount: input.afterPaymentCount,
  };
  next = withActivePaymentState(
    next,
    beforeStatus,
    input.occurredAt,
    input.paymentTimestamp ?? { paidAt: null, paidDate: null },
    "payment",
  );
  const afterStatus = deriveInvoicePaymentStatus(next);
  const paymentEvent: Record<InvoicePaymentMutationKind, InvoiceEventType> = {
    record: "payment.recorded",
    update: "payment.updated",
    delete: "payment.deleted",
  };
  const changedStatusEvent = outcomeEvent(beforeStatus, afterStatus);
  return {
    invoice: next,
    events:
      changedStatusEvent === null
        ? [paymentEvent[input.kind]]
        : [paymentEvent[input.kind], changedStatusEvent],
  };
};

/**
 * Reconciles lifecycle after an edit to an existing invoice. The database owns
 * total calculation; this reducer owns state/timestamps and ordered event names.
 */
export const reduceInvoiceEdit = (
  invoice: InvoiceLifecycleSnapshot,
  input: InvoiceEditInput,
): InvoiceStateReduction => {
  assertInvoiceLifecycleSnapshot(invoice);
  if (invoice.state === "closed") {
    fail("invoice_closed", "a closed invoice rejects native edits");
  }
  assertCents(
    input.afterDueAmountCents,
    "afterDueAmountCents",
    "invalid_mutation_input",
  );
  const beforeStatus = deriveInvoicePaymentStatus(invoice);
  let next = mutationBase(invoice, input.occurredAt);
  next = { ...next, dueAmountCents: input.afterDueAmountCents };
  next = withActivePaymentState(
    next,
    beforeStatus,
    input.occurredAt,
    { paidAt: null, paidDate: null },
    "mutation",
  );
  const afterStatus = deriveInvoicePaymentStatus(next);
  const changedStatusEvent = outcomeEvent(beforeStatus, afterStatus);
  return {
    invoice: next,
    events:
      changedStatusEvent === null
        ? ["invoice.updated"]
        : ["invoice.updated", changedStatusEvent],
  };
};
