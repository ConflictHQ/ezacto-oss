import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  groupInvoiceLinesByEndClient,
  invoiceDocumentMoney,
  layoutInvoiceDocument,
  renderInvoiceDocument,
  type InvoiceDocumentInput,
} from "../src/invoice-document.js";
import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  capHeight,
  textWidth,
  type PdfImage,
  type PdfOperation,
} from "../src/pdf.js";

/**
 * Issue 626, laid out as Harvest's invoice so the first one a migrated client
 * receives sits beside years of Harvest's without looking like a stranger.
 * Asserted on the laid-out page where position is the point -- a label over a
 * figure, a line under the footer -- and on the written file where it is not.
 */

type TextOperation = Extract<PdfOperation, { kind: "text" }>;
type WatermarkOperation = Extract<PdfOperation, { kind: "watermark" }>;

const text = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const invoice = (overrides: Partial<InvoiceDocumentInput> = {}): InvoiceDocumentInput => ({
  number: "1315",
  companyName: "CONFLICT LLC",
  companyAddress: "100 Example Ave, STE 200\nSpringfield, IL, 62701",
  clientName: "Kestrel Environmental",
  clientAddress: "1 Client Way\nSuite 1100\nShelbyville, IL 62565",
  issueDate: "2026-09-12",
  dueDate: "2026-10-12",
  paymentTerms: "net_30",
  currency: "USD",
  subject: "Tracked work 2026-08-01 – 2026-08-31",
  lines: [
    { kind: "Service", description: "Advisory", quantity: 30.5, unitPriceCents: 10_000, amountCents: 305_000 },
    { kind: "Service", description: "Field work", quantity: 1, unitPriceCents: 14_495, amountCents: 14_495 },
  ],
  subtotalCents: 319_495,
  discountCents: 0,
  taxCents: 0,
  totalCents: 319_495,
  ...overrides,
});

const texts = (input: InvoiceDocumentInput): { page: number; op: TextOperation }[] =>
  layoutInvoiceDocument(input).pages.flatMap((page, index) =>
    page.operations
      .filter((op): op is TextOperation => op.kind === "text")
      .map((op) => ({ page: index + 1, op })),
  );

const strings = (input: InvoiceDocumentInput): string[] => texts(input).map(({ op }) => op.text);

const find = (input: InvoiceDocumentInput, value: string): TextOperation => {
  const found = texts(input).find(({ op }) => op.text === value)?.op;
  if (found === undefined) throw new Error(`"${value}" is not on the page`);
  return found;
};

/** Where a text operation's ink starts and ends on the line, alignment applied. */
const extent = (op: TextOperation): { left: number; right: number } => {
  const width = textWidth(op.text, op.font, op.size);
  const left = op.align === "right" ? op.x - width : op.align === "center" ? op.x - width / 2 : op.x;
  return { left, right: left + width };
};

/**
 * The totals block line by line, top to bottom: each label, the figure beside
 * it and the page they are set on. The block is the run of right-aligned text
 * from "Subtotal" on; what follows it -- the payment link, the notes, the page
 * number -- is set left or centred.
 */
const totalsBlock = (input: InvoiceDocumentInput): { page: number; label: TextOperation; figure: TextOperation }[] => {
  const placed = texts(input);
  const start = placed.findIndex(({ op }) => op.text === "Subtotal");
  if (start === -1) throw new Error("the totals are not on the page");
  const after = placed.findIndex(({ op }, index) => index > start && op.align !== "right");
  const run = placed.slice(start, after === -1 ? placed.length : after);
  return Array.from({ length: Math.ceil(run.length / 2) }, (_, index) => {
    const label = run[index * 2]!;
    const figure = run[index * 2 + 1];
    if (figure === undefined) throw new Error(`"${label.op.text}" has no figure beside it`);
    return { page: label.page, label: label.op, figure: figure.op };
  });
};

/**
 * Which of the two treatments a totals line is set in: a muted row, or the
 * large bold line. Anything else comes back as its fonts and sizes, so a
 * failure says what was set instead.
 */
