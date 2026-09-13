// Provenance: issue 484. A banded team at a flat monthly rate has no
// representation, so invoicing that engagement from tracked time bills the
// wrong number -- $136,875.90 of time against a $93,685.00 band, for the
// largest active engagement.
//
// Two columns, and the second is not the one the issue asked for.
//
// `claims_project_ids` is how a definition says whose time its flat amount
// consumes. `fixed_lines` carries no project reference and `line_items_import`
// already carries `project_ids`, so a banded definition is a fixed-lines
// definition that also names the projects it covers. Null means it claims
// nothing, which is what every definition does today -- this whole feature is
// inert until somebody names a project.
//
// `foregone_billable_cents` is the value delivered under the band and never
// charged. The issue proposed putting it in `written_off_cents`, and that would
// be wrong: those columns are settlement. `write_off` adds the invoice's own due
// amount to them, and a non-zero write-off blocks returning an invoice to draft.
// The banded client owes the full flat amount and pays all of it; nothing about
// that invoice is forgiven. Recording the difference there would make a fully
// collectible invoice read as partly written off, so this is its own column and
// stays outside the due/paid/written-off arithmetic entirely.

export const bandedEngagementsMigration = [
  `ALTER TABLE recurring_invoices ADD COLUMN claims_project_ids TEXT
    CHECK (claims_project_ids IS NULL OR (
      json_valid(claims_project_ids)
      AND json_type(claims_project_ids) = 'array'
      AND json_array_length(claims_project_ids) > 0
    ))`,

  // Never negative. A band that bills more than the work it covers is an
  // ordinary profitable month, not a negative forgone amount, and the reporting
  // question "what did the band cost" has the answer zero.
  `ALTER TABLE invoices ADD COLUMN foregone_billable_cents INTEGER NOT NULL DEFAULT 0
    CHECK (foregone_billable_cents BETWEEN 0 AND 9000000000000)`,

  // Every named project must belong to the definition's client. Claiming time
  // across clients would put one client's work inside another's invoice, and
  // the time-entry trigger from 0004 would refuse the claim anyway -- better to
  // refuse the definition than to have it fail every month at generation.
  `CREATE TRIGGER recurring_claims_projects_same_client_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.claims_project_ids IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.claims_project_ids) member
      WHERE NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = CAST(member.value AS INTEGER)
          AND project.client_id = NEW.client_id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'a claimed project must belong to the definition client'); END`,
  `CREATE TRIGGER recurring_claims_projects_same_client_update
    BEFORE UPDATE OF claims_project_ids, client_id ON recurring_invoices
    WHEN NEW.claims_project_ids IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.claims_project_ids) member
      WHERE NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = CAST(member.value AS INTEGER)
          AND project.client_id = NEW.client_id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'a claimed project must belong to the definition client'); END`,
] as const
