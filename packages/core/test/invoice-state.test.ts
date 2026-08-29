import { describe, expect, it } from "vitest";
import {
  InvoiceLifecycleError,
  assertInvoiceLifecycleSnapshot,
  calculateInvoiceLineAmountCents,
  deriveInvoicePaymentStatus,
  invoiceEventTypes,
  invoiceLifecycleCommands,
  reduceInvoiceCommand,
  reduceInvoiceEdit,
  reduceInvoicePaymentMutation,
  type InvoiceActorType,
  type InvoiceEventType,
  type InvoiceLifecycleCommand,
  type InvoiceLifecycleErrorCode,
  type InvoiceLifecycleSnapshot,
  type InvoicePaymentMutationKind,
  type InvoiceState,
} from "../src/invoice-state.js";

const oldTime = "2026-08-26T10:00:00Z";
const occurredAt = "2026-08-27T12:34:56.789Z";

const invoice = (
  state: InvoiceState,
  changes: Partial<InvoiceLifecycleSnapshot> = {},
): InvoiceLifecycleSnapshot => {
  const common: InvoiceLifecycleSnapshot = {
    state,
    closeReason: null,
    closeWriteOffCents: 0,
    writtenOffCents: 0,
    dueAmountCents: 10_000,
    paymentCount: 0,
    sentAt: state === "draft" ? null : oldTime,
    paidAt: null,
    paidDate: null,
    closedAt: null,
    version: 7,
    updatedAt: oldTime,
  };
  if (state === "paid") {
    common.dueAmountCents = 0;
    common.paymentCount = 1;
    common.paidAt = oldTime;
  } else if (state === "closed") {
    common.closeReason = "source_closed";
    common.closedAt = oldTime;
  }
  return { ...common, ...changes };
};

