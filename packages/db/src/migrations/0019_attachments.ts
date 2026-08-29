// Provenance: ezacto-oss #122; domain model §2.13; F4; D17;
// migration spec §4; DV-16. Binary placement remains owned by D17.
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

const staticPolicyValid = `json_type(NEW.attachment_policy, '$.schema_version') = 'integer'
      AND json_extract(NEW.attachment_policy, '$.schema_version') = 1
      AND json_type(NEW.attachment_policy, '$.type') = 'text'
      AND json_extract(NEW.attachment_policy, '$.type') = 'static'
      AND (SELECT count(*) FROM json_each(NEW.attachment_policy)) = 3
      AND (SELECT count(*) FROM json_each(NEW.attachment_policy)) =
        (SELECT count(DISTINCT key) FROM json_each(NEW.attachment_policy))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.attachment_policy)
        WHERE key NOT IN ('schema_version','type','attachment_ids')
      )
      AND json_type(NEW.attachment_policy, '$.attachment_ids') = 'array'
      AND json_array_length(NEW.attachment_policy, '$.attachment_ids') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.attachment_policy, '$.attachment_ids') configured
        WHERE configured.type <> 'integer'
          OR configured.value NOT BETWEEN 1 AND ${safeIntegerLimit}
      )
      AND (
        SELECT count(*)
        FROM json_each(NEW.attachment_policy, '$.attachment_ids')
      ) = (
        SELECT count(DISTINCT value)
        FROM json_each(NEW.attachment_policy, '$.attachment_ids')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.attachment_policy, '$.attachment_ids') configured
        LEFT JOIN recurring_invoice_attachments owned
          ON owned.attachment_id = configured.value
          AND owned.recurring_invoice_id = NEW.id
        WHERE owned.attachment_id IS NULL
      )`

const attachmentOwnerLink = (
  table: string,
  parentColumn: string,
  parentTable: string,
  guardColumn: string,
) =>
  [
    `CREATE TABLE ${table} (
    attachment_id INTEGER PRIMARY KEY
      REFERENCES attachments(id) ON DELETE CASCADE,
    ${parentColumn} INTEGER NOT NULL
      REFERENCES ${parentTable}(id) ON DELETE RESTRICT
  ) STRICT`,
    `CREATE INDEX ${table}_${parentColumn}
    ON ${table}(${parentColumn}, attachment_id)`,
    `CREATE TRIGGER ${table}_owner_guard_insert
    BEFORE INSERT ON ${table}
    WHEN NOT EXISTS (
      SELECT 1 FROM attachments attachment
      WHERE attachment.id = NEW.attachment_id
        AND attachment.${guardColumn} = NEW.attachment_id
    )
    BEGIN SELECT RAISE(ABORT, '${table} does not match the attachment owner guard'); END`,
    `CREATE TRIGGER ${table}_reject_identity_collision
    BEFORE INSERT ON ${table}
    WHEN EXISTS (
      SELECT 1 FROM ${table} existing WHERE existing.attachment_id = NEW.attachment_id
    )
    BEGIN SELECT RAISE(ABORT, '${table} attachment identity already exists'); END`,
    `CREATE TRIGGER ${table}_owner_immutable
    BEFORE UPDATE OF attachment_id, ${parentColumn} ON ${table}
    WHEN OLD.attachment_id IS NOT NEW.attachment_id
      OR OLD.${parentColumn} IS NOT NEW.${parentColumn}
    BEGIN SELECT RAISE(ABORT, '${table} ownership is immutable'); END`,
  ] as const

const ownerLinks = [
  ...attachmentOwnerLink(
    'invoice_attachments',
    'invoice_id',
    'invoices',
    'invoice_attachment_link_id',
  ),
  ...attachmentOwnerLink(
    'recurring_invoice_attachments',
    'recurring_invoice_id',
    'recurring_invoices',
    'recurring_invoice_attachment_link_id',
  ),
  ...attachmentOwnerLink(
    'estimate_attachments',
    'estimate_id',
    'estimates',
    'estimate_attachment_link_id',
  ),
  ...attachmentOwnerLink(
    'expense_attachments',
    'expense_id',
    'expenses',
    'expense_attachment_link_id',
  ),
  ...attachmentOwnerLink(
    'project_attachments',
    'project_id',
    'projects',
    'project_attachment_link_id',
  ),
] as const

