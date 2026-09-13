import { describe, expect, it } from "vitest";
import {
  composeThankYou,
  type ThankYouInvoice,
  type ThankYouSender,
  type ThankYouTemplate,
} from "../src/thank-you.js";

/**
 * Issue 545. The half that turns a settled invoice into a message.
 */

const invoice = (overrides: Partial<ThankYouInvoice> = {}): ThankYouInvoice => ({
  invoiceId: 1315,
  number: "1315",
  subject: "August advisory",
  currency: "USD",
  amountCents: 172_5625,
  discountAmountCents: 0,
  taxAmountCents: 0,
  tax2AmountCents: 0,
  issueDate: "2026-08-31",
  dueDate: "2026-09-30",
  paidDate: "2026-09-12",
  organizationName: "CONFLICT",
  clientName: "Kestrel Environmental",
  lineItems: [
    {
      kind: "Service",
      description: "Advisory",
      quantity: 72.5,
      unitPriceCents: 23_800,
      amountCents: 172_5625,
    },
  ],
  ...overrides,
});

const template = (overrides: Partial<ThankYouTemplate> = {}): ThankYouTemplate => ({
  version: 3,
  subjectTemplate: "Thank you for your payment of %invoice_amount%",
  textTemplate: "%client_name%, we received %invoice_amount% on %invoice_paid_date%.",
  htmlTemplate: null,
  unknownVariablePolicy: "error",
  ...overrides,
});

const sender: ThankYouSender = {
  id: 1,
  version: 0,
  evidenceVersion: 1,
  displayName: "CONFLICT Billing",
  email: "billing@example.test",
  replyToEmail: null,
};

const compose = (
  invoiceOverrides: Partial<ThankYouInvoice> = {},
  templateOverrides: Partial<ThankYouTemplate> = {},
) =>
  composeThankYou({
    invoice: invoice(invoiceOverrides),
    template: template(templateOverrides),
    sender,
  });

describe("what the client reads", () => {
  it("[unit] fills the invoice into the subject and the body", () => {
    const composed = compose();
    expect(composed.subject).toBe("Thank you for your payment of $17,256.25");
    expect(composed.textBody).toContain(
      "Kestrel Environmental, we received $17,256.25 on 2026-09-12.",
    );
  });

  it("[unit] carries the settlement date, which no other kind has", () => {
    expect(compose({ paidDate: "2026-09-01" }).textBody).toContain("on 2026-09-01.");
  });

  it("[money] renders rather than fails when the invoice carries no settlement date", () => {
    // A thank-you that throws is a thank-you nobody receives. An empty date
    // reads badly; a failed send reads as nothing at all.
    expect(compose({ paidDate: null }).textBody).toContain("we received $17,256.25 on .");
  });

  it("[money] never offers a payment link", () => {
    // There is nothing left to pay. A link here invites a second payment.
    const composed = compose({}, { textTemplate: "Paid. [%invoice_payment_url%]" });
    expect(composed.textBody).toContain("Paid. []");
  });
});

describe("the work behind the figure", () => {
  it("[unit] appends the line items when the template never asks for them", () => {
    const composed = compose();
    expect(composed.textBody).toContain("Advisory");
    expect(composed.textBody.indexOf("Advisory")).toBeGreaterThan(
      composed.textBody.indexOf("we received"),
    );
  });

  it("[unit] leaves them where the template puts them, and does not repeat them", () => {
    const composed = compose({}, { textTemplate: "Lines:\n%invoice_line_items%\nThanks." });
    expect(composed.textBody.endsWith("Thanks.")).toBe(true);
    expect(composed.textBody.split("Advisory").length - 1).toBe(1);
  });

  it("[unit] renders an HTML body only when the template has one", () => {
    expect(compose().htmlBody).toBeNull();
    const composed = compose({}, { htmlTemplate: "<p>%client_name%</p>" });
    expect(composed.htmlBody).toContain("Kestrel Environmental");
  });
});

describe("what the record will say it was built from", () => {
  it("[security] reports the template and sender versions it actually used", () => {
    // These are written into an immutable record of what the client received.
    // Reporting a version other than the one rendered makes that record a lie.
    const composed = compose();
    expect(composed).toMatchObject({
      templateVersion: 3,
      senderIdentityId: 1,
      senderIdentityVersion: 0,
      senderEvidenceVersion: 1,
      fromName: "CONFLICT Billing",
      fromEmail: "billing@example.test",
      replyToEmail: null,
    });
  });

  it("[security] refuses a variable this kind does not have", () => {
    // `action_url` belongs to the auth emails. A template reaching for it is a
    // mistake, and the strict policy is what turns it into one.
    expect(() => compose({}, { textTemplate: "Go to %action_url%" })).toThrow();
  });
});
