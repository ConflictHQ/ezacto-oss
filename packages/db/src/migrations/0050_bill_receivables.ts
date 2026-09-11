// Provenance: ezacto-oss #542. A client who pays through BILL should get their
// invoice there, and the payment should come back without anyone retyping it.
//
// Why there is no connection table here. The QuickBooks mirror stores its
// tokens (0048) because OAuth issues them to the instance and they rotate.
// BILL has no OAuth: the credential is an organisation id, a developer key and
// a username/password pair, all of which are set once and none of which this
// system can obtain or rotate on its own. They are deployment configuration,
// held the way the Intuit client secret already is, and a table holding a
// password would be a table worth stealing. So this migration adds only what
// the deployment cannot supply: which clients opted in, and what BILL called
// the things we sent it.
//
// Why the opt-in is a column on `clients` rather than a table. It is one
// boolean per client with no history anyone asked for, and a join table for a
// flag is a second place to be wrong about it. `clients` already carries
// `budget_cents` the same way (0036).
//
// Why the links are not a foreign key. `ezacto_id` is polymorphic -- a
// `clients.id` for a customer and an `invoices.id` for an invoice -- and
// SQLite cannot REFERENCES two tables from one column, which is the same
// reason `quickbooks_links` is shaped this way. The triggers below do what the
// foreign key would.
//
// Why payments are not stored here at all. A BILL payment that settled one of
// our invoices becomes a payment row in the money tables, exactly as a
// QuickBooks one does; what this table holds is only the mapping needed to
// recognise it, and the payment/invoice pair is what makes recording one twice
// impossible.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const billReceivablesMigration = [
  // Off unless asked. Sending a client's invoice through a third party is a
  // change to how that client is billed, so it is never the default.
  `ALTER TABLE clients ADD COLUMN bill_delivery INTEGER NOT NULL DEFAULT 0
    CHECK (bill_delivery IN (0,1))`,
  `CREATE TABLE bill_links (
    kind TEXT NOT NULL CHECK (kind IN ('customer','invoice')),
    -- Our id: a clients.id or an invoices.id depending on kind.
    ezacto_id INTEGER NOT NULL CHECK (ezacto_id > 0),
    -- BILL's id. Customers begin '0cu' and invoices '00e'; the prefix is
    -- checked against the kind so a customer id can never be filed as an
    -- invoice, which would send a payment to the wrong document.
    bill_id TEXT NOT NULL CHECK (length(trim(bill_id)) BETWEEN 1 AND 64),
    -- Where the client is told to pay, when BILL is not sending the invoice
    -- itself. Null where BILL mailed it, because then BILL owns the link.
    payment_link TEXT CHECK (payment_link IS NULL OR length(payment_link) BETWEEN 1 AND 2048),
    mirrored_at TEXT NOT NULL CHECK (${canonicalTimestamp('mirrored_at')}),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    PRIMARY KEY (kind, ezacto_id),
    CHECK (
      (kind = 'customer' AND bill_id GLOB '0cu*')
      OR (kind = 'invoice' AND bill_id GLOB '00e*')
    )
  ) STRICT`,
  // One BILL object per kind, both ways. Without this a second mirror attempt
  // could file the same BILL invoice against two of ours, and a payment would
  // then be recorded against whichever was found first.
  `CREATE UNIQUE INDEX bill_links_identity ON bill_links(kind, bill_id)`,
  // What a foreign key would do, were the column not polymorphic.
  `CREATE TRIGGER bill_links_insert_guard
    BEFORE INSERT ON bill_links
    FOR EACH ROW WHEN
      (NEW.kind = 'customer' AND NOT EXISTS (SELECT 1 FROM clients WHERE id = NEW.ezacto_id))
      OR (NEW.kind = 'invoice' AND NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.ezacto_id))
    BEGIN
      SELECT RAISE(ABORT, 'bill_links.ezacto_id must name an existing client or invoice');
    END`,
  // An id that moves is a link pointing at a different document than the one it
  // was written for, which is how a payment lands on the wrong invoice.
  `CREATE TRIGGER bill_links_identity_immutable
    BEFORE UPDATE ON bill_links
    FOR EACH ROW WHEN
      NEW.kind <> OLD.kind OR NEW.ezacto_id <> OLD.ezacto_id OR NEW.bill_id <> OLD.bill_id
    BEGIN
      SELECT RAISE(ABORT, 'bill_links identity is immutable');
    END`,
  `CREATE TABLE bill_received_payments (
    -- BILL's payment id, beginning '0rp', and the invoice it settled. The key
    -- is the PAIR, because one BILL payment can settle several invoices at
    -- once and each invoice's share is its own row -- keyed on the payment
    -- alone, the second invoice's share would have nowhere to go.
    --
    -- That it is a key at all is what makes the reconciliation safe to repeat:
    -- it is a poll, so it sees every payment again on every pass, and the
    -- second pass must record nothing.
    bill_payment_id TEXT NOT NULL
      CHECK (length(trim(bill_payment_id)) BETWEEN 1 AND 64),
    bill_invoice_id TEXT NOT NULL CHECK (length(trim(bill_invoice_id)) BETWEEN 1 AND 64),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    paid_on TEXT CHECK (paid_on IS NULL OR paid_on GLOB '????-??-??'),
    recorded_at TEXT NOT NULL CHECK (${canonicalTimestamp('recorded_at')}),
    PRIMARY KEY (bill_payment_id, bill_invoice_id)
  ) STRICT`,
  `CREATE INDEX bill_received_payments_invoice ON bill_received_payments(invoice_id)`,
] as const
