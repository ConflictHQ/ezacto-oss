import { describe, expect, it, vi } from "vitest";
import {
  createInvoiceThankYouSubscriber,
  type ThankYouMessage,
} from "../src/thank-you-subscriber.js";

/**
 * Issue 545. The part that decides a settled invoice is worth an email.
 */

const message = (overrides: Partial<ThankYouMessage> = {}): ThankYouMessage => ({
  deliveryId: 9100,
  senderIdentityId: 1,
  senderIdentityVersion: 0,
  senderEvidenceVersion: 1,
  fromName: "CONFLICT Billing",
  fromEmail: "billing@example.test",
  replyToEmail: null,
  to: [{ name: "Accounts Payable", email: "ap@example.test" }],
  templateVersion: 3,
  subject: "Thank you for your payment",
  textBody: "We received your payment.",
  htmlBody: null,
  ...overrides,
});

const harness = (prepared: ThankYouMessage | null = message()) => {
  const prepare = vi.fn(async () => prepared);
  const enqueuePersisted =
    vi.fn<
      (
        deliveryId: number,
        binding: Record<string, unknown>,
        body: Record<string, unknown>,
      ) => Promise<void>
    >(async () => undefined);
  const subscriber = createInvoiceThankYouSubscriber({ prepare }, {
    enqueuePersisted,
  } as never);
  return { subscriber, prepare, enqueuePersisted };
};

describe("which events it acts on", () => {
  it("[money] sends when the invoice becomes paid", async () => {
    const { subscriber, enqueuePersisted } = harness();
    await subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    expect(enqueuePersisted).toHaveBeenCalledTimes(1);
  });

  it("[money] ignores a payment that leaves the invoice part paid", async () => {
    // The reducer emits `invoice.partially_paid` when the status does not reach
    // paid. A $10 payment against a $10,000 invoice must thank nobody, and this
    // subscriber gets that for free by subscribing to the right event.
    const { subscriber, prepare, enqueuePersisted } = harness();
    await subscriber.deliver({ eventType: "invoice.partially_paid", aggregateId: 1315 });
    expect(prepare).not.toHaveBeenCalled();
    expect(enqueuePersisted).not.toHaveBeenCalled();
  });

  it("[money] ignores every other invoice event", async () => {
    const { subscriber, prepare } = harness();
    for (const eventType of [
      "invoice.sent",
      "invoice.viewed",
      "payment.recorded",
      "invoice.unpaid",
      "invoice.written_off",
    ]) {
      await subscriber.deliver({ eventType, aggregateId: 1315 });
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("what it queues", () => {
  it("[unit] addresses everyone the port named, on one message", async () => {
    const { subscriber, enqueuePersisted } = harness(
      message({
        to: [
          { name: "Accounts Payable", email: "ap@example.test" },
          { name: "", email: "adeyemi@example.test" },
        ],
      }),
    );
    await subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    const [, binding, body] = enqueuePersisted.mock.calls[0]!;
    expect(binding).toEqual({
      senderIdentityId: 1,
      senderIdentityVersion: 0,
      senderEvidenceVersion: 1,
      from: { email: "billing@example.test", name: "CONFLICT Billing" },
    });
    // A recipient with no name is addressed by address alone; an empty display
    // name renders as a stray comma in most clients.
    expect(body.to).toEqual([
      { email: "ap@example.test", name: "Accounts Payable" },
      { email: "adeyemi@example.test" },
    ]);
    expect(body.template).toBe("thank_you:3");
    expect(body.related).toEqual({ type: "invoice", id: 1315 });
  });

  it("[unit] carries a reply-to only when the sender has one", async () => {
    const { enqueuePersisted, subscriber } = harness();
    await subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    expect(enqueuePersisted.mock.calls[0]![1]).not.toHaveProperty("replyTo");

    const withReply = harness(message({ replyToEmail: "ar@example.test" }));
    await withReply.subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    expect(withReply.enqueuePersisted.mock.calls[0]![1]).toMatchObject({
      replyTo: [{ email: "ar@example.test" }],
    });
  });

  it("[unit] omits html rather than sending an empty body", async () => {
    const { enqueuePersisted, subscriber } = harness();
    await subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    expect(enqueuePersisted.mock.calls[0]![2]).not.toHaveProperty("html");
  });
});

describe("when there is nothing to send", () => {
  it("[unit] queues nothing when the port declines", async () => {
    // Off globally, opted out on this invoice, nobody was ever emailed it, or
    // already thanked. The port tells them apart; this does not need to.
    const { subscriber, enqueuePersisted } = harness(null);
    await subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 });
    expect(enqueuePersisted).not.toHaveBeenCalled();
  });

  it("[money] refuses to stay quiet when the queue is missing", async () => {
    // The intent is already recorded by this point. Returning silently would
    // leave the book saying a client was thanked when nothing was queued.
    const subscriber = createInvoiceThankYouSubscriber({
      prepare: vi.fn(async () => message()),
    });
    await expect(
      subscriber.deliver({ eventType: "invoice.paid", aggregateId: 1315 }),
    ).rejects.toThrow(/durable enqueue is unavailable/u);
  });
});
