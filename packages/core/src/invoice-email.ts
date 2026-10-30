import {
  type EmailTemplateBlockValue,
  type EmailTemplateVariableValues,
  escapeEmailHtml,
  interpolateEmailTemplate,
} from "./email-templates.js";
import { invoiceDocumentMoney, type InvoicePaymentTerms } from "./invoice-document.js";
import { invoicePaymentTermsLabel } from "./payment-terms.js";
import { markupLines } from "./pdf-text.js";

export interface InvoiceEmailLine {
  readonly kind: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly amountCents: number;
}

/**
 * The header money the block has to reconcile against. `totalCents` is the
 * invoice's grand total -- subtotal minus discount plus both taxes -- so a list
 * of pre-tax line amounts printed under it does not add up on its own. The two
 * adjustments are therefore stated rather than implied, and both are required:
 * a caller that has to name them cannot omit tax by forgetting it exists.
 *
 * `taxCents` is the two tax amounts summed, as the invoice document on screen
 * sums them into one Tax row.
 */
export interface InvoiceEmailLineItemsOptions {
  readonly currency: string;
  readonly totalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
}

/**
 * How many lines the email carries before it summarises the rest.
 *
 * An invoice generated from detailed time entries can carry hundreds of lines,
 * and the message body it lands in is bounded at 100,000 characters, so an
 * unbounded block is a send that fails rather than a client who reads more. The
 * cut is stated in the block itself, with the money that was left out, so the
 * recipient can see that they are looking at part of a list rather than a
 * complete one.
 */
export const invoiceEmailLineLimit = 100;

/**
 * A line description is a 100,000-character free-text field on the invoice. In
 * an email it is a cell, so it is clamped to a readable width; the invoice
 * document remains the place the whole of it is legible.
 */
export const invoiceEmailDescriptionLimit = 160;

/*
 * Ink, not fill. An email client that keeps the styles still prints the message
 * on paper with backgrounds off, so the rules that separate the columns are
 * borders and the total is a heavier rule -- both of which are painted where a
 * background is not.
 */
const cellStyle = "padding:6px 8px;border-bottom:1px solid #C8CBD0";
const headStyle = `${cellStyle};font-weight:600`;
const summaryStyle = "padding:6px 8px";
const totalStyle = "padding:8px;border-top:2px solid #14161A;font-weight:700";

const moneyFormatters = new Map<string, Intl.NumberFormat>();

const money = (cents: number, currency: string): string => {
  let formatter = moneyFormatters.get(currency);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
};

const quantityFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});

/**
 * Whitespace is structure in a plain-text block: a description carrying a
 * newline would otherwise draw a row of its own, so a client-facing list could
 * be made to claim lines the invoice does not have. Collapsing it is the
 * plain-text half of escaping, and `escapeEmailHtml` is the other.
 */
const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

const clamp = (value: string): string => {
  const characters = [...value];
  return characters.length <= invoiceEmailDescriptionLimit
    ? value
    : `${characters.slice(0, invoiceEmailDescriptionLimit - 1).join("")}…`;
};

const label = (line: InvoiceEmailLine): string => {
  const kind = oneLine(line.kind);
  const description = clamp(oneLine(line.description ?? ""));
  if (description === "") return kind === "" ? "Line item" : kind;
  return kind === "" ? description : `${kind}: ${description}`;
};

const rate = (line: InvoiceEmailLine, currency: string): string =>
  `${quantityFormatter.format(line.quantity)} x ${money(line.unitPriceCents, currency)}`;

const withheld = (
  lines: readonly InvoiceEmailLine[],
  currency: string,
): string | null => {
  const rest = lines.slice(invoiceEmailLineLimit);
  if (rest.length === 0) return null;
  const cents = rest.reduce((total, line) => total + line.amountCents, 0);
  return `and ${rest.length} more line ${rest.length === 1 ? "item" : "items"} totalling ${money(cents, currency)}`;
};

const emptyStatement = "This invoice has no line items.";