const treatment = (label: TextOperation, figure: TextOperation): string => {
  const set = `${label.font} ${String(label.size)} ${String(label.grey)} / ${figure.font} ${String(figure.size)}`;
  if (set === "regular 8.25 0.38 / regular 9") return "row";
  if (set === "bold 10.5 0.11 / regular 11.7") return "large";
  return set;
};

/** The totals as a reader sees them: label, figure and treatment, line by line. */
const totals = (input: InvoiceDocumentInput): string[][] =>
  totalsBlock(input).map(({ label, figure }) => [label.text, figure.text, treatment(label, figure)]);

describe("the head of the invoice", () => {
  it("[money] sets the title, the sender and who it is for as Harvest does", () => {
    const input = invoice();
    expect(find(input, "INVOICE")).toMatchObject({ font: "bold", size: 15 });
    expect(find(input, "From").align).toBe("right");
    expect(find(input, "CONFLICT LLC").font).toBe("bold");
    expect(strings(input)).toEqual(
      expect.arrayContaining([
        "100 Example Ave, STE 200",
        "Springfield, IL, 62701",
        "Invoice For",
        "Suite 1100",
        "Shelbyville, IL 62565",
        "Invoice ID",
        "Issue Date",
        "2026-09-12",
        "Due Date",
      ]),
    );
    expect(find(input, "Kestrel Environmental").font).toBe("bold");
    expect(find(input, "1315").font).toBe("bold");
  });

  it("[money] states the terms beside the due date, except custom terms", () => {
    for (const [terms, due] of [
      ["net_15", "2026-10-12 (Net 15)"],
      ["net_30", "2026-10-12 (Net 30)"],
      ["net_45", "2026-10-12 (Net 45)"],
      ["net_60", "2026-10-12 (Net 60)"],
      ["upon_receipt", "2026-10-12 (upon receipt)"],
      ["custom", "2026-10-12"],
    ] as const) {
      expect(strings(invoice({ paymentTerms: terms }))).toContain(due);
    }
  });

  it("[money] adds the purchase order under the invoice number only when there is one", () => {
    const withPo = strings(invoice({ purchaseOrder: "4500000001" }));
    expect(withPo).toEqual(expect.arrayContaining(["PO Number", "4500000001"]));
    expect(withPo.indexOf("PO Number")).toBeGreaterThan(withPo.indexOf("Invoice ID"));
    expect(withPo.indexOf("PO Number")).toBeLessThan(withPo.indexOf("Issue Date"));
    for (const none of [null, "", "  "]) expect(strings(invoice({ purchaseOrder: none }))).not.toContain("PO Number");
  });

  it("[unit] leaves an absent address off rather than printing a blank block", () => {
    const rendered = strings(invoice({ companyAddress: null, clientAddress: "" }));
    expect(rendered).not.toContain("Springfield, IL, 62701");
    expect(rendered).toContain("CONFLICT LLC");
    expect(rendered).toContain("Kestrel Environmental");
  });

  it("[unit] prints the subject in full, wrapped rather than cut", () => {
    const subject = `Conflict <> Northwind Freight - Platform Phase 1 Invoice: September 2026 ${"and more ".repeat(20)}`.trim();
    const rendered = strings(invoice({ subject }));
    expect(rendered).toContain("Subject");
    const start = rendered.findIndex((value) => value.startsWith("Conflict <>"));
    const lines = rendered.slice(start, start + 3);
    expect(lines.join(" ")).toBe(subject);
    expect(rendered.some((value) => value.includes("…"))).toBe(false);
  });

  it("[unit] draws the logo in its box with its proportions, or sets the name there", () => {
    const logo: PdfImage = { width: 572, height: 137, colorSpace: "DeviceRGB", filter: "FlateDecode", data: new Uint8Array([1]), alpha: null };
    const image = layoutInvoiceDocument(invoice({ logo })).pages[0]!.operations.find((op) => op.kind === "image");
    expect(image).toMatchObject({ kind: "image", x: 39, width: 220 });
    if (image?.kind !== "image") throw new Error("no image");
    expect(image.height).toBeCloseTo((220 * 137) / 572, 6);
    // A square mark is held by the height instead.
    const square = layoutInvoiceDocument(invoice({ logo: { ...logo, width: 400, height: 400 } })).pages[0]!.operations.find(
      (op) => op.kind === "image",
    );
    if (square?.kind !== "image") throw new Error("no image");
    expect(square.width).toBeCloseTo(110, 6);
    expect(square.height).toBeCloseTo(110, 6);
    const named = texts(invoice({ logo: null })).filter(({ op }) => op.text === "CONFLICT LLC");
    expect(named.map(({ op }) => [op.x, op.size])).toEqual(expect.arrayContaining([[39, 15]]));
  });
});

