// Provenance: issue 545. Nothing reacts to an invoice being paid.
//
// The operator wants a thank-you sent automatically when a payment settles an
// invoice, unless it has been turned off -- globally, or for one invoice, since
// some invoices settle a dispute and a cheerful automated note is the wrong
// thing to send about those.
//
// The obstacle was `invoice_email_intents`. That table is the immutable record
// of every email a client receives, and two of its columns make an automatic
// send impossible to express: `confirmed_by_user_id` is NOT NULL and therefore
// asserts that a named person confirmed this send, and `template_kind` is
// checked against 'invoice' alone. Migration 0032 also puts no-update and
// no-delete triggers on it, so the assertion is permanent.
//
// Three ways out were on the table. Making the column nullable is cheapest and
// quietly turns "a person confirmed this" into "a person confirmed this, or
// nobody did", which breaks every reader that treats it as provenance.
// Attributing the send to whoever enabled the automation keeps the column
// non-null by recording a person who did not confirm this email, did not see
// it, and may have left.
//
// This is the third: an automatic send gets its own table. There are genuinely
// two provenances -- one records *who confirmed* a message, the other records
// *why* one was sent -- and neither has to pretend to be the other.
//
// Two properties fall out of that choice rather than needing to be arranged.
//
// Idempotence becomes a schema fact. The table is keyed on the payment that
// triggered it, so a payment recorded, deleted and recorded again cannot
// produce a second thank-you: the primary key refuses it. Nothing has to
// remember what it already sent.
//
// "Never on import" comes free. The cutover loaded 740 invoices, 432 of them
// settled, and a naive implementation would have emailed every client of the
// last thirteen years. An imported payment creates no row here because nothing
// back-fills this table -- the only way in is a live payment being recorded.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const automaticThankYouMigration = [
  // The global default. Off, because an instance upgrading into this feature
  // should not begin emailing clients because it was deployed.
  `ALTER TABLE organizations ADD COLUMN auto_thank_you INTEGER NOT NULL DEFAULT 0
    CHECK (auto_thank_you IN (0,1))`,

  // The per-invoice override, and the load-bearing half. NULL means "follow the
  // global default", and it is read at send time rather than captured when the
  // invoice was raised -- an operator who turns the feature off today expects
  // that to govern invoices raised yesterday.
  `ALTER TABLE invoices ADD COLUMN auto_thank_you INTEGER
    CHECK (auto_thank_you IS NULL OR auto_thank_you IN (0,1))`,

  `CREATE TABLE invoice_auto_email_intents (
    -- The key is the payment, not the invoice. One thank-you per payment, and
    -- a payment removed and re-recorded cannot produce a second one.
    invoice_payment_id INTEGER PRIMARY KEY
      REFERENCES invoice_payments(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    -- The delivery this became, rather than an outbox event. event_outbox is
    -- the invoice command journal: a trigger requires every invoice event there
    -- to match a pending row in invoice_command_ledger, and an automatic
    -- thank-you has no command because nobody issued one. That is the same
    -- collision as confirmed_by_user_id in the other intent table, showing up a
    -- second time -- the invoice machinery is shaped around operator decisions,
    -- and an automatic action is not one.
    delivery_id INTEGER NOT NULL UNIQUE REFERENCES email_log(id) ON DELETE RESTRICT,
    -- Only this kind. An invoice send is a person's decision and belongs in the
    -- other table; widening this check is how the two would blur back together.
    template_kind TEXT NOT NULL CHECK (template_kind = 'thank_you'),
    template_version INTEGER NOT NULL CHECK (
      template_version BETWEEN 1 AND 9007199254740991
    ),
    sender_identity_id INTEGER NOT NULL
      REFERENCES sender_identities(id) ON DELETE RESTRICT,
    sender_identity_version INTEGER NOT NULL CHECK (
      sender_identity_version BETWEEN 0 AND 9007199254740991
    ),
    sender_evidence_version INTEGER NOT NULL CHECK (
      sender_evidence_version BETWEEN 1 AND 9007199254740991
    ),
    from_name TEXT NOT NULL CHECK (length(trim(from_name)) BETWEEN 1 AND 200),
    from_email TEXT NOT NULL CHECK (length(trim(from_email)) BETWEEN 3 AND 254),
    reply_to_email TEXT CHECK (
      reply_to_email IS NULL OR length(trim(reply_to_email)) BETWEEN 3 AND 254
    ),
    subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 998),
    text_body TEXT NOT NULL CHECK (length(trim(text_body)) BETWEEN 1 AND 1000000),
    html_body TEXT CHECK (
      html_body IS NULL OR length(trim(html_body)) BETWEEN 1 AND 2000000
    ),
    -- Why it was sent, where the human table records who confirmed it.
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('payment_settled')),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    FOREIGN KEY (template_kind, template_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT,
    FOREIGN KEY (sender_identity_id, sender_evidence_version)
      REFERENCES sender_identity_evidence(sender_identity_id, evidence_version)
      ON DELETE RESTRICT
  ) STRICT`,

  `CREATE INDEX invoice_auto_email_intents_invoice
    ON invoice_auto_email_intents(invoice_id, created_at)`,

  // Immutable for the same reason the confirmed intents are: this is the record
  // of what a client was actually sent, and a record that can be edited
  // afterwards answers a different question than the one it was kept for.
  `CREATE TRIGGER invoice_auto_email_intents_no_update
    BEFORE UPDATE ON invoice_auto_email_intents
    BEGIN SELECT RAISE(ABORT, 'automatic email intent is immutable'); END`,
  `CREATE TRIGGER invoice_auto_email_intents_no_delete
    BEFORE DELETE ON invoice_auto_email_intents
    BEGIN SELECT RAISE(ABORT, 'automatic email intent is immutable'); END`,

  // An imported payment must never produce one of these. The cutover carried
  // 432 settled invoices, and the failure this refuses is emailing every client
  // of the last thirteen years at once.
  `CREATE TRIGGER invoice_auto_email_intents_reject_imported
    BEFORE INSERT ON invoice_auto_email_intents
    WHEN EXISTS (
      SELECT 1 FROM invoice_payments payment
      WHERE payment.id = NEW.invoice_payment_id AND payment.harvest_id IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'an imported payment cannot send a thank-you'); END`,
] as const