/**
 * The rows that carry the list up to the total, in the order and the wording
 * the invoice document on screen already uses: what the work came to, what was
 * taken off, what was added on. The invoice header stores no subtotal, so it is
 * recovered from the components that made the total -- which is what keeps the
 * printed column adding up to the printed total by construction rather than by
 * a second, independently drifting sum of the lines.
 *
 * Nothing is printed when neither adjustment applies: the total is then the
 * subtotal, and a client does not need to be told the same number twice. A
 * discount is shown as the negative it is, so the column reads as arithmetic.
 */
const summaryRows = (
  options: InvoiceEmailLineItemsOptions,
): ReadonlyArray<readonly [string, number]> => {
  const { totalCents, discountCents, taxCents } = options;
  if (discountCents === 0 && taxCents === 0) return [];
  return [
    ["Subtotal", totalCents + discountCents - taxCents] as const,
    ...(discountCents === 0
      ? []
      : [["Discount", -discountCents] as const]),
    ...(taxCents === 0 ? [] : [["Tax", taxCents] as const]),
  ];
};

/**
 * The lines of an invoice, rendered for both bodies of the email that carries
 * it. Until a PDF exists (#59) this block is the only statement of what the
 * amount is for that a client ever receives.
 *
 * Nothing in either rendering carries meaning in a background fill. An email
 * client strips styles it dislikes and a browser drops backgrounds when
 * printing, so the table is ruled with borders and its heading row is text, not
 * a band of colour.
 */
export const invoiceLineItemsBlock = (
  lines: readonly InvoiceEmailLine[],
  options: InvoiceEmailLineItemsOptions,
): EmailTemplateBlockValue => {
  const { currency, totalCents } = options;
  const shown = lines.slice(0, invoiceEmailLineLimit);
  const rest = withheld(lines, currency);
  const summary = summaryRows(options);
  const total = money(totalCents, currency);

  const text = [
    "Line items",
    ...(shown.length === 0
      ? [emptyStatement]
      : shown.flatMap((line) => [
          label(line),
          `  ${rate(line, currency)} = ${money(line.amountCents, currency)}`,
        ])),
    ...(rest === null ? [] : [rest]),
    ...summary.map(([name, cents]) => `${name}: ${money(cents, currency)}`),
    `Total: ${total}`,
  ].join("\n");

  const cells = (line: InvoiceEmailLine): string =>
    `<tr><td style="${cellStyle};text-align:left">${escapeEmailHtml(label(line))}</td>` +
    `<td style="${cellStyle}">${escapeEmailHtml(quantityFormatter.format(line.quantity))}</td>` +
    `<td style="${cellStyle}">${escapeEmailHtml(money(line.unitPriceCents, currency))}</td>` +
    `<td style="${cellStyle}">${escapeEmailHtml(money(line.amountCents, currency))}</td></tr>`;

  const html = [
    '<table style="border-collapse:collapse;width:100%;text-align:right">',
    "<caption style=\"text-align:left;font-weight:700;padding-bottom:6px\">Line items</caption>",
    `<thead><tr>${["Description", "Quantity", "Rate", "Amount"]
      .map(
        (heading, index) =>
          `<th scope="col" style="${headStyle}${index === 0 ? ";text-align:left" : ""}">${heading}</th>`,
      )
      .join("")}</tr></thead>`,
    "<tbody>",
    ...(shown.length === 0
      ? [
          `<tr><td colspan="4" style="${cellStyle};text-align:left">${emptyStatement}</td></tr>`,
        ]
      : shown.map(cells)),
    ...(rest === null
      ? []
      : [
          `<tr><td colspan="4" style="${cellStyle};text-align:left">${escapeEmailHtml(rest)}</td></tr>`,
        ]),
    "</tbody>",
    "<tfoot>",
    ...summary.map(
      ([name, cents]) =>
        `<tr><th scope="row" colspan="3" style="${summaryStyle};text-align:left">${name}</th>` +
        `<td style="${summaryStyle}">${escapeEmailHtml(money(cents, currency))}</td></tr>`,
    ),
    `<tr><th scope="row" colspan="3" style="${totalStyle};text-align:left">Total</th>` +
      `<td style="${totalStyle}">${escapeEmailHtml(total)}</td></tr>`,
    "</tfoot>",
    "</table>",
  ].join("");

  return { text, html };
};