describe("the lines", () => {
  it("[money] prints money as Harvest does: symbol, figure, code, a leading minus", () => {
    expect(invoiceDocumentMoney(9_993_500, "USD")).toBe("$99,935.00 USD");
    expect(invoiceDocumentMoney(-625_000, "USD")).toBe("-$6,250.00 USD");
    expect(invoiceDocumentMoney(123_456_789, "usd")).toBe("$1,234,567.89 USD");
    expect(invoiceDocumentMoney(100_000, "EUR")).toBe("€1,000.00 EUR");
    // A symbol the encoding cannot draw is left off, never printed as "?".
    expect(invoiceDocumentMoney(100_000, "INR")).toBe("1,000.00 INR");
  });

  it("[money] sets the item type, quantity, unit price and a bold amount per line", () => {
    const input = invoice({
      lines: [{ kind: "Service", description: "*CREDIT 1 of 4:* $6,250.00", quantity: -1, unitPriceCents: 625_000, amountCents: -625_000 }],
    });
    expect(strings(input)).toEqual(expect.arrayContaining(["Service", "-1.00", "$6,250.00 USD"]));
    expect(find(input, "-$6,250.00 USD")).toMatchObject({ font: "bold", align: "right" });
    expect(find(input, "CREDIT 1 of 4:").font).toBe("bold");
    expect(text(renderInvoiceDocument(input))).not.toContain("(\\($6,250.00");
  });

  it("[unit] prints a description in full, with its line breaks, bullets and markup", () => {
    const description =
      "*Blended monthly team fee (team described in Section 2 of SOW):*\n\nThe team composition includes:\n" +
      "• Technical Lead (Principal)\n• Senior Frontend Engineers & UX Engineer (added in concentrated bursts " +
      "while frontend and design work is active)\n\n*Services Include*\n• Assist with any _additional_ requirement gathering";
    const input = invoice({ lines: [{ kind: "Service", description, quantity: 1, unitPriceCents: 1, amountCents: 1 }] });
    const rendered = texts(input).map(({ op }) => op);
    const joined = rendered.map((op) => op.text).join(" ");
    for (const phrase of ["Technical Lead (Principal)", "concentrated bursts", "while frontend and design work is active)", "requirement gathering"]) {
      expect(joined).toContain(phrase);
    }
    expect(rendered.find((op) => op.text === "Services Include")?.font).toBe("bold");
    expect(rendered.find((op) => op.text === "additional")?.font).toBe("italic");
    expect(text(renderInvoiceDocument(input))).toContain(`(${String.fromCharCode(0x95)} Technical Lead \\(Principal\\)) Tj`);
    expect(joined).not.toContain("…");
  });

  it("[unit] shades every other row, as Harvest does", () => {
    const lines = Array.from({ length: 4 }, (_, index) => ({
      kind: "Service",
      description: `Line ${String(index)}`,
      quantity: 1,
      unitPriceCents: 100,
      amountCents: 100,
    }));
    const fills = layoutInvoiceDocument(invoice({ lines })).pages[0]!.operations.filter((op) => op.kind === "rect");
    expect(fills).toHaveLength(2);
  });

  it("[unit] carries rows onto later pages, keeps each one whole, and sets nothing under the footer", () => {
    const lines = Array.from({ length: 90 }, (_, index) => ({
      kind: "Service",
      description: index % 4 === 0 ? `Long line ${String(index)}\nwith a second line\nand a third` : `Line ${String(index)}`,
      quantity: 1,
      unitPriceCents: 100,
      amountCents: 100,
    }));
    const input = invoice({ lines, subtotalCents: 9_000, totalCents: 9_000 });
    const all = texts(input);
    const count = layoutInvoiceDocument(input).pages.length;
    expect(count).toBeGreaterThan(2);
    expect(all.filter(({ op }) => !/^Page \d+ of \d+$/u.test(op.text)).every(({ op }) => op.y >= 62)).toBe(true);
    // A long row starts and ends on the same page: each page holds as many
    // last lines as first lines.
    for (let page = 1; page <= count; page += 1) {
      const starts = all.filter(({ op, page: at }) => at === page && op.text.startsWith("Long line ")).length;
      const ends = all.filter(({ op, page: at }) => at === page && op.text === "and a third").length;
      expect(ends, `page ${String(page)}`).toBe(starts);
    }
    expect(all.filter(({ op }) => op.text.startsWith("Long line "))).toHaveLength(23);
    // The header is set once, as Harvest's is.
    expect(all.filter(({ op }) => op.text === "Item Type")).toHaveLength(1);
  });
});

