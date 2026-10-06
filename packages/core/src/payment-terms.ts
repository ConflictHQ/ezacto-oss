import type { InvoicePaymentTerms } from "./invoice-document.js";

/**
 * How many days an invoice's terms give the client, and what they are called.
 *
 * One rule in one place. Invoice generation and the recurring engine each
 * carried their own copy of the due-date arithmetic, and two copies of the
 * rule that decides when a client owes money is how a generated invoice and a
 * recurring one come to disagree about the same terms.
 */

const termDays: Readonly<Record<InvoicePaymentTerms, number>> = {
  upon_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
  // Custom terms are a date somebody chooses on the invoice. Raised without
  // one, the invoice is due the day it is issued, which is the honest default:
  // nothing later was agreed.
  custom: 0,
};

/**
 * The due date for an invoice issued on `issueDate` under `terms`. Calendar
 * arithmetic in UTC on a `YYYY-MM-DD` day, so no timezone moves the answer.
 */
export const invoiceDueDate = (issueDate: string, terms: InvoicePaymentTerms): string => {
  const value = new Date(`${issueDate}T00:00:00.000Z`);
  if (!Number.isFinite(value.valueOf()) || value.toISOString().slice(0, 10) !== issueDate) {
    throw new RangeError("issue date must be a canonical calendar date");
  }
  value.setUTCDate(value.getUTCDate() + termDays[terms]);
  return value.toISOString().slice(0, 10);
};

/**
 * Harvest's own wording, as its invoices print it beside the due date:
 * "(Net 30)", "(upon receipt)". Custom terms have no name to print -- the due
 * date is the whole of the agreement -- so they answer `null`.
 */
export const invoicePaymentTermsLabel = (terms: InvoicePaymentTerms): string | null =>
  terms === "upon_receipt"
    ? "upon receipt"
    : terms === "custom"
      ? null
      : `Net ${String(termDays[terms])}`;
