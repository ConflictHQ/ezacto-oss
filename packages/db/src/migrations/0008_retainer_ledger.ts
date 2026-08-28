const centsLimit = 9_000_000_000_000
const safeIntegerLimit = 9_007_199_254_740_991

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

export const retainerLedgerMigration = [
  `CREATE TABLE retainers (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE
      CHECK (harvest_id IS NULL OR harvest_id BETWEEN 1 AND ${safeIntegerLimit}),
    client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
    project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
    state TEXT NOT NULL DEFAULT 'ongoing' CHECK (state IN ('ongoing','closed')),
    denomination TEXT NOT NULL CHECK (denomination IN ('money','hours')),
    amount_cents INTEGER,
    seconds INTEGER,
    locked_rate_cents INTEGER,
    rate_locked_at TEXT,
    period TEXT CHECK (period IS NULL OR length(trim(period)) BETWEEN 1 AND 64),
    rollover TEXT CHECK (rollover IS NULL OR rollover IN ('carry','expire','cap')),
    expires_at TEXT,
    on_exhaustion TEXT NOT NULL DEFAULT 'block'
      CHECK (on_exhaustion IN ('block','warn','overflow')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (denomination = 'money'
        AND amount_cents BETWEEN 0 AND ${centsLimit}
        AND seconds IS NULL
        AND locked_rate_cents IS NULL
        AND rate_locked_at IS NULL)
      OR
      (denomination = 'hours'
        AND amount_cents IS NULL
        AND seconds BETWEEN 0 AND ${safeIntegerLimit}
        AND ((locked_rate_cents IS NULL AND rate_locked_at IS NULL)
          OR (locked_rate_cents BETWEEN 0 AND ${centsLimit} AND rate_locked_at IS NOT NULL)))
    ),
    CHECK (expires_at IS NULL OR date(expires_at) IS expires_at),
    CHECK (rate_locked_at IS NULL OR (${canonicalTimestamp('rate_locked_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX retainers_client_id ON retainers(client_id)`,
  `CREATE INDEX retainers_project_id ON retainers(project_id)`,
  `CREATE TRIGGER retainers_reject_identity_collision
    BEFORE INSERT ON retainers
    WHEN EXISTS (SELECT 1 FROM retainers existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM retainers existing WHERE existing.harvest_id = NEW.harvest_id
      ))
    BEGIN SELECT RAISE(ABORT, 'retainer identity already exists'); END`,
  `CREATE TRIGGER retainers_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id ON retainers
    WHEN EXISTS (
      SELECT 1 FROM retainers existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM retainers existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    ))
    BEGIN SELECT RAISE(ABORT, 'retainer identity belongs to another row'); END`,
  `CREATE TRIGGER retainers_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON retainers
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'retainer Harvest identity is immutable'); END`,
  `CREATE TRIGGER retainers_project_client_insert
    BEFORE INSERT ON retainers
    WHEN NEW.project_id IS NOT NULL AND NEW.client_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects WHERE id = NEW.project_id AND client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'retainer project must belong to retainer client'); END`,
  `CREATE TRIGGER retainers_project_client_update
    BEFORE UPDATE OF project_id, client_id ON retainers
    WHEN NEW.project_id IS NOT NULL AND NEW.client_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM projects WHERE id = NEW.project_id AND client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'retainer project must belong to retainer client'); END`,
  `CREATE TRIGGER projects_client_consistent_with_retainers_update
    BEFORE UPDATE OF client_id ON projects
    WHEN OLD.client_id IS NOT NEW.client_id AND EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.project_id = OLD.id
        AND retainer.client_id IS NOT NULL
        AND retainer.client_id IS NOT NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'project client must match every linked retainer'); END`,
  `ALTER TABLE invoices ADD COLUMN retainer_id INTEGER
    REFERENCES retainers(id) ON DELETE RESTRICT`,
  `CREATE INDEX invoices_retainer_id ON invoices(retainer_id)`,
  `CREATE TRIGGER invoices_retainer_client_insert
    BEFORE INSERT ON invoices
    WHEN NEW.retainer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.retainer_id
        AND (retainer.client_id IS NULL OR retainer.client_id = NEW.client_id)
    )
    BEGIN SELECT RAISE(ABORT, 'invoice retainer must belong to invoice client'); END`,
  `CREATE TRIGGER invoices_retainer_client_update
    BEFORE UPDATE OF retainer_id, client_id ON invoices
    WHEN NEW.retainer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.retainer_id
        AND (retainer.client_id IS NULL OR retainer.client_id = NEW.client_id)
    )
    BEGIN SELECT RAISE(ABORT, 'invoice retainer must belong to invoice client'); END`,
  `CREATE TRIGGER retainers_linked_invoice_client_update
    BEFORE UPDATE OF client_id ON retainers
    WHEN EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.retainer_id = OLD.id
        AND NEW.client_id IS NOT NULL
        AND invoice.client_id <> NEW.client_id
    ) OR EXISTS (
      SELECT 1 FROM retainer_ledger entry
      JOIN invoices invoice ON invoice.id = entry.invoice_id
      WHERE entry.retainer_id = OLD.id
        AND NEW.client_id IS NOT NULL
        AND invoice.client_id <> NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'retainer client must match every linked invoice'); END`,
  `CREATE TABLE retainer_ledger (
    id TEXT PRIMARY KEY CHECK (
      length(id) BETWEEN 1 AND 128
      AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    retainer_id INTEGER NOT NULL REFERENCES retainers(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL
      CHECK (kind IN ('deposit','drawdown','expiry','reset','adjustment')),
    unit TEXT NOT NULL CHECK (unit IN ('cents','seconds')),
    amount INTEGER NOT NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
    occurred_on TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    CHECK (
      (unit = 'cents' AND amount BETWEEN -${centsLimit} AND ${centsLimit})
      OR (unit = 'seconds' AND amount BETWEEN -${safeIntegerLimit} AND ${safeIntegerLimit})
    ),
    CHECK (amount <> 0),
    CHECK (
      (kind = 'deposit' AND amount > 0)
      OR (kind IN ('drawdown','expiry') AND amount < 0)
      OR kind IN ('reset','adjustment')
    ),
    CHECK (kind <> 'adjustment' OR (notes IS NOT NULL AND length(trim(notes)) > 0)),
    CHECK (kind NOT IN ('deposit','drawdown') OR invoice_id IS NOT NULL),
    CHECK (date(occurred_on) IS occurred_on),
    CHECK (${canonicalTimestamp('created_at')})
  ) STRICT`,
  `CREATE TRIGGER retainer_ledger_reject_identity_collision
    BEFORE INSERT ON retainer_ledger
    WHEN EXISTS (SELECT 1 FROM retainer_ledger existing WHERE existing.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'retainer ledger identity already exists'); END`,
  `CREATE TRIGGER invoices_retainer_with_ledger_immutable
    BEFORE UPDATE OF retainer_id ON invoices
    WHEN OLD.retainer_id IS NOT NEW.retainer_id
      AND EXISTS (SELECT 1 FROM retainer_ledger entry WHERE entry.invoice_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'invoice retainer is immutable after a linked ledger entry'); END`,
  `CREATE INDEX retainer_ledger_retainer_occurred_id
    ON retainer_ledger(retainer_id, occurred_on, id)`,
  `CREATE INDEX retainer_ledger_invoice_id ON retainer_ledger(invoice_id)`,
  `CREATE TRIGGER retainer_ledger_unit_guard
    BEFORE INSERT ON retainer_ledger
    WHEN NOT EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.retainer_id
        AND ((retainer.denomination = 'money' AND NEW.unit = 'cents')
          OR (retainer.denomination = 'hours' AND NEW.unit = 'seconds'))
    )
    BEGIN SELECT RAISE(ABORT, 'retainer ledger unit must match parent denomination'); END`,
  `CREATE TRIGGER retainer_ledger_invoice_client_guard
    BEFORE INSERT ON retainer_ledger
    WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM retainers retainer
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE retainer.id = NEW.retainer_id
        AND invoice.retainer_id = NEW.retainer_id
        AND (retainer.client_id IS NULL OR retainer.client_id = invoice.client_id)
    )
    BEGIN SELECT RAISE(ABORT, 'retainer ledger invoice must link the same retainer and client'); END`,
  `CREATE TRIGGER retainer_ledger_balance_guard
    BEFORE INSERT ON retainer_ledger
    WHEN EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.retainer_id
        AND (
          (retainer.on_exhaustion <> 'overflow' AND
            COALESCE((SELECT SUM(entry.amount) FROM retainer_ledger entry
              WHERE entry.retainer_id = NEW.retainer_id), 0) + NEW.amount < 0)
          OR (NEW.unit = 'cents' AND
            COALESCE((SELECT SUM(entry.amount) FROM retainer_ledger entry
              WHERE entry.retainer_id = NEW.retainer_id), 0) + NEW.amount
              NOT BETWEEN -${centsLimit} AND ${centsLimit})
          OR (NEW.unit = 'seconds' AND
            COALESCE((SELECT SUM(entry.amount) FROM retainer_ledger entry
              WHERE entry.retainer_id = NEW.retainer_id), 0) + NEW.amount
              NOT BETWEEN -${safeIntegerLimit} AND ${safeIntegerLimit})
        )
    )
    BEGIN SELECT RAISE(ABORT, 'retainer balance cannot overdraw or exceed its unit bound'); END`,
  `CREATE TRIGGER retainer_ledger_append_only_update
    BEFORE UPDATE ON retainer_ledger
    BEGIN SELECT RAISE(ABORT, 'retainer ledger is append-only'); END`,
  `CREATE TRIGGER retainer_ledger_append_only_delete
    BEFORE DELETE ON retainer_ledger
    BEGIN SELECT RAISE(ABORT, 'retainer ledger is append-only'); END`,
  `CREATE TRIGGER retainers_denomination_with_ledger_immutable
    BEFORE UPDATE OF denomination ON retainers
    WHEN OLD.denomination IS NOT NEW.denomination
      AND EXISTS (SELECT 1 FROM retainer_ledger WHERE retainer_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'retainer denomination is immutable after its first ledger entry'); END`,
  `CREATE TRIGGER retainers_exhaustion_policy_balance_guard
    BEFORE UPDATE OF on_exhaustion ON retainers
    WHEN NEW.on_exhaustion <> 'overflow'
      AND COALESCE((SELECT SUM(amount) FROM retainer_ledger WHERE retainer_id = OLD.id), 0) < 0
    BEGIN SELECT RAISE(ABORT, 'negative retainer balance requires overflow policy'); END`,
  `CREATE VIEW retainer_balances AS
    SELECT retainer.id AS retainer_id, retainer.denomination,
      COALESCE(SUM(entry.amount), 0) AS balance
    FROM retainers retainer
    LEFT JOIN retainer_ledger entry ON entry.retainer_id = retainer.id
    GROUP BY retainer.id, retainer.denomination`,
] as const