describe("the totals", () => {
  const taxed = { subtotalCents: 200_000, taxCents: 16_500, taxRatePpm: 82_500, totalCents: 216_500 } as const;
  const everything = {
    subtotalCents: 200_000,
    discountCents: 40_000,
    discountRatePpm: 200_000,
    taxCents: 14_200,
    taxRatePpm: 88_750,
    tax2Cents: 3_200,
    tax2RatePpm: 20_000,
    totalCents: 177_400,
    paidCents: 100_000,
    dueAmountCents: 77_400,
  } as const;

  it("[money] always states the net, the tax and the total, the total last and large", () => {
    // Accounts payable books an invoice by its net amount, tax amount and
    // total, and sends back one that leaves any of them off -- so all three are
    // stated even at no tax, where Harvest's went straight to the amount due.
    expect(totals(invoice())).toEqual([
      ["Subtotal", "$3,194.95 USD", "row"],
      ["Tax", "$0.00 USD", "row"],
      ["Total", "$3,194.95 USD", "large"],
    ]);
    expect(strings(invoice())).not.toContain("Amount Due");
  });

  it("[money] states the tax rate beside the tax when one is recorded", () => {
    expect(totals(invoice(taxed))).toEqual([
      ["Subtotal", "$2,000.00 USD", "row"],
      ["Tax (8.25%)", "$165.00 USD", "row"],
      ["Total", "$2,165.00 USD", "large"],
    ]);
    // A rate entered as 0 is still a rate, and is stated as one.
    expect(totals(invoice({ taxRatePpm: 0 }))[1]).toEqual(["Tax (0%)", "$0.00 USD", "row"]);
  });

  it("[money] follows the total with the payments and the amount due, that last and large", () => {
    expect(totals(invoice({ ...taxed, paidCents: 100_000, dueAmountCents: 116_500 }))).toEqual([
      ["Subtotal", "$2,000.00 USD", "row"],
      ["Tax (8.25%)", "$165.00 USD", "row"],
      ["Total", "$2,165.00 USD", "row"],
      ["Payments", "-$1,000.00 USD", "row"],
      ["Amount Due", "$1,165.00 USD", "large"],
    ]);
    // Paid in full, it still says what is owed: nothing.
    expect(totals(invoice({ ...taxed, paidCents: 216_500, dueAmountCents: 0 })).slice(-3)).toEqual([
      ["Total", "$2,165.00 USD", "row"],
      ["Payments", "-$2,165.00 USD", "row"],
      ["Amount Due", "$0.00 USD", "large"],
    ]);
    // Owed other than the total with nothing paid against it, the amount due
    // follows the total alone; owed exactly the total, it is not said twice.
    expect(totals(invoice({ ...taxed, dueAmountCents: 100_000 })).slice(-2)).toEqual([
      ["Total", "$2,165.00 USD", "row"],
      ["Amount Due", "$1,000.00 USD", "large"],
    ]);
    expect(totals(invoice({ ...taxed, dueAmountCents: 216_500 })).at(-1)).toEqual(["Total", "$2,165.00 USD", "large"]);
  });

  it("[money] adds a discount and a second tax only when they are real, in Harvest's order", () => {
    expect(totals(invoice(everything))).toEqual([
      ["Subtotal", "$2,000.00 USD", "row"],
      ["Discount (20%)", "-$400.00 USD", "row"],
      ["Tax (8.875%)", "$142.00 USD", "row"],
      ["Tax 2 (2%)", "$32.00 USD", "row"],
      ["Total", "$1,774.00 USD", "row"],
      ["Payments", "-$1,000.00 USD", "row"],
      ["Amount Due", "$774.00 USD", "large"],
    ]);
    // A rate with nothing behind it prints neither.
    const labels = totals(invoice({ discountRatePpm: 200_000, tax2Cents: 0, tax2RatePpm: 20_000 })).map(([label]) => label);
    expect(labels).toEqual(["Subtotal", "Tax", "Total"]);
  });

  it("[unit] keeps Harvest's rhythm: the rows a line apart, the last line set clear below them", () => {
    for (const input of [invoice(), invoice(everything)]) {
      const baselines = totalsBlock(input).map(({ label }) => label.y);
      const steps = baselines.slice(1).map((at, index) => baselines[index]! - at);
      for (const step of steps.slice(0, -1)) expect(step).toBeCloseTo(14.2, 6);
      expect(steps.at(-1)).toBeCloseTo(25, 6);
    }
  });

  it("[money] keeps every totals label clear of the figure beside it, however large", () => {
    const large = { subtotalCents: 123_456_789_00, discountCents: 1_000_000_00, totalCents: 122_456_789_00 };
    // With payments the amount due ends the block; without them, the total.
    for (const input of [invoice({ ...large, paidCents: 100_000_00, dueAmountCents: 122_356_789_00 }), invoice(large)]) {
      for (const { label, figure } of totalsBlock(input)) {
        expect(label.y).toBe(figure.y);
        expect(extent(label).right, label.text).toBeLessThan(extent(figure).left);
      }
    }
  });

  it("[unit] keeps the block whole on one page, clear of the page number, wherever the table ends", () => {
    // From one row to three pages of them: on the way the block lands at the
    // foot of a page and has to move to the next whole rather than split.
    const pages = new Set<number>();
    for (let count = 1; count <= 60; count += 1) {
      const lines = Array.from({ length: count }, (_, index) => ({
        kind: "Service",
        description: `Line ${String(index)}`,
        quantity: 1,
        unitPriceCents: 100,
        amountCents: 100,
      }));
      const block = totalsBlock(invoice({ ...everything, lines }));
      expect(block, `${String(count)} rows`).toHaveLength(7);
      expect(new Set(block.map(({ page }) => page)).size, `${String(count)} rows`).toBe(1);
      expect(block.every(({ label, figure }) => label.y >= 62 && figure.y >= 62), `${String(count)} rows`).toBe(true);
      pages.add(block[0]!.page);
    }
    expect([...pages]).toEqual([1, 2, 3]);
  });
});

