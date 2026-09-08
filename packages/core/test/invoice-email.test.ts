import { describe, expect, it } from "vitest";
import {
  interpolateEmailTemplate,
  invoiceEmailDescriptionLimit,
  invoiceEmailLineLimit,
  invoiceLineItemsBlock,
  type InvoiceEmailLine,
} from "../src/index.js";

const line = (over: Partial<InvoiceEmailLine> = {}): InvoiceEmailLine => ({
  kind: "Service",
  description: "Discovery workshop",
  quantity: 3,
  unitPriceCents: 12_500,
  amountCents: 37_500,
  ...over,
});

describe("invoice email line items", () => {
  it("[unit] states what the amount is for in both bodies", () => {
    const block = invoiceLineItemsBlock(
      [line(), line({ kind: "Expense", description: null, quantity: 1, unitPriceCents: 4_000, amountCents: 4_000 })],
      { currency: "USD", totalCents: 41_500, discountCents: 0, taxCents: 0 },
    );

    expect(block.text).toBe(
      [
        "Line items",
        "Service: Discovery workshop",
        "  3 x $125.00 = $375.00",
        "Expense",
        "  1 x $40.00 = $40.00",
        "Total: $415.00",
      ].join("\n"),
    );
    // The same three facts per line, and the same total, reach an HTML body as
    // a table rather than as one run-on paragraph.
    expect(block.html).toContain(
      '<td style="padding:6px 8px;border-bottom:1px solid #C8CBD0;text-align:left">Service: Discovery workshop</td>',
    );
    expect(block.html).toContain(">$375.00</td>");
    expect(block.html).toContain(">$415.00</td>");
    expect(block.html.match(/<tr>/gu)).toHaveLength(4);
  });

  it("[unit] escapes a client-authored description into HTML and flattens it in text", () => {
    const block = invoiceLineItemsBlock(
      [
        line({
          kind: "Service",
          description:
            '<script>alert("x")</script> & more\nTotal: $0.00\n  1 x $0.00 = $0.00',
        }),
      ],
      { currency: "USD", totalCents: 37_500, discountCents: 0, taxCents: 0 },
    );

    // HTML: markup a client typed into a description arrives as text.
    expect(block.html).not.toContain("<script>");
    expect(block.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more",
    );
    // Plain text: newlines are structure in this block, so a description
    // cannot draw rows of its own and claim lines the invoice does not have.
    expect(block.text.split("\n")).toEqual([
      "Line items",
      'Service: <script>alert("x")</script> & more Total: $0.00 1 x $0.00 = $0.00',
      "  3 x $125.00 = $375.00",
      "Total: $375.00",
    ]);
  });

  it("[unit] clamps a long description and summarises the money it does not list", () => {
    const long = "d".repeat(invoiceEmailDescriptionLimit + 40);
    const lines = [
      line({ description: long }),
      ...Array.from({ length: invoiceEmailLineLimit }, () =>
        line({ description: "Overflow", amountCents: 1_000 }),
      ),
    ];
    const block = invoiceLineItemsBlock(lines, {
      currency: "USD",
      totalCents: 100_000,
      discountCents: 0,
      taxCents: 0,
    });

    const clamped = block.text.split("\n")[1]!;
    expect(clamped).toBe(
      `Service: ${"d".repeat(invoiceEmailDescriptionLimit - 1)}…`,
    );
    // One line over the limit, and it is accounted for rather than dropped.
    expect(block.text).toContain("and 1 more line item totalling $10.00");
    expect(block.text.endsWith("Total: $1,000.00")).toBe(true);
    expect(block.html.match(/<tr>/gu)).toHaveLength(invoiceEmailLineLimit + 3);
  });

  it("[unit] says so when an invoice carries no lines at all", () => {
    const block = invoiceLineItemsBlock([], {
      currency: "EUR",
      totalCents: 0,
      discountCents: 0,
      taxCents: 0,
    });
    expect(block.text).toBe(
      ["Line items", "This invoice has no line items.", "Total: €0.00"].join("\n"),
    );
    expect(block.html).toContain("This invoice has no line items.");
  });

  // The defect this closes: line amounts are pre-tax and the header total is
  // not, so a list printed straight under that total contradicted it. A client
  // was shown $415.00 of work and told to pay $407.25 with nothing between the
  // two. The rows that reconcile them are the ones the invoice document on
  // screen already shows.
  it("[unit] reconciles a discounted, taxed list to the total printed beneath it", () => {
    // A 10% discount on a $415.00 subtotal, and 10% tax on the discounted
    // $375.00 taxed base: exactly what the invoice header stores.
    const subtotalCents = 41_500;
    const discountCents = 4_150;
    const taxCents = 3_375;
    const totalCents = subtotalCents - discountCents + taxCents;
    const block = invoiceLineItemsBlock(
      [line(), line({ kind: "Expense", description: null, quantity: 1, unitPriceCents: 4_000, amountCents: 4_000 })],
      { currency: "USD", totalCents, discountCents, taxCents },
    );

    expect(block.text).toBe(
      [
        "Line items",
        "Service: Discovery workshop",
        "  3 x $125.00 = $375.00",
        "Expense",
        "  1 x $40.00 = $40.00",
        // $375.00 + $40.00 = $415.00, and the column below it arrives at the
        // total a client is asked to pay.
        "Subtotal: $415.00",
        "Discount: -$41.50",
        "Tax: $33.75",
        "Total: $407.25",
      ].join("\n"),
    );
    // The same reconciliation in the HTML body, in the table's foot: three
    // adjustment rows above the total rather than a total on its own.
    expect(block.html).toContain(
      '<tfoot><tr><th scope="row" colspan="3" style="padding:6px 8px;text-align:left">Subtotal</th>',
    );
    expect(block.html).toContain(">-$41.50</td>");
    expect(block.html).toContain(">$33.75</td>");
    expect(block.html).toContain(">$407.25</td>");
    expect(block.html.match(/<tr>/gu)).toHaveLength(7);
  });

  it("[unit] summarises withheld lines against the subtotal, not the taxed total", () => {
    const lines = Array.from({ length: invoiceEmailLineLimit + 1 }, () =>
      line({ description: "Overflow", quantity: 1, unitPriceCents: 1_000, amountCents: 1_000 }),
    );
    const block = invoiceLineItemsBlock(lines, {
      currency: "USD",
      totalCents: 111_100,
      discountCents: 0,
      taxCents: 10_100,
    });

    // The 100 listed lines come to $1,000.00 and the withheld one to $10.00.
    // Together they are the subtotal, and the tax carries that to the total.
    expect(block.text.split("\n").slice(-4)).toEqual([
      "and 1 more line item totalling $10.00",
      "Subtotal: $1,010.00",
      "Tax: $101.00",
      "Total: $1,111.00",
    ]);
  });

  it("[unit] reaches a template as a block, not as escaped markup", () => {
    const block = invoiceLineItemsBlock([line()], {
      currency: "USD",
      totalCents: 37_500,
      discountCents: 0,
      taxCents: 0,
    });

    expect(
      interpolateEmailTemplate("invoice", "Owed:\n%invoice_line_items%", {
        invoice_line_items: block,
      }),
    ).toBe(`Owed:\n${block.text}`);
    expect(
      interpolateEmailTemplate(
        "invoice",
        "<p>Owed:</p>%invoice_line_items%",
        { invoice_line_items: block },
        { output: "html" },
      ),
    ).toBe(`<p>Owed:</p>${block.html}`);
  });
});
