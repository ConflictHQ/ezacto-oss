// Provenance: sending an invoice from ezacto has to produce the email the
// maintainers sent from Harvest every month -- one message To the client's
// accounts payable, Cc the client's people and the company's own finance
// mailbox, the PDF named INVOICE_<number>_<COMPANY>.pdf with the purchase order
// letter behind it -- and the client's rules for that have to be standing
// rules, not choices remade on every send.
//
// What changes, table by table:
//
// - One email per send, not one per recipient. Every address the message went
//   to is a row in `invoice_email_recipients`, with the header it sat in, and
//   they all name the same delivery. The table is rebuilt because SQLite cannot
//   drop the UNIQUE that bound one delivery to one recipient: rows already
//   written are copied across as `to`, which is what they were.
// - `email_log.cc_json` and `invoice_messages.cc_recipients` record the Cc
//   header beside the To one the log and the message already had.
// - `invoice_message_documents.appended_attachment_ids` records which files
//   were bound into the back of the document that went, so a retried delivery
//   attaches the identical file and does not send those files a second time.
// - A client carries its own sending rules: who an invoice goes to and who is
//   copied (`invoice_recipients`, null to follow the contacts' invoice routing)
//   and what goes with it (`invoice_extras`, the same vocabulary as an
//   invoice's, limited to the sending kinds). An invoice's own answer wins, a
//   client's comes next, the organization's last.
// - `append` joins the extras vocabulary: the invoice's PDF files bound into
//   the back of the invoice document, as accounts payable departments ask.
// - The organization can copy fixed addresses on every invoice email, and each
//   person decides whether they are copied on what they send.
// - A recurring definition carries the purchase order its invoices are raised
//   under, and the files attached to it go with every invoice it issues until
//   their `through` day -- a yearly purchase order covers its fiscal year and
//   no further. Removing one is a timestamp, not a delete: the invoices it went
//   with keep their own copies, and the definition keeps the record.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

const INVOICE_KINDS = `'document','files','thank_you','journal','reminders','journal_formats','append'`
// What a client's rules can say: how its invoices go, never whether they are
// chased or thanked, which stay the organization's and the invoice's.
const CLIENT_KINDS = `'document','files','journal','journal_formats','append'`
const FORMATS = `'pdf','csv','xlsx'`

const vocabulary = (table: string, guard: string, kinds: string): string[] => [
  `DROP TRIGGER IF EXISTS ${table}_invoice_extras_vocabulary_insert`,
  `DROP TRIGGER IF EXISTS ${table}_invoice_extras_vocabulary_update`,
  `CREATE TRIGGER ${table}_invoice_extras_vocabulary_insert
    BEFORE INSERT ON ${table}
    WHEN ${guard}EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${kinds})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
  `CREATE TRIGGER ${table}_invoice_extras_vocabulary_update
    BEFORE UPDATE OF invoice_extras ON ${table}
    WHEN ${guard}EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${kinds})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
]

// The same format rule 0096 gave the other two tables.
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

// A boolean kind that is not a boolean would be dropped on read and quietly
// follow the next level instead, so `append` is checked here like the formats.
const malformedAppend = `json_type(NEW.invoice_extras, '$.append') IS NOT NULL
      AND json_type(NEW.invoice_extras, '$.append') NOT IN ('true','false')`

const valueGuards = (table: string, guard: string): string[] => [
  `CREATE TRIGGER ${table}_invoice_extras_append_insert
    BEFORE INSERT ON ${table}
    WHEN ${guard}${malformedAppend}
    BEGIN SELECT RAISE(ABORT, 'invalid append preference'); END`,
  `CREATE TRIGGER ${table}_invoice_extras_append_update
    BEFORE UPDATE OF invoice_extras ON ${table}
    WHEN ${guard}${malformedAppend}
    BEGIN SELECT RAISE(ABORT, 'invalid append preference'); END`,
]

const clientFormats = [
  `CREATE TRIGGER clients_invoice_extras_journal_formats_insert
    BEFORE INSERT ON clients
    WHEN NEW.invoice_extras IS NOT NULL AND ${malformedFormats}
    BEGIN SELECT RAISE(ABORT, 'invalid journal formats'); END`,
  `CREATE TRIGGER clients_invoice_extras_journal_formats_update
    BEFORE UPDATE OF invoice_extras ON clients
    WHEN NEW.invoice_extras IS NOT NULL AND ${malformedFormats}
    BEGIN SELECT RAISE(ABORT, 'invalid journal formats'); END`,
]

