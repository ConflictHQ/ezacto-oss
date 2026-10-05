// Provenance: issue 647, the work journal's files. It went as a PDF; a client
// who loads the hours into their own books wants a CSV or a workbook beside it,
// or instead of it.
//
// `journal_formats` joins the invoice extras vocabulary (0058, widened by 0090)
// as its own kind rather than a richer `journal` value. The level -- detailed or
// summary -- and the files are separate answers: an invoice can follow the
// organization's level and still ask for a spreadsheet of it. And a `journal`
// value reshaped into an object would read as no journal at all on a deployment
// rolled back past this one, since `parseInvoiceExtras` drops a value it cannot
// interpret; a kind it has never heard of is dropped the same way, and the
// journal it does understand keeps going.
//
// Absent is the answer nobody wrote, on both tables: on an invoice it follows
// the organization, and on the organization it is the PDF the journal has
// always been. So nothing is backfilled, and every stored row is left byte for
// byte as it was.
//
// Unlike the earlier kinds, the value is checked here as well as the key. A
// boolean that is not a boolean is refused by the code that reads it; a format
// list that is not one -- empty, a format twice, a format that does not exist --
// would be dropped on read and quietly send the default instead, which is the
// silent never-applies the vocabulary trigger exists to turn into a refusal.
const KINDS = `'document','files','thank_you','journal','reminders','journal_formats'`
const FORMATS = `'pdf','csv','xlsx'`

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

// A non-empty array of distinct known formats, or the key absent.
const malformedFormats = `json_type(NEW.invoice_extras, '$.journal_formats') IS NOT NULL
      AND NOT (
        json_type(NEW.invoice_extras, '$.journal_formats') = 'array'
        AND json_array_length(NEW.invoice_extras, '$.journal_formats') > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.invoice_extras, '$.journal_formats') member
          WHERE member.type <> 'text' OR member.value NOT IN (${FORMATS})
        )
        AND (
          SELECT count(DISTINCT member.value)
          FROM json_each(NEW.invoice_extras, '$.journal_formats') member
        ) = json_array_length(NEW.invoice_extras, '$.journal_formats')
      )`

const formats = (table: string, guard: string): string[] => [
  `CREATE TRIGGER ${table}_invoice_extras_journal_formats_insert
    BEFORE INSERT ON ${table}
    WHEN ${guard}${malformedFormats}
    BEGIN SELECT RAISE(ABORT, 'invalid journal formats'); END`,
  `CREATE TRIGGER ${table}_invoice_extras_journal_formats_update
    BEFORE UPDATE OF invoice_extras ON ${table}
    WHEN ${guard}${malformedFormats}
    BEGIN SELECT RAISE(ABORT, 'invalid journal formats'); END`,
]

export const journalFormatsInvoiceExtraMigration = [
  ...vocabulary('organizations', ''),
  ...vocabulary('invoices', 'NEW.invoice_extras IS NOT NULL AND '),
  ...formats('organizations', ''),
  ...formats('invoices', 'NEW.invoice_extras IS NOT NULL AND '),
]
