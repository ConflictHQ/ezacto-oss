// Provenance: ezacto-oss #15; D22 stable command identity; reviewer hardening pass.
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

export const resourceCreateCommandsMigration = [
  `CREATE TABLE resource_create_commands (
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'retainer.create', 'recurring_invoice.create',
      'invoice_attachment.create', 'recurring_invoice_attachment.create',
      'estimate_attachment.create', 'expense_attachment.create', 'project_attachment.create'
    )),
    command_id TEXT NOT NULL CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    resource_id INTEGER NOT NULL CHECK (resource_id BETWEEN 1 AND 9007199254740991),
    result_json TEXT NOT NULL CHECK (
      json_valid(result_json)
      AND json_extract(result_json, '$.schema_version') = 1
      AND json_type(result_json, '$.data') = 'object'
    ),
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')}),
    PRIMARY KEY (command_kind, command_id),
    UNIQUE (command_kind, resource_id)
  ) STRICT`,
  `CREATE TRIGGER resource_create_commands_reject_identity_collision
    BEFORE INSERT ON resource_create_commands
    WHEN EXISTS (
      SELECT 1 FROM resource_create_commands existing
      WHERE existing.command_kind = NEW.command_kind AND existing.command_id = NEW.command_id
    ) OR EXISTS (
      SELECT 1 FROM resource_create_commands existing
      WHERE existing.command_kind = NEW.command_kind AND existing.resource_id = NEW.resource_id
    )
    BEGIN SELECT RAISE(ABORT, 'resource create command identity already exists'); END`,
  `CREATE TRIGGER resource_create_commands_require_resource
    BEFORE INSERT ON resource_create_commands
    WHEN CASE NEW.command_kind
      WHEN 'retainer.create' THEN NOT EXISTS (SELECT 1 FROM retainers WHERE id = NEW.resource_id)
      WHEN 'recurring_invoice.create' THEN
        NOT EXISTS (SELECT 1 FROM recurring_invoices WHERE id = NEW.resource_id)
      WHEN 'invoice_attachment.create' THEN NOT EXISTS (
        SELECT 1 FROM invoice_attachments WHERE attachment_id = NEW.resource_id
      )
      WHEN 'recurring_invoice_attachment.create' THEN NOT EXISTS (
        SELECT 1 FROM recurring_invoice_attachments WHERE attachment_id = NEW.resource_id
      )
      WHEN 'estimate_attachment.create' THEN NOT EXISTS (
        SELECT 1 FROM estimate_attachments WHERE attachment_id = NEW.resource_id
      )
      WHEN 'expense_attachment.create' THEN NOT EXISTS (
        SELECT 1 FROM expense_attachments WHERE attachment_id = NEW.resource_id
      )
      WHEN 'project_attachment.create' THEN NOT EXISTS (
        SELECT 1 FROM project_attachments WHERE attachment_id = NEW.resource_id
      )
    END
    BEGIN SELECT RAISE(ABORT, 'resource create receipt requires its resource'); END`,
  `CREATE TRIGGER resource_create_commands_reject_update
    BEFORE UPDATE ON resource_create_commands
    BEGIN SELECT RAISE(ABORT, 'resource create receipts are immutable'); END`,
  `CREATE TRIGGER resource_create_commands_reject_delete
    BEFORE DELETE ON resource_create_commands
    BEGIN SELECT RAISE(ABORT, 'resource create receipts are append-only'); END`,
  `CREATE TRIGGER invoices_reject_invalid_date_order_update
    BEFORE UPDATE OF issue_date, due_date ON invoices
    WHEN NEW.due_date < NEW.issue_date
    BEGIN SELECT RAISE(ABORT, 'invoice due date cannot precede issue date'); END`,
] as const