/**
 * Everything the invoice email is composed from, read as one snapshot of the
 * invoice. The money is the header's own: `amountCents` is the total and
 * `dueAmountCents` what is still owed, which is the figure the email leads
 * with.
 */
export interface InvoiceEmailInvoice {
  readonly invoiceId: number;
  readonly number: string;
  readonly subject: string | null;
  readonly currency: string;
  readonly amountCents: number;
  readonly dueAmountCents: number;
  readonly discountAmountCents: number;
  readonly taxAmountCents: number;
  readonly tax2AmountCents: number;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly paymentTerms: InvoicePaymentTerms;
  readonly purchaseOrder: string | null;
  readonly notes: string | null;
  /** The billing period's calendar bounds; both null for a free-form invoice. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly organizationName: string;
  /** The IANA zone the organization keeps its days in. */
  readonly organizationTimeZone: string;
  readonly clientName: string;
  readonly lineItems: readonly InvoiceEmailLine[];
}

const presentText = (value: string | null): string | null =>
  value === null || value.trim() === "" ? null : value.trim();

const calendarDate = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
    ? date
    : null;
};

const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/**
 * The billing period as a person writes it (issue 925): "September 2026" for a
 * period inside one month, "August – September 2026" across months, and
 * "December 2025 – January 2026" across a year end. Months rather than days,
 * because that is how an invoice is talked about, and the exact days are on the
 * document. Empty where the invoice has no period -- a free-form invoice -- and
 * a period with one bound set reads as that bound's month.
 */
export const invoicePeriodLabel = (start: string | null, end: string | null): string => {
  const from = calendarDate(start ?? end ?? "");
  const to = calendarDate(end ?? start ?? "");
  if (from === null || to === null) return "";
  const fromYear = from.getUTCFullYear();
  const toYear = to.getUTCFullYear();
  if (fromYear === toYear && from.getUTCMonth() === to.getUTCMonth()) {
    return `${monthName.format(from)} ${String(fromYear)}`;
  }
  return fromYear === toYear
    ? `${monthName.format(from)} – ${monthName.format(to)} ${String(toYear)}`
    : `${monthName.format(from)} ${String(fromYear)} – ${monthName.format(to)} ${String(toYear)}`;
};

/**
 * The weekday an instant falls on in the organization's zone, in English
 * (issue 925). A zone the runtime does not know reads as UTC rather than
 * failing the send, which is the rule the time-entry repository applies to the
 * same column.
 */
export const sendWeekday = (instant: string, timeZone: string): string => {
  const at = new Date(instant);
  if (!Number.isFinite(at.valueOf())) throw new RangeError("send instant is invalid");
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(at);
  }
};

/**
 * The variables an invoice email's subject and message can name, for one
 * invoice. Every one is supplied, empty where the invoice has no value: the
 * interpolator refuses a variable it was promised and not given, and a message
 * that mentions the purchase order of an invoice without one should read an
 * empty word, not fail the send.
 */
