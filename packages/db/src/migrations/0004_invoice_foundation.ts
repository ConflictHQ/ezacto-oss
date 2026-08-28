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

export const invoiceFoundationMigration = [
  `CREATE TABLE invoices (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_creator_id INTEGER,
    source_creator_name TEXT,
    number TEXT NOT NULL UNIQUE,
    subject TEXT,
    purchase_order TEXT,
    notes TEXT,
    currency TEXT NOT NULL,
    issue_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    payment_terms TEXT NOT NULL DEFAULT 'custom'
      CHECK (payment_terms IN ('upon_receipt','net_15','net_30','net_45','net_60','custom')),
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','open','paid','closed')),
    sent_at TEXT,
    paid_at TEXT,
    paid_date TEXT,
    closed_at TEXT,
    period_start TEXT,
    period_end TEXT,
    client_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(32)))),
    project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
    reminder_policy TEXT CHECK (
      reminder_policy IS NULL
      OR (json_valid(reminder_policy) AND json_type(reminder_policy) = 'object')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (date(issue_date) IS issue_date),
    CHECK (date(due_date) IS due_date),
    CHECK (paid_date IS NULL OR date(paid_date) IS paid_date),
    CHECK (period_start IS NULL OR date(period_start) IS period_start),
    CHECK (period_end IS NULL OR date(period_end) IS period_end),
    CHECK (${nullableCanonicalTimestamp('sent_at')}),
    CHECK (${nullableCanonicalTimestamp('paid_at')}),
    CHECK (${nullableCanonicalTimestamp('closed_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX invoices_client_id ON invoices(client_id)`,
  `CREATE INDEX invoices_project_id ON invoices(project_id)`,
  `CREATE INDEX invoices_created_by_user_id ON invoices(created_by_user_id)`,
  `CREATE TRIGGER invoices_reject_identity_collision
    BEFORE INSERT ON invoices
    WHEN EXISTS (SELECT 1 FROM invoices existing WHERE existing.id = NEW.id)
      OR (
        NEW.harvest_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM invoices existing WHERE existing.harvest_id = NEW.harvest_id
        )
      )
      OR EXISTS (SELECT 1 FROM invoices existing WHERE existing.number = NEW.number)
      OR EXISTS (SELECT 1 FROM invoices existing WHERE existing.client_key = NEW.client_key)
    BEGIN SELECT RAISE(ABORT, 'invoice identity already exists'); END`,
  `CREATE TRIGGER invoices_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id, number, client_key ON invoices
    WHEN EXISTS (
      SELECT 1 FROM invoices existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    )
      OR (
      NEW.harvest_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM invoices existing
        WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
      )
    )
      OR EXISTS (
        SELECT 1 FROM invoices existing
        WHERE existing.number = NEW.number AND existing.id <> OLD.id
      )
      OR EXISTS (
        SELECT 1 FROM invoices existing
        WHERE existing.client_key = NEW.client_key AND existing.id <> OLD.id
      )
    BEGIN SELECT RAISE(ABORT, 'invoice identity belongs to another row'); END`,
  `CREATE TRIGGER invoices_source_creator_immutable
    BEFORE UPDATE OF source_creator_id, source_creator_name ON invoices
    WHEN OLD.source_creator_id IS NOT NEW.source_creator_id
      OR OLD.source_creator_name IS NOT NEW.source_creator_name
    BEGIN SELECT RAISE(ABORT, 'invoice source creator provenance is immutable'); END`,
  `CREATE TRIGGER invoices_project_client_insert
    BEFORE INSERT ON invoices
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects
      WHERE id = NEW.project_id AND client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice project must belong to invoice client'); END`,
  `CREATE TRIGGER invoices_project_client_update
    BEFORE UPDATE OF project_id, client_id ON invoices
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects
      WHERE id = NEW.project_id AND client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice project must belong to invoice client'); END`,
  `CREATE TABLE invoice_item_categories (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    name TEXT NOT NULL UNIQUE,
    use_as_service INTEGER NOT NULL DEFAULT 0 CHECK (use_as_service IN (0,1)),
    use_as_expense INTEGER NOT NULL DEFAULT 0 CHECK (use_as_expense IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE invoice_line_items (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL,
    description TEXT,
    quantity REAL NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    taxed INTEGER NOT NULL DEFAULT 0 CHECK (taxed IN (0,1)),
    taxed2 INTEGER NOT NULL DEFAULT 0 CHECK (taxed2 IN (0,1)),
    project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (invoice_id, position),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX invoice_line_items_invoice_id ON invoice_line_items(invoice_id)`,
  `CREATE INDEX invoice_line_items_project_id ON invoice_line_items(project_id)`,
  `CREATE TRIGGER invoice_line_items_project_client_insert
    BEFORE INSERT ON invoice_line_items
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects project
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE project.id = NEW.project_id AND project.client_id = invoice.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice line project must belong to invoice client'); END`,
  `CREATE TRIGGER invoice_line_items_project_client_update
    BEFORE UPDATE OF invoice_id, project_id ON invoice_line_items
    WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects project
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE project.id = NEW.project_id AND project.client_id = invoice.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice line project must belong to invoice client'); END`,
  `CREATE TABLE invoice_messages (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    sent_by TEXT,
    sent_by_email TEXT,
    sent_from TEXT,
    sent_from_email TEXT,
    recipients TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(recipients) AND json_type(recipients) = 'array'),
    subject TEXT,
    body TEXT,
    attach_pdf INTEGER NOT NULL DEFAULT 0 CHECK (attach_pdf IN (0,1)),
    send_me_a_copy INTEGER NOT NULL DEFAULT 0 CHECK (send_me_a_copy IN (0,1)),
    thank_you INTEGER NOT NULL DEFAULT 0 CHECK (thank_you IN (0,1)),
    reminder INTEGER NOT NULL DEFAULT 0 CHECK (reminder IN (0,1)),
    send_reminder_on TEXT,
    event_type TEXT CHECK (event_type IS NULL OR event_type IN ('send','close','re-open','draft')),
    delivery_status TEXT
      CHECK (delivery_status IS NULL OR delivery_status IN ('queued','sent','bounced','complained','failed')),
    provider_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (send_reminder_on IS NULL OR date(send_reminder_on) IS send_reminder_on),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX invoice_messages_invoice_created_id
    ON invoice_messages(invoice_id, created_at, id)`,
  `CREATE INDEX invoice_messages_provider_message_id
    ON invoice_messages(provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE TRIGGER invoice_messages_reject_identity_collision
    BEFORE INSERT ON invoice_messages
    WHEN EXISTS (SELECT 1 FROM invoice_messages existing WHERE existing.id = NEW.id)
      OR (
        NEW.harvest_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM invoice_messages existing WHERE existing.harvest_id = NEW.harvest_id
        )
      )
    BEGIN SELECT RAISE(ABORT, 'invoice message identity already exists'); END`,
  `CREATE TRIGGER invoice_messages_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id ON invoice_messages
    WHEN EXISTS (
      SELECT 1 FROM invoice_messages existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    )
      OR (
        NEW.harvest_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM invoice_messages existing
          WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
        )
      )
    BEGIN SELECT RAISE(ABORT, 'invoice message identity belongs to another row'); END`,
  `CREATE TRIGGER invoice_messages_sender_snapshots_immutable
    BEFORE UPDATE OF sent_by, sent_by_email, sent_from, sent_from_email ON invoice_messages
    WHEN OLD.sent_by IS NOT NEW.sent_by
      OR OLD.sent_by_email IS NOT NEW.sent_by_email
      OR OLD.sent_from IS NOT NEW.sent_from
      OR OLD.sent_from_email IS NOT NEW.sent_from_email
    BEGIN SELECT RAISE(ABORT, 'invoice message sender snapshots are immutable'); END`,
  `CREATE TABLE event_outbox (
    id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id INTEGER NOT NULL,
    aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence >= 1),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    occurred_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    published_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    UNIQUE (aggregate_type, aggregate_id, aggregate_sequence),
    CHECK (${canonicalTimestamp('occurred_at')}),
    CHECK (${canonicalTimestamp('available_at')}),
    CHECK (${nullableCanonicalTimestamp('published_at')})
  ) STRICT`,
  `CREATE INDEX event_outbox_dequeue
    ON event_outbox(published_at, available_at, occurred_at, id)`,
  `CREATE TRIGGER event_outbox_reject_identity_collision
    BEFORE INSERT ON event_outbox
    WHEN EXISTS (SELECT 1 FROM event_outbox existing WHERE existing.id = NEW.id)
      OR EXISTS (
        SELECT 1 FROM event_outbox existing
        WHERE existing.aggregate_type = NEW.aggregate_type
          AND existing.aggregate_id = NEW.aggregate_id
          AND existing.aggregate_sequence = NEW.aggregate_sequence
      )
    BEGIN SELECT RAISE(ABORT, 'outbox event identity already exists'); END`,
  `CREATE TRIGGER event_outbox_reject_update_identity_collision
    BEFORE UPDATE OF id, aggregate_type, aggregate_id, aggregate_sequence ON event_outbox
    WHEN EXISTS (
      SELECT 1 FROM event_outbox existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    )
      OR EXISTS (
        SELECT 1 FROM event_outbox existing
        WHERE existing.aggregate_type = NEW.aggregate_type
          AND existing.aggregate_id = NEW.aggregate_id
          AND existing.aggregate_sequence = NEW.aggregate_sequence
          AND existing.id <> OLD.id
      )
    BEGIN SELECT RAISE(ABORT, 'outbox event identity belongs to another row'); END`,
  `CREATE TRIGGER event_outbox_event_immutable
    BEFORE UPDATE OF id, aggregate_type, aggregate_id, aggregate_sequence,
      event_type, payload_json, occurred_at ON event_outbox
    WHEN OLD.id IS NOT NEW.id
      OR OLD.aggregate_type IS NOT NEW.aggregate_type
      OR OLD.aggregate_id IS NOT NEW.aggregate_id
      OR OLD.aggregate_sequence IS NOT NEW.aggregate_sequence
      OR OLD.event_type IS NOT NEW.event_type
      OR OLD.payload_json IS NOT NEW.payload_json
      OR OLD.occurred_at IS NOT NEW.occurred_at
    BEGIN SELECT RAISE(ABORT, 'outbox event identity and payload are immutable'); END`,
  `ALTER TABLE time_entries ADD COLUMN invoice_id INTEGER
    REFERENCES invoices(id) ON DELETE RESTRICT`,
  `CREATE INDEX time_entries_invoice_id ON time_entries(invoice_id)`,
  `CREATE TRIGGER time_entries_invoice_client_insert
    BEFORE INSERT ON time_entries
    WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'time entry project must belong to invoice client'); END`,
  `CREATE TRIGGER time_entries_invoice_client_update
    BEFORE UPDATE OF invoice_id, project_id ON time_entries
    WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'time entry project must belong to invoice client'); END`,
  `ALTER TABLE project_milestones ADD COLUMN invoiced_invoice_id INTEGER
    REFERENCES invoices(id) ON DELETE RESTRICT`,
  `CREATE INDEX project_milestones_invoiced_invoice_id
    ON project_milestones(invoiced_invoice_id)`,
  `CREATE TRIGGER project_milestones_invoice_client_insert
    BEFORE INSERT ON project_milestones
    WHEN NEW.invoiced_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoiced_invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'milestone project must belong to invoice client'); END`,
  `CREATE TRIGGER project_milestones_invoice_client_update
    BEFORE UPDATE OF invoiced_invoice_id, project_id ON project_milestones
    WHEN NEW.invoiced_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoiced_invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'milestone project must belong to invoice client'); END`,
  `CREATE TRIGGER invoices_client_consistent_with_children_update
    BEFORE UPDATE OF client_id ON invoices
    WHEN OLD.client_id IS NOT NEW.client_id AND (
      EXISTS (
        SELECT 1 FROM invoice_line_items line
        JOIN projects project ON project.id = line.project_id
        WHERE line.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
      OR EXISTS (
        SELECT 1 FROM time_entries entry
        JOIN projects project ON project.id = entry.project_id
        WHERE entry.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
      OR EXISTS (
        SELECT 1 FROM project_milestones milestone
        JOIN projects project ON project.id = milestone.project_id
        WHERE milestone.invoiced_invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice client must match every linked project'); END`,
  `CREATE TRIGGER projects_client_immutable_while_invoiced
    BEFORE UPDATE OF client_id ON projects
    WHEN OLD.client_id IS NOT NEW.client_id
      AND (
        EXISTS (SELECT 1 FROM invoices WHERE project_id = OLD.id)
        OR EXISTS (SELECT 1 FROM invoice_line_items WHERE project_id = OLD.id)
        OR EXISTS (
          SELECT 1 FROM time_entries
          WHERE project_id = OLD.id AND invoice_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM project_milestones
          WHERE project_id = OLD.id AND invoiced_invoice_id IS NOT NULL
        )
      )
    BEGIN SELECT RAISE(ABORT, 'project client is immutable while invoices are linked'); END`,
] as const
