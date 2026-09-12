// Provenance: issue 496. There is no way to take a time entry back.
//
// A person who logs to the wrong project, or twice, has to be able to remove
// the entry. `deleteTimeEntry` exists, but an entry claimed by an invoice is not
// free to delete: its hours are billed, and `time_entries.invoice_id` points at
// the invoice that billed them.
//
// The account has a live example of what happens without a path. A test invoice
// raised during acceptance had to be removed by rebuilding the production
// database, because 352 entries were locked to it and nothing could release
// them.
//
// So the operation is two, not one: release, then delete. This migration is the
// first half, and the rule it enforces is that releasing is refused while the
// invoice still stands.
//
// "Stands" means open or paid. An invoice a client has been sent and may pay is
// the one thing that must not quietly lose the hours behind it -- release it and
// the invoice claims money no time entry accounts for any more, which is a
// reconciliation that can never be made to balance. A draft has not been sent,
// and a closed invoice has been cancelled or written off, so in both cases the
// hours are no longer supporting a live claim.
//
// Enforced here rather than only in the repository, because the failure this
// prevents is silent. Clearing a column is the sort of thing a fix-up script
// does at 2am, and the trigger is what makes that refuse rather than succeed.

export const releaseInvoicedTimeMigration = [
  `CREATE TRIGGER time_entries_release_requires_settled_invoice
    BEFORE UPDATE OF invoice_id ON time_entries
    WHEN OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NULL
      AND EXISTS (
        SELECT 1 FROM invoices invoice
        WHERE invoice.id = OLD.invoice_id AND invoice.state IN ('open','paid')
      )
    BEGIN
      SELECT RAISE(ABORT, 'a time entry cannot be released while its invoice stands');
    END`,

  // The same rule from the other side. Deleting the row outright would take the
  // hours with it and leave the invoice claiming money nothing accounts for --
  // the identical hole, reached by a different statement.
  `CREATE TRIGGER time_entries_delete_requires_release
    BEFORE DELETE ON time_entries
    WHEN OLD.invoice_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM invoices invoice
        WHERE invoice.id = OLD.invoice_id AND invoice.state IN ('open','paid')
      )
    BEGIN
      SELECT RAISE(ABORT, 'a time entry cannot be deleted while its invoice stands');
    END`,
] as const
