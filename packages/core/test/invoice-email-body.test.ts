import { describe, expect, it } from "vitest";
import {
  composeInvoiceEmail,
  EmailTemplateVariableError,
  inspectEmailTemplateVariables,
  invoiceDueDate,
  invoiceEmailBody,
  invoiceEmailValues,
  invoiceNotesPlainText,
  invoicePaymentTermsLabel,
  type InvoiceEmailInvoice,
} from "../src/index.js";

const invoice = (over: Partial<InvoiceEmailInvoice> = {}): InvoiceEmailInvoice => ({
  invoiceId: 852_537,
  number: "4021",
  subject: "Retainer, October 2026",
  currency: "USD",
  amountCents: 1_250_000,
  dueAmountCents: 1_250_000,
  discountAmountCents: 0,
  taxAmountCents: 0,
  tax2AmountCents: 0,
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  paymentTerms: "net_30",
  purchaseOrder: "PO-778812",
  notes:
    "*Beneficiary:* Example Studio LLC\n100 Example Street, Example City, EX 00000\n\nBank: Example Federal Bank\nAccount: 000123456789\n\n_Wire:_ SWIFT EXAMPLEXX",
  organizationName: "Example Studio LLC",
  clientName: "Northwind Example Co",
  lineItems: [
    {
      kind: "Service",
      description: "Monthly retainer",
      quantity: 1,
      unitPriceCents: 1_250_000,
      amountCents: 1_250_000,
    },
  ],
  ...over,
});

const rule = "---------------------------------------------";

describe("invoice email body, as Harvest wrote it", () => {
  it("[unit] puts the message first, then the summary, the payment details and the PDF line", () => {
    expect(
      invoiceEmailBody({
        message: "Happy Friday! Please find this month's invoice below.\n\nBest,\nAna",
        invoice: invoice(),
        viewUrl: "https://pay.example.test/i/4021",
        pdfAttached: true,
      }),
    ).toBe(
      [
        "Happy Friday! Please find this month's invoice below.",
        "",
        "Best,",
        "Ana",
        "",
        "Amount Due: $12,500.00 USD",
        "View invoice",
        "https://pay.example.test/i/4021",
        "",
        rule,
        "Invoice Summary",
        rule,
        "Invoice ID: 4021",
        "Issue date: 2026-10-01",
        "Client: Northwind Example Co",
        "P.O. Number: PO-778812",
        "Amount: $12,500.00 USD",
        "Due: 2026-10-31 (Net 30)",
        "",
        rule,
        "Payment Information",
        rule,
        "Beneficiary: Example Studio LLC",
        "100 Example Street, Example City, EX 00000",
        "",
        "Bank: Example Federal Bank",
        "Account: 000123456789",
        "",
        "Wire: SWIFT EXAMPLEXX",
        "",
        "The detailed invoice is attached as a PDF.",
        "",
        "Thank you!",
      ].join("\n"),
    );
  });

  it("[unit] leaves out what the invoice does not have and never promises a PDF it does not carry", () => {
    expect(
      invoiceEmailBody({
        message: "   ",
        invoice: invoice({
          purchaseOrder: "  ",
          notes: null,
          paymentTerms: "custom",
          dueAmountCents: 250_000,
        }),
        viewUrl: null,
        pdfAttached: false,
      }),
    ).toBe(
      [
        "Amount Due: $2,500.00 USD",
        "",
        rule,
        "Invoice Summary",
        rule,
        "Invoice ID: 4021",
        "Issue date: 2026-10-01",
        "Client: Northwind Example Co",
        "Amount: $12,500.00 USD",
        "Due: 2026-10-31",
        "",
        "Thank you!",
      ].join("\n"),
    );
  });

  it("[unit] keeps a summary line on one line whatever a name holds", () => {
    const body = invoiceEmailBody({
      message: "",
      invoice: invoice({ clientName: "Northwind\nExample Co", purchaseOrder: "PO\n1" }),
      viewUrl: null,
      pdfAttached: false,
    });
    expect(body).toContain("Client: Northwind Example Co\n");
    expect(body).toContain("P.O. Number: PO 1\n");
  });

  it("[unit] strips Harvest's markup from the notes with the document's own rules", () => {
    expect(invoiceNotesPlainText("*_Wire to:_* max_user_instances\n5 * 3")).toBe(
      "Wire to: max_user_instances\n5 * 3",
    );
  });
});

describe("composing the invoice email from the Send dialog", () => {
  it("[unit] interpolates the subject and the message, purchase order and terms included", () => {
    const email = composeInvoiceEmail({
      invoice: invoice(),
      subjectTemplate: "Invoice #%invoice_number% from %company_name%",
      messageTemplate:
        "Hello %client_name%,\n\nInvoice %invoice_number% under %invoice_purchase_order% is due %invoice_payment_terms%.",
      paymentUrl: null,
      pdfAttached: true,
    });
    expect(email.subject).toBe("Invoice #4021 from Example Studio LLC");
    expect(
      email.text.startsWith(
        "Hello Northwind Example Co,\n\nInvoice 4021 under PO-778812 is due Net 30.\n\nAmount Due: $12,500.00 USD\n\n",
      ),
    ).toBe(true);
    expect(email.text.endsWith("The detailed invoice is attached as a PDF.\n\nThank you!")).toBe(
      true,
    );
  });

  it("[unit] refuses a variable that does not exist rather than mailing the typo", () => {
    expect(() =>
      composeInvoiceEmail({
        invoice: invoice(),
        subjectTemplate: "Invoice #%invoice_numbr%",
        messageTemplate: "",
        paymentUrl: null,
        pdfAttached: false,
      }),
    ).toThrow(EmailTemplateVariableError);
  });

  it("[unit] gives every invoice variable a value, empty where the invoice has none", () => {
    const values = invoiceEmailValues(
      invoice({ purchaseOrder: null, paymentTerms: "custom" }),
      null,
    );
    expect(values.invoice_purchase_order).toBe("");
    expect(values.invoice_payment_terms).toBe("");
    expect(values.invoice_payment_url).toBe("");
    expect(values.client_name).toBe("Northwind Example Co");
    expect(values.company_name).toBe("Example Studio LLC");
  });

  it("[unit] offers the purchase order and terms to invoice templates only", () => {
    expect(
      inspectEmailTemplateVariables("invoice", "%invoice_purchase_order% %invoice_payment_terms%"),
    ).toEqual([]);
    expect(
      inspectEmailTemplateVariables("reminder", "%invoice_purchase_order%").map(
        (error) => error.code,
      ),
    ).toEqual(["variable_not_allowed"]);
  });
});

describe("payment terms", () => {
  it("[unit] dates an invoice by its terms, in calendar days", () => {
    expect(invoiceDueDate("2026-10-01", "net_30")).toBe("2026-10-31");
    expect(invoiceDueDate("2026-12-20", "net_15")).toBe("2027-01-04");
    expect(invoiceDueDate("2028-02-14", "net_15")).toBe("2028-02-29");
    expect(invoiceDueDate("2026-10-01", "upon_receipt")).toBe("2026-10-01");
    expect(invoiceDueDate("2026-10-01", "custom")).toBe("2026-10-01");
    expect(() => invoiceDueDate("2026-02-30", "net_30")).toThrow(RangeError);
  });

  it("[unit] names terms as Harvest printed them", () => {
    expect(invoicePaymentTermsLabel("net_45")).toBe("Net 45");
    expect(invoicePaymentTermsLabel("upon_receipt")).toBe("upon receipt");
    expect(invoicePaymentTermsLabel("custom")).toBeNull();
  });
});
