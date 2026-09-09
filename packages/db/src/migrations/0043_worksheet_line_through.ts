// The worksheet receipt learns the stop date the stored config already had.
//
// 0041 gave a recurring fixed line an optional `through` and the engine honours
// it: a line stops appearing once the issue date passes. What it did not reach
// was the worksheet -- the only path by which a migrated definition is created
// at all. Its receipt triggers pin the line shape independently, so an operator
// transcribing a fixed-term credit could enter it only as one that runs
// forever.
//
// That is not academic. The one definition this blocks carries `CREDIT 1 of 4`;
// without a stop date it credits the client every month after the fourth, and
// the worksheet apply is all-or-nothing, so the row cannot simply be left out.
//
// Same shape as 0041: the two triggers are dropped and recreated from the
// builders that own them, rather than transcribed. `through` is optional and
// absent means what it always meant, so every stored receipt stays valid.

import {
  recurringFixedShapeValidWith,
  recurringFixedScalarsValidWith,
} from './0024_migration_worksheet_completions.js'

/**
 * Present-and-a-date, or absent. The two-argument `json_type` is required: the
 * one-argument form parses its input as JSON, and a bare `2026-11-30` is not a
 * JSON document. For an absent key it returns SQL NULL rather than the string
 * 'null', which is why the IS NULL arm is the one that matters -- without it
 * every line written before this key existed would be rejected.
 */
const optionalThrough = (line: string) => `(
  json_type(${line}, '$.through') IS NULL
  OR json_type(${line}, '$.through') = 'null'
  OR (
    json_type(${line}, '$.through') = 'text'
    AND date(json_extract(${line}, '$.through')) IS json_extract(${line}, '$.through')
  )
)`

const shapeValid = recurringFixedShapeValidWith(['through'])
// The source and resolved copies must agree on the stop date for the same
// reason they must agree on the price: the receipt is the evidence that what
// was applied is what the operator wrote.
const scalarsValid = recurringFixedScalarsValidWith(`
      AND ${optionalThrough('source_line.value')}
      AND json_extract(source_line.value, '$.through')
        IS json_extract(resolved_line.value, '$.through')`)

export const worksheetLineThroughMigration = [
  `DROP TRIGGER IF EXISTS worksheet_recurring_authority_fixed_shape_insert`,
  `DROP TRIGGER IF EXISTS worksheet_recurring_authority_fixed_scalars_insert`,
  `CREATE TRIGGER worksheet_recurring_authority_fixed_shape_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'fixed_lines'
      AND NOT coalesce((${shapeValid('NEW.input_json')}), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet fixed-line shape is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_fixed_scalars_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'fixed_lines'
      AND NOT coalesce((${scalarsValid('NEW.input_json')}), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet fixed-line values are invalid'); END`,
] as const