const expectLifecycleError = (
  operation: () => unknown,
  code: InvoiceLifecycleErrorCode,
): void => {
  try {
    operation();
    throw new Error("expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(InvoiceLifecycleError);
    expect((error as InvoiceLifecycleError).code).toBe(code);
  }
};

describe("invoice payment status", () => {
  it.each([
    [0, 10_000, "unpaid"],
    [0, 0, "unpaid"],
    [0, -1, "unpaid"],
    [1, 10_000, "partial"],
    [4, 1, "partial"],
    [1, 0, "paid"],
    [3, -100, "paid"],
  ] as const)(
    "[unit] derives count=%d due=%d as %s",
    (paymentCount, dueAmountCents, expected) => {
      expect(deriveInvoicePaymentStatus({ paymentCount, dueAmountCents })).toBe(
        expected,
      );
    },
  );

  it.each([
    [{ paymentCount: -1, dueAmountCents: 1 }, /paymentCount/],
    [{ paymentCount: 1.5, dueAmountCents: 1 }, /paymentCount/],
    [{ paymentCount: 1, dueAmountCents: Number.NaN }, /dueAmountCents/],
    [{ paymentCount: 1, dueAmountCents: 9_000_000_000_001 }, /dueAmountCents/],
  ])("[unit] rejects malformed payment facts", (facts, message) => {
    expect(() => deriveInvoicePaymentStatus(facts)).toThrow(message);
  });
});

describe("native invoice line amount", () => {
  it.each([
    [1.5, 101, 152],
    [-1.5, 101, -152],
    [0.1, 105, 11],
    [1e-3, 500, 1],
    [2, -25, -50],
  ])(
    "[unit] computes %s × %s as exact half-away cents",
    (quantity, unit, expected) => {
      expect(calculateInvoiceLineAmountCents(quantity, unit)).toBe(expected);
    },
  );

  it("[unit] rejects floating and aggregate overflow instead of rounding unsafely", () => {
    expect(() =>
      calculateInvoiceLineAmountCents(Number.POSITIVE_INFINITY, 1),
    ).toThrow(RangeError);
    expect(() => calculateInvoiceLineAmountCents(2, 9_000_000_000_000)).toThrow(
      RangeError,
    );
  });
});

describe("invoice lifecycle commands", () => {
  const legal: Record<InvoiceState, readonly InvoiceLifecycleCommand[]> = {
    draft: ["send", "cancel", "source_close"],
    open: ["send", "view", "draft", "cancel", "write_off", "source_close"],
    paid: ["view", "source_close"],
    closed: ["view", "reopen"],
  };
  const commandEvent: Record<InvoiceLifecycleCommand, InvoiceEventType> = {
    send: "invoice.sent",
    view: "invoice.viewed",
    draft: "invoice.drafted",
    cancel: "invoice.cancelled",
    write_off: "invoice.written_off",
    reopen: "invoice.reopened",
    source_close: "invoice.closed",
  };

  for (const state of ["draft", "open", "paid", "closed"] as const) {
    for (const command of invoiceLifecycleCommands) {
      const isLegal = legal[state].includes(command);
      it(`[unit] ${isLegal ? "accepts" : "rejects"} ${command} from ${state}`, () => {
        const current = invoice(state);
        const actorType: InvoiceActorType =
          command === "view" ? "system" : "user";
        if (!isLegal) {
          expectLifecycleError(
            () =>
              reduceInvoiceCommand(current, {
                command,
                actorType,
                occurredAt,
              }),
            "illegal_invoice_transition",
          );
          return;
        }
        const result = reduceInvoiceCommand(current, {
          command,
          actorType,
          occurredAt,
        });
        expect(result.events).toEqual([commandEvent[command]]);
        expect(() =>
          assertInvoiceLifecycleSnapshot(result.invoice),
        ).not.toThrow();
      });
    }
  }

  it("[unit] sends a draft, sets sent time once, and advances its mutation version", () => {
    const current = invoice("draft");
    const sent = reduceInvoiceCommand(current, {
      command: "send",
      actorType: "user",
      occurredAt,
    }).invoice;
    expect(sent).toMatchObject({
      state: "open",
      sentAt: occurredAt,
      version: 8,
      updatedAt: occurredAt,
    });

    const resentAt = "2026-08-28T00:00:00Z";
    const resent = reduceInvoiceCommand(sent, {
      command: "send",
      actorType: "contact",
      occurredAt: resentAt,
    }).invoice;
    expect(resent).toMatchObject({
      state: "open",
      sentAt: occurredAt,
      version: 9,
      updatedAt: resentAt,
    });
  });

  it("[unit] records a system view without changing invoice state, version, or timestamp", () => {
    const current = Object.freeze(invoice("paid"));
    const result = reduceInvoiceCommand(current, {
      command: "view",
      actorType: "system",
      occurredAt,
    });
    expect(result.invoice).toEqual(current);
    expect(result.invoice).not.toBe(current);
    expect(result.events).toEqual(["invoice.viewed"]);
  });

  it.each(["user", "contact"] as const)(
    "[unit] rejects a caller-supplied view from a %s actor",
    (actorType) => {
      expectLifecycleError(
        () =>
          reduceInvoiceCommand(invoice("open"), {
            command: "view",
            actorType,
            occurredAt,
          }),
        "system_actor_required",
      );
    },
  );

  it("[unit] returns an open invoice to draft only without payments or write-off", () => {
    const current = invoice("open", { sentAt: oldTime });
    const result = reduceInvoiceCommand(current, {
      command: "draft",
      actorType: "user",
      occurredAt,
    });
    expect(result.invoice).toMatchObject({
      state: "draft",
      sentAt: oldTime,
      paidAt: null,
      paidDate: null,
      version: 8,
      updatedAt: occurredAt,
    });
  });

  it.each([
    invoice("open", { paymentCount: 1, dueAmountCents: 1 }),
    invoice("open", { writtenOffCents: 1, dueAmountCents: 9_999 }),
  ])(
    "[unit] rejects draft when payment or write-off history exists",
    (current) => {
      expectLifecycleError(
        () =>
          reduceInvoiceCommand(current, {
            command: "draft",
            actorType: "user",
            occurredAt,
          }),
        "illegal_invoice_transition",
      );
    },
  );

  it("[unit] cancels a partially paid invoice without changing totals or payments", () => {
    const current = invoice("open", {
      dueAmountCents: 7_500,
      paymentCount: 1,
      writtenOffCents: 500,
    });
    const result = reduceInvoiceCommand(current, {
      command: "cancel",
      actorType: "user",
      occurredAt,
    });
    expect(result.invoice).toMatchObject({
      state: "closed",
      closeReason: "cancelled",
      closeWriteOffCents: 0,
      writtenOffCents: 500,
      dueAmountCents: 7_500,
      paymentCount: 1,
      closedAt: occurredAt,
      paidAt: null,
      paidDate: null,
    });
  });

  it("[unit] writes off exactly the current due and re-open reverses only that addition", () => {
    const current = invoice("open", {
      dueAmountCents: 7_500,
      paymentCount: 1,
      writtenOffCents: 500,
    });
    const writtenOff = reduceInvoiceCommand(current, {
      command: "write_off",
      actorType: "user",
      occurredAt,
    });
    expect(writtenOff.invoice).toMatchObject({
      state: "closed",
      closeReason: "written_off",
      closeWriteOffCents: 7_500,
      writtenOffCents: 8_000,
      dueAmountCents: 0,
      closedAt: occurredAt,
      paidAt: null,
      paidDate: null,
    });
    expect(writtenOff.events).toEqual(["invoice.written_off"]);

    const reopenedAt = "2026-08-28T01:02:03Z";
    const reopened = reduceInvoiceCommand(writtenOff.invoice, {
      command: "reopen",
      actorType: "user",
      occurredAt: reopenedAt,
    });
    expect(reopened.invoice).toMatchObject({
      state: "open",
      closeReason: null,
      closeWriteOffCents: 0,
      writtenOffCents: 500,
      dueAmountCents: 7_500,
      closedAt: null,
      paidAt: null,
      paidDate: null,
      version: 9,
      updatedAt: reopenedAt,
    });
    expect(reopened.events).toEqual(["invoice.reopened"]);
  });

  it.each([0, -1])(
    "[unit] rejects write-off when due is not positive (%d)",
    (dueAmountCents) => {
      expectLifecycleError(
        () =>
          reduceInvoiceCommand(invoice("open", { dueAmountCents }), {
            command: "write_off",
            actorType: "user",
            occurredAt,
          }),
        "illegal_invoice_transition",
      );
    },
  );

  it("[unit] rejects a write-off that would exceed the cents bound", () => {
    expectLifecycleError(
      () =>
        reduceInvoiceCommand(
          invoice("open", {
            dueAmountCents: 1,
            writtenOffCents: 9_000_000_000_000,
          }),
          { command: "write_off", actorType: "user", occurredAt },
        ),
      "invalid_mutation_input",
    );
  });

  it("[unit] re-opens a source-closed paid invoice and preserves its paid date", () => {
    const current = invoice("closed", {
      dueAmountCents: -1,
      paymentCount: 2,
      paidAt: null,
      paidDate: "2026-08-20",
    });
    const result = reduceInvoiceCommand(current, {
      command: "reopen",
      actorType: "user",
      occurredAt,
    });
    expect(result.invoice).toMatchObject({
      state: "paid",
      closeReason: null,
      closedAt: null,
      paidAt: null,
      paidDate: "2026-08-20",
    });
  });

  it("[unit] re-opens a closed paid-status invoice with a deterministic fallback timestamp", () => {
    const current = invoice("closed", {
      dueAmountCents: 0,
      paymentCount: 1,
      paidAt: null,
      paidDate: null,
    });
    const result = reduceInvoiceCommand(current, {
      command: "reopen",
      actorType: "user",
      occurredAt,
    });
    expect(result.invoice).toMatchObject({
      state: "paid",
      paidAt: occurredAt,
      paidDate: null,
    });
  });

  it("[unit] source-close preserves paid timestamps and never invents a write-off", () => {
    const current = invoice("paid", { paidAt: null, paidDate: "2026-08-25" });
    const result = reduceInvoiceCommand(current, {
      command: "source_close",
      actorType: "system",
      occurredAt,
    });
    expect(result.invoice).toMatchObject({
      state: "closed",
      closeReason: "source_closed",
      closeWriteOffCents: 0,
      writtenOffCents: 0,
      paidAt: null,
      paidDate: "2026-08-25",
      closedAt: occurredAt,
    });
    expect(result.events).toEqual(["invoice.closed"]);
  });

  it("[unit] does not mutate its input snapshot", () => {
    const current = Object.freeze(invoice("draft"));
    reduceInvoiceCommand(current, {
      command: "send",
      actorType: "user",
      occurredAt,
    });
    expect(current).toEqual(invoice("draft"));
  });
});

describe("payment-mutation reconciliation and event sets", () => {
  const paymentAt = { paidAt: "2026-08-27T09:00:00Z", paidDate: null };
  const paymentOn = { paidAt: null, paidDate: "2026-08-27" };

  it.each([
    {
      name: "record unpaid to partial",
      before: invoice("open"),
      kind: "record",
      due: 7_500,
      count: 1,
      paymentTimestamp: paymentAt,
      state: "open",
      events: ["payment.recorded", "invoice.partially_paid"],
    },
    {
      name: "record partial to paid",
      before: invoice("open", { dueAmountCents: 5_000, paymentCount: 1 }),
      kind: "record",
      due: 0,
      count: 2,
      paymentTimestamp: paymentOn,
      state: "paid",
      events: ["payment.recorded", "invoice.paid"],
    },
    {
      name: "record while already paid",
      before: invoice("paid"),
      kind: "record",
      due: -500,
      count: 2,
      paymentTimestamp: paymentAt,
      state: "paid",
      events: ["payment.recorded"],
    },
    {
      name: "update partial to paid",
      before: invoice("open", { dueAmountCents: 100, paymentCount: 1 }),
      kind: "update",
      due: -100,
      count: 1,
      paymentTimestamp: paymentAt,
      state: "paid",
      events: ["payment.updated", "invoice.paid"],
    },
    {
      name: "update paid to partial",
      before: invoice("paid"),
      kind: "update",
      due: 100,
      count: 1,
      paymentTimestamp: paymentAt,
      state: "open",
      events: ["payment.updated", "invoice.partially_paid"],
    },
    {
      name: "delete sole partial payment to unpaid",
      before: invoice("open", { dueAmountCents: 100, paymentCount: 1 }),
      kind: "delete",
      due: 1_000,
      count: 0,
      paymentTimestamp: null,
      state: "open",
      events: ["payment.deleted", "invoice.unpaid"],
    },
    {
      name: "delete paid payment to partial",
      before: invoice("paid", { paymentCount: 2 }),
      kind: "delete",
      due: 100,
      count: 1,
      paymentTimestamp: null,
      state: "open",
      events: ["payment.deleted", "invoice.partially_paid"],
    },
    {
      name: "delete an overpayment and remain paid",
      before: invoice("paid", { dueAmountCents: -1_000, paymentCount: 2 }),
      kind: "delete",
      due: 0,
      count: 1,
      paymentTimestamp: null,
      state: "paid",
      events: ["payment.deleted"],
    },
  ] as const)(
    "[unit] emits the ordered event set for $name",
    ({ before, kind, due, count, paymentTimestamp, state, events }) => {
      const result = reduceInvoicePaymentMutation(before, {
        kind,
        occurredAt,
        afterDueAmountCents: due,
        afterPaymentCount: count,
        paymentTimestamp,
      });
      expect(result.events).toEqual(events);
      expect(result.invoice).toMatchObject({
        state,
        dueAmountCents: due,
        paymentCount: count,
        version: 8,
        updatedAt: occurredAt,
      });
      expect(() =>
        assertInvoiceLifecycleSnapshot(result.invoice),
      ).not.toThrow();
    },
  );

  it("[unit] copies the triggering payment date when payment first makes the invoice paid", () => {
    const result = reduceInvoicePaymentMutation(invoice("open"), {
      kind: "record",
      occurredAt,
      afterDueAmountCents: 0,
      afterPaymentCount: 1,
      paymentTimestamp: paymentOn,
    });
    expect(result.invoice).toMatchObject({
      paidAt: null,
      paidDate: "2026-08-27",
    });
  });

  it("[unit] preserves the original paid timestamp while payment status remains paid", () => {
    const result = reduceInvoicePaymentMutation(
      invoice("paid", { paidAt: null, paidDate: "2026-08-20" }),
      {
        kind: "record",
        occurredAt,
        afterDueAmountCents: -500,
        afterPaymentCount: 2,
        paymentTimestamp: paymentAt,
      },
    );
    expect(result.invoice).toMatchObject({
      paidAt: null,
      paidDate: "2026-08-20",
    });
  });

  it("[unit] clears paid timestamps when deleting a payment regresses paid to open", () => {
    const result = reduceInvoicePaymentMutation(invoice("paid"), {
      kind: "delete",
      occurredAt,
      afterDueAmountCents: 10_000,
      afterPaymentCount: 0,
      paymentTimestamp: null,
    });
    expect(result.invoice).toMatchObject({
      state: "open",
      paidAt: null,
      paidDate: null,
    });
    expect(result.events).toEqual(["payment.deleted", "invoice.unpaid"]);
  });

  it.each(["draft", "closed"] as const)(
    "[unit] rejects payments on a %s invoice",
    (state) => {
      expectLifecycleError(
        () =>
          reduceInvoicePaymentMutation(invoice(state), {
            kind: "record",
            occurredAt,
            afterDueAmountCents: 0,
            afterPaymentCount: 1,
            paymentTimestamp: paymentAt,
          }),
        "invoice_payment_not_allowed",
      );
    },
  );

  it.each([
    ["record", 0, paymentAt],
    ["update", 2, paymentAt],
    ["delete", 1, null],
  ] as const)(
    "[unit] rejects a %s mutation with an impossible payment count",
    (kind, afterPaymentCount, paymentTimestamp) => {
      expectLifecycleError(
        () =>
          reduceInvoicePaymentMutation(
            invoice("open", { paymentCount: 1, dueAmountCents: 1 }),
            {
              kind,
              occurredAt,
              afterDueAmountCents: 1,
              afterPaymentCount,
              paymentTimestamp,
            },
          ),
        "invalid_mutation_input",
      );
    },
  );

  it.each([
    ["record", null],
    ["update", null],
    ["delete", paymentAt],
  ] as const)(
    "[unit] rejects a %s mutation with the wrong post-mutation timestamp shape",
    (kind, paymentTimestamp) => {
      const before =
        kind === "record"
          ? invoice("open")
          : invoice("open", { paymentCount: 1, dueAmountCents: 1 });
      const count = kind === "record" ? 1 : kind === "delete" ? 0 : 1;
      expectLifecycleError(
        () =>
          reduceInvoicePaymentMutation(before, {
            kind,
            occurredAt,
            afterDueAmountCents: 1,
            afterPaymentCount: count,
            paymentTimestamp,
          }),
        "invalid_mutation_input",
      );
    },
  );

  it.each([
    { paidAt: null, paidDate: null },
    { paidAt: occurredAt, paidDate: "2026-08-27" },
    { paidAt: "2026-02-30T00:00:00Z", paidDate: null },
    { paidAt: null, paidDate: "2026-02-30" },
  ])("[unit] rejects a non-canonical payment timestamp", (paymentTimestamp) => {
    expectLifecycleError(
      () =>
        reduceInvoicePaymentMutation(invoice("open"), {
          kind: "record",
          occurredAt,
          afterDueAmountCents: 1,
          afterPaymentCount: 1,
          paymentTimestamp,
        }),
      "invalid_mutation_input",
    );
  });

  it.each(["record", "update", "delete"] as const)(
    "[unit] leaves the caller snapshot untouched during payment %s",
    (kind: InvoicePaymentMutationKind) => {
      const current = Object.freeze(
        kind === "record"
          ? invoice("open")
          : invoice("open", { paymentCount: 1, dueAmountCents: 1 }),
      );
      reduceInvoicePaymentMutation(current, {
        kind,
        occurredAt,
        afterDueAmountCents: kind === "delete" ? 100 : 1,
        afterPaymentCount: kind === "record" ? 1 : kind === "delete" ? 0 : 1,
        paymentTimestamp: kind === "delete" ? null : paymentAt,
      });
      expect(current.version).toBe(7);
      expect(current.updatedAt).toBe(oldTime);
    },
  );
});

describe("existing-invoice edit reconciliation and event sets", () => {
  it("[unit] keeps a draft draft and emits only invoice.updated", () => {
    const result = reduceInvoiceEdit(invoice("draft"), {
      occurredAt,
      afterDueAmountCents: -100,
    });
    expect(result.invoice).toMatchObject({
      state: "draft",
      dueAmountCents: -100,
      paidAt: null,
      paidDate: null,
      version: 8,
      updatedAt: occurredAt,
    });
    expect(result.events).toEqual(["invoice.updated"]);
  });

  it("[unit] emits invoice.updated without an outcome when status is unchanged", () => {
    const result = reduceInvoiceEdit(
      invoice("open", { paymentCount: 1, dueAmountCents: 500 }),
      { occurredAt, afterDueAmountCents: 250 },
    );
    expect(result.invoice.state).toBe("open");
    expect(result.events).toEqual(["invoice.updated"]);
  });

  it("[unit] emits update before paid and timestamps a totals-derived paid entry at occurrence", () => {
    const result = reduceInvoiceEdit(
      invoice("open", { paymentCount: 1, dueAmountCents: 500 }),
      { occurredAt, afterDueAmountCents: 0 },
    );
    expect(result.invoice).toMatchObject({
      state: "paid",
      paidAt: occurredAt,
      paidDate: null,
    });
    expect(result.events).toEqual(["invoice.updated", "invoice.paid"]);
  });

  it("[unit] emits update before partial and clears timestamps on paid regression", () => {
    const result = reduceInvoiceEdit(invoice("paid"), {
      occurredAt,
      afterDueAmountCents: 1,
    });
    expect(result.invoice).toMatchObject({
      state: "open",
      paidAt: null,
      paidDate: null,
    });
    expect(result.events).toEqual([
      "invoice.updated",
      "invoice.partially_paid",
    ]);
  });

  it("[unit] preserves the paid timestamp when an edit leaves status paid", () => {
    const result = reduceInvoiceEdit(
      invoice("paid", { paidAt: null, paidDate: "2026-08-20" }),
      { occurredAt, afterDueAmountCents: -200 },
    );
    expect(result.invoice).toMatchObject({
      state: "paid",
      paidAt: null,
      paidDate: "2026-08-20",
    });
    expect(result.events).toEqual(["invoice.updated"]);
  });

  it("[unit] rejects every native edit while terminally closed", () => {
    expectLifecycleError(
      () =>
        reduceInvoiceEdit(invoice("closed"), {
          occurredAt,
          afterDueAmountCents: 1,
        }),
      "invoice_closed",
    );
  });
});

describe("invoice snapshot invariants", () => {
  it.each([
    ["active close reason", invoice("open", { closeReason: "cancelled" })],
    ["closed without reason", invoice("closed", { closeReason: null })],
    ["active closed timestamp", invoice("open", { closedAt: oldTime })],
    [
      "non-written-off adjustment",
      invoice("closed", { closeWriteOffCents: 1 }),
    ],
    [
      "zero written-off adjustment",
      invoice("closed", {
        closeReason: "written_off",
        closeWriteOffCents: 0,
      }),
    ],
    [
      "adjustment above total write-off",
      invoice("closed", {
        closeReason: "written_off",
        closeWriteOffCents: 2,
        writtenOffCents: 1,
      }),
    ],
    ["draft payment", invoice("draft", { paymentCount: 1 })],
    [
      "open with paid predicate",
      invoice("open", { paymentCount: 1, dueAmountCents: 0 }),
    ],
    ["paid without a payment", invoice("paid", { paymentCount: 0 })],
    ["paid with positive due", invoice("paid", { dueAmountCents: 1 })],
    ["paid without timestamp", invoice("paid", { paidAt: null })],
    [
      "paid with conflicting timestamps",
      invoice("paid", { paidDate: "2026-08-26" }),
    ],
    ["open with paid timestamp", invoice("open", { paidAt: oldTime })],
    ["malformed update timestamp", invoice("open", { updatedAt: "yesterday" })],
    ["negative version", invoice("open", { version: -1 })],
  ] as const)("[unit] rejects %s", (_name, malformed) => {
    expectLifecycleError(
      () => assertInvoiceLifecycleSnapshot(malformed),
      "invalid_invoice_snapshot",
    );
  });

  it("[unit] permits terminal closure to override paid payment status", () => {
    const closedPaid = invoice("closed", {
      paymentCount: 2,
      dueAmountCents: -100,
      paidAt: null,
      paidDate: null,
    });
    expect(deriveInvoicePaymentStatus(closedPaid)).toBe("paid");
    expect(() => assertInvoiceLifecycleSnapshot(closedPaid)).not.toThrow();
  });

  it("[unit] preserves and can reopen a migrated closed row without closed timestamp evidence", () => {
    const migrated = invoice("closed", { closedAt: null });

    expect(() => assertInvoiceLifecycleSnapshot(migrated)).not.toThrow();
    expect(
      reduceInvoiceCommand(migrated, {
        command: "reopen",
        actorType: "user",
        occurredAt,
      }).invoice,
    ).toMatchObject({
      state: "open",
      closeReason: null,
      closedAt: null,
      updatedAt: occurredAt,
    });
  });

  it("[unit] exports exactly the D22 producer vocabulary owned by this story", () => {
    expect(invoiceEventTypes).toEqual([
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
    ]);
  });
});