describe("the notes and the page", () => {
  const notes =
    "Beneficiary:\n*CONFLICT LLC*\n100 Example Ave STE 200\nSpringfield, IL 62701\n\n*Account details*\n" +
    "Bank: Example Bank, N.A.\nAccount number: 000123456\nRouting number: 110000000\n\n" +
    "*_For wire transfers, please use routing number 011000015._*";

  it("[money] prints the notes under their heading with Harvest's markup", () => {
    const input = invoice({ notes });
    expect(find(input, "Notes").font).toBe("bold");
    expect(find(input, "CONFLICT LLC").font).toBe("bold");
    expect(find(input, "Account details").font).toBe("bold");
    expect(find(input, "For wire transfers, please use routing number 011000015.").font).toBe("bold_italic");
    expect(strings(input)).toEqual(expect.arrayContaining(["Account number: 000123456", "Routing number: 110000000"]));
  });

  it("[money] never cuts the notes: they flow on to as many pages as they need", () => {
    // The bank details are the point of the notes; half an account number is
    // a wire nobody can send.
    const long = Array.from({ length: 140 }, (_, index) => `Line ${String(index)} of the remittance terms`).join("\n");
    const input = invoice({ notes: long });
    const rendered = texts(input);
    for (let index = 0; index < 140; index += 1) {
      expect(rendered.some(({ op }) => op.text === `Line ${String(index)} of the remittance terms`)).toBe(true);
    }
    expect(new Set(rendered.filter(({ op }) => op.text.startsWith("Line ")).map(({ page }) => page)).size).toBeGreaterThan(1);
    expect(rendered.filter(({ op }) => !/^Page \d+ of \d+$/u.test(op.text)).every(({ op }) => op.y >= 62)).toBe(true);
  });

  it("[unit] numbers every page out of the total, centred at the foot", () => {
    const input = invoice({ notes: Array.from({ length: 120 }, (_, index) => `Line ${String(index)}`).join("\n") });
    const count = layoutInvoiceDocument(input).pages.length;
    expect(count).toBeGreaterThan(1);
    for (let page = 1; page <= count; page += 1) {
      expect(find(input, `Page ${String(page)} of ${String(count)}`)).toMatchObject({ align: "center", x: 306 });
    }
  });

  it("[money] prints the payment link when there is one, and nothing when there is not", () => {
    const withLink = strings(invoice({ paymentUrl: "https://buy.stripe.com/test_abc" }));
    expect(withLink).toEqual(expect.arrayContaining(["Pay online", "https://buy.stripe.com/test_abc"]));
    expect(strings(invoice())).not.toContain("Pay online");
    for (const empty of [null, "", "  "]) {
      expect(strings(invoice({ paymentUrl: empty }))).not.toContain("Pay online");
    }
  });

  it("[unit] names the document and renders one with no lines at all", () => {
    expect(text(renderInvoiceDocument(invoice()))).toContain("/Title (Invoice 1315)");
    const rendered = strings(invoice({ lines: [], subtotalCents: 0, totalCents: 0 }));
    expect(rendered).toEqual(expect.arrayContaining(["Item Type", "Total", "$0.00 USD"]));
  });
});

