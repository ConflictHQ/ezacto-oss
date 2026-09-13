// Provenance: issue 626. An invoice may need to carry more than itself.
//
// From the operator: "potentially any other staged attachments like purchase
// orders". `invoice_attachments` has existed since the import and holds exactly
// that -- files somebody attached to an invoice -- and nothing has ever sent
// one.
//
// Its own preference rather than reusing the document's. These are three
// separate decisions: whether the client gets the invoice as a PDF, whether
// they get the work behind it, and whether they get the files staged against
// it. An operator who wants a purchase order returned with the invoice has not
// thereby asked for a forty-page work journal.
//
// Off by default, and that matters more here than elsewhere. Attachments are
// already on invoices in this account; turning this on by default would email
// files to clients that nobody chose to send, on the day it deployed.
//
// If a fourth of these appears, the three column pairs should become one set
// rather than a fourth pair. Three independent booleans are three independent
// choices; four is a list wearing a disguise.

export const invoiceStagedAttachmentsMigration = [
  `ALTER TABLE organizations ADD COLUMN attach_invoice_files INTEGER NOT NULL DEFAULT 0
    CHECK (attach_invoice_files IN (0,1))`,

  `ALTER TABLE invoices ADD COLUMN attach_invoice_files INTEGER
    CHECK (attach_invoice_files IS NULL OR attach_invoice_files IN (0,1))`,
] as const
