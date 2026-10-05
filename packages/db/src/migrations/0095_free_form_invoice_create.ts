import { invoiceGenerationMigration } from './0026_invoice_generation.js'
import { recurringGenerateCommandMigration } from './0037_recurring_generate_command.js'

/**
 * A free-form invoice is the blank draft Harvest's New invoice dialog makes
 * when nothing tracked is imported: one client, no lines, no period, no
 * project. It is still an `invoice.create` -- the same receipt, number
 * sequence, creation event and replay -- but the creation CHECK 0026 wrote
 * describes a tracked import only: it demands a date range, a non-empty
 * `project_ids` and at least one line, none of which a blank draft has.
 *
 * So `invoice.create` admits a second request shape, as exact as the first: a
 * `free_form` kind, the client and its currency, zero for every count and the
 * amount, empty manifests, and none of the keys that describe a selection. A
 * tracked request is held to the clause it always was.
 *
 * The creation event guard compared the request's range to the header's period
 * with `=`, which is never true for a draft that has no period. It uses `IS`
 * now. A tracked request's CHECK still requires both dates, so for it nothing
 * changes; for a blank draft the same comparison holds the header to no period.
 *
 * Rebuilt rather than altered because SQLite cannot change a CHECK in place:
 * the rename-copy-drop 0026 and 0037 used, over 0037's own text, asserted first
 * so a reshaped historical statement fails this migration instead of silently
 * losing a clause.
 */
const historicalStatement = (statements: readonly string[], prefix: string): string => {
  const matches = statements.filter((statement) => statement.startsWith(prefix))
  if (matches.length !== 1) {
    throw new Error(`free-form invoice migration could not find one historical ${prefix}`)
  }
  return matches[0]!
}

const replaceOnce = (source: string, needle: string, replacement: string): string => {
  if (source.split(needle).length - 1 !== 1) {
    throw new Error(`free-form invoice migration found an unexpected historical ${needle}`)
  }
  // A replacer function, so the `$.` paths in the SQL are never read as patterns.
  return source.replace(needle, () => replacement)
}

const recurringCreation = `OR (command_kind = 'recurring.generate' AND COALESCE((`

const freeFormCreation = `OR (command_kind = 'invoice.create' AND COALESCE((
        json_valid(request_json) AND json_type(request_json) = 'object'
        AND json_extract(request_json, '$.schema_version') = 1
        AND json_type(request_json, '$.schema_version') = 'integer'
        AND json_extract(request_json, '$.expected_version') = 0
        AND json_type(request_json, '$.expected_version') = 'integer'
        AND json_extract(request_json, '$.kind') = 'free_form'
        AND json_type(request_json, '$.client_id') = 'integer'
        AND json_extract(request_json, '$.client_id') > 0
        -- A blank draft selects nothing, so the keys a tracked request uses to
        -- describe its selection are absent rather than empty.
        AND json_type(request_json, '$.from') IS NULL
        AND json_type(request_json, '$.to') IS NULL
        AND json_type(request_json, '$.project_ids') IS NULL
        AND json_type(request_json, '$.time_summary_type') IS NULL
        AND json_type(request_json, '$.expense_summary_type') IS NULL
        AND json_type(request_json, '$.currency') = 'text'
        AND length(json_extract(request_json, '$.currency')) = 3
        AND json_type(request_json, '$.amount_cents') = 'integer'
        AND json_extract(request_json, '$.amount_cents') = 0
        AND json_type(request_json, '$.line_count') = 'integer'
        AND json_extract(request_json, '$.line_count') = 0
        AND json_type(request_json, '$.time_entry_count') = 'integer'
        AND json_extract(request_json, '$.time_entry_count') = 0
        AND json_type(request_json, '$.expense_count') = 'integer'
        AND json_extract(request_json, '$.expense_count') = 0
        AND json_valid(source_manifest_json) AND json_type(source_manifest_json) = 'object'
        AND json_extract(source_manifest_json, '$.schema_version') = 1
        AND json_type(source_manifest_json, '$.time_entries') = 'array'
        AND json_array_length(source_manifest_json, '$.time_entries') = 0
        AND json_type(source_manifest_json, '$.expenses') = 'array'
        AND json_array_length(source_manifest_json, '$.expenses') = 0
        AND json_valid(line_manifest_json) AND json_type(line_manifest_json) = 'object'
        AND json_extract(line_manifest_json, '$.schema_version') = 1
        AND json_type(line_manifest_json, '$.lines') = 'array'
        AND json_array_length(line_manifest_json, '$.lines') = 0
      ), 0))
      ${recurringCreation}`

const ledgerTable = replaceOnce(
  historicalStatement(recurringGenerateCommandMigration, 'CREATE TABLE invoice_command_ledger ('),
  recurringCreation,
  freeFormCreation,
)

const creationEventGuard = [
  `json_extract(command.request_json, '$.from') = invoice.period_start`,
  `json_extract(command.request_json, '$.to') = invoice.period_end`,
].reduce(
  (guard, comparison) => replaceOnce(guard, comparison, comparison.replace(' = ', ' IS ')),
  historicalStatement(
    invoiceGenerationMigration,
    'CREATE TRIGGER invoice_generation_event_outbox_guard',
  ),
)

export const freeFormInvoiceCreateMigration = [
  `PRAGMA legacy_alter_table = ON`,
  `DROP TRIGGER invoice_command_ledger_insert_guard`,
  `DROP TRIGGER invoice_command_ledger_update_guard`,
  `DROP TRIGGER invoice_command_ledger_delete_guard`,
  `ALTER TABLE invoice_command_ledger RENAME TO invoice_command_ledger_0094`,
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
  FROM invoice_command_ledger_0094`,
  `DROP TABLE invoice_command_ledger_0094`,
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
  `DROP TRIGGER invoice_generation_event_outbox_guard`,
  creationEventGuard,
]
