import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  capHeight,
  isPdfEncodable,
  renderPdf,
  textWidth,
  type PdfDocument,
  type PdfFont,
  type PdfImage,
  type PdfOperation,
  type PdfPage,
} from "./pdf.js";
import { wrapMarkup, wrapText, type TextRun } from "./pdf-text.js";
import type { InvoiceEmailLine } from "./invoice-email.js";
import { invoicePaymentTermsLabel } from "./payment-terms.js";

/**
 * The invoice as a document (issue 626), laid out as Harvest's.
 *
 * Every client of an instance migrated from Harvest has years of Harvest's
 * invoice PDF in their files, and the first one this sends sits beside them.
 * So it keeps Harvest's page: the logo top left and the title and sender top
 * right; who it is for, its number and dates; the subject; a table of item,
 * description, quantity, unit price and amount; the totals; then the notes,
 * which carry the bank details and so are never cut, flowing on to as many
 * pages as they need. Descriptions and notes keep the author's line breaks and
 * Harvest's `*bold*` and `_italic_`, and money reads as Harvest prints it --
 * "-$6,250.00 USD", never in parentheses.
 *
 * It takes `InvoiceEmailLine` -- the same lines the email body is composed from
 * -- deliberately. The attachment and the message are two renderings of one
 * invoice, and giving them separate inputs is how they come to disagree about
 * what was billed.
 */

export type InvoicePaymentTerms =
  | "upon_receipt"
  | "net_15"
  | "net_30"
  | "net_45"
  | "net_60"
  | "custom";

export interface InvoiceDocumentInput {
  readonly number: string;
  readonly companyName: string;
  /** Line breaks kept. Absent or blank leaves the sender at its name. */
  readonly companyAddress?: string | null;
  /** The organization's light-ground wordmark; the name is set in its place without one. */
  readonly logo?: PdfImage | null;
  readonly clientName: string;
  readonly clientAddress?: string | null;
  readonly issueDate: string;
  readonly dueDate: string;
  /** Printed beside the due date as Harvest does -- "(Net 30)" -- except for custom terms. */
  readonly paymentTerms?: InvoicePaymentTerms | null;
  readonly purchaseOrder?: string | null;
  readonly currency: string;
  readonly subject: string | null;
  readonly lines: readonly InvoiceEmailLine[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  /** Parts per million, for the "(20%)" beside the discount. */
  readonly discountRatePpm?: number | null;
  /** The first tax alone; the second is `tax2Cents`. */
  readonly taxCents: number;
  readonly taxRatePpm?: number | null;
  readonly tax2Cents?: number;
  readonly tax2RatePpm?: number | null;
  readonly totalCents: number;
  /** What has been paid against it, printed as Harvest's "Payments". */
  readonly paidCents?: number;
  /** What is still owed. Absent where the caller does not track it: the total. */
  readonly dueAmountCents?: number;
  readonly notes?: string | null;
  /** Where the client can pay, printed only when one exists. */
  readonly paymentUrl?: string | null;
  /**
   * Set large across every page: "PREVIEW" on the copy an operator checks
   * before sending, and never on what is sent. Absent or blank draws nothing,
   * and the file is byte for byte what it was before there were watermarks.
   */
  readonly watermark?: string | null;
}

/** Harvest's page, in points: its margins, its two label columns, its table. */
const LEFT = 39;
const RIGHT = PDF_PAGE_WIDTH - 39;
const TOP = PDF_PAGE_HEIGHT - 39;
/** Content stays above this, clear of the page number. */
const FLOOR = 62;
const INK = 0.11;
const MUTED = 0.38;
const HAIRLINE = 0.82;
const BODY = 8.25;
const LEADING = 10.2;
const LEFT_VALUE = 108.3;
const LEFT_RULE = 101.5;
const RIGHT_LABEL = 415.3;
const RIGHT_VALUE = 428.6;
const RIGHT_RULE = 421.5;
/** The logo fits this box, aspect kept, a wordmark wide and a square mark tall. */
const LOGO_WIDTH = 220;
const LOGO_HEIGHT = 110;
const PAD = 3;
/**
 * A preview's watermark: large, bold and on the diagonal over everything on
 * the page, so no part of it passes for the copy that is sent, in a red faint
 * enough that every figure under it still reads.
 */
const WATERMARK = { font: "bold", size: 120, angle: 45, opacity: 0.15, rgb: [0.75, 0.12, 0.12] } as const;

const TABLE = {
  kind: { left: LEFT, right: 103 },
  description: { left: 103, right: 365 },
  quantity: { left: 365, right: 417 },
  unitPrice: { left: 417, right: 495.5 },
  amount: { left: 495.5, right: RIGHT },
} as const;

const moneyFormats = new Map<string, Intl.NumberFormat>();
const plainFormats = new Map<string, Intl.NumberFormat>();

/**
 * "$99,935.00 USD": the currency's symbol where the PDF's encoding carries
 * one, the figure in the currency's own decimals, and the code after it, so
 * three currencies that all print "$" still read apart. A symbol the encoding
 * cannot carry is left off rather than drawn as `?`.
 */
export const invoiceDocumentMoney = (cents: number, currency: string): string => {
  const code = currency.toUpperCase();
  let symbol = moneyFormats.get(code);
  if (symbol === undefined) {
    symbol = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    });
    moneyFormats.set(code, symbol);
  }
  const figure = symbol.format(cents / 100);
  if (isPdfEncodable(figure)) return `${figure} ${code}`;
  let plain = plainFormats.get(code);
  if (plain === undefined) {
    const digits = symbol.resolvedOptions().minimumFractionDigits ?? 2;
    plain = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    plainFormats.set(code, plain);
  }
  return `${plain.format(cents / 100)} ${code}`;
};

const quantityFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** "20%", "8.875%": the rate as typed, no trailing zeroes. */
const rate = (ppm: number | null | undefined): string =>
  ppm === null || ppm === undefined ? "" : ` (${String(Math.round(ppm) / 10_000)}%)`;

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== "";

/**
 * The watermark at its size, or smaller where the text is long enough that,
 * turned, it would reach past the page's margins: the same 39 points on every
 * side.
 */
const watermarkOperation = (value: string): PdfOperation => {
  const turn = (WATERMARK.angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  // How far it reaches across the page and up it for each point of its size.
  const width = textWidth(value, WATERMARK.font, 1);
  const cap = capHeight(WATERMARK.font, 1);
  const size = Math.min(
    WATERMARK.size,
    (RIGHT - LEFT) / (width * cos + cap * sin),
    (TOP - (PDF_PAGE_HEIGHT - TOP)) / (width * sin + cap * cos),
  );
  return {
    kind: "watermark",
    text: value,
    font: WATERMARK.font,
    size,
    angle: WATERMARK.angle,
    opacity: WATERMARK.opacity,
    rgb: WATERMARK.rgb,
  };
};

/** A page of operations being filled from the top. */
interface Sheet {
  operations: PdfOperation[];
}

export const layoutInvoiceDocument = (input: InvoiceDocumentInput): PdfDocument => {
  const pages: Sheet[] = [{ operations: [] }];
  let sheet = pages[0]!;
  let y = TOP;
  const nextPage = (): void => {
    sheet = { operations: [] };
    pages.push(sheet);
    y = TOP;
  };
  /** A new page unless `height` more points fit above the floor. */
  const room = (height: number): void => {
    if (y - height < FLOOR) nextPage();
  };

  const text = (
    x: number,
    baseline: number,
    value: string,
    options: { size?: number; font?: PdfFont; grey?: number; align?: "left" | "right" | "center" } = {},
  ): void => {
    if (value === "") return;
    sheet.operations.push({
      kind: "text",
      x,
      y: baseline,
      size: options.size ?? BODY,
      font: options.font ?? "regular",
      text: value,
      grey: options.grey ?? INK,
      ...(options.align === undefined ? {} : { align: options.align }),
    });
  };
  const runs = (x: number, baseline: number, line: readonly TextRun[], size = BODY): void => {
    let at = x;
    for (const run of line) {
      text(at, baseline, run.text, { size, font: run.font });
      at += textWidth(run.text, run.font, size);
    }
  };
  const vertical = (x: number, top: number, bottom: number, grey = HAIRLINE): void => {
    sheet.operations.push({ kind: "line", x1: x, y1: top, x2: x, y2: bottom, width: 0.6, grey });
  };
  const horizontal = (at: number, grey = HAIRLINE, width = 0.6): void => {
    sheet.operations.push({ kind: "line", x1: LEFT, y1: at, x2: RIGHT, y2: at, width, grey });
  };
  /** A figure right-aligned in its column, set smaller only if it would not fit. */
  const figure = (right: number, left: number, baseline: number, value: string, font: PdfFont, size = BODY): void => {
    const space = right - left - PAD * 2;
    const width = textWidth(value, font, size);
    text(right - PAD, baseline, value, {
      size: width <= space ? size : (size * space) / width,
      font,
      align: "right",
    });
  };

  // The logo, or the company's name where it would go; then the title and the
  // sender, right.
  let leftBottom: number;
  if (input.logo !== undefined && input.logo !== null) {
    const scale = Math.min(LOGO_WIDTH / input.logo.width, LOGO_HEIGHT / input.logo.height);
    const width = input.logo.width * scale;
    const height = input.logo.height * scale;
    sheet.operations.push({ kind: "image", x: LEFT, y: TOP - height, width, height, image: input.logo });
    leftBottom = TOP - height;
  } else {
    const lines = wrapText(input.companyName, "bold", 15, LOGO_WIDTH + 80);
    lines.forEach((line, index) => text(LEFT, TOP - 14.5 - index * 18, line, { size: 15, font: "bold" }));
    leftBottom = TOP - 14.5 - (lines.length - 1) * 18 - 6;
  }
  text(RIGHT_VALUE, TOP - 14.5, "INVOICE", { size: 15, font: "bold" });
  text(RIGHT_LABEL, TOP - 43.7, "From", { grey: MUTED, align: "right" });
  const senderMeasure = RIGHT - RIGHT_VALUE;
  const senderName = wrapText(input.companyName, "bold", 9.75, senderMeasure);
  let baseline = TOP - 45.2;
  senderName.forEach((line, index) => text(RIGHT_VALUE, baseline - index * 11.7, line, { size: 9.75, font: "bold" }));
  baseline -= 11.7 * (senderName.length - 1) + 12.1;
  if (present(input.companyAddress)) {
    for (const line of wrapText(input.companyAddress.trim(), "regular", BODY, senderMeasure)) {
      text(RIGHT_VALUE, baseline, line);
      baseline -= LEADING;
    }
  }
  const senderBottom = baseline + LEADING - 3;
  vertical(RIGHT_RULE, TOP - 35, senderBottom);

  // Who it is for, left; what it is, right.
  const blockTop = Math.min(leftBottom, senderBottom) - 26;
  text(LEFT, blockTop - 8, "Invoice For", { grey: MUTED });
  const clientMeasure = RIGHT_RULE - 40 - LEFT_VALUE;
  baseline = blockTop - 9.5;
  for (const line of wrapText(input.clientName, "bold", 9.75, clientMeasure)) {
    text(LEFT_VALUE, baseline, line, { size: 9.75, font: "bold" });
    baseline -= 11.7;
  }
  baseline -= 0.4;
  if (present(input.clientAddress)) {
    for (const line of wrapText(input.clientAddress.trim(), "regular", BODY, clientMeasure)) {
      text(LEFT_VALUE, baseline, line);
      baseline -= LEADING;
    }
  }
  const clientBottom = baseline + LEADING - 3;
  vertical(LEFT_RULE, blockTop + 1, clientBottom);

  const terms = input.paymentTerms === undefined || input.paymentTerms === null ? null : invoicePaymentTermsLabel(input.paymentTerms);
  const facts: readonly (readonly [string, string, PdfFont])[] = [
    ["Invoice ID", input.number, "bold"],
    ...(present(input.purchaseOrder) ? [["PO Number", input.purchaseOrder.trim(), "regular"] as const] : []),
    ["Issue Date", input.issueDate, "regular"],
    ["Due Date", terms === null ? input.dueDate : `${input.dueDate} (${terms})`, "regular"],
  ];
  baseline = blockTop - 8;
  for (const [label, value, font] of facts) {
    text(RIGHT_LABEL, baseline, label, { grey: MUTED, align: "right" });
    const lines = wrapText(value, font, BODY, senderMeasure);
    lines.forEach((line, index) => text(RIGHT_VALUE, baseline - index * LEADING, line, { font }));
    baseline -= LEADING * (lines.length - 1) + 16.3;
  }
  const factsBottom = baseline + 16.3 - 5;
  vertical(RIGHT_RULE, blockTop + 1, factsBottom);
  y = Math.min(clientBottom, factsBottom);

  // The subject, in full: a long one wraps rather than being cut.
  if (present(input.subject)) {
    const top = y - 25;
    text(LEFT, top - 8, "Subject", { grey: MUTED });
    const lines = wrapText(input.subject.trim(), "regular", BODY, RIGHT - LEFT_VALUE);
    lines.forEach((line, index) => text(LEFT_VALUE, top - 8 - index * LEADING, line));
    const bottom = top - 8 - LEADING * (lines.length - 1) - 5;
    vertical(LEFT_RULE, top + 1, bottom);
    y = bottom;
  }

  // The table. Its header is set once, as Harvest's is; a continuation page
  // carries on with the rows.
  y -= 40;
  const separators = (top: number, bottom: number): void => {
    for (const column of [TABLE.description, TABLE.quantity, TABLE.unitPrice, TABLE.amount]) {
      vertical(column.left, top, bottom);
    }
  };
  room(17 + 36);
  const headerTop = y;
  const headerBaseline = headerTop - 11;
  text(TABLE.kind.left + PAD, headerBaseline, "Item Type", { size: 7.3, font: "bold" });
  text(TABLE.description.left + PAD, headerBaseline, "Description", { size: 7.3, font: "bold" });
  for (const [column, label] of [
    [TABLE.quantity, "Quantity"],
    [TABLE.unitPrice, "Unit Price"],
    [TABLE.amount, "Amount"],
  ] as const) {
    text(column.right - PAD, headerBaseline, label, { size: 7.3, font: "bold", align: "right" });
  }
  y = headerTop - 17;
  separators(headerTop, y);
  horizontal(y, 0.75, 1);

  const descriptionMeasure = TABLE.description.right - TABLE.description.left - PAD * 2;
  input.lines.forEach((line, index) => {
    const description =
      line.description === null || line.description.trim() === ""
        ? [[]]
        : wrapMarkup(line.description.trim(), BODY, descriptionMeasure);
    const firstBaseline = 14.5;
    const below = 11;
    const height = firstBaseline + LEADING * (description.length - 1) + below;
    const shade = index % 2 === 1;
    // Kept on one page where it fits on one; a description longer than a page
    // carries on over the break with the row's rules around each part.
    if (height <= TOP - FLOOR) room(height);
    else room(firstBaseline + below);
    let top = y;
    let baselineAt = y - firstBaseline;
    const close = (bottom: number): void => {
      if (shade) {
        sheet.operations.unshift({ kind: "rect", x: LEFT, y: bottom, width: RIGHT - LEFT, height: top - bottom, grey: 0.95 });
      }
      separators(top, bottom);
      horizontal(bottom);
    };
    text(TABLE.kind.left + PAD, baselineAt, line.kind);
    figure(TABLE.quantity.right, TABLE.quantity.left, baselineAt, quantityFormat.format(line.quantity), "regular");
    figure(
      TABLE.unitPrice.right,
      TABLE.unitPrice.left,
      baselineAt,
      invoiceDocumentMoney(line.unitPriceCents, input.currency),
      "regular",
    );
    figure(
      TABLE.amount.right,
      TABLE.amount.left,
      baselineAt,
      invoiceDocumentMoney(line.amountCents, input.currency),
      "bold",
    );
    description.forEach((runsOfLine, lineIndex) => {
      if (lineIndex > 0) {
        baselineAt -= LEADING;
        if (baselineAt - below < FLOOR) {
          close(baselineAt + LEADING - below);
          nextPage();
          top = y;
          baselineAt = y - firstBaseline;
        }
      }
      runs(TABLE.description.left + PAD, baselineAt, runsOfLine);
    });
    y = baselineAt - below;
    close(y);
  });

  // The totals, right. Harvest's read straight to the amount due when nothing
  // adjusts the total, but an accounts-payable department books an invoice by
  // its net, its tax and its total, and sends back one that does not state all
  // three -- so the subtotal, the tax ("$0.00 USD" where there is none) and the
  // total are always printed. Harvest never set a tax row or a "Total" label,
  // so they are named plainly. A discount and a second tax still appear only
  // when they are real, and the payments and the amount due only once something
  // has been paid or what is owed is no longer the total. The last line is set
  // large, as Harvest's amount due is: it is the figure the client is to pay.
  const paid = input.paidCents ?? 0;
  const tax2 = input.tax2Cents ?? 0;
  const owed = input.dueAmountCents ?? input.totalCents;
  const totals: readonly (readonly [string, number])[] = [
    ["Subtotal", input.subtotalCents],
    ...(input.discountCents !== 0
      ? [[`Discount${rate(input.discountRatePpm)}`, -Math.abs(input.discountCents)] as const]
      : []),
    [`Tax${rate(input.taxRatePpm)}`, input.taxCents],
    ...(tax2 !== 0 ? [[`Tax 2${rate(input.tax2RatePpm)}`, tax2] as const] : []),
    ["Total", input.totalCents],
    ...(paid !== 0 ? [["Payments", -paid] as const] : []),
    ...(paid !== 0 || owed !== input.totalCents ? [["Amount Due", owed] as const] : []),
  ];
  const rows = totals.slice(0, -1);
  const [finalLabel, finalCents] = totals[totals.length - 1]!;
  const totalsHeight = 27 + 14.2 * rows.length + 25;
  room(totalsHeight);
  baseline = y - 27;
  // Labels end where Harvest's do, unless a figure is wide enough to need the
  // room, in which case they stand clear of it.
  const labelEdge = TABLE.unitPrice.right - 0.5;
  const figures = rows.map(([, cents]) => invoiceDocumentMoney(cents, input.currency));
  const widest = figures.reduce((wide, value) => Math.max(wide, textWidth(value, "regular", 9)), 0);
  const rowLabelEdge = Math.min(labelEdge, RIGHT - PAD - widest - 10);
  rows.forEach(([label], index) => {
    text(rowLabelEdge, baseline, label, { grey: MUTED, align: "right" });
    text(RIGHT - PAD, baseline, figures[index]!, { size: 9, align: "right" });
    baseline -= 14.2;
  });
  baseline -= 10.8;
  const finalFigure = invoiceDocumentMoney(finalCents, input.currency);
  const finalLabelEdge = Math.min(labelEdge, RIGHT - PAD - textWidth(finalFigure, "regular", 11.7) - 9);
  text(finalLabelEdge, baseline, finalLabel, { size: 10.5, font: "bold", align: "right" });
  text(RIGHT - PAD, baseline, finalFigure, { size: 11.7, align: "right" });
  y = baseline - 6;

  if (present(input.paymentUrl)) {
    const lines = wrapText(input.paymentUrl.trim(), "regular", BODY, RIGHT - LEFT);
    room(22 + LEADING * lines.length);
    y -= 22;
    text(LEFT, y, "Pay online", { font: "bold" });
    for (const line of lines) {
      y -= LEADING;
      text(LEFT, y, line);
    }
  }

  // The notes, in full, on as many pages as they take: they carry the bank
  // details, and a wire cannot be sent to half an account number.
  if (present(input.notes)) {
    room(35 + 33 + LEADING);
    y -= 35;
    horizontal(y);
    text(LEFT + PAD, y - 10, "Notes", { size: 7.3, font: "bold" });
    baseline = y - 25;
    const noteLines = wrapMarkup(input.notes.trim(), BODY, RIGHT - LEFT - PAD * 2);
    noteLines.forEach((line, index) => {
      if (index > 0) baseline -= LEADING;
      if (baseline < FLOOR) {
        nextPage();
        baseline = y - 8;
      }
      runs(LEFT + PAD, baseline, line);
    });
    y = baseline;
  }

  const count = pages.length;
  // A preview's watermark goes on last, over everything else on every page.
  const watermark = present(input.watermark) ? watermarkOperation(input.watermark.trim()) : null;
  return {
    pages: pages.map(
      (page, index): PdfPage => ({
        operations: [
          ...page.operations,
          {
            kind: "text",
            x: PDF_PAGE_WIDTH / 2,
            y: 33.4,
            size: 9.4,
            font: "regular",
            text: `Page ${String(index + 1)} of ${String(count)}`,
            align: "center",
            grey: INK,
          },
          ...(watermark === null ? [] : [watermark]),
        ],
      }),
    ),
    title: `Invoice ${input.number}`,
  };
};

export const renderInvoiceDocument = (input: InvoiceDocumentInput): Uint8Array =>
  renderPdf(layoutInvoiceDocument(input));
