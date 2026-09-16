import { describe, expect, it } from "vitest";
import {
  composeReminder,
  daysPastDue,
  type ReminderInvoice,
  type ReminderSender,
  type ReminderTemplate,
} from "../src/reminder.js";

/**
 * Issue 801. The half that turns an overdue invoice into a message.
 */

const invoice = (overrides: Partial<ReminderInvoice> = {}): ReminderInvoice => ({
  invoiceId: 1293,
  number: "1293",
  subject: "June advisory",
  currency: "USD",
  amountCents: 1_511_250,
  dueAmountCents: 1_511_250,
  discountAmountCents: 0,
  taxAmountCents: 0,
  tax2AmountCents: 0,
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  organizationName: "CONFLICT LLC",
  clientName: "Kestrel Environmental",
  lineItems: [
    {
      kind: "Service",
      description: "Advisory",
      quantity: 63.5,
      unitPriceCents: 23_800,
      amountCents: 1_511_250,
    },
  ],
  ...overrides,
});

const template = (overrides: Partial<ReminderTemplate> = {}): ReminderTemplate => ({
  version: 2,
  subjectTemplate: "Past due invoice reminder: #%invoice_number% from %company_name%",
  textTemplate:
    "Amount Due: %invoice_due_amount%\n\nThis is a friendly reminder to let you know that " +
    "Invoice %invoice_number% is %invoice_days_past_due% days past due.",
  htmlTemplate: null,
  unknownVariablePolicy: "error",
  ...overrides,
});

const sender: ReminderSender = {
  id: 1,
  version: 0,
  evidenceVersion: 1,
  displayName: "Finance team - CONFLICT",
  email: "billing@example.test",
  replyToEmail: "ar@example.test",
};

describe("composing a reminder", () => {
  it("[unit] says what is owed and how late it is, the way Harvest's did", () => {
    const composed = composeReminder({
      invoice: invoice(),
      template: template(),
      sender,
      onDate: "2026-08-14",
      paymentUrl: null,
    });
    expect(composed.subject).toBe("Past due invoice reminder: #1293 from CONFLICT LLC");
    expect(composed.textBody).toContain("Amount Due: $15,112.50");
    expect(composed.textBody).toContain("Invoice 1293 is 14 days past due.");
    // The lines follow when the template never asks for them, as every invoice
    // kind does, so what was billed is never silently dropped.
    expect(composed.textBody).toContain("Advisory");
    expect(composed).toMatchObject({
      templateVersion: 2,
      senderIdentityId: 1,
      fromName: "Finance team - CONFLICT",
      replyToEmail: "ar@example.test",
    });
  });

  it("[unit] the amount owed is the balance, not the amount billed", () => {
    const composed = composeReminder({
      invoice: invoice({ dueAmountCents: 500_000 }),
      template: template({ textTemplate: "Owed %invoice_due_amount% of %invoice_amount%." }),
      sender,
      onDate: "2026-08-14",
      paymentUrl: null,
    });
    expect(composed.textBody).toContain("Owed $5,000.00 of $15,112.50.");
  });

  it("[unit] carries the pay link when there is one and nothing when there is not", () => {
    const withLink = composeReminder({
      invoice: invoice(),
      template: template({ textTemplate: "Pay here: %invoice_payment_url%" }),
      sender,
      onDate: "2026-08-14",
      paymentUrl: "https://pay.example.test/1293",
    });
    expect(withLink.textBody).toContain("Pay here: https://pay.example.test/1293");
    const without = composeReminder({
      invoice: invoice(),
      template: template({ textTemplate: "Pay here: %invoice_payment_url%" }),
      sender,
      onDate: "2026-08-14",
      paymentUrl: null,
    });
    expect(without.textBody).toContain("Pay here: ");
  });

  it("[unit] refuses a reminder variable in a kind that has none", () => {
    expect(() =>
      composeReminder({
        invoice: invoice(),
        template: template({ subjectTemplate: "%invoice_paid_date%" }),
        sender,
        onDate: "2026-08-14",
        paymentUrl: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "variable_not_allowed" }));
  });
});

describe("days past due", () => {
  it("[unit] counts whole days and never goes negative", () => {
    expect(daysPastDue("2026-07-31", "2026-08-14")).toBe(14);
    expect(daysPastDue("2026-07-31", "2026-07-31")).toBe(0);
    expect(daysPastDue("2026-07-31", "2026-07-20T09:00:00.000Z")).toBe(0);
  });
});
