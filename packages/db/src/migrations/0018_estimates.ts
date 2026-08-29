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

const nullableCanonicalTimestamp = (column: string) =>
  `${column} IS NULL OR (${canonicalTimestamp(column)})`

const moneyUpperBound = 9_000_000_000_000
const maxSafeInteger = 9_007_199_254_740_991

export const estimatesMigration = [
  `CREATE TABLE estimates (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_creator_id INTEGER,
    source_creator_name TEXT,
    number TEXT NOT NULL UNIQUE CHECK (length(trim(number)) > 0),
    purchase_order TEXT,
    subject TEXT,
    notes TEXT,
    currency TEXT NOT NULL CHECK (
      length(currency) = 3 AND currency = upper(currency)
      AND currency NOT GLOB '*[^A-Z]*'
    ),
    state TEXT NOT NULL DEFAULT 'draft'
      CHECK (state IN ('draft','sent','accepted','declined')),
    version INTEGER NOT NULL DEFAULT 0
      CHECK (version BETWEEN 0 AND ${maxSafeInteger}),
    issue_date TEXT NOT NULL,
    sent_at TEXT,
    accepted_at TEXT,
    declined_at TEXT,
    client_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(32)))),
    tax_rate_ppm INTEGER CHECK (tax_rate_ppm IS NULL OR tax_rate_ppm BETWEEN 0 AND 1000000),
    tax2_rate_ppm INTEGER CHECK (tax2_rate_ppm IS NULL OR tax2_rate_ppm BETWEEN 0 AND 1000000),
    discount_rate_ppm INTEGER
      CHECK (discount_rate_ppm IS NULL OR discount_rate_ppm BETWEEN 0 AND 1000000),
    amount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (abs(amount_cents) <= ${moneyUpperBound}),
    tax_amount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (abs(tax_amount_cents) <= ${moneyUpperBound}),
    tax2_amount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (abs(tax2_amount_cents) <= ${moneyUpperBound}),
    discount_amount_cents INTEGER NOT NULL DEFAULT 0
      CHECK (abs(discount_amount_cents) <= ${moneyUpperBound}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((source_creator_id IS NULL) = (source_creator_name IS NULL)),
    CHECK (date(issue_date) IS issue_date),
    CHECK (${nullableCanonicalTimestamp('sent_at')}),
    CHECK (${nullableCanonicalTimestamp('accepted_at')}),
    CHECK (${nullableCanonicalTimestamp('declined_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX estimates_client_id ON estimates(client_id)`,
  `CREATE INDEX estimates_created_by_user_id ON estimates(created_by_user_id)`,
  `CREATE TRIGGER estimates_reject_identity_collision
    BEFORE INSERT ON estimates
    WHEN EXISTS (SELECT 1 FROM estimates existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM estimates existing WHERE existing.harvest_id = NEW.harvest_id
      ))
      OR EXISTS (SELECT 1 FROM estimates existing WHERE existing.number = NEW.number)
      OR EXISTS (SELECT 1 FROM estimates existing WHERE existing.client_key = NEW.client_key)
    BEGIN SELECT RAISE(ABORT, 'estimate identity already exists'); END`,
  `CREATE TRIGGER estimates_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id, number, client_key ON estimates
    WHEN EXISTS (
      SELECT 1 FROM estimates existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimates existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    )) OR EXISTS (
      SELECT 1 FROM estimates existing
      WHERE existing.number = NEW.number AND existing.id <> OLD.id
    ) OR EXISTS (
      SELECT 1 FROM estimates existing
      WHERE existing.client_key = NEW.client_key AND existing.id <> OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'estimate identity belongs to another row'); END`,
  `CREATE TRIGGER estimates_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON estimates
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'estimate Harvest identity is immutable'); END`,
  `CREATE TRIGGER estimates_source_creator_immutable
    BEFORE UPDATE OF source_creator_id, source_creator_name ON estimates
    WHEN OLD.source_creator_id IS NOT NEW.source_creator_id
      OR OLD.source_creator_name IS NOT NEW.source_creator_name
    BEGIN SELECT RAISE(ABORT, 'estimate source creator provenance is immutable'); END`,
  `CREATE TABLE estimate_item_categories (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TRIGGER estimate_item_categories_reject_identity_collision
    BEFORE INSERT ON estimate_item_categories
    WHEN EXISTS (SELECT 1 FROM estimate_item_categories existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM estimate_item_categories existing
        WHERE existing.harvest_id = NEW.harvest_id
      ))
      OR EXISTS (SELECT 1 FROM estimate_item_categories existing WHERE existing.name = NEW.name)
    BEGIN SELECT RAISE(ABORT, 'estimate item category identity already exists'); END`,
  `CREATE TRIGGER estimate_item_categories_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id, name ON estimate_item_categories
    WHEN EXISTS (
      SELECT 1 FROM estimate_item_categories existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimate_item_categories existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    )) OR EXISTS (
      SELECT 1 FROM estimate_item_categories existing
      WHERE existing.name = NEW.name AND existing.id <> OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'estimate item category identity belongs to another row'); END`,
  `CREATE TRIGGER estimate_item_categories_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON estimate_item_categories
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'estimate item category Harvest identity is immutable'); END`,
  `CREATE TABLE estimate_line_items (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND ${maxSafeInteger}),
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    description TEXT,
    quantity REAL NOT NULL
      CHECK (quantity BETWEEN -${maxSafeInteger} AND ${maxSafeInteger}),
    unit_price_cents INTEGER NOT NULL
      CHECK (abs(unit_price_cents) <= ${moneyUpperBound}),
    amount_cents INTEGER NOT NULL
      CHECK (abs(amount_cents) <= ${moneyUpperBound}),
    taxed INTEGER NOT NULL DEFAULT 0 CHECK (taxed IN (0,1)),
    taxed2 INTEGER NOT NULL DEFAULT 0 CHECK (taxed2 IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (estimate_id, position),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX estimate_line_items_estimate_id ON estimate_line_items(estimate_id)`,
  `CREATE TRIGGER estimate_line_items_reject_identity_collision
    BEFORE INSERT ON estimate_line_items
    WHEN EXISTS (SELECT 1 FROM estimate_line_items existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM estimate_line_items existing WHERE existing.harvest_id = NEW.harvest_id
      ))
      OR EXISTS (
        SELECT 1 FROM estimate_line_items existing
        WHERE existing.estimate_id = NEW.estimate_id AND existing.position = NEW.position
      )
    BEGIN SELECT RAISE(ABORT, 'estimate line identity already exists'); END`,
  `CREATE TRIGGER estimate_line_items_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id, estimate_id, position ON estimate_line_items
    WHEN EXISTS (
      SELECT 1 FROM estimate_line_items existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimate_line_items existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    )) OR EXISTS (
      SELECT 1 FROM estimate_line_items existing
      WHERE existing.estimate_id = NEW.estimate_id AND existing.position = NEW.position
        AND existing.id <> OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'estimate line identity belongs to another row'); END`,
  `CREATE TRIGGER estimate_line_items_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON estimate_line_items
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'estimate line Harvest identity is immutable'); END`,
  `CREATE TABLE estimate_messages (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    sent_by TEXT,
    sent_by_email TEXT,
    sent_from TEXT,
    sent_from_email TEXT,
    recipients TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(recipients) AND json_type(recipients) = 'array'),
    subject TEXT,
    body TEXT,
    send_me_a_copy INTEGER NOT NULL DEFAULT 0 CHECK (send_me_a_copy IN (0,1)),
    event_type TEXT CHECK (
      event_type IS NULL OR event_type IN ('send','accept','decline','re-open','view','invoice')
    ),
    delivery_status TEXT CHECK (
      delivery_status IS NULL
      OR delivery_status IN ('queued','sent','bounced','complained','failed')
    ),
    provider_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (event_type IS NOT 'send' OR json_array_length(recipients) > 0),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX estimate_messages_estimate_created_id
    ON estimate_messages(estimate_id, created_at, id)`,
  `CREATE INDEX estimate_messages_provider_message_id
    ON estimate_messages(provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE TRIGGER estimate_messages_recipients_shape_insert
    BEFORE INSERT ON estimate_messages
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.recipients) recipient
      WHERE json_type(recipient.value) <> 'object'
        OR json_type(recipient.value, '$.name') <> 'text'
        OR json_type(recipient.value, '$.email') <> 'text'
        OR length(trim(json_extract(recipient.value, '$.email'))) = 0
        OR (SELECT count(*) FROM json_each(recipient.value)) <> 2
        OR EXISTS (
          SELECT 1 FROM json_each(recipient.value) field
          WHERE field.key NOT IN ('name','email')
        )
    )
    BEGIN SELECT RAISE(ABORT, 'estimate message recipients are invalid'); END`,
  `CREATE TRIGGER estimate_messages_recipients_shape_update
    BEFORE UPDATE OF recipients ON estimate_messages
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.recipients) recipient
      WHERE json_type(recipient.value) <> 'object'
        OR json_type(recipient.value, '$.name') <> 'text'
        OR json_type(recipient.value, '$.email') <> 'text'
        OR length(trim(json_extract(recipient.value, '$.email'))) = 0
        OR (SELECT count(*) FROM json_each(recipient.value)) <> 2
        OR EXISTS (
          SELECT 1 FROM json_each(recipient.value) field
          WHERE field.key NOT IN ('name','email')
        )
    )
    BEGIN SELECT RAISE(ABORT, 'estimate message recipients are invalid'); END`,
  `CREATE TRIGGER estimate_messages_reject_identity_collision
    BEFORE INSERT ON estimate_messages
    WHEN EXISTS (SELECT 1 FROM estimate_messages existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM estimate_messages existing WHERE existing.harvest_id = NEW.harvest_id
      ))
    BEGIN SELECT RAISE(ABORT, 'estimate message identity already exists'); END`,
  `CREATE TRIGGER estimate_messages_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id ON estimate_messages
    WHEN EXISTS (
      SELECT 1 FROM estimate_messages existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimate_messages existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    ))
    BEGIN SELECT RAISE(ABORT, 'estimate message identity belongs to another row'); END`,
  `CREATE TRIGGER estimate_messages_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON estimate_messages
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'estimate message Harvest identity is immutable'); END`,
  `CREATE TRIGGER estimate_messages_sender_snapshots_immutable
    BEFORE UPDATE OF sent_by, sent_by_email, sent_from, sent_from_email ON estimate_messages
    WHEN OLD.sent_by IS NOT NEW.sent_by OR OLD.sent_by_email IS NOT NEW.sent_by_email
      OR OLD.sent_from IS NOT NEW.sent_from OR OLD.sent_from_email IS NOT NEW.sent_from_email
    BEGIN SELECT RAISE(ABORT, 'estimate message sender snapshots are immutable'); END`,
  `ALTER TABLE invoices ADD COLUMN estimate_id INTEGER
    REFERENCES estimates(id) ON DELETE RESTRICT`,
  `CREATE INDEX invoices_estimate_id ON invoices(estimate_id)`,
  `CREATE TRIGGER invoices_estimate_client_insert
    BEFORE INSERT ON invoices
    WHEN NEW.estimate_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM estimates estimate
      WHERE estimate.id = NEW.estimate_id AND estimate.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice estimate must belong to invoice client'); END`,
  `CREATE TRIGGER invoices_estimate_client_update
    BEFORE UPDATE OF estimate_id, client_id ON invoices
    WHEN NEW.estimate_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM estimates estimate
      WHERE estimate.id = NEW.estimate_id AND estimate.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice estimate must belong to invoice client'); END`,
  `CREATE TRIGGER estimates_client_immutable_while_invoiced
    BEFORE UPDATE OF client_id ON estimates
    WHEN OLD.client_id IS NOT NEW.client_id
      AND EXISTS (SELECT 1 FROM invoices invoice WHERE invoice.estimate_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'estimate client is immutable while invoices are linked'); END`,
] as const
