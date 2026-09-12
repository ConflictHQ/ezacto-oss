// Provenance: issue 626. An invoice should arrive with its document attached.
//
// Harvest attached a PDF to every invoice it sent. ezacto has sent none, so this
// is the parity gap a client meets on the first real send.
//
// Two things are recorded here, and they answer different questions.
//
// Whether to attach is a preference, and it follows exactly the shape migration
// 0053 settled for the automatic thank-you: an invoice's own answer wins, an
// invoice with none follows the organization default, and the question is asked
// at send time rather than captured when the invoice was raised. One precedence
// rule in this product rather than two that drift.
//
// What was attached is a fact, and it is kept. The rendered document is written
// to object storage once, at the moment the message is composed, and this table
// records which object went with which message. A client disputing what they
// received is answered by the file they were sent, the same way `text_body` on
// `invoice_email_intents` already answers what the message said -- re-rendering
// later would answer a different question, because the invoice may have moved
// on since.
//
// The key is the message, not the invoice. An invoice sent twice is two
// messages, and each carries the document as it stood when that message went.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const invoiceAttachedDocumentsMigration = [
  // The organization default. Off, so an instance upgrading into this feature
  // does not start attaching documents to mail it was already sending.
  `ALTER TABLE organizations ADD COLUMN attach_invoice_pdf INTEGER NOT NULL DEFAULT 0
    CHECK (attach_invoice_pdf IN (0,1))`,

  // The per-invoice override. NULL means follow the organization.
  `ALTER TABLE invoices ADD COLUMN attach_invoice_pdf INTEGER
    CHECK (attach_invoice_pdf IS NULL OR attach_invoice_pdf IN (0,1))`,

  `CREATE TABLE invoice_message_documents (
    -- One document per message. An invoice sent twice is two messages, each
    -- carrying what the document said at the time it went.
    invoice_message_id INTEGER PRIMARY KEY
      REFERENCES invoice_messages(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    -- Where the bytes are. A queue message is capped at 128 KB, so the job
    -- names this and the consumer fetches it at send time.
    object_key TEXT NOT NULL CHECK (length(trim(object_key)) BETWEEN 1 AND 1024),
    filename TEXT NOT NULL CHECK (
      length(trim(filename)) BETWEEN 1 AND 255
      -- The name reaches the recipient's filesystem. A separator in it is how a
      -- saved attachment lands somewhere the person did not choose.
      AND instr(filename, '/') = 0
      AND instr(filename, char(92)) = 0
    ),
    content_type TEXT NOT NULL CHECK (content_type = 'application/pdf'),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
    -- What the document was rendered from, so a later reader can tell whether
    -- the invoice has moved on since the client was sent this.
    invoice_version INTEGER NOT NULL CHECK (
      invoice_version BETWEEN 0 AND 9007199254740991
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')})
  ) STRICT`,

  `CREATE INDEX invoice_message_documents_invoice
    ON invoice_message_documents(invoice_id, created_at)`,

  // Immutable for the same reason the intents are: this is the record of what a
  // client was actually sent, and a record that can be edited afterwards answers
  // a different question than the one it was kept for.
  `CREATE TRIGGER invoice_message_documents_no_update
    BEFORE UPDATE ON invoice_message_documents
    BEGIN SELECT RAISE(ABORT, 'an attached document record is immutable'); END`,
  `CREATE TRIGGER invoice_message_documents_no_delete
    BEFORE DELETE ON invoice_message_documents
    BEGIN SELECT RAISE(ABORT, 'an attached document record is immutable'); END`,
] as const