export const attachmentsMigration = [
  `CREATE TABLE file_objects (
    id INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE CHECK (
      length(content_hash) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    file_key TEXT NOT NULL UNIQUE CHECK (
      length(file_key) BETWEEN 1 AND 1024
      AND length(trim(file_key)) > 0
    ),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND ${safeIntegerLimit}),
    content_type TEXT NOT NULL CHECK (
      length(content_type) BETWEEN 1 AND 255
      AND length(trim(content_type)) > 0
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    file_object_id INTEGER NOT NULL
      REFERENCES file_objects(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (
      length(name) BETWEEN 1 AND 255
      AND length(trim(name)) > 0
    ),
    uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    invoice_attachment_link_id INTEGER UNIQUE,
    recurring_invoice_attachment_link_id INTEGER UNIQUE,
    estimate_attachment_link_id INTEGER UNIQUE,
    expense_attachment_link_id INTEGER UNIQUE,
    project_attachment_link_id INTEGER UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (invoice_attachment_link_id IS NOT NULL)
      + (recurring_invoice_attachment_link_id IS NOT NULL)
      + (estimate_attachment_link_id IS NOT NULL)
      + (expense_attachment_link_id IS NOT NULL)
      + (project_attachment_link_id IS NOT NULL) = 1
    ),
    CHECK (invoice_attachment_link_id IS NULL OR invoice_attachment_link_id = id),
    CHECK (
      recurring_invoice_attachment_link_id IS NULL
      OR recurring_invoice_attachment_link_id = id
    ),
    CHECK (estimate_attachment_link_id IS NULL OR estimate_attachment_link_id = id),
    CHECK (expense_attachment_link_id IS NULL OR expense_attachment_link_id = id),
    CHECK (project_attachment_link_id IS NULL OR project_attachment_link_id = id),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    FOREIGN KEY (invoice_attachment_link_id)
      REFERENCES invoice_attachments(attachment_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (recurring_invoice_attachment_link_id)
      REFERENCES recurring_invoice_attachments(attachment_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (estimate_attachment_link_id)
      REFERENCES estimate_attachments(attachment_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (expense_attachment_link_id)
      REFERENCES expense_attachments(attachment_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (project_attachment_link_id)
      REFERENCES project_attachments(attachment_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE INDEX attachments_file_object_id ON attachments(file_object_id)`,
  `CREATE INDEX attachments_uploaded_by_user_id
    ON attachments(uploaded_by_user_id)
    WHERE uploaded_by_user_id IS NOT NULL`,
  ...ownerLinks,
  `CREATE TRIGGER file_objects_reject_identity_collision
    BEFORE INSERT ON file_objects
    WHEN EXISTS (
      SELECT 1 FROM file_objects existing
      WHERE existing.id = NEW.id
        OR existing.content_hash = NEW.content_hash
        OR existing.file_key = NEW.file_key
    )
    BEGIN SELECT RAISE(ABORT, 'file object identity already exists'); END`,
  `CREATE TRIGGER file_objects_content_identity_immutable
    BEFORE UPDATE OF content_hash, file_key, byte_size, content_type ON file_objects
    WHEN OLD.content_hash IS NOT NEW.content_hash
      OR OLD.file_key IS NOT NEW.file_key
      OR OLD.byte_size IS NOT NEW.byte_size
      OR OLD.content_type IS NOT NEW.content_type
    BEGIN SELECT RAISE(ABORT, 'file object content identity is immutable'); END`,
  `CREATE TRIGGER attachments_reject_identity_collision
    BEFORE INSERT ON attachments
    WHEN EXISTS (SELECT 1 FROM attachments existing WHERE existing.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'attachment identity already exists'); END`,
  `CREATE TRIGGER attachments_identity_and_owner_immutable
    BEFORE UPDATE OF id, file_object_id,
      invoice_attachment_link_id, recurring_invoice_attachment_link_id,
      estimate_attachment_link_id, expense_attachment_link_id,
      project_attachment_link_id ON attachments
    WHEN OLD.id IS NOT NEW.id
      OR OLD.file_object_id IS NOT NEW.file_object_id
      OR OLD.invoice_attachment_link_id IS NOT NEW.invoice_attachment_link_id
      OR OLD.recurring_invoice_attachment_link_id IS NOT NEW.recurring_invoice_attachment_link_id
      OR OLD.estimate_attachment_link_id IS NOT NEW.estimate_attachment_link_id
      OR OLD.expense_attachment_link_id IS NOT NEW.expense_attachment_link_id
      OR OLD.project_attachment_link_id IS NOT NEW.project_attachment_link_id
    BEGIN SELECT RAISE(ABORT, 'attachment identity and ownership are immutable'); END`,
  `ALTER TABLE recurring_invoices ADD COLUMN attachment_policy TEXT
    CHECK (attachment_policy IS NULL OR json_valid(attachment_policy))`,
  `CREATE TRIGGER recurring_invoices_attachment_policy_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.attachment_policy IS NOT NULL AND NOT CASE
      WHEN NEW.definition_status = 'complete'
        AND json_valid(NEW.attachment_policy)
        AND json_type(NEW.attachment_policy) = 'object'
      THEN coalesce((${staticPolicyValid}), 0)
      ELSE 0
    END
    BEGIN SELECT RAISE(ABORT, 'recurring attachment policy is invalid'); END`,
  `CREATE TRIGGER recurring_invoices_attachment_policy_update
    BEFORE UPDATE OF id, definition_status, attachment_policy ON recurring_invoices
    WHEN NEW.attachment_policy IS NOT NULL AND NOT CASE
      WHEN NEW.definition_status = 'complete'
        AND json_valid(NEW.attachment_policy)
        AND json_type(NEW.attachment_policy) = 'object'
      THEN coalesce((${staticPolicyValid}), 0)
      ELSE 0
    END
    BEGIN SELECT RAISE(ABORT, 'recurring attachment policy is invalid'); END`,
  `CREATE TRIGGER recurring_invoice_attachments_policy_delete
    BEFORE DELETE ON recurring_invoice_attachments
    WHEN EXISTS (
      SELECT 1
      FROM recurring_invoices recurring,
        json_each(recurring.attachment_policy, '$.attachment_ids') configured
      WHERE recurring.id = OLD.recurring_invoice_id
        AND recurring.attachment_policy IS NOT NULL
        AND json_valid(recurring.attachment_policy)
        AND configured.value = OLD.attachment_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'recurring attachment is referenced by its static policy');
    END`,
] as const
