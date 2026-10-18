// Provenance: ezacto-pvt #959. expense_attachments.expense_id is ON DELETE
// RESTRICT, so deleting an expense that carried a receipt failed with a foreign
// key error and the expense could never be removed.
//
// A receipt belongs to its expense: deleting the expense removes the attachment
// rows (the owner link goes with them by cascade). The content-addressed
// file_objects row and its stored bytes are deliberately retained: they are
// shared by content hash with other attachments and a stored object is only
// ever reclaimed by a retention sweep, never by an owner delete. The trigger
// fires only for rows the guarded DELETE actually matches, so locked, billed
// and foreign expenses keep their receipts.
export const expenseDeleteReceiptsMigration = [
  `CREATE TRIGGER expenses_delete_receipts
    BEFORE DELETE ON expenses
    BEGIN
      DELETE FROM attachments
      WHERE expense_attachment_link_id IN (
        SELECT attachment_id FROM expense_attachments WHERE expense_id = OLD.id
      );
    END`,
] as const
