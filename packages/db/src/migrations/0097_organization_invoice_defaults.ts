/**
 * What every new invoice starts with, as Harvest's Invoices › Configure › Default
 * values had it: the notes that carry the beneficiary and bank details, and the
 * subject. Without them a draft goes out with no way to pay it unless somebody
 * remembers to paste the account details in by hand.
 *
 * Nullable: no default is a real answer, and a fresh install has none. Blank is
 * refused rather than stored, so "none" has one spelling.
 */
export const organizationInvoiceDefaultsMigration = [
  `ALTER TABLE organizations ADD COLUMN invoice_default_notes TEXT
    CHECK (invoice_default_notes IS NULL OR (length(trim(invoice_default_notes)) BETWEEN 1 AND 100000))`,
  `ALTER TABLE organizations ADD COLUMN invoice_default_subject TEXT
    CHECK (invoice_default_subject IS NULL OR (length(trim(invoice_default_subject)) BETWEEN 1 AND 998))`,
]
