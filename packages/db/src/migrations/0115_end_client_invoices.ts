/**
 * One invoice, many end-clients (issue 33, F7).
 *
 * An invoice raised for a parent client may bill work done under any client
 * beneath it in the tree, each line attributed to its end-client by the
 * project it carries. Until now the database insisted that every project an
 * invoice touched belonged to the invoice's own client, which is why a
 * parent's invoice needed a free-text subject to say whose work it was.
 *
 * Seven triggers state that rule, and each is replaced here with the same text
 * and the same message, the equality widened to "the invoice's client, or a
 * client beneath it":
 *
 * - `invoice_line_items_project_client_insert` / `_update` (0004)
 * - `time_entries_invoice_client_insert` / `_update` (0004)
 * - `expenses_invoice_client_insert` / `_update` (0007)
 * - `invoices_client_consistent_with_children_update` (0023), whose line, time
 *   and expense clauses follow; the milestone clause is left as it was.
 *
 * Nothing else is relaxed. A project of an unrelated client, of the invoice's
 * ancestor, or of a sibling is still refused; the invoice header's own
 * `project_id` (0004) still has to be the invoice client's project; a band
 * (0078) still claims only its own client's work; and a project still cannot
 * change client while an invoice links it (0007).
 *
 * No row is read or written, so no existing invoice, line, or total changes.
 */

/** Whether `node` is `root` or any client beneath it. Cycles are refused at write (0001). */
const inTree = (root: string, node: string): string => `EXISTS (
        WITH RECURSIVE tree(id) AS (
          SELECT ${root}
          UNION
          SELECT child.id FROM clients child JOIN tree ON child.parent_client_id = tree.id
        )
        SELECT 1 FROM tree WHERE tree.id = ${node}
      )`

const linkedTrigger = (
  name: string,
  event: string,
  table: string,
  link: string,
  invoice: string,
  message: string,
): string => `CREATE TRIGGER ${name}
    ${event} ON ${table}
    WHEN NEW.${invoice} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.${link}
      WHERE invoice.id = NEW.${invoice}
        AND ${inTree('invoice.client_id', 'project.client_id')}
    )
    BEGIN SELECT RAISE(ABORT, '${message}'); END`

export const endClientInvoicesMigration = [
  `DROP TRIGGER invoice_line_items_project_client_insert`,
  `DROP TRIGGER invoice_line_items_project_client_update`,
  `DROP TRIGGER time_entries_invoice_client_insert`,
  `DROP TRIGGER time_entries_invoice_client_update`,
  `DROP TRIGGER expenses_invoice_client_insert`,
  `DROP TRIGGER expenses_invoice_client_update`,
  `DROP TRIGGER invoices_client_consistent_with_children_update`,
  `CREATE TRIGGER invoice_line_items_project_client_insert
    BEFORE INSERT ON invoice_line_items
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects project
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE project.id = NEW.project_id
        AND ${inTree('invoice.client_id', 'project.client_id')}
    )
    BEGIN SELECT RAISE(ABORT, 'invoice line project must belong to invoice client'); END`,
  `CREATE TRIGGER invoice_line_items_project_client_update
    BEFORE UPDATE OF invoice_id, project_id ON invoice_line_items
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects project
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE project.id = NEW.project_id
        AND ${inTree('invoice.client_id', 'project.client_id')}
    )
    BEGIN SELECT RAISE(ABORT, 'invoice line project must belong to invoice client'); END`,
  linkedTrigger(
    'time_entries_invoice_client_insert',
    'BEFORE INSERT',
    'time_entries',
    'project_id',
    'invoice_id',
    'time entry project must belong to invoice client',
  ),
  linkedTrigger(
    'time_entries_invoice_client_update',
    'BEFORE UPDATE OF invoice_id, project_id',
    'time_entries',
    'project_id',
    'invoice_id',
    'time entry project must belong to invoice client',
  ),
  linkedTrigger(
    'expenses_invoice_client_insert',
    'BEFORE INSERT',
    'expenses',
    'project_id',
    'invoice_id',
    'expense project must belong to invoice client',
  ),
  linkedTrigger(
    'expenses_invoice_client_update',
    'BEFORE UPDATE OF invoice_id, project_id',
    'expenses',
    'project_id',
    'invoice_id',
    'expense project must belong to invoice client',
  ),
  `CREATE TRIGGER invoices_client_consistent_with_children_update
    BEFORE UPDATE OF client_id ON invoices
    WHEN OLD.client_id IS NOT NEW.client_id AND (
      EXISTS (SELECT 1 FROM invoice_line_items line JOIN projects project ON project.id = line.project_id
        WHERE line.invoice_id = OLD.id AND NOT ${inTree('NEW.client_id', 'project.client_id')})
      OR EXISTS (SELECT 1 FROM time_entries entry JOIN projects project ON project.id = entry.project_id
        WHERE entry.invoice_id = OLD.id AND NOT ${inTree('NEW.client_id', 'project.client_id')})
      OR EXISTS (SELECT 1 FROM project_milestones milestone JOIN projects project ON project.id = milestone.project_id
        WHERE milestone.invoiced_invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id)
      OR EXISTS (SELECT 1 FROM expenses expense JOIN projects project ON project.id = expense.project_id
        WHERE expense.invoice_id = OLD.id AND NOT ${inTree('NEW.client_id', 'project.client_id')})
    )
    BEGIN SELECT RAISE(ABORT, 'invoice client must match every linked project'); END`,
] as const
