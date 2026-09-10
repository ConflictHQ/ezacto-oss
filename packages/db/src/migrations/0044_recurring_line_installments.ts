// A finite recurring line can now say how many issues it runs for, so it can
// count itself off in its own text: "CREDIT 2 of 4".
//
// Why this exists. 0041 gave a line a date it stops on, and its own note records
// what prompted it: Harvest wrote "CREDIT 1 of 4" into the description, "which
// the source system tracked in the description and nowhere the software could
// act on". `through` solved half of that -- the line now stops by itself. The
// other half is the ordinal, and a static description carries whichever number
// happened to be on the invoice the definition was derived from. The live
// Halcyon Biolabs definition is the case: it was read off an invoice reading
// "CREDIT 1 of 4" and stored a sentence saying "4 of 4 payments", so every
// remaining issue would have claimed to be the last one.
//
// Counted backwards, which is why one key is enough. A definition records when
// a line stops and never when it started, so the position cannot be counted
// forwards without storing a start date the agreement never had. Given the
// total and a fixed cadence, the issues still to come are countable from
// `through`, and the position is the total less those.
//
// Optional, and requires `through`. Following 0041 rather than bumping the
// schema version: absent means what every stored line already means, so no row
// changes and a config written before this migration stays valid after it. The
// dependency is enforced here as well as in TypeScript because a total with no
// end has nothing to count back from -- it would render the same ordinal on
// every invoice forever, which is the failure this migration exists to remove.

import { fixedLinesValidWith, importConfigValid } from './0010_recurring_invoices.js'

/**
 * A date, or null. Restated from 0041 rather than imported: this migration
 * replaces that trigger outright, so it has to re-express every clause the
 * replacement still enforces, and a migration that reads as a snapshot of the
 * rule it installs is easier to audit than one assembled from two files.
 */
const optionalDate = (document: string, path: string) => {
  const value = `json_extract(${document}, '${path}')`
  return `(json_type(${document}, '${path}') IS NULL
      OR json_type(${document}, '${path}') IS 'null'
      OR (
      json_type(${document}, '${path}') = 'text'
      AND ${value} GLOB '????-??-??'
      AND date(${value}) IS ${value}
    ))`
}

/**
 * A positive whole count, or null, and only alongside a real `through` date.
 *
 * `json_type` answers 'integer' for 4 and 'real' for 4.0, and a run of four and
 * a half payments is not a thing; the type check rejects it before the range
 * check would have accepted it.
 */
const optionalInstallments = (document: string, path: string, throughPath: string) => {
  const value = `json_extract(${document}, '${path}')`
  return `(json_type(${document}, '${path}') IS NULL
      OR json_type(${document}, '${path}') IS 'null'
      OR (
      json_type(${document}, '${path}') = 'integer'
      AND ${value} >= 1
      AND json_type(${document}, '${throughPath}') = 'text'
    ))`
}

const fixedLinesValid = fixedLinesValidWith({
  optionalLineKeys: ['through', 'installments'],
  extraLineRejection: `OR NOT ${optionalDate('line.value', '$.through')}
      OR NOT ${optionalInstallments('line.value', '$.installments', '$.through')}`,
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

export const recurringLineInstallmentsMigration = [
  // Replace the two config triggers with ones that also permit `installments`.
  // Every stored config stays valid: the key is optional and its absence carries
  // the meaning those rows already had, which is "this line does not count
  // itself".
  `DROP TRIGGER IF EXISTS recurring_invoices_amount_config_insert`,
  `DROP TRIGGER IF EXISTS recurring_invoices_amount_config_update`,
  amountConfigTrigger('INSERT'),
  amountConfigTrigger('UPDATE'),
] as const
