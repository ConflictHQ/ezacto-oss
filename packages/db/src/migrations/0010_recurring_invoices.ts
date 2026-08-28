const centsLimit = 9_000_000_000_000
const safeIntegerLimit = 9_007_199_254_740_991
const whitespaceCharacters = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
  8201, 8202, 8232, 8233, 8239, 8287, 12_288, 65_279,
]
  .map((codePoint) => `char(${codePoint})`)
  .join(' || ')

const nonBlankText = (value: string) => `length(trim(${value}, ${whitespaceCharacters})) > 0`

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

const fixedLinesValid = `json_type(NEW.amount_config, '$.schema_version') = 'integer'
      AND json_extract(NEW.amount_config, '$.schema_version') = 1
      AND json_type(NEW.amount_config, '$.type') = 'text'
      AND json_extract(NEW.amount_config, '$.type') = 'fixed_lines'
      AND (SELECT count(*) FROM json_each(NEW.amount_config)) = 3
      AND (SELECT count(*) FROM json_each(NEW.amount_config)) =
        (SELECT count(DISTINCT key) FROM json_each(NEW.amount_config))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.amount_config)
        WHERE key NOT IN ('schema_version','type','line_items')
      )
      AND json_type(NEW.amount_config, '$.line_items') = 'array'
      AND json_array_length(NEW.amount_config, '$.line_items') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.amount_config, '$.line_items') line
        WHERE json_type(line.value) IS NOT 'object'
          OR (SELECT count(*) FROM json_each(line.value)) <> 7
          OR (SELECT count(*) FROM json_each(line.value)) <>
            (SELECT count(DISTINCT key) FROM json_each(line.value))
          OR EXISTS (
            SELECT 1 FROM json_each(line.value)
            WHERE key NOT IN (
              'kind','description','quantity','unit_price_cents','taxed','taxed2','project_id'
            )
          )
          OR json_type(line.value, '$.kind') IS NOT 'text'
          OR NOT (${nonBlankText("json_extract(line.value, '$.kind')")})
          OR (
            json_type(line.value, '$.description') IS NOT 'text'
            AND json_type(line.value, '$.description') IS NOT 'null'
          )
          OR (
            json_type(line.value, '$.quantity') IS NOT 'integer'
            AND json_type(line.value, '$.quantity') IS NOT 'real'
          )
          OR json_extract(line.value, '$.quantity') <= 0
          OR json_extract(line.value, '$.quantity') > ${safeIntegerLimit}
          OR json_type(line.value, '$.unit_price_cents') IS NOT 'integer'
          OR json_extract(line.value, '$.unit_price_cents')
            NOT BETWEEN -${centsLimit} AND ${centsLimit}
          OR (
            json_type(line.value, '$.taxed') IS NOT 'true'
            AND json_type(line.value, '$.taxed') IS NOT 'false'
          )
          OR (
            json_type(line.value, '$.taxed2') IS NOT 'true'
            AND json_type(line.value, '$.taxed2') IS NOT 'false'
          )
          OR (
            json_type(line.value, '$.project_id') IS NOT 'null'
            AND NOT (
              json_type(line.value, '$.project_id') = 'integer'
              AND json_extract(line.value, '$.project_id')
                BETWEEN 1 AND ${safeIntegerLimit}
            )
          )
      )`

