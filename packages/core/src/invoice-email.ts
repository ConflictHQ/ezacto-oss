import {
  type EmailTemplateBlockValue,
  escapeEmailHtml,
} from "./email-templates.js";

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
