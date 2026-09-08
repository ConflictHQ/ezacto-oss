// A fixed recurring line can now carry a date it stops on.
//
// Why this exists. A fixed_lines definition repeats the same lines every month
// with no notion of when one of them ought to stop. That is wrong for any line
// that is inherently finite: a discount running three months, an introductory
// rate, a credit being worked off. The case that forced it is an imported
// definition carrying a credit line -- Harvest's own line reads "CREDIT 1 of 4",
// which the source system tracked in the description and nowhere the software
// could act on.
//
// The alternatives were worse. Transcribing the credit and diarising a manual
// edit puts a business outcome behind somebody remembering a calendar entry
// eight months out; omitting it makes the definition's monthly total differ
// permanently from the source invoice with no way to record that the difference
// was intended. A line that expires itself needs neither.
//
// An optional eighth key, not a schema version. The first attempt bumped to
// version 2 and rewrote every stored config, on the reasoning that the trigger
// counts keys exactly so no half-upgraded row should exist. That cost 34 test
// fixtures across five files and a rewrite of live rows, to express something
// the file already had a way to say: `importConfigValid` in 0010 accepts four
// or five keys with `time` and `expenses` optional.
//
// So `through` is optional, and absent means the same as null: repeats
// indefinitely, which is what every existing line already meant. No stored row
// changes, and a config written before this migration stays valid after it.

import { fixedLinesValidWith, importConfigValid } from './0010_recurring_invoices.js'



/**
 * A date, or null. Written as a GLOB plus a date() round-trip rather than a
 * pattern alone: '2026-02-31' matches the shape and is not a day, and a line
 * that expires on a date the calendar does not have would never expire.
 */
const optionalDate = (document: string, path: string) => {
  const value = `json_extract(${document}, '${path}')`
  // The two-argument json_type, document and path. The one-argument form parses
  // its input AS JSON, so handing it an extracted date string is "malformed
  // JSON" rather than a type answer -- a bare 2026-08-31 is not a JSON document.
  // Three cases, and the first is the one that bites: for an ABSENT key
  // json_type returns SQL NULL, not the string 'null'. Only a key present and
  // explicitly JSON null returns 'null'. Checking for the string alone rejects
  // every line written before this key existed, which is all of them.
  return `(json_type(${document}, '${path}') IS NULL
      OR json_type(${document}, '${path}') IS 'null'
      OR (
      json_type(${document}, '${path}') = 'text'
      AND ${value} GLOB '????-??-??'
      AND date(${value}) IS ${value}
    ))`
}

const fixedLinesValid = fixedLinesValidWith({
  optionalLineKeys: ['through'],
  extraLineRejection: `OR NOT ${optionalDate('line.value', '$.through')}`,
})

const amountConfigTrigger = (operation: 'INSERT' | 'UPDATE') => `CREATE TRIGGER
    recurring_invoices_amount_config_${operation.toLowerCase()}
    BEFORE ${operation} ON recurring_invoices
    WHEN NEW.definition_status = 'complete' AND NOT CASE
      WHEN json_valid(NEW.amount_config) AND json_type(NEW.amount_config) = 'object'
      THEN coalesce(((${fixedLinesValid}) OR (${importConfigValid})), 0)
      ELSE 0
    END
    BEGIN SELECT RAISE(ABORT, 'recurring invoice amount config is invalid'); END`

export const recurringLineThroughMigration = [
  // Replace the two config triggers with ones that also permit `through`.
  // Nothing else changes: every stored config is still valid, because the key
  // is optional and its absence carries the meaning those rows already had.
  `DROP TRIGGER IF EXISTS recurring_invoices_amount_config_insert`,
  `DROP TRIGGER IF EXISTS recurring_invoices_amount_config_update`,
  amountConfigTrigger('INSERT'),
  amountConfigTrigger('UPDATE'),
] as const
