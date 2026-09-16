// Provenance: ezacto-oss issue 801; reminders were scheduled and never sent,
// and once they are sent there has to be a record of what a client received.

import { canonicalTimestamp } from './0029_outbox_delivery.js'

/**
 * One row per reminder that went out: the scheduled row it answers, the
 * `email_log` delivery it became, and the message as it was built.
 *
 * Its own table rather than a third `triggered_by` on
 * `invoice_auto_email_intents`: that table is keyed on the payment that settled
 * the invoice, and a reminder has no payment -- it is sent precisely because
 * there is none. The key here is the scheduled reminder, which is what makes a
 * redelivered cron tick idempotent: a second send for the same row loses on
 * the primary key and its delivery row goes with it.
 *
 * Immutable like the other intent tables. This is the record of what a client
 * was sent, and a record that can be edited afterwards answers a different
 * question than the one it was kept for.
 */
export const invoiceReminderDeliveriesMigration = [
  `CREATE TABLE invoice_reminder_deliveries (
    scheduled_reminder_id INTEGER PRIMARY KEY
      REFERENCES scheduled_reminders(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    delivery_id INTEGER NOT NULL UNIQUE REFERENCES email_log(id) ON DELETE RESTRICT,
    template_kind TEXT NOT NULL CHECK (template_kind = 'reminder'),
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
    -- How late the invoice was on the day this went, as the message said it.
    days_past_due INTEGER NOT NULL CHECK (days_past_due BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    FOREIGN KEY (template_kind, template_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT,
    FOREIGN KEY (sender_identity_id, sender_evidence_version)
      REFERENCES sender_identity_evidence(sender_identity_id, evidence_version)
      ON DELETE RESTRICT
  ) STRICT`,

  `CREATE INDEX invoice_reminder_deliveries_invoice
    ON invoice_reminder_deliveries(invoice_id, created_at)`,

  `CREATE TRIGGER invoice_reminder_deliveries_no_update
    BEFORE UPDATE ON invoice_reminder_deliveries
    BEGIN SELECT RAISE(ABORT, 'reminder delivery record is immutable'); END`,
  `CREATE TRIGGER invoice_reminder_deliveries_no_delete
    BEFORE DELETE ON invoice_reminder_deliveries
    BEGIN SELECT RAISE(ABORT, 'reminder delivery record is immutable'); END`,

  // A reminder goes to an invoice that is open and past due, and to no other.
  // Re-stated here rather than trusted from the processor, for the same reason
  // the thank-you refuses an imported payment at the schema: the failure this
  // guards against is mailing a client about an invoice they have paid.
  `CREATE TRIGGER invoice_reminder_deliveries_open_only
    BEFORE INSERT ON invoice_reminder_deliveries
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.id = NEW.invoice_id AND invoice.state = 'open'
    )
    BEGIN SELECT RAISE(ABORT, 'a reminder goes only to an open invoice'); END`,
] as const
