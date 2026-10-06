import { invoiceGenerationMigration } from './0026_invoice_generation.js'
import { recurringGenerateCommandMigration } from './0037_recurring_generate_command.js'
import { freeFormInvoiceCreateMigration } from './0095_free_form_invoice_create.js'

/**
 * A flat fee covering tracked time -- a band raised from the New invoice
 * dialog rather than by a recurring definition -- is still an `invoice.create`:
 * the same receipt, number sequence, creation event and replay. Its request is
 * a third shape, as exact as the other two: the selection a tracked request
 * has, the band's terms instead of summary types, how many of its lines are
 * the fee, and what the fee covered against what was billed past it. It claims
 * time and never expenses, so its expense count is zero.
 *
 * A fee line is written as a free-form line is, and one may have no
 * description and no project. The line manifest guard 0026 wrote compared both
 * with `=`, which is never true of a null, so it compares them with `IS` now. A
 * tracked request's lines always carry both, so for it nothing changes.
 *
 * Rebuilt rather than altered because SQLite cannot change a CHECK in place:
 * the rename-copy-drop 0095 used, over 0095's own text, asserted first so a
 * reshaped historical statement fails this migration instead of silently
 * losing a clause.
 */
const historicalStatement = (statements: readonly string[], prefix: string): string => {
  const matches = statements.filter((statement) => statement.startsWith(prefix))
  if (matches.length !== 1) {
    throw new Error(`banded invoice migration could not find one historical ${prefix}`)
  }
  return matches[0]!
}

const replaceOnce = (source: string, needle: string, replacement: string): string => {
  if (source.split(needle).length - 1 !== 1) {
    throw new Error(`banded invoice migration found an unexpected historical ${needle}`)
  }
  // A replacer function, so the `$.` paths in the SQL are never read as patterns.
  return source.replace(needle, () => replacement)
}

const recurringCreation = `OR (command_kind = 'recurring.generate' AND COALESCE((`

const bandedCreation = `OR (command_kind = 'invoice.create' AND COALESCE((
        json_valid(request_json) AND json_type(request_json) = 'object'
        AND json_extract(request_json, '$.schema_version') = 1
        AND json_type(request_json, '$.schema_version') = 'integer'
        AND json_extract(request_json, '$.expected_version') = 0
        AND json_type(request_json, '$.expected_version') = 'integer'
        AND json_extract(request_json, '$.kind') = 'banded'
        AND json_type(request_json, '$.client_id') = 'integer'
        AND json_extract(request_json, '$.client_id') > 0
        -- The period the fee covers. An open start over nothing tracked has no
        -- first day to date it from, and records none rather than invent one.
        AND json_type(request_json, '$.to') = 'text'
        AND date(json_extract(request_json, '$.to')) = json_extract(request_json, '$.to')
        AND (json_type(request_json, '$.from') = 'null'
          OR (json_type(request_json, '$.from') = 'text'
            AND date(json_extract(request_json, '$.from')) = json_extract(request_json, '$.from')
            AND json_extract(request_json, '$.from') <= json_extract(request_json, '$.to')))
        AND json_type(request_json, '$.project_ids') = 'array'
        AND json_array_length(request_json, '$.project_ids') > 0
        -- A band is not a summary of the selection, so the keys a tracked
        -- request bills by are absent.
        AND json_type(request_json, '$.time_summary_type') IS NULL
        AND json_type(request_json, '$.expense_summary_type') IS NULL
        -- Everything, or the oldest hours up to exactly one limit with a
        -- grouping for what is billed past it.
        AND ((json_extract(request_json, '$.claim_mode') = 'all'
            AND json_type(request_json, '$.claim_ceiling_seconds') = 'null'
            AND json_type(request_json, '$.claim_ceiling_cents') = 'null'
            AND json_type(request_json, '$.overage_summary_type') = 'null'
            AND json_extract(request_json, '$.billed_entry_count') = 0
            AND json_extract(request_json, '$.billed_seconds') = 0)
          OR (json_extract(request_json, '$.claim_mode') = 'ceiling'
            AND ((json_type(request_json, '$.claim_ceiling_seconds') = 'integer'
                AND json_extract(request_json, '$.claim_ceiling_seconds') > 0
                AND json_type(request_json, '$.claim_ceiling_cents') = 'null')
              OR (json_type(request_json, '$.claim_ceiling_cents') = 'integer'
                AND json_extract(request_json, '$.claim_ceiling_cents') > 0
                AND json_type(request_json, '$.claim_ceiling_seconds') = 'null'))
            AND json_type(request_json, '$.overage_summary_type') = 'text'
            AND json_extract(request_json, '$.overage_summary_type')
              IN ('project','task','people','detailed')))
        AND json_type(request_json, '$.currency') = 'text'
        AND length(json_extract(request_json, '$.currency')) = 3
        AND json_type(request_json, '$.amount_cents') = 'integer'
        AND json_extract(request_json, '$.amount_cents') >= 0
        -- The fee comes first, at least one line of it; any hours billed past
        -- the ceiling follow it.
        AND json_type(request_json, '$.fee_line_count') = 'integer'
        AND json_extract(request_json, '$.fee_line_count') > 0
        AND json_type(request_json, '$.line_count') = 'integer'
        AND json_extract(request_json, '$.line_count')
          >= json_extract(request_json, '$.fee_line_count')
        -- Every entry read lands on the invoice: covered by the fee or billed.
        AND json_type(request_json, '$.time_entry_count') = 'integer'
        AND json_type(request_json, '$.claimed_entry_count') = 'integer'
        AND json_extract(request_json, '$.claimed_entry_count') >= 0
        AND json_type(request_json, '$.billed_entry_count') = 'integer'
        AND json_extract(request_json, '$.billed_entry_count') >= 0
        AND json_extract(request_json, '$.time_entry_count')
          = json_extract(request_json, '$.claimed_entry_count')
            + json_extract(request_json, '$.billed_entry_count')
        AND json_type(request_json, '$.claimed_seconds') = 'integer'
        AND json_type(request_json, '$.billed_seconds') = 'integer'
        AND json_type(request_json, '$.expense_count') = 'integer'
        AND json_extract(request_json, '$.expense_count') = 0
        AND json_valid(source_manifest_json) AND json_type(source_manifest_json) = 'object'
        AND json_extract(source_manifest_json, '$.schema_version') = 1
        AND json_type(source_manifest_json, '$.time_entries') = 'array'
        AND json_type(source_manifest_json, '$.expenses') = 'array'
        AND json_array_length(source_manifest_json, '$.expenses') = 0
        AND json_valid(line_manifest_json) AND json_type(line_manifest_json) = 'object'
        AND json_extract(line_manifest_json, '$.schema_version') = 1
        AND json_type(line_manifest_json, '$.lines') = 'array'
      ), 0))
      ${recurringCreation}`