describe("the preview watermark", () => {
  // Part paid, with a purchase order and notes long enough to carry it on to
  // a second page.
  const twoPages = invoice({
    purchaseOrder: "PO-778812",
    paidCents: 100_000,
    dueAmountCents: 219_495,
    notes: Array.from({ length: 60 }, (_, index) => `Remittance detail ${String(index + 1)}`).join("\n"),
  });

  it("[unit] changes nothing without one: the same bytes the invoice rendered as before it existed", () => {
    const plain = renderInvoiceDocument(twoPages);
    for (const none of [null, "", "  \n "]) expect(renderInvoiceDocument({ ...twoPages, watermark: none })).toEqual(plain);
    expect(text(plain)).not.toContain("/ExtGState");
    // Recorded from this layout before the watermark was added. A deliberate
    // change to the layout changes it and is the time to record it again; the
    // watermark alone never may, because an invoice already sent is compared
    // with a re-render of it.
    expect(createHash("sha256").update(plain).digest("hex")).toBe(
      "45d52b28ba2494a8cc2c4d26f97f728752c6ea9ff0f776a32b1c3e1314b2781b",
    );
  });

  it("[unit] stamps every page, last, so nothing on the page can cover it", () => {
    const stamped = layoutInvoiceDocument({ ...twoPages, watermark: "  PREVIEW " });
    expect(stamped.pages).toHaveLength(2);
    for (const [index, page] of stamped.pages.entries()) {
      const mark = page.operations.at(-1);
      if (mark?.kind !== "watermark") throw new Error(`page ${String(index + 1)} does not end with the watermark`);
      expect(page.operations.filter((op) => op.kind === "watermark")).toHaveLength(1);
      // Large and bold, on the diagonal, and faint enough to read the figures through.
      expect(mark).toMatchObject({ text: "PREVIEW", font: "bold", angle: 45 });
      expect(mark.size).toBeGreaterThanOrEqual(100);
      expect(mark.size).toBeLessThanOrEqual(130);
      expect(mark.opacity).toBeGreaterThanOrEqual(0.12);
      expect(mark.opacity).toBeLessThanOrEqual(0.18);
    }
    const rendered = text(renderInvoiceDocument({ ...twoPages, watermark: "PREVIEW" }));
    expect(rendered.split("(PREVIEW) Tj").length - 1).toBe(2);
    expect(rendered.split(" /ExtGState << ").length - 1).toBe(2);
  });

  it("[money] moves and removes nothing the client reads", () => {
    const plain = layoutInvoiceDocument(twoPages);
    const stamped = layoutInvoiceDocument({ ...twoPages, watermark: "PREVIEW" });
    expect(stamped.title).toBe(plain.title);
    expect(stamped.pages.map((page) => page.operations.filter((op) => op.kind !== "watermark"))).toEqual(
      plain.pages.map((page) => page.operations),
    );
  });

  it("[unit] sets a long one smaller rather than run it off the page", () => {
    const watermarkOf = (watermark: string): WatermarkOperation => {
      const mark = layoutInvoiceDocument(invoice({ watermark })).pages[0]!.operations.at(-1);
      if (mark?.kind !== "watermark") throw new Error("there is no watermark on the page");
      return mark;
    };
    const short = watermarkOf("PREVIEW");
    const long = watermarkOf("PREVIEW — NOT A REQUEST FOR PAYMENT");
    expect(long.size).toBeLessThan(short.size);
    // Turned, each still sits inside the page's 39-point margins.
    for (const mark of [short, long]) {
      const turn = (mark.angle * Math.PI) / 180;
      const width = textWidth(mark.text, mark.font, mark.size);
      const cap = capHeight(mark.font, mark.size);
      expect(width * Math.cos(turn) + cap * Math.sin(turn), mark.text).toBeLessThanOrEqual(PDF_PAGE_WIDTH - 2 * 39 + 1e-9);
      expect(width * Math.sin(turn) + cap * Math.cos(turn), mark.text).toBeLessThanOrEqual(PDF_PAGE_HEIGHT - 2 * 39 + 1e-9);
    }
  });
});