const importConfigValid = `json_type(NEW.amount_config, '$.schema_version') = 'integer'
      AND json_extract(NEW.amount_config, '$.schema_version') = 1
      AND json_type(NEW.amount_config, '$.type') = 'text'
      AND json_extract(NEW.amount_config, '$.type') = 'line_items_import'
      AND (SELECT count(*) FROM json_each(NEW.amount_config)) BETWEEN 4 AND 5
      AND (SELECT count(*) FROM json_each(NEW.amount_config)) =
        (SELECT count(DISTINCT key) FROM json_each(NEW.amount_config))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.amount_config)
        WHERE key NOT IN ('schema_version','type','project_ids','time','expenses')
      )
      AND json_type(NEW.amount_config, '$.project_ids') = 'array'
      AND json_array_length(NEW.amount_config, '$.project_ids') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.amount_config, '$.project_ids') project
        WHERE project.type <> 'integer'
          OR project.value NOT BETWEEN 1 AND ${safeIntegerLimit}
      )
      AND (
        SELECT count(*) FROM json_each(NEW.amount_config, '$.project_ids')
      ) = (
        SELECT count(DISTINCT value) FROM json_each(NEW.amount_config, '$.project_ids')
      )
      AND (
        json_type(NEW.amount_config, '$.time') = 'object'
        OR json_type(NEW.amount_config, '$.expenses') = 'object'
      )
      AND (
        json_type(NEW.amount_config, '$.time') IS NULL
        OR (
          json_type(NEW.amount_config, '$.time') = 'object'
          AND (SELECT count(*) FROM json_each(NEW.amount_config, '$.time')) = 1
          AND (SELECT count(*) FROM json_each(NEW.amount_config, '$.time')) =
            (SELECT count(DISTINCT key) FROM json_each(NEW.amount_config, '$.time'))
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.amount_config, '$.time')
            WHERE key <> 'summary_type'
          )
          AND json_extract(NEW.amount_config, '$.time.summary_type')
            IN ('project','task','people','detailed')
        )
      )
      AND (
        json_type(NEW.amount_config, '$.expenses') IS NULL
        OR (
          json_type(NEW.amount_config, '$.expenses') = 'object'
          AND (SELECT count(*) FROM json_each(NEW.amount_config, '$.expenses')) = 1
          AND (SELECT count(*) FROM json_each(NEW.amount_config, '$.expenses')) =
            (SELECT count(DISTINCT key) FROM json_each(NEW.amount_config, '$.expenses'))
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.amount_config, '$.expenses')
            WHERE key <> 'summary_type'
          )
          AND json_extract(NEW.amount_config, '$.expenses.summary_type')
            IN ('project','category','people','detailed')
        )
      )`

const amountConfigTrigger = (operation: 'INSERT' | 'UPDATE') => `CREATE TRIGGER
    recurring_invoices_amount_config_${operation.toLowerCase()}
    BEFORE ${operation} ON recurring_invoices
    WHEN NEW.definition_status = 'complete' AND NOT CASE
      WHEN json_valid(NEW.amount_config) AND json_type(NEW.amount_config) = 'object'
      THEN coalesce(((${fixedLinesValid}) OR (${importConfigValid})), 0)
      ELSE 0
    END
    BEGIN SELECT RAISE(ABORT, 'recurring invoice amount config is invalid'); END`

const amountProjectReferencesTrigger = (operation: 'INSERT' | 'UPDATE') => `CREATE TRIGGER
    recurring_invoices_amount_projects_${operation.toLowerCase()}
    BEFORE ${operation} ON recurring_invoices
    WHEN NEW.definition_status = 'complete' AND CASE
      WHEN json_valid(NEW.amount_config) AND json_type(NEW.amount_config) = 'object'
      THEN coalesce(
        (json_extract(NEW.amount_config, '$.type') = 'fixed_lines' AND EXISTS (
          SELECT 1
          FROM json_each(NEW.amount_config, '$.line_items') line
          LEFT JOIN projects project
            ON project.id = json_extract(line.value, '$.project_id')
          WHERE json_type(line.value, '$.project_id') IS NOT 'null'
            AND (project.id IS NULL OR project.client_id IS NOT NEW.client_id)
        ))
        OR
        (json_extract(NEW.amount_config, '$.type') = 'line_items_import' AND EXISTS (
          SELECT 1
          FROM json_each(NEW.amount_config, '$.project_ids') configured_project
          LEFT JOIN projects project ON project.id = configured_project.value
          WHERE project.id IS NULL OR project.client_id IS NOT NEW.client_id
        )),
        0
      )
      ELSE 0
    END
    BEGIN
      SELECT RAISE(ABORT, 'recurring invoice projects must exist and belong to its client');
    END`

