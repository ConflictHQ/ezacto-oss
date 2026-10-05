import { describe, expect, it } from "vitest";
import {
  invoiceDocumentMoney,
  layoutInvoiceDocument,
  renderInvoiceDocument,
  type InvoiceDocumentInput,
} from "../src/invoice-document.js";
import { textWidth, type PdfImage, type PdfOperation } from "../src/pdf.js";

/**
 * Issue 626, laid out as Harvest's invoice so the first one a migrated client
 * receives sits beside years of Harvest's without looking like a stranger.
 * Asserted on the laid-out page where position is the point -- a label over a
 * figure, a line under the footer -- and on the written file where it is not.
 */

type TextOperation = Extract<PdfOperation, { kind: "text" }>;

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
  it("[money] goes straight to the amount due when nothing adjusts the total", () => {
    const rendered = strings(invoice());
    expect(rendered).not.toContain("Subtotal");
    expect(rendered).toEqual(expect.arrayContaining(["Amount Due", "$3,194.95 USD"]));
  });

  it("[money] lists the subtotal and each adjustment that is real, with Harvest's labels", () => {
    const rendered = strings(
      invoice({
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
      }),
    );
    const order = ["Subtotal", "Discount (20%)", "Tax (8.875%)", "Tax 2 (2%)", "Payments", "Amount Due"];
    expect(order.map((label) => rendered.indexOf(label))).toEqual([...order.map((label) => rendered.indexOf(label))].sort((a, b) => a - b));
    expect(rendered).toEqual(
      expect.arrayContaining(["$2,000.00 USD", "-$400.00 USD", "$142.00 USD", "$32.00 USD", "-$1,000.00 USD", "$774.00 USD"]),
    );
  });

  it("[money] keeps every totals label clear of the figure beside it, however large", () => {
    const input = invoice({
      subtotalCents: 123_456_789_00,
      discountCents: 1_000_000_00,
      totalCents: 122_456_789_00,
      paidCents: 100_000_00,
      dueAmountCents: 122_356_789_00,
    });
    for (const [label, figure] of [
      ["Subtotal", "$123,456,789.00 USD"],
      ["Discount", "-$1,000,000.00 USD"],
      ["Payments", "-$100,000.00 USD"],
      ["Amount Due", "$122,356,789.00 USD"],
    ] as const) {
      const name = find(input, label);
      const value = find(input, figure);
      expect(name.y).toBe(value.y);
      expect(extent(name).right).toBeLessThan(extent(value).left);
    }
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
    expect(rendered).toEqual(expect.arrayContaining(["Item Type", "Amount Due", "$0.00 USD"]));
  });
});
