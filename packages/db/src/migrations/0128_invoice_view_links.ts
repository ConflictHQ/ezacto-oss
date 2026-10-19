// Provenance: ezacto-pvt #936, owner decision of 2026-10-19. Invoice view
// receipts: show when a client opened the emailed invoice.
//
// The mechanism is a hosted, token-gated invoice page, not a tracking pixel.
// A pixel would be noise (Apple Mail Privacy Protection preloads every image)
// and tracks a client who did nothing. A view is recorded only when a person
// looks at the page, or downloads its PDF.
//
// Three things are stored here.
//
// - `organizations.invoice_view_receipts`, the company setting. Off, so an
//   instance upgrading into this feature sends exactly the email it sent
//   before and has no public page.
//
// - `invoice_view_links`, one row per sent invoice message that carries a link.
//   The token is a bearer secret and is never stored: only its SHA-256 is, so a
//   copy of the database cannot be used to open anybody's invoice. The row is
//   written in the same batch as the send, and keyed on the message because
//   since 0099 an invoice email is one message (To and Cc), so a receipt is per
//   send, not per recipient. A link expires; `first_viewed_at` is the receipt,
//   and `view_message_id` is the `view` row the invoice.view command wrote into
//   the invoice's history.
//
// - `invoice_view_limits`, a per-minute attempt counter keyed on a hash of the
//   caller's address, so the public routes can refuse a caller that is
//   guessing or hammering without the table holding anybody's address.
//
// The link row is immutable except for the view bookkeeping columns, and it is
// never deleted: it is the record of what link a client was sent.
const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const invoiceViewLinksMigration = [
  `ALTER TABLE organizations ADD COLUMN invoice_view_receipts INTEGER NOT NULL DEFAULT 0
    CHECK (invoice_view_receipts IN (0,1))`,

  `CREATE TABLE invoice_view_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_message_id INTEGER NOT NULL UNIQUE
      REFERENCES invoice_messages(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    -- SHA-256 of the token, lower-case hex. The token itself is never stored.
    token_hash TEXT NOT NULL UNIQUE
      CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    first_viewed_at TEXT CHECK (first_viewed_at IS NULL OR (${canonicalTimestamp('first_viewed_at')})),
    last_viewed_at TEXT CHECK (last_viewed_at IS NULL OR (${canonicalTimestamp('last_viewed_at')})),
    view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    view_message_id INTEGER REFERENCES invoice_messages(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    CHECK ((first_viewed_at IS NULL) = (view_count = 0))
  ) STRICT`,

  `CREATE INDEX invoice_view_links_invoice ON invoice_view_links(invoice_id)`,

  // The identity of a link never changes; only what happened to it does.
  `CREATE TRIGGER invoice_view_links_identity_immutable
    BEFORE UPDATE OF invoice_message_id, invoice_id, token_hash, expires_at, created_at
      ON invoice_view_links
    BEGIN SELECT RAISE(ABORT, 'an invoice view link is immutable'); END`,
  `CREATE TRIGGER invoice_view_links_no_delete
    BEFORE DELETE ON invoice_view_links
    BEGIN SELECT RAISE(ABORT, 'an invoice view link is immutable'); END`,

  `CREATE TABLE invoice_view_limits (
    window_minute INTEGER NOT NULL CHECK (window_minute >= 0),
    client_hash TEXT NOT NULL CHECK (length(client_hash) = 64),
    attempts INTEGER NOT NULL CHECK (attempts >= 1),
    PRIMARY KEY (window_minute, client_hash)
  ) STRICT`,
] as const