export const recurringInvoicesMigration = [
  `CREATE TABLE recurring_invoices (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE
      CHECK (harvest_id IS NULL OR harvest_id BETWEEN 1 AND ${safeIntegerLimit}),
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    definition_status TEXT NOT NULL DEFAULT 'complete'
      CHECK (definition_status IN ('complete','incomplete')),
    subject_template TEXT,
    notes_template TEXT,
    every_n_months INTEGER,
    day_of_month INTEGER,
    next_issue_on TEXT,
    amount_config TEXT,
    can_draw_from_retainer_id INTEGER REFERENCES retainers(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (definition_status = 'complete'
        AND subject_template IS NOT NULL
        AND ${nonBlankText('subject_template')}
        AND notes_template IS NOT NULL
        AND every_n_months BETWEEN 1 AND ${safeIntegerLimit}
        AND day_of_month BETWEEN 1 AND 31
        AND next_issue_on IS NOT NULL
        AND date(next_issue_on, '+0 days') IS next_issue_on
        AND amount_config IS NOT NULL
        AND json_valid(amount_config)
        AND json_type(amount_config) = 'object')
      OR
      (definition_status = 'incomplete'
        AND harvest_id IS NOT NULL
        AND subject_template IS NULL
        AND notes_template IS NULL
        AND every_n_months IS NULL
        AND day_of_month IS NULL
        AND next_issue_on IS NULL
        AND amount_config IS NULL
        AND can_draw_from_retainer_id IS NULL)
    ),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX recurring_invoices_client_id ON recurring_invoices(client_id)`,
  `CREATE INDEX recurring_invoices_retainer_id
    ON recurring_invoices(can_draw_from_retainer_id)
    WHERE can_draw_from_retainer_id IS NOT NULL`,
  `CREATE TRIGGER recurring_invoices_reject_identity_collision
    BEFORE INSERT ON recurring_invoices
    WHEN EXISTS (SELECT 1 FROM recurring_invoices existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM recurring_invoices existing WHERE existing.harvest_id = NEW.harvest_id
      ))
    BEGIN SELECT RAISE(ABORT, 'recurring invoice identity already exists'); END`,
  `CREATE TRIGGER recurring_invoices_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id ON recurring_invoices
    WHEN EXISTS (
      SELECT 1 FROM recurring_invoices existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM recurring_invoices existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    ))
    BEGIN SELECT RAISE(ABORT, 'recurring invoice identity belongs to another row'); END`,
  `CREATE TRIGGER recurring_invoices_harvest_id_immutable
    BEFORE UPDATE OF harvest_id ON recurring_invoices
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'recurring invoice Harvest identity is immutable'); END`,
  `CREATE TRIGGER recurring_invoices_completeness_one_way
    BEFORE UPDATE OF definition_status ON recurring_invoices
    WHEN OLD.definition_status = 'complete' AND NEW.definition_status = 'incomplete'
    BEGIN SELECT RAISE(ABORT, 'complete recurring invoice cannot become incomplete'); END`,
  amountConfigTrigger('INSERT'),
  amountConfigTrigger('UPDATE'),
  amountProjectReferencesTrigger('INSERT'),
  amountProjectReferencesTrigger('UPDATE'),
  `CREATE TRIGGER recurring_invoices_retainer_client_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.can_draw_from_retainer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.can_draw_from_retainer_id
        AND retainer.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'recurring invoice retainer must belong to its client'); END`,
  `CREATE TRIGGER recurring_invoices_retainer_client_update
    BEFORE UPDATE OF can_draw_from_retainer_id, client_id ON recurring_invoices
    WHEN NEW.can_draw_from_retainer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM retainers retainer
      WHERE retainer.id = NEW.can_draw_from_retainer_id
        AND retainer.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'recurring invoice retainer must belong to its client'); END`,
  `CREATE TRIGGER retainers_recurring_invoice_client_update
    BEFORE UPDATE OF client_id ON retainers
    WHEN EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.can_draw_from_retainer_id = OLD.id
        AND recurring.client_id IS NOT NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'retainer client must match every recurring invoice'); END`,
  `CREATE TRIGGER projects_recurring_invoice_client_insert
    BEFORE INSERT ON projects
    WHEN EXISTS (
      SELECT 1 FROM projects existing
      WHERE (
        existing.id = NEW.id
        OR (NEW.harvest_id IS NOT NULL AND existing.harvest_id = NEW.harvest_id)
      )
        AND EXISTS (
          SELECT 1 FROM recurring_invoices recurring
          WHERE recurring.definition_status = 'complete'
            AND (
              (json_extract(recurring.amount_config, '$.type') = 'fixed_lines' AND EXISTS (
                SELECT 1 FROM json_each(recurring.amount_config, '$.line_items') line
                WHERE json_extract(line.value, '$.project_id') = existing.id
              ))
              OR
              (json_extract(recurring.amount_config, '$.type') = 'line_items_import' AND EXISTS (
                SELECT 1
                FROM json_each(recurring.amount_config, '$.project_ids') configured_project
                WHERE configured_project.value = existing.id
              ))
            )
            AND (existing.id IS NOT NEW.id OR recurring.client_id IS NOT NEW.client_id)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'project replacement must preserve recurring invoice references');
    END`,
  `CREATE TRIGGER projects_recurring_invoice_client_update
    BEFORE UPDATE OF id, client_id ON projects
    WHEN (OLD.id IS NOT NEW.id OR OLD.client_id IS NOT NEW.client_id) AND EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.definition_status = 'complete'
        AND (OLD.id IS NOT NEW.id OR recurring.client_id IS NOT NEW.client_id)
        AND (
          (json_extract(recurring.amount_config, '$.type') = 'fixed_lines' AND EXISTS (
            SELECT 1 FROM json_each(recurring.amount_config, '$.line_items') line
            WHERE json_extract(line.value, '$.project_id') = OLD.id
          ))
          OR
          (json_extract(recurring.amount_config, '$.type') = 'line_items_import' AND EXISTS (
            SELECT 1 FROM json_each(recurring.amount_config, '$.project_ids') configured_project
            WHERE configured_project.value = OLD.id
          ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'project client must match every recurring invoice definition');
    END`,
  `CREATE TRIGGER projects_recurring_invoice_delete
    BEFORE DELETE ON projects
    WHEN EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.definition_status = 'complete'
        AND (
          (json_extract(recurring.amount_config, '$.type') = 'fixed_lines' AND EXISTS (
            SELECT 1 FROM json_each(recurring.amount_config, '$.line_items') line
            WHERE json_extract(line.value, '$.project_id') = OLD.id
          ))
          OR
          (json_extract(recurring.amount_config, '$.type') = 'line_items_import' AND EXISTS (
            SELECT 1 FROM json_each(recurring.amount_config, '$.project_ids') configured_project
            WHERE configured_project.value = OLD.id
          ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'project is referenced by a recurring invoice definition'); END`,
  `ALTER TABLE invoices ADD COLUMN recurring_invoice_id INTEGER
    REFERENCES recurring_invoices(id) ON DELETE RESTRICT`,
  `CREATE INDEX invoices_recurring_invoice_id ON invoices(recurring_invoice_id)`,
  `CREATE TRIGGER invoices_recurring_invoice_client_insert
    BEFORE INSERT ON invoices
    WHEN NEW.recurring_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.id = NEW.recurring_invoice_id
        AND recurring.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice recurring definition must belong to invoice client'); END`,
  `CREATE TRIGGER invoices_recurring_invoice_client_update
    BEFORE UPDATE OF recurring_invoice_id, client_id ON invoices
    WHEN NEW.recurring_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.id = NEW.recurring_invoice_id
        AND recurring.client_id = NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice recurring definition must belong to invoice client'); END`,
  `CREATE TRIGGER recurring_invoices_linked_invoice_client_update
    BEFORE UPDATE OF client_id ON recurring_invoices
    WHEN EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.recurring_invoice_id = OLD.id
        AND invoice.client_id IS NOT NEW.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'recurring invoice client must match every linked invoice'); END`,
  `CREATE TRIGGER invoices_recurring_invoice_provenance_update
    BEFORE UPDATE OF recurring_invoice_id ON invoices
    WHEN OLD.recurring_invoice_id IS NOT NEW.recurring_invoice_id
      AND (
        OLD.version <> 0
        OR EXISTS (
          SELECT 1 FROM invoice_command_ledger command WHERE command.invoice_id = OLD.id
        )
      )
    BEGIN SELECT RAISE(ABORT, 'invoice recurring provenance is immutable after commands'); END`,
] as const