/**
 * Issue 33 (F7): an invoice for a parent client reads as a section per
 * end-client, each closed by its subtotal; one for a single client is untouched.
 */
describe("invoice document by end-client", () => {
  const line = (endClientId: number | null, endClientName: string | null, description: string, amountCents: number) => ({
    kind: "Service",
    description,
    quantity: 1,
    unitPriceCents: amountCents,
    amountCents,
    endClientId,
    endClientName,
  });
  const lines = [
    line(1, "Alpha Unit", "Alpha one", 10_000),
    line(2, "Bravo Division", "Bravo one", 15_000),
    line(1, "Alpha Unit", "Alpha two", 333),
    line(null, null, "Loose fee", 700),
  ];

  it("[unit] gathers lines by the end-client they name, exactly", () => {
    const grouped = groupInvoiceLinesByEndClient(lines)!;
    expect(grouped.sections.map(({ endClientName, subtotalCents }) => [endClientName, subtotalCents])).toEqual([
      ["Alpha Unit", 10_333],
      ["Bravo Division", 15_000],
    ]);
    expect(grouped.sections[0]!.lines.map((l) => l.description)).toEqual(["Alpha one", "Alpha two"]);
    expect(grouped.ungrouped.map((l) => l.description)).toEqual(["Loose fee"]);
  });

  it("[unit] groups nothing for one end-client or none", () => {
    expect(groupInvoiceLinesByEndClient(lines.filter((l) => l.endClientId !== 2))).toBeNull();
    expect(groupInvoiceLinesByEndClient(lines.map((l) => ({ ...l, endClientId: null })))).toBeNull();
    expect(groupInvoiceLinesByEndClient([])).toBeNull();
  });

  it("[unit] refuses a subtotal that leaves the safe integers", () => {
    expect(() =>
      groupInvoiceLinesByEndClient([
        line(1, "A", "x", Number.MAX_SAFE_INTEGER),
        line(1, "A", "y", 1),
        line(2, "B", "z", 1),
      ]),
    ).toThrow(RangeError);
  });

  it("[money] prints each section's name and subtotal, and the totals are the invoice's", () => {
    const all = strings(invoice({ lines, subtotalCents: 26_033, totalCents: 26_033 }));
    for (const printed of [
      "Alpha Unit",
      "Subtotal: Alpha Unit",
      "$103.33 USD",
      "Bravo Division",
      "Subtotal: Bravo Division",
      "$150.00 USD",
    ]) {
      expect(all, printed).toContain(printed);
    }
    // Alpha's two lines sit together, before Bravo's, though they were not adjacent.
    expect(all.indexOf("Alpha two")).toBeLessThan(all.indexOf("Bravo one"));
    expect(all.indexOf("Subtotal: Alpha Unit")).toBeLessThan(all.indexOf("Bravo Division"));
    expect(all.indexOf("Loose fee")).toBeGreaterThan(all.indexOf("Subtotal: Bravo Division"));
    expect(all).toContain("$260.33 USD");
  });

  it("[unit] lays out an invoice for one client byte for byte as before", () => {
    const plain = invoice().lines;
    const attributed = plain.map((l) => ({ ...l, endClientId: 7, endClientName: "Only Client" }));
    expect(layoutInvoiceDocument(invoice({ lines: attributed }))).toEqual(layoutInvoiceDocument(invoice({ lines: plain })));
  });
});

