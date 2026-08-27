export const clientsMigration = [
  `CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    address TEXT,
    currency TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    parent_client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
    bill_to_client_id INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
    statement_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(32)))),
    payment_terms TEXT NOT NULL DEFAULT 'custom'
      CHECK (payment_terms IN ('upon_receipt','net_15','net_30','net_45','net_60','custom')),
    default_tax_pct REAL,
    default_tax2_pct REAL,
    default_discount_pct REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX clients_parent_client_id ON clients(parent_client_id)`,
  `CREATE INDEX clients_bill_to_client_id ON clients(bill_to_client_id)`,
  `CREATE TRIGGER clients_parent_cycle_insert BEFORE INSERT ON clients
    WHEN NEW.parent_client_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE descendants(id) AS (
        SELECT NEW.id
        UNION
        SELECT child.id FROM clients child
        JOIN descendants parent ON child.parent_client_id = parent.id
      )
      SELECT 1 FROM descendants WHERE id = NEW.parent_client_id
    )
    BEGIN SELECT RAISE(ABORT, 'client parent cycle'); END`,
  `CREATE TRIGGER clients_parent_cycle_update BEFORE UPDATE OF parent_client_id ON clients
    WHEN NEW.parent_client_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE descendants(id) AS (
        SELECT NEW.id
        UNION
        SELECT child.id FROM clients child
        JOIN descendants parent ON child.parent_client_id = parent.id
      )
      SELECT 1 FROM descendants WHERE id = NEW.parent_client_id
    )
    BEGIN SELECT RAISE(ABORT, 'client parent cycle'); END`,
  `CREATE VIEW client_hierarchy (ancestor_id, descendant_id, depth) AS
    WITH RECURSIVE hierarchy(ancestor_id, descendant_id, depth, visited) AS (
      SELECT id, id, 0, printf(',%d,', id) FROM clients
      UNION ALL
      SELECT hierarchy.ancestor_id, child.id, hierarchy.depth + 1,
        hierarchy.visited || child.id || ','
      FROM hierarchy
      JOIN clients child ON child.parent_client_id = hierarchy.descendant_id
      WHERE instr(hierarchy.visited, printf(',%d,', child.id)) = 0
    )
    SELECT ancestor_id, descendant_id, depth FROM hierarchy`,
  `CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    title TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT,
    email TEXT,
    phone_office TEXT,
    phone_mobile TEXT,
    fax TEXT,
    invoice_recipient_status TEXT NOT NULL DEFAULT 'none'
      CHECK (invoice_recipient_status IN ('none','recipient','cc','bcc')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX contacts_client_id ON contacts(client_id)`,
] as const
