// One QuickBooks company, the links to what we mirrored into it, and the
// webhook deliveries we have already acted on.
//
// Why one connection and not many. An instance is one set of books. Mirroring
// the same invoice into two QuickBooks companies would make two documents of
// record for one debt, and deciding which is authoritative is not a question
// this system should be able to ask. `id = 1` says so in the schema rather than
// in a comment somebody has to find.
//
// Why the realm is part of every link's key. An operator can disconnect and
// connect a *different* company -- a new accountant, a restructure, a sandbox
// they were testing against. Every link made against the old company is then
// meaningless, and a mirror that reused them would update invoices belonging to
// somebody else's books. Keying on the realm makes those rows unreachable
// rather than wrong, without deleting the history of what was mirrored where.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const quickbooksConnectionMigration = [
  `CREATE TABLE quickbooks_connections (
    -- One company, stated in the schema. See the note above.
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- Intuit's id for the connected company. Every API path carries it, and it
    -- is what tells two connections apart.
    realm_id TEXT NOT NULL CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    company_name TEXT CHECK (company_name IS NULL OR length(company_name) <= 255),
    -- Tokens. These are credentials: whoever holds the refresh token can read
    -- and write the company's books until it is revoked.
    access_token TEXT NOT NULL CHECK (length(access_token) BETWEEN 1 AND 4096),
    refresh_token TEXT NOT NULL CHECK (length(refresh_token) BETWEEN 1 AND 4096),
    access_token_expires_at TEXT NOT NULL
      CHECK (${canonicalTimestamp('access_token_expires_at')}),
    refresh_token_expires_at TEXT NOT NULL
      CHECK (${canonicalTimestamp('refresh_token_expires_at')}),
    -- What the operator actually granted, recorded rather than assumed. A scope
    -- narrower than the mirror needs is a connection that will fail on its first
    -- write, and it is better to say so than to discover it then.
    scope TEXT NOT NULL CHECK (length(trim(scope)) BETWEEN 1 AND 512),
    -- Whether mirrored invoices offer QuickBooks' own payment links. Off unless
    -- asked: it only does anything where the company has QuickBooks Payments,
    -- and turning it on changes how a client is invited to pay.
    allow_online_payment INTEGER NOT NULL DEFAULT 0
      CHECK (allow_online_payment IN (0,1)),
    -- Who connected it. A grant over the company's books that appeared with no
    -- author is one nobody can be asked about.
    connected_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    connected_at TEXT NOT NULL CHECK (${canonicalTimestamp('connected_at')}),
    -- Set rather than deleted, so the links below keep a company to point at
    -- and an operator can still read what was mirrored before they disconnected.
    disconnected_at TEXT
      CHECK (disconnected_at IS NULL OR (${canonicalTimestamp('disconnected_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
  ) STRICT`,

  // The single-use value that ties a callback to the request that started it.
  //
  // Without this an attacker can hand an administrator a link that connects
  // *their* QuickBooks company to this instance, and every invoice afterwards
  // mirrors into books they control. The row is deleted on use, so a replayed
  // callback finds nothing and is refused.
  `CREATE TABLE quickbooks_oauth_states (
    state TEXT PRIMARY KEY CHECK (length(state) BETWEEN 16 AND 128),
    requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The callback must match what the authorize request was built with, or a
    -- code obtained for one deployment could be redeemed against another.
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    -- Short. A consent screen is answered in minutes; an hour-old state is a
    -- link somebody kept.
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    CHECK (expires_at > created_at)
  ) STRICT`,

  `CREATE INDEX quickbooks_oauth_states_expiry ON quickbooks_oauth_states(expires_at)`,

  // What we put in QuickBooks, and where it landed.
  `CREATE TABLE quickbooks_links (
    realm_id TEXT NOT NULL CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK (kind IN ('customer','invoice')),
    -- Our id: a clients.id or an invoices.id depending on kind. Not a foreign
    -- key, because the pair is polymorphic and a REFERENCES cannot be; the
    -- triggers below do what a foreign key would.
    ezacto_id INTEGER NOT NULL CHECK (ezacto_id > 0),
    quickbooks_id TEXT NOT NULL CHECK (length(trim(quickbooks_id)) BETWEEN 1 AND 64),
    -- QuickBooks' optimistic-concurrency token. An update carrying a stale one
    -- is refused rather than merged, which is what stops our write silently
    -- overwriting an edit somebody made in QuickBooks.
    sync_token TEXT NOT NULL CHECK (length(trim(sync_token)) BETWEEN 1 AND 32),
    mirrored_at TEXT NOT NULL CHECK (${canonicalTimestamp('mirrored_at')}),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    PRIMARY KEY (realm_id, kind, ezacto_id)
  ) STRICT`,

  // One of ours per QuickBooks document, as well as the other way round. Two of
  // our invoices pointing at one QuickBooks invoice means one of them is
  // overwriting the other every time it mirrors.
  `CREATE UNIQUE INDEX quickbooks_links_remote
    ON quickbooks_links(realm_id, kind, quickbooks_id)`,

  // Deliveries Intuit has already sent us.
  //
  // Intuit retries, and a retry after a successful-but-slow handler is
  // indistinguishable from a first delivery. Recording what has been processed
  // is what stops one payment being recorded twice against an invoice -- which
  // is money, not bookkeeping.
  `CREATE TABLE quickbooks_webhook_deliveries (
    realm_id TEXT NOT NULL CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    entity_name TEXT NOT NULL CHECK (length(trim(entity_name)) BETWEEN 1 AND 64),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 64),
    operation TEXT NOT NULL CHECK (operation IN ('Create','Update','Delete','Merge','Void','Emailed')),
    -- Intuit's own instant for the change. Together with the identity above it
    -- is what makes one delivery distinguishable from the next.
    last_updated TEXT NOT NULL CHECK (${canonicalTimestamp('last_updated')}),
    received_at TEXT NOT NULL CHECK (${canonicalTimestamp('received_at')}),
    -- Null while the delivery is known but not yet acted on, so a crash between
    -- accepting and handling is visible rather than silently dropped.
    processed_at TEXT
      CHECK (processed_at IS NULL OR (${canonicalTimestamp('processed_at')})),
    -- Why it was not acted on, where that was a decision rather than a failure:
    -- an entity we do not mirror, a realm that is not the connected one.
    skipped_reason TEXT CHECK (skipped_reason IS NULL OR length(skipped_reason) <= 255),
    PRIMARY KEY (realm_id, entity_name, entity_id, operation, last_updated),
    CHECK (processed_at IS NULL OR processed_at >= received_at)
  ) STRICT`,

  `CREATE INDEX quickbooks_webhook_deliveries_unprocessed
    ON quickbooks_webhook_deliveries(received_at)
    WHERE processed_at IS NULL`,

  // A link has to point at something that exists. The kind decides which table,
  // which is why this is a trigger rather than two foreign keys.
  `CREATE TRIGGER quickbooks_links_insert_guard
    BEFORE INSERT ON quickbooks_links
    BEGIN
      SELECT CASE
        WHEN NEW.kind = 'customer'
          AND NOT EXISTS (SELECT 1 FROM clients WHERE id = NEW.ezacto_id)
          THEN RAISE(ABORT, 'quickbooks link points at a client that does not exist')
        WHEN NEW.kind = 'invoice'
          AND NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.ezacto_id)
          THEN RAISE(ABORT, 'quickbooks link points at an invoice that does not exist')
      END;
    END`,

  // The pair a link names is the fact. Correcting one means deleting the link
  // and making it again, which leaves a trace; editing it in place would let a
  // mirror quietly start writing to a different document.
  `CREATE TRIGGER quickbooks_links_identity_immutable
    BEFORE UPDATE ON quickbooks_links
    WHEN OLD.realm_id IS NOT NEW.realm_id
      OR OLD.kind IS NOT NEW.kind
      OR OLD.ezacto_id IS NOT NEW.ezacto_id
      OR OLD.quickbooks_id IS NOT NEW.quickbooks_id
    BEGIN SELECT RAISE(ABORT, 'quickbooks link identity is immutable'); END`,

  // A connection's realm is likewise the fact. Connecting a different company is
  // a new connection, not an edit of the old one -- otherwise every link made
  // against the previous realm silently becomes a link against this one.
  `CREATE TRIGGER quickbooks_connections_realm_immutable
    BEFORE UPDATE ON quickbooks_connections
    WHEN OLD.realm_id IS NOT NEW.realm_id AND OLD.disconnected_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'disconnect before connecting a different QuickBooks company'); END`,
] as const
