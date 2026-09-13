import {
  interpolateEmailTemplate,
  type EmailTemplateBlockValue,
  type UnknownEmailTemplateVariablePolicy,
} from "./email-templates.js";
import { invoiceLineItemsBlock, type InvoiceEmailLine } from "./invoice-email.js";

/**
 * The thank-you an invoice sends when it settles (issue 545).
 *
 * A pure function, deliberately. Deciding whether to send, finding who to send
 * it to, recording it and queueing it are each somebody else's job and each has
 * a database or a queue behind it; this is only the part that turns an invoice
 * and a template into a message, and it is the part most worth being able to
 * read without a fixture.
 *
 * It renders the same way the invoice send does -- same interpolator, same line
 * items block, same rule about a template that does not mention them -- because
 * a client should not be able to tell from the formatting that one of these
 * emails was sent by a person and the other by the system.
 */

export interface ThankYouInvoice {
  readonly invoiceId: number;
  readonly number: string;
  readonly subject: string | null;
  readonly currency: string;
  readonly amountCents: number;
  readonly discountAmountCents: number;
  readonly taxAmountCents: number;
  readonly tax2AmountCents: number;
  readonly issueDate: string;
  readonly dueDate: string;
  /** When it settled. The one variable this kind has and the invoice does not. */
  readonly paidDate: string | null;
  readonly organizationName: string;
  readonly clientName: string;
  readonly lineItems: readonly InvoiceEmailLine[];
}

export interface ThankYouTemplate {
  readonly version: number;
  readonly subjectTemplate: string;
  readonly textTemplate: string;
  readonly htmlTemplate: string | null;
  readonly unknownVariablePolicy: UnknownEmailTemplateVariablePolicy;
}

export interface ThankYouSender {
  readonly id: number;
  readonly version: number;
  readonly evidenceVersion: number;
  readonly displayName: string;
  readonly email: string;
  readonly replyToEmail: string | null;
}

export interface ComposedThankYou {
  readonly templateVersion: number;
  readonly senderIdentityId: number;
  readonly senderIdentityVersion: number;
  readonly senderEvidenceVersion: number;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string | null;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string | null;
}

const LINE_ITEMS_TOKEN = "%invoice_line_items%";

/**
 * Appends the line items when the template never asks for them.
 *
 * The same rule the invoice send follows. A template written before the block
 * existed still shows what was billed rather than silently dropping it.
 */
const withLineItems = (
  body: string,
  template: string,
  block: string,
  separator: string,
): string => (template.includes(LINE_ITEMS_TOKEN) ? body : `${body}${separator}${block}`);

export const composeThankYou = (
  input: Readonly<{
    invoice: ThankYouInvoice;
    template: ThankYouTemplate;
    sender: ThankYouSender;
  }>,
): ComposedThankYou => {
  const { invoice, template, sender } = input;
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
    invoice_amount: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: invoice.currency,
    }).format(invoice.amountCents / 100),
    invoice_currency: invoice.currency,
    invoice_issue_date: invoice.issueDate,
    invoice_due_date: invoice.dueDate,
    // Always supplied, empty when the invoice carries no settlement date. The
    // interpolator throws on a variable it was promised and not given, and a
    // thank-you that fails to render is a thank-you nobody receives.
    invoice_paid_date: invoice.paidDate ?? "",
    client_name: invoice.clientName,
    // There is nothing left to pay. A payment link in a thank-you invites a
    // second payment, so this kind always renders it empty.
    invoice_payment_url: "",
    invoice_line_items: lineItems,
  } as const;
  const interpolation = { unknownVariable: template.unknownVariablePolicy } as const;
  const subject = interpolateEmailTemplate(
    "thank_you",
    template.subjectTemplate,
    values,
    interpolation,
  );
  const textBody = withLineItems(
    interpolateEmailTemplate("thank_you", template.textTemplate, values, interpolation),
    template.textTemplate,
    lineItems.text,
    "\n\n",
  );
  const htmlBody =
    template.htmlTemplate === null
      ? null
      : withLineItems(
          interpolateEmailTemplate("thank_you", template.htmlTemplate, values, {
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