const ledgerTable = replaceOnce(
  historicalStatement(freeFormInvoiceCreateMigration, 'CREATE TABLE invoice_command_ledger ('),
  recurringCreation,
  bandedCreation,
)

const lineManifestGuard = [
  `line.description = json_extract(member.value, '$.description')`,
  `line.project_id = json_extract(member.value, '$.project_id')`,
].reduce(
  (guard, comparison) => replaceOnce(guard, comparison, comparison.replace(' = ', ' IS ')),
  historicalStatement(
    invoiceGenerationMigration,
    'CREATE TRIGGER invoice_generation_line_manifest_guard',
  ),
)

export const bandedInvoiceCreateMigration = [
  `PRAGMA legacy_alter_table = ON`,
  `DROP TRIGGER invoice_command_ledger_insert_guard`,
  `DROP TRIGGER invoice_command_ledger_update_guard`,
  `DROP TRIGGER invoice_command_ledger_delete_guard`,
  `ALTER TABLE invoice_command_ledger RENAME TO invoice_command_ledger_0097`,
  ledgerTable,
  `INSERT INTO invoice_command_ledger (
    invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
    expected_invoice_version, occurred_at, request_json, source_manifest_json,
    line_manifest_json, event_count, completed, first_aggregate_sequence, result_json,
    completed_at
  ) SELECT invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
    expected_invoice_version, occurred_at, request_json, source_manifest_json,
    line_manifest_json, event_count, completed, first_aggregate_sequence, result_json,
    completed_at
  FROM invoice_command_ledger_0097`,
  `DROP TABLE invoice_command_ledger_0097`,
  `PRAGMA legacy_alter_table = OFF`,
  historicalStatement(
    recurringGenerateCommandMigration,
    'CREATE UNIQUE INDEX invoice_command_ledger_pending_invoice_unique',
  ),
  historicalStatement(
    recurringGenerateCommandMigration,
    'CREATE TRIGGER invoice_command_ledger_insert_guard',
  ),
  historicalStatement(
    recurringGenerateCommandMigration,
    'CREATE TRIGGER invoice_command_ledger_update_guard',
  ),
  historicalStatement(
    recurringGenerateCommandMigration,
    'CREATE TRIGGER invoice_command_ledger_delete_guard',
  ),
  `DROP TRIGGER invoice_generation_line_manifest_guard`,
  lineManifestGuard,
]