describe("the instance accent (issue 1011)", () => {
  type LineOperation = Extract<PdfOperation, { kind: "line" }>;
  const coloured = (input: InvoiceDocumentInput): LineOperation[] =>
    layoutInvoiceDocument(input).pages.flatMap((page) =>
      page.operations.filter((op): op is LineOperation => op.kind === "line" && op.rgb !== undefined),
    );

  it("[unit] draws the accent as rules, in the channels of the hex", () => {
    const rules = coloured(invoice({ accentColor: "#FF8000" }));
    expect(rules.length).toBe(2);
    for (const rule of rules) {
      expect(rule.rgb![0]).toBeCloseTo(1, 5);
      expect(rule.rgb![1]).toBeCloseTo(128 / 255, 5);
      expect(rule.rgb![2]).toBeCloseTo(0, 5);
    }
    expect(text(renderInvoiceDocument(invoice({ accentColor: "#FF8000" })))).toContain(" RG");
  });

  it("[unit] never colours text", () => {
    expect(texts(invoice({ accentColor: "#FF8000" }))).toEqual(texts(invoice()));
  });

  it("[unit] no accent, or one that is not a six-digit hex, is the greyscale page byte for byte", () => {
    const plain = renderInvoiceDocument(invoice());
    for (const accentColor of [null, "red", "#FFF", "#GG0000", "url(x)"]) {
      expect(renderInvoiceDocument(invoice({ accentColor }))).toEqual(plain);
    }
    expect(text(plain)).not.toContain(" RG");
  });
});