export const invoiceEmailValues = (
  invoice: InvoiceEmailInvoice,
  paymentUrl: string | null,
  /** When the message is composed to go: the send, or the preview of it. */
  sentAt: string,
): EmailTemplateVariableValues => {
  const issue = new Date(`${invoice.issueDate}T00:00:00.000Z`);
  return {
    send_weekday: sendWeekday(sentAt, invoice.organizationTimeZone),
    invoice_period: invoicePeriodLabel(invoice.periodStart, invoice.periodEnd),
    company_name: invoice.organizationName,
    invoice_id: String(invoice.invoiceId),
    invoice_issue_month_name: new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
    }).format(issue),
    invoice_issue_year: String(issue.getUTCFullYear()),
    invoice_number: invoice.number,
    invoice_subject: invoice.subject ?? "",
    invoice_amount: money(invoice.amountCents, invoice.currency),
    invoice_currency: invoice.currency,
    invoice_issue_date: invoice.issueDate,
    invoice_due_date: invoice.dueDate,
    client_name: invoice.clientName,
    invoice_purchase_order: presentText(invoice.purchaseOrder) ?? "",
    invoice_payment_terms: invoicePaymentTermsLabel(invoice.paymentTerms) ?? "",
    invoice_payment_url: paymentUrl ?? "",
    invoice_line_items: invoiceLineItemsBlock(invoice.lineItems, {
      currency: invoice.currency,
      totalCents: invoice.amountCents,
      discountCents: invoice.discountAmountCents,
      taxCents: invoice.taxAmountCents + invoice.tax2AmountCents,
    }),
  };
};

/** Harvest's rule, exactly as its invoice email drew it. */
const rule = "-".repeat(45);

/**
 * Notes are written in Harvest's markup -- `*bold*` and `_italic_` -- for the
 * PDF, which can set both. A plain-text email cannot, so the marks are taken
 * off by the same parser the PDF uses: a span the document sets in bold reads
 * as its words here, and a stray `*` the document prints is printed here too.
 */
export const invoiceNotesPlainText = (notes: string): string =>
  markupLines(notes)
    .map((runs) => runs.map((run) => run.text).join(""))
    .join("\n")
    .trim();

/**
 * The body of the invoice email, as Harvest wrote it (the Send dialog's message
 * first, then its invoice summary).
 *
 * Generated rather than templated. The block below the message is the same
 * facts the invoice document prints, in Harvest's order and Harvest's words,
 * and a template an operator has to maintain to say them is a template that
 * drifts from the document it is sent with. What a person writes is the
 * message above it, typed when the invoice goes.
 *
 * Plain text only, as Harvest's was: one part means nothing can render
 * differently in a client that prefers HTML.
 */
export const invoiceEmailBody = (
  input: Readonly<{
    /** The personal message, already interpolated. Blank leaves it out. */
    message: string;
    invoice: InvoiceEmailInvoice;
    /** Where the client views and pays this invoice, if anywhere. */
    viewUrl: string | null;
    /** Whether the invoice PDF goes with this email. */
    pdfAttached: boolean;
  }>,
): string => {
  const { invoice } = input;
  const message = input.message.replace(/\s+$/u, "");
  const terms = invoicePaymentTermsLabel(invoice.paymentTerms);
  const purchaseOrder = presentText(invoice.purchaseOrder);
  const notes = presentText(invoice.notes);
  const viewUrl = presentText(input.viewUrl);
  const sections: string[][] = [
    ...(message.trim() === "" ? [] : [[message]]),
    [
      `Amount Due: ${invoiceDocumentMoney(invoice.dueAmountCents, invoice.currency)}`,
      // Only where there is somewhere to go. A "View invoice" with nothing
      // under it is a link the client reads as broken.
      ...(viewUrl === null ? [] : ["View invoice", viewUrl]),
    ],
    [
      rule,
      "Invoice Summary",
      rule,
      `Invoice ID: ${invoice.number}`,
      `Issue date: ${invoice.issueDate}`,
      `Client: ${oneLine(invoice.clientName)}`,
      ...(purchaseOrder === null ? [] : [`P.O. Number: ${oneLine(purchaseOrder)}`]),
      `Amount: ${invoiceDocumentMoney(invoice.amountCents, invoice.currency)}`,
      `Due: ${invoice.dueDate}${terms === null ? "" : ` (${terms})`}`,
    ],
    // The bank and wire details live in the notes, and Harvest sent them under
    // their own heading. An invoice with no notes has no heading to print.
    ...(notes === null
      ? []
      : [[rule, "Payment Information", rule, invoiceNotesPlainText(notes)]]),
    // Said only when it is true: the sentence is a promise about the
    // attachments, and a client told a document is attached looks for it.
    ...(input.pdfAttached ? [["The detailed invoice is attached as a PDF."]] : []),
    ["Thank you!"],
  ];
  return sections.map((lines) => lines.join("\n")).join("\n\n");
};