export const invoiceSendingMigration = [
  `ALTER TABLE email_log ADD COLUMN cc_json TEXT CHECK (
    cc_json IS NULL OR (
      json_valid(cc_json) AND json_type(cc_json) = 'array'
      AND json_array_length(cc_json) BETWEEN 1 AND 99
    )
  )`,
  `ALTER TABLE invoice_messages ADD COLUMN cc_recipients TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(cc_recipients) AND json_type(cc_recipients) = 'array')`,

  `CREATE TABLE invoice_email_recipients_0099 (
    invoice_message_id INTEGER NOT NULL
      REFERENCES invoice_email_intents(invoice_message_id) ON DELETE RESTRICT,
    recipient_index INTEGER NOT NULL CHECK (recipient_index BETWEEN 0 AND 999),
    -- Every recipient of one message names the one email that carried it, so
    -- a delivery's status is each of its recipients' status.
    delivery_id INTEGER NOT NULL REFERENCES email_log(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('to','cc')),
    name TEXT NOT NULL CHECK (length(name) <= 200),
    email TEXT NOT NULL COLLATE NOCASE CHECK (
      length(email) BETWEEN 3 AND 254 AND email = lower(trim(email))
      AND instr(email, ' ') = 0 AND instr(email, '@') > 1
      AND instr(substr(email, instr(email, '@') + 1), '@') = 0
      AND instr(substr(email, instr(email, '@') + 1), '.') > 1
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    PRIMARY KEY (invoice_message_id, recipient_index),
    -- One header per address: copied on a message is not also addressed by it.
    UNIQUE (invoice_message_id, email)
  ) STRICT`,
  `INSERT INTO invoice_email_recipients_0099 (
      invoice_message_id, recipient_index, delivery_id, role, name, email, created_at
    )
    SELECT invoice_message_id, recipient_index, delivery_id, 'to', name, email, created_at
    FROM invoice_email_recipients`,
  `DROP TABLE invoice_email_recipients`,
  `ALTER TABLE invoice_email_recipients_0099 RENAME TO invoice_email_recipients`,
  `CREATE INDEX invoice_email_recipients_message
    ON invoice_email_recipients(invoice_message_id, recipient_index)`,
  `CREATE INDEX invoice_email_recipients_delivery
    ON invoice_email_recipients(delivery_id)`,
  `CREATE TRIGGER invoice_email_recipients_no_update BEFORE UPDATE ON invoice_email_recipients
    BEGIN SELECT RAISE(ABORT, 'invoice email recipient receipt is immutable'); END`,
  `CREATE TRIGGER invoice_email_recipients_no_delete BEFORE DELETE ON invoice_email_recipients
    BEGIN SELECT RAISE(ABORT, 'invoice email recipient receipt is immutable'); END`,

  `ALTER TABLE invoice_message_documents ADD COLUMN appended_attachment_ids TEXT NOT NULL
    DEFAULT '[]' CHECK (
      json_valid(appended_attachment_ids) AND json_type(appended_attachment_ids) = 'array'
    )`,

  `ALTER TABLE clients ADD COLUMN invoice_extras TEXT CHECK (
    invoice_extras IS NULL OR (json_valid(invoice_extras) AND json_type(invoice_extras) = 'object')
  )`,
  // The lists' members are addresses the store validates as it writes them; a
  // CHECK cannot walk an array (SQLite refuses a subquery there), so the shape
  // is what is held here.
  `ALTER TABLE clients ADD COLUMN invoice_recipients TEXT CHECK (
    invoice_recipients IS NULL OR (
      json_valid(invoice_recipients) AND json_type(invoice_recipients) = 'object'
      AND json_type(invoice_recipients, '$.to') = 'array'
      AND json_type(invoice_recipients, '$.cc') = 'array'
    )
  )`,
  `ALTER TABLE organizations ADD COLUMN invoice_always_cc TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(invoice_always_cc) AND json_type(invoice_always_cc) = 'array'
    AND json_array_length(invoice_always_cc) <= 20
  )`,
  // On unless somebody turns it off: the person who sends an invoice should see
  // exactly what the client saw, and Harvest's "send me a copy" was how they did.
  `ALTER TABLE users ADD COLUMN invoice_email_copy INTEGER NOT NULL DEFAULT 1
    CHECK (invoice_email_copy IN (0,1))`,

  ...vocabulary('organizations', '', INVOICE_KINDS),
  ...vocabulary('invoices', 'NEW.invoice_extras IS NOT NULL AND ', INVOICE_KINDS),
  ...vocabulary('clients', 'NEW.invoice_extras IS NOT NULL AND ', CLIENT_KINDS),
  ...clientFormats,
  ...valueGuards('organizations', ''),
  ...valueGuards('invoices', 'NEW.invoice_extras IS NOT NULL AND '),
  ...valueGuards('clients', 'NEW.invoice_extras IS NOT NULL AND '),

  // Nullable: most definitions bill without one. Blank is refused rather than
  // stored, so "none" has one spelling.
  `ALTER TABLE recurring_invoices ADD COLUMN purchase_order TEXT CHECK (
    purchase_order IS NULL OR length(trim(purchase_order)) BETWEEN 1 AND 1000
  )`,
  `ALTER TABLE recurring_invoice_attachments ADD COLUMN through TEXT CHECK (
    through IS NULL OR date(through, '+0 days') IS through
  )`,
  `ALTER TABLE recurring_invoice_attachments ADD COLUMN removed_at TEXT CHECK (
    removed_at IS NULL OR (${canonicalTimestamp('removed_at')})
  )`,
] as const
