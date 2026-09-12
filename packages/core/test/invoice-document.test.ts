import { describe, expect, it } from "vitest";
import { renderInvoiceDocument, type InvoiceDocumentInput } from "../src/invoice-document.js";

/**
 * Issue 626. Harvest attached a PDF to every invoice it sent and ezacto sends
 * none, so this is what a client sees on the first real send.
 */

const text = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const invoice = (overrides: Partial<InvoiceDocumentInput> = {}): InvoiceDocumentInput => ({
  number: "1315",
  companyName: "CONFLICT",
  clientName: "Kestrel Environmental",
  issueDate: "2026-09-12",
  dueDate: "2026-10-12",
  currency: "USD",
  subject: "Tracked work 2026-08-01 to 2026-08-31",
  lines: [
    { kind: "Service", description: "Advisory", quantity: 12, unitPriceCents: 25_000, amountCents: 300_000 },
    { kind: "Expense", description: "Lodging", quantity: 1, unitPriceCents: 19_495, amountCents: 19_495 },
  ],
  subtotalCents: 319_495,
  discountCents: 0,
  taxCents: 0,
  totalCents: 319_495,
  ...overrides,
});

describe("the invoice a client receives", () => {
  it("[money] prints the number, the client, and the total", () => {
    const rendered = text(renderInvoiceDocument(invoice()));
    expect(rendered).toContain("(INVOICE 1315) Tj");
    expect(rendered).toContain("(BILLED TO KESTREL ENVIRONMENTAL) Tj");
    expect(rendered).toContain("($3,194.95) Tj");
    expect(rendered).toContain("(Issued 2026-09-12   Due 2026-10-12) Tj");
  });

  it("[money] groups thousands and keeps two decimal places", () => {
    const rendered = text(
      renderInvoiceDocument(
        invoice({ subtotalCents: 1_234_567_89, totalCents: 1_234_567_89, lines: [] }),
      ),
    );
    expect(rendered).toContain("($1,234,567.89) Tj");
  });

  it("[money] shows a negative amount in parentheses, as an invoice does", () => {
    // A credit line reading `-$500.00` is read as a minus sign somebody typed;
    // parentheses are what an invoice means by it.
    const rendered = text(
      renderInvoiceDocument(
        invoice({
          lines: [
            { kind: "Service", description: "Credit", quantity: 1, unitPriceCents: -50_000, amountCents: -50_000 },
          ],
        }),
      ),
    );
    // The parentheses are escaped, because they delimit a PDF string.
    expect(rendered).toContain("(\\($500.00\\)) Tj");
  });

  it("[money] omits a zero discount and a zero tax rather than printing them", () => {
    // A row reading "Discount 0.00" invites the question of what discount.
    const rendered = text(renderInvoiceDocument(invoice()));
    expect(rendered).not.toContain("(Discount) Tj");
    expect(rendered).not.toContain("(Tax) Tj");
  });

  it("[money] prints discount and tax when they are real, and the subtotal always", () => {
    const rendered = text(
      renderInvoiceDocument(
        invoice({ discountCents: 5_000, taxCents: 2_500, totalCents: 316_995 }),
      ),
    );
    expect(rendered).toContain("(Subtotal) Tj");
    expect(rendered).toContain("(Discount) Tj");
    expect(rendered).toContain("(Tax) Tj");
    // Shown as a deduction rather than a positive number beside a minus label.
    expect(rendered).toContain("(\\($50.00\\)) Tj");
  });

  it("[money] states the amount due separately only when it differs from the total", () => {
    // On a part-paid invoice the two are different numbers and the client needs
    // the second one; on an untouched invoice a second identical figure reads
    // as a mistake.
    expect(text(renderInvoiceDocument(invoice({ dueAmountCents: 319_495 })))).not.toContain(
      "(Amount due) Tj",
    );
    expect(text(renderInvoiceDocument(invoice({ dueAmountCents: 100_000 })))).toContain(
      "(Amount due) Tj",
    );
  });

  it("[money] prints the payment link when there is one, and nothing when there is not", () => {
    const withLink = text(
      renderInvoiceDocument(invoice({ paymentUrl: "https://buy.stripe.com/test_abc" })),
    );
    expect(withLink).toContain("(Pay online) Tj");
    expect(withLink).toContain("(https://buy.stripe.com/test_abc) Tj");
    for (const empty of [undefined, null, ""]) {
      expect(text(renderInvoiceDocument(invoice({ paymentUrl: empty })))).not.toContain(
        "(Pay online) Tj",
      );
    }
  });

  it("[unit] carries a line onto a second page rather than off the bottom", () => {
    // A hundred lines is an ordinary invoice generated from tracked time.
    const lines = Array.from({ length: 100 }, (_, index) => ({
      kind: "Service",
      description: `Day ${String(index + 1)}`,
      quantity: 1,
      unitPriceCents: 10_000,
      amountCents: 10_000,
    }))
    const rendered = text(
      renderInvoiceDocument(invoice({ lines, subtotalCents: 1_000_000, totalCents: 1_000_000 })),
    );
    const pages = Number(/\/Count (\d+)/u.exec(rendered)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(rendered).toContain("(Page 1) Tj");
    expect(rendered).toContain(`(Page ${String(pages)}) Tj`);
    // The column heading repeats, or the second page is a list of bare numbers.
    expect(rendered.split("(DESCRIPTION) Tj").length - 1).toBeGreaterThan(1);
    // Prefixed with its kind, so the last line reads "Service: Day 100".
    expect(rendered).toContain("(Service: Day 100) Tj");
  });

  it("[unit] cuts a description rather than letting it run under the figures", () => {
    const rendered = text(
      renderInvoiceDocument(
        invoice({
          lines: [
            {
              kind: "Service",
              description: "x".repeat(200),
              quantity: 1,
              unitPriceCents: 100,
              amountCents: 100,
            },
          ],
        }),
      ),
    );
    // The ellipsis is WinAnsi 0x85.
    expect(rendered).toContain(String.fromCharCode(0x85));
    expect(rendered).not.toContain("x".repeat(100));
  });

  it("[unit] falls back to the line kind when a description is missing", () => {
    const rendered = text(
      renderInvoiceDocument(
        invoice({
          lines: [
            { kind: "Service", description: null, quantity: 1, unitPriceCents: 100, amountCents: 100 },
            { kind: "Expense", description: "  ", quantity: 1, unitPriceCents: 100, amountCents: 100 },
          ],
        }),
      ),
    );
    expect(rendered).toContain("(Service) Tj");
    expect(rendered).toContain("(Expense) Tj");
  });

  it("[unit] names the document so a reader and a saved file both say which invoice", () => {
    expect(text(renderInvoiceDocument(invoice()))).toContain("/Title (Invoice 1315)");
  });

  it("[money] keeps every totals label clear of the figure beside it", () => {
    // Geometry, not content. `toContain` cannot see two strings printed on top
    // of one another, and that is exactly what happened: the labels were placed
    // at the rate column and ran right through the amounts, so the first render
    // read "Subtotal" over "$23,739.80". Ghostscript showed it; no assertion
    // about either string being present could have.
    //
    // The figures are monospaced, so where one starts is arithmetic: its right
    // edge less its exact width. A label may not reach that point.
    const rendered = text(
      renderInvoiceDocument(
        invoice({ discountCents: 12_500, taxCents: 18_750, totalCents: 2_380_230, dueAmountCents: 1_380_230 }),
      ),
    );
    const placements = [
      ...rendered.matchAll(
        /\/(F\d) ([\d.]+) Tf\n([-\d.]+) ([-\d.]+) Td\n\((.*?)\) Tj/gu,
      ),
    ].map((match) => ({
      font: match[1]!,
      size: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
      text: match[5]!,
    }));

    for (const name of ["Subtotal", "Discount", "Tax", "Total", "Amount due"]) {
      const label = placements.find((placement) => placement.text === name);
      expect(label, `${name} is missing from the document`).toBeDefined();
      // The figure printed on the same line. Mono, so its left edge is known.
      const figure = placements.find(
        (placement) =>
          placement.y === label!.y &&
          placement.text !== name &&
          (placement.font === "F3" || placement.font === "F4"),
      );
      expect(figure, `${name} has no figure beside it`).toBeDefined();
      // The label's own width is what runs into the figure, so comparing the
      // two starting points proves nothing -- the first version of this test
      // did exactly that and passed with the labels back in the overlapping
      // position. Helvetica's widest glyph is `W` at 944/1000 em, so 0.95 per
      // character cannot under-estimate a proportional string.
      const widestPossible = label!.text.length * label!.size * 0.95;
      expect(
        label!.x + widestPossible,
        `${name} can overlap the figure beside it`,
      ).toBeLessThanOrEqual(figure!.x);
    }
  });

  it("[money] keeps the total band clear of the row above it", () => {
    // Fills are painted in order, so a band tall enough to reach the previous
    // row covers it. The Tax row vanished underneath this band in the first
    // render, and nothing about the text could show that -- the string was
    // still in the file, with a grey rectangle drawn on top of it.
    const rendered = text(
      renderInvoiceDocument(
        invoice({ discountCents: 12_500, taxCents: 18_750, totalCents: 2_380_230 }),
      ),
    );
    const band = [
      ...rendered.matchAll(/([\d.]+) g\n([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re f/gu),
    ]
      .map((match) => ({
        grey: Number(match[1]),
        y: Number(match[3]),
        height: Number(match[5]),
      }))
      .find((rectangle) => rectangle.grey > 0.8);
    expect(band, "the total band is missing").toBeDefined();

    const tax = /\n([-\d.]+) ([-\d.]+) Td\n\(Tax\) Tj/u.exec(rendered);
    expect(tax, "the Tax row is missing").not.toBeNull();
    expect(
      band!.y + band!.height,
      "the total band is painted over the row above it",
    ).toBeLessThan(Number(tax![2]));
  });

  it("[unit] renders an invoice with no lines at all", () => {
    // A fixed-fee invoice can have its money entirely in the totals.
    const rendered = text(renderInvoiceDocument(invoice({ lines: [] })));
    expect(rendered).toContain("(Subtotal) Tj");
    expect(rendered).toContain("(Total) Tj");
  });
});
