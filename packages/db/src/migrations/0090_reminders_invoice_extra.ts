// Provenance: ezacto-oss issue 850. A client who has said they will pay
// should not be reminded, and there was no way to say so for one invoice:
// the invoice's own reminder policy only takes another schedule, and null
// means "follow the organization".
//
// `reminders` joins the invoice extras vocabulary (0058). On an invoice,
// `false` is "no reminders for this one" and cancels anything pending;
// absent is "follow the organization", as for every other kind. The
// organization side is not a boolean here -- its answer is the reminder
// policy it already holds -- so the organization never writes this key, and
// the vocabulary trigger on organizations is widened only so the two tables
// keep one list.
const KINDS = `'document','files','thank_you','journal','reminders'`

const vocabulary = (table: string, guard: string): string[] => [
  `DROP TRIGGER IF EXISTS ${table}_invoice_extras_vocabulary_insert`,
  `DROP TRIGGER IF EXISTS ${table}_invoice_extras_vocabulary_update`,
  `CREATE TRIGGER ${table}_invoice_extras_vocabulary_insert
    BEFORE INSERT ON ${table}
    WHEN ${guard}EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
  `CREATE TRIGGER ${table}_invoice_extras_vocabulary_update
    BEFORE UPDATE OF invoice_extras ON ${table}
    WHEN ${guard}EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
]

export const remindersInvoiceExtraMigration = [
  ...vocabulary('organizations', ''),
  ...vocabulary('invoices', 'NEW.invoice_extras IS NOT NULL AND '),
]
