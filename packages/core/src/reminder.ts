import {
  interpolateEmailTemplate,
  type EmailTemplateBlockValue,
} from "./email-templates.js";
import { invoiceLineItemsBlock } from "./invoice-email.js";
import type { ComposedThankYou, ThankYouSender, ThankYouTemplate } from "./thank-you.js";
import type { ThankYouInvoice } from "./thank-you.js";

/**
 * The reminder an open invoice sends once it is past due (issue 801).
 *
 * The same shape as the thank-you, for the same reason: this only turns an
 * invoice and a template into a message. Deciding when, finding who, recording
 * and queueing are the scheduler's, the port's and the mailer's.
 *
 * Two facts the invoice email does not have: what is still owed, and how late
 * it is. The reminder Harvest sent named both -- "Invoice 1293 is 14 days past
 * due", amount due at the top -- and a template that cannot say them is not a
 * reminder.
 */

export interface ReminderInvoice extends Omit<ThankYouInvoice, "paidDate"> {
  /** What is still owed. The amount a reminder is about. */
  readonly dueAmountCents: number;
}

export type ReminderTemplate = ThankYouTemplate;
export type ReminderSender = ThankYouSender;
export type ComposedReminder = ComposedThankYou;

const LINE_ITEMS_TOKEN = "%invoice_line_items%";

const withLineItems = (
  body: string,
  template: string,
  block: string,
  separator: string,
): string => (template.includes(LINE_ITEMS_TOKEN) ? body : `${body}${separator}${block}`);

const DAY_MS = 86_400_000;

/**
 * Whole days from the due date to the day the reminder goes, never negative:
 * a reminder scheduled before the due date is "0 days past due", not a
 * negative number in a client's inbox.
 */
export const daysPastDue = (dueDate: string, onDate: string): number => {
  const due = Date.parse(`${dueDate}T00:00:00.000Z`);
  const on = Date.parse(`${onDate.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(due) || !Number.isFinite(on)) {
    throw new RangeError("reminder dates must be canonical calendar dates");
  }
  return Math.max(0, Math.floor((on - due) / DAY_MS));
};

export const composeReminder = (
  input: Readonly<{
    invoice: ReminderInvoice;
    template: ReminderTemplate;
    sender: ReminderSender;
    /** The day the reminder is sent, for the days-past-due figure. */
    onDate: string;
    /** Where the client pays online, or null where no link exists. */
    paymentUrl: string | null;
  }>,
): ComposedReminder => {
  const { invoice, template, sender } = input;
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: invoice.currency,
  });
  const lineItems: EmailTemplateBlockValue = invoiceLineItemsBlock(invoice.lineItems, {
    currency: invoice.currency,
    totalCents: invoice.amountCents,
    discountCents: invoice.discountAmountCents,
    taxCents: invoice.taxAmountCents + invoice.tax2AmountCents,
  });
  const issue = new Date(`${invoice.issueDate}T00:00:00.000Z`);
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
    invoice_amount: money.format(invoice.amountCents / 100),
    invoice_due_amount: money.format(invoice.dueAmountCents / 100),
    invoice_days_past_due: String(daysPastDue(invoice.dueDate, input.onDate)),
    invoice_currency: invoice.currency,
    invoice_issue_date: invoice.issueDate,
    invoice_due_date: invoice.dueDate,
    client_name: invoice.clientName,
    invoice_payment_url: input.paymentUrl ?? "",
    invoice_line_items: lineItems,
  } as const;
  const interpolation = { unknownVariable: template.unknownVariablePolicy } as const;
  const subject = interpolateEmailTemplate("reminder", template.subjectTemplate, values, interpolation);
  const textBody = withLineItems(
    interpolateEmailTemplate("reminder", template.textTemplate, values, interpolation),
    template.textTemplate,
    lineItems.text,
    "\n\n",
  );
  const htmlBody =
    template.htmlTemplate === null
      ? null
      : withLineItems(
          interpolateEmailTemplate("reminder", template.htmlTemplate, values, {
            ...interpolation,
            output: "html",
          }),
          template.htmlTemplate,
          lineItems.html,
          "\n",
        );
  return {
    templateVersion: template.version,
    senderIdentityId: sender.id,
    senderIdentityVersion: sender.version,
    senderEvidenceVersion: sender.evidenceVersion,
    fromName: sender.displayName,
    fromEmail: sender.email,
    replyToEmail: sender.replyToEmail,
    subject,
    textBody,
    htmlBody,
  };
};
