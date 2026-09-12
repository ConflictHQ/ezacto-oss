import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  monospacedWidth,
  renderPdf,
  type PdfOperation,
  type PdfPage,
} from "./pdf.js";
import type { InvoiceEmailLine } from "./invoice-email.js";

/**
 * The invoice as a document (issue 626).
 *
 * Harvest attached a PDF to every invoice it sent, and ezacto has been sending
 * none, so this is a parity gap a client notices on the first real send.
 *
 * It takes `InvoiceEmailLine` -- the same shape the email body is composed from
 * -- deliberately. The attachment and the message are two renderings of one
 * invoice, and giving them separate inputs is how they come to disagree about
 * what was billed.
 *
 * Money is set in the monospaced face so the column aligns by arithmetic rather
 * than by a font metric table; `pdf.ts` explains why that is the whole reason
 * the face was chosen.
 */

export interface InvoiceDocumentInput {
  readonly number: string;
  readonly companyName: string;
  readonly clientName: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly subject: string | null;
  readonly lines: readonly InvoiceEmailLine[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  /** What is still owed. Absent where the caller does not track it. */
  readonly dueAmountCents?: number;
  /** Where the client can pay, printed only when one exists. */
  readonly paymentUrl?: string | null;
}

const LEFT = 56;
const RIGHT = PDF_PAGE_WIDTH - 56;
const HEADER_HEIGHT = 96;
/** Leave room for the footer rule and the page number beneath it. */
const BOTTOM = 86;

const money = (cents: number, currency: string): string => {
  const negative = cents < 0;
  const units = Math.trunc(Math.abs(cents) / 100);
  const remainder = String(Math.abs(cents) % 100).padStart(2, "0");
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const symbol = currency.toUpperCase() === "USD" ? "$" : "";
  const body = `${symbol}${grouped}.${remainder}`;
  return negative ? `(${body})` : body;
};

const label = (line: InvoiceEmailLine): string =>
  line.description === null || line.description.trim() === ""
    ? line.kind
    : `${line.kind}: ${line.description.trim()}`;

/**
 * Cuts a description to what fits beside the money column.
 *
 * The prose face is proportional, so its width is not known here. The bound is
 * therefore a character count chosen against the narrowest column the layout
 * leaves, which over-trims a narrow string and never overlaps the figures --
 * the failure worth avoiding is a description running under the amount, not a
 * description that stops early.
 */
const DESCRIPTION_LIMIT = 58;

const trimmed = (text: string): string =>
  text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 1)}…`;

interface Column {
  readonly quantity: number;
  readonly rate: number;
  readonly amount: number;
}

/**
 * Right edges for the three figure columns, measured from the widest figure
 * each will hold rather than guessed, so a large invoice does not collide.
 */
const columns = (input: InvoiceDocumentInput, size: number): Column => {
  const widest = (values: readonly string[]): number =>
    values.reduce((wide, value) => Math.max(wide, monospacedWidth(value, size)), 0);
  const amounts = input.lines.map((line) => money(line.amountCents, input.currency));
  const rates = input.lines.map((line) => money(line.unitPriceCents, input.currency));
  const amount = RIGHT;
  const rate = amount - Math.max(widest(amounts), monospacedWidth(money(input.totalCents, input.currency), size)) - 18;
  const quantity = rate - widest(rates) - 18;
  return { amount, rate, quantity };
};

export const renderInvoiceDocument = (input: InvoiceDocumentInput): Uint8Array => {
  const pages: PdfPage[] = [];
  let operations: PdfOperation[] = [];
  let y = 0;
  let pageNumber = 0;

  const size = 9.5;
  const column = columns(input, size);

  const startPage = (): void => {
    pageNumber += 1;
    operations = [];
    operations.push({
      kind: "rect",
      x: 0,
      y: PDF_PAGE_HEIGHT - HEADER_HEIGHT,
      width: PDF_PAGE_WIDTH,
      height: HEADER_HEIGHT,
      grey: 0.11,
    });
    operations.push({
      kind: "text",
      x: LEFT,
      y: PDF_PAGE_HEIGHT - 58,
      size: 15,
      font: "bold",
      text: input.companyName,
      grey: 1,
    });
    operations.push({
      kind: "text",
      x: RIGHT,
      y: PDF_PAGE_HEIGHT - 58,
      size: 11,
      font: "mono",
      text: `INVOICE ${input.number}`,
      align: "right",
      grey: 1,
    });
    y = PDF_PAGE_HEIGHT - HEADER_HEIGHT - 40;
  };

  const endPage = (): void => {
    operations.push({
      kind: "text",
      x: RIGHT,
      y: 52,
      size: 8,
      font: "mono",
      text: `Page ${String(pageNumber)}`,
      align: "right",
      grey: 0.55,
    });
    pages.push({ operations });
  };

  const heading = (): void => {
    operations.push(
      { kind: "text", x: LEFT, y, size: 7.5, font: "bold", text: "DESCRIPTION", grey: 0.45 },
      { kind: "text", x: column.quantity, y, size: 7.5, font: "mono_bold", text: "QTY", align: "right", grey: 0.45 },
      { kind: "text", x: column.rate, y, size: 7.5, font: "mono_bold", text: "RATE", align: "right", grey: 0.45 },
      { kind: "text", x: column.amount, y, size: 7.5, font: "mono_bold", text: "AMOUNT", align: "right", grey: 0.45 },
    );
    y -= 8;
    operations.push({ kind: "line", x1: LEFT, y1: y, x2: RIGHT, y2: y, width: 0.75, grey: 0.75 });
    y -= 16;
  };

  startPage();

  // The facts a person checks first, before reading a single line.
  //
  // All of it set from the left margin. Prose is proportional here, so its
  // width is not known -- an earlier draft put the client name at the right
  // margin with no alignment, which starts it there and runs it off the page.
  // `pdftotext` showed "Billed to Kestre" where the name should be, and no
  // assertion about the string being present could have seen it.
  operations.push({
    kind: "text",
    x: LEFT,
    y,
    size: 8,
    font: "regular",
    text: `BILLED TO ${trimmed(input.clientName).toUpperCase()}`,
    grey: 0.45,
  });
  y -= 26;
  operations.push({
    kind: "text",
    x: LEFT,
    y,
    size: 22,
    font: "bold",
    text: money(input.totalCents, input.currency),
  });
  y -= 18;
  if (input.subject !== null && input.subject.trim() !== "") {
    operations.push({
      kind: "text",
      x: LEFT,
      y,
      size: 9.5,
      font: "regular",
      text: trimmed(input.subject.trim()),
      grey: 0.3,
    });
    y -= 14;
  }
  operations.push({
    kind: "text",
    x: LEFT,
    y,
    size: 9,
    font: "regular",
    text: `Issued ${input.issueDate}   Due ${input.dueDate}`,
    grey: 0.45,
  });
  y -= 28;
  heading();

  for (const line of input.lines) {
    if (y < BOTTOM + 60) {
      endPage();
      startPage();
      heading();
    }
    operations.push(
      { kind: "text", x: LEFT, y, size, font: "regular", text: trimmed(label(line)) },
      { kind: "text", x: column.quantity, y, size, font: "mono", text: String(line.quantity), align: "right" },
      { kind: "text", x: column.rate, y, size, font: "mono", text: money(line.unitPriceCents, input.currency), align: "right" },
      { kind: "text", x: column.amount, y, size, font: "mono", text: money(line.amountCents, input.currency), align: "right" },
    );
    y -= 15;
  }

  // Totals. The adjustments are printed only when they are not zero, because a
  // row reading "Discount 0.00" invites the question of what discount.
  y -= 6;
  operations.push({ kind: "line", x1: LEFT, y1: y, x2: RIGHT, y2: y, width: 0.75, grey: 0.75 });
  y -= 18;

  // The label sits well left of the figures. Set at `column.rate` it began
  // where the rate column begins and ran right, straight through the amount --
  // "Subtotal" printed over "$23,739.80". Prose width is unknown here, so the
  // gap is generous rather than measured.
  const totalLabelX = RIGHT - 260;

  const total = (name: string, cents: number, emphasis = false): void => {
    operations.push(
      {
        kind: "text",
        x: totalLabelX,
        y,
        size: emphasis ? 11 : size,
        font: emphasis ? "bold" : "regular",
        text: name,
      },
      {
        kind: "text",
        x: column.amount,
        y,
        size: emphasis ? 11 : size,
        font: emphasis ? "mono_bold" : "mono",
        text: money(cents, input.currency),
        align: "right",
      },
    );
    y -= emphasis ? 20 : 15;
  };

  total("Subtotal", input.subtotalCents);
  if (input.discountCents !== 0) total("Discount", -Math.abs(input.discountCents));
  if (input.taxCents !== 0) total("Tax", input.taxCents);
  // Dropped clear of the row above before the band is painted. Fills are drawn
  // in order, so a band tall enough to reach the previous row covers it -- the
  // Tax row disappeared underneath this one until the gap was opened.
  y -= 6;
  operations.push({
    kind: "rect",
    x: totalLabelX - 14,
    y: y - 9,
    width: RIGHT - totalLabelX + 20,
    height: 26,
    grey: 0.93,
  });
  total("Total", input.totalCents, true);
  if (input.dueAmountCents !== undefined && input.dueAmountCents !== input.totalCents) {
    total("Amount due", input.dueAmountCents, true);
  }

  if (input.paymentUrl !== undefined && input.paymentUrl !== null && input.paymentUrl !== "") {
    y -= 10;
    operations.push(
      { kind: "text", x: LEFT, y, size: 9, font: "bold", text: "Pay online" },
      { kind: "text", x: LEFT, y: y - 13, size: 8.5, font: "mono", text: input.paymentUrl, grey: 0.3 },
    );
    y -= 30;
  }

  endPage();
  return renderPdf({ pages, title: `Invoice ${input.number}` });
};