/**
 * The subject and body of one invoice email, from what the Send dialog says.
 *
 * Both are interpolated with the invoice's variables, and an unknown variable
 * is refused rather than sent: a token the client reads as `%invoice_numbr%`
 * is a typo nobody sees until it has gone.
 */
export const composeInvoiceEmail = (
  input: Readonly<{
    invoice: InvoiceEmailInvoice;
    subjectTemplate: string;
    messageTemplate: string;
    paymentUrl: string | null;
    /**
     * The hosted invoice page the "View invoice" line points at (issue 936),
     * where the company has turned view receipts on. Absent, the line points
     * at the payment page exactly as it always did. `%invoice_payment_url%`
     * is the payment page either way.
     */
    viewUrl?: string | null;
    pdfAttached: boolean;
    /** The instant the message is composed to go, which `%send_weekday%` reads. */
    sentAt: string;
  }>,
): { readonly subject: string; readonly text: string } => {
  const values = invoiceEmailValues(input.invoice, input.paymentUrl, input.sentAt);
  const subject = interpolateEmailTemplate("invoice", input.subjectTemplate, values).trim();
  const message = interpolateEmailTemplate("invoice", input.messageTemplate, values);
  return {
    subject,
    text: invoiceEmailBody({
      message,
      invoice: input.invoice,
      viewUrl: input.viewUrl ?? input.paymentUrl,
      pdfAttached: input.pdfAttached,
    }),
  };
};

const addressList = (people: readonly { readonly name: string; readonly email: string }[]): string =>
  people.length === 0
    ? "nobody"
    : people
        .map((person) => (person.name.trim() === "" ? person.email : `${oneLine(person.name)} <${person.email}>`))
        .join(", ");

/**
 * The invoice email, stamped as a preview for the person about to send it.
 *
 * The same subject and body the client would get -- composed by the same code
 * -- with a stamp no one can mistake: "[PREVIEW]" ahead of the subject and a
 * suffix behind it (mail clients ignore a bracketed prefix when threading, so
 * without the suffix the real email joined the preview's thread and wore its
 * subject), a
 * banner above the body saying it was not sent to the client and naming who it
 * would go to, in both parts. The HTML part exists only to carry the banner at
 * a size a skimming eye stops on; under it is the plain-text body the client
 * would read, unchanged.
 */
export const invoiceEmailPreview = (
  input: Readonly<{
    subject: string;
    text: string;
    to: readonly { readonly name: string; readonly email: string }[];
    cc: readonly { readonly name: string; readonly email: string }[];
  }>,
): { readonly subject: string; readonly text: string; readonly html: string } => {
  const audience = `This email would go to: To ${addressList(input.to)}; Cc ${addressList(input.cc)}`;
  const banner = "==== PREVIEW ====";
  return {
    subject: `[PREVIEW] ${input.subject} (preview, not sent to the client)`,
    text: [banner, "Not sent to the client.", audience, banner, "", input.text].join("\n"),
    html: [
      '<div style="margin:0 0 24px;padding:20px 24px;border:4px solid #B42318;background:#FEF3F2;color:#B42318;font-family:Arial,Helvetica,sans-serif">',
      '<div style="font-size:44px;line-height:1.1;font-weight:800;letter-spacing:6px">PREVIEW</div>',
      '<div style="margin-top:8px;font-size:16px;font-weight:700">Not sent to the client.</div>',
      `<div style="margin-top:4px;font-size:14px">${escapeEmailHtml(audience)}</div>`,
      "</div>",
      `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;margin:0">${escapeEmailHtml(input.text)}</pre>`,
    ].join(""),
  };
};
