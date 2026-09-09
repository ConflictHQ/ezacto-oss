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

const safeIntegerLimit = 9_007_199_254_740_991

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * JSON1 accepts duplicate object members and `json_extract` returns only one of
 * them. Counting members therefore does not prove a payload has the promised
 * shape: one required member can be omitted and another duplicated. Check every
 * required key exactly once, every optional key at most once, and reject unknown
 * keys before any authority is granted.
 */
const exactObjectKeys = (
  expression: string,
  required: readonly string[],
  optional: readonly string[] = [],
): string => {
  const requiredList = required.map(sqlLiteral).join(',')
  const allowed = [...required, ...optional].map(sqlLiteral).join(',')
  return `json_type(${expression}) = 'object'
    AND (SELECT count(*) FROM json_each(${expression})) =
      (SELECT count(DISTINCT key) FROM json_each(${expression}))
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${expression}) member WHERE member.key NOT IN (${allowed})
    )
    AND (SELECT count(*) FROM json_each(${expression}) member
      WHERE member.key IN (${requiredList})) = ${required.length}`
}

const retainerInputKeys = [
  'version',
  'kind',
  'harvest_retainer_id',
  'snapshot_sha256',
  'context_sha256',
  'balance_cents',
  'occurred_on',
  'notes',
] as const

const recurringInputKeys = [
  'version',
  'kind',
  'harvest_recurring_invoice_id',
  'snapshot_sha256',
  'context_sha256',
  'subject_template',
  'notes_template',
  'every_n_months',
  'day_of_month',
  'next_issue_on',
  'source_amount_config',
  'amount_config',
  'source_can_draw_from_harvest_retainer_id',
  'can_draw_from_retainer_id',
] as const

const fixedConfigKeys = ['schema_version', 'type', 'line_items'] as const
const resolvedFixedLineKeys = [
  'kind',
  'description',
  'quantity',
  'unit_price_cents',
  'taxed',
  'taxed2',
  'project_id',
] as const
const sourceFixedLineKeys = [
  'kind',
  'description',
  'quantity',
  'unit_price_cents',
  'taxed',
  'taxed2',
  'harvest_project_id',
] as const
const importConfigRequiredKeys = ['schema_version', 'type'] as const

const recurringSourceMappingValid = (inputJson: string, clientId: string) => `(
  json_type(${inputJson}, '$.source_can_draw_from_harvest_retainer_id') = 'null'
  AND json_type(${inputJson}, '$.can_draw_from_retainer_id') = 'null'
) OR (
  json_type(${inputJson}, '$.source_can_draw_from_harvest_retainer_id') = 'integer'
  AND json_extract(${inputJson}, '$.source_can_draw_from_harvest_retainer_id')
    BETWEEN 1 AND ${safeIntegerLimit}
  AND json_type(${inputJson}, '$.can_draw_from_retainer_id') = 'integer'
  AND json_extract(${inputJson}, '$.can_draw_from_retainer_id')
    BETWEEN 1 AND ${safeIntegerLimit}
  AND EXISTS (
    SELECT 1 FROM retainers mapped_retainer
    WHERE mapped_retainer.harvest_id = json_extract(
        ${inputJson}, '$.source_can_draw_from_harvest_retainer_id'
      )
      AND mapped_retainer.id = json_extract(${inputJson}, '$.can_draw_from_retainer_id')
      AND mapped_retainer.client_id = ${clientId}
      AND mapped_retainer.denomination = 'money'
  )
)`

/**
 * Parameterised so a later migration can widen the permitted line keys without
 * transcribing this SQL. 0041 added an optional `through` to a stored config;
 * these worksheet-receipt triggers pin the same shape and had to learn it too.
 */
export const recurringFixedShapeValidWith =
  (optionalLineKeys: readonly string[] = []) =>
  (inputJson: string) => `
  ${exactObjectKeys(`json_extract(${inputJson}, '$.source_amount_config')`, fixedConfigKeys)}
  AND ${exactObjectKeys(`json_extract(${inputJson}, '$.amount_config')`, fixedConfigKeys)}
  AND json_extract(${inputJson}, '$.source_amount_config.schema_version') = 1
  AND json_extract(${inputJson}, '$.amount_config.schema_version') = 1
  AND json_extract(${inputJson}, '$.source_amount_config.type') = 'fixed_lines'
  AND json_extract(${inputJson}, '$.amount_config.type') = 'fixed_lines'
  AND json_type(${inputJson}, '$.source_amount_config.line_items') = 'array'
  AND json_type(${inputJson}, '$.amount_config.line_items') = 'array'
  AND json_array_length(${inputJson}, '$.source_amount_config.line_items') > 0
  AND json_array_length(${inputJson}, '$.source_amount_config.line_items')
    = json_array_length(${inputJson}, '$.amount_config.line_items')
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(${inputJson}, '$.source_amount_config.line_items') source_line
    LEFT JOIN json_each(${inputJson}, '$.amount_config.line_items') resolved_line
      ON resolved_line.key = source_line.key
    WHERE NOT coalesce((
      resolved_line.key IS NOT NULL
      AND ${exactObjectKeys('source_line.value', sourceFixedLineKeys, optionalLineKeys)}
      AND ${exactObjectKeys('resolved_line.value', resolvedFixedLineKeys, optionalLineKeys)}
    ), 0)
  )`

/** Same reason as the shape builder: a later migration adds its own clauses. */
export const recurringFixedScalarsValidWith =
  (extraLineClauses = '') =>
  (inputJson: string) => `NOT EXISTS (
  SELECT 1
  FROM json_each(${inputJson}, '$.source_amount_config.line_items') source_line
  LEFT JOIN json_each(${inputJson}, '$.amount_config.line_items') resolved_line
    ON resolved_line.key = source_line.key
  WHERE NOT coalesce((
      json_type(source_line.value, '$.kind') = 'text'
      AND length(trim(json_extract(source_line.value, '$.kind'))) > 0
      AND json_type(source_line.value, '$.description') IN ('text','null')
      AND json_type(source_line.value, '$.quantity') IN ('integer','real')
      AND json_extract(source_line.value, '$.quantity') > 0
      AND json_extract(source_line.value, '$.quantity') <= ${safeIntegerLimit}
      AND json_type(source_line.value, '$.unit_price_cents') = 'integer'
      AND json_extract(source_line.value, '$.unit_price_cents')
        BETWEEN -9000000000000 AND 9000000000000
      AND json_type(source_line.value, '$.taxed') IN ('true','false')
      AND json_type(source_line.value, '$.taxed2') IN ('true','false')
      AND json_extract(source_line.value, '$.kind')
        IS json_extract(resolved_line.value, '$.kind')
      AND json_extract(source_line.value, '$.description')
        IS json_extract(resolved_line.value, '$.description')
      AND json_extract(source_line.value, '$.quantity')
        IS json_extract(resolved_line.value, '$.quantity')
      AND json_extract(source_line.value, '$.unit_price_cents')
        IS json_extract(resolved_line.value, '$.unit_price_cents')
      AND json_extract(source_line.value, '$.taxed')
        IS json_extract(resolved_line.value, '$.taxed')
      AND json_extract(source_line.value, '$.taxed2')
        IS json_extract(resolved_line.value, '$.taxed2')${extraLineClauses}
    ), 0)
  )`

const recurringFixedShapeValid = recurringFixedShapeValidWith()
const recurringFixedScalarsValid = recurringFixedScalarsValidWith()

const recurringFixedProjectsValid = (inputJson: string, clientId: string) => `NOT EXISTS (
  SELECT 1
  FROM json_each(${inputJson}, '$.source_amount_config.line_items') source_line
  LEFT JOIN json_each(${inputJson}, '$.amount_config.line_items') resolved_line
    ON resolved_line.key = source_line.key
  WHERE NOT coalesce((
      (
        (
          json_type(source_line.value, '$.harvest_project_id') = 'null'
          AND json_type(resolved_line.value, '$.project_id') = 'null'
        ) OR (
          json_type(source_line.value, '$.harvest_project_id') = 'integer'
          AND json_extract(source_line.value, '$.harvest_project_id')
            BETWEEN 1 AND ${safeIntegerLimit}
          AND json_type(resolved_line.value, '$.project_id') = 'integer'
          AND json_extract(resolved_line.value, '$.project_id')
            BETWEEN 1 AND ${safeIntegerLimit}
          AND EXISTS (
            SELECT 1 FROM projects mapped_project
            WHERE mapped_project.harvest_id = json_extract(
                source_line.value, '$.harvest_project_id'
              )
              AND mapped_project.id = json_extract(resolved_line.value, '$.project_id')
              AND mapped_project.client_id = ${clientId}
          )
        )
      )
    ), 0)
  )`

const recurringSummaryMappingValid = (
  inputJson: string,
  field: 'time' | 'expenses',
  allowed: readonly string[],
) => `(
  json_type(${inputJson}, '$.source_amount_config.${field}') IS NULL
  AND json_type(${inputJson}, '$.amount_config.${field}') IS NULL
) OR (
  ${exactObjectKeys(`json_extract(${inputJson}, '$.source_amount_config.${field}')`, [
    'summary_type',
  ])}
  AND ${exactObjectKeys(`json_extract(${inputJson}, '$.amount_config.${field}')`, ['summary_type'])}
  AND json_extract(${inputJson}, '$.source_amount_config.${field}.summary_type')
    IS json_extract(${inputJson}, '$.amount_config.${field}.summary_type')
  AND json_extract(${inputJson}, '$.source_amount_config.${field}.summary_type')
    IN (${allowed.map(sqlLiteral).join(',')})
)`

const recurringImportShapeValid = (inputJson: string) => `
  ${exactObjectKeys(
    `json_extract(${inputJson}, '$.source_amount_config')`,
    [...importConfigRequiredKeys, 'harvest_project_ids'],
    ['time', 'expenses'],
  )}
  AND ${exactObjectKeys(
    `json_extract(${inputJson}, '$.amount_config')`,
    [...importConfigRequiredKeys, 'project_ids'],
    ['time', 'expenses'],
  )}
  AND json_extract(${inputJson}, '$.source_amount_config.schema_version') = 1
  AND json_extract(${inputJson}, '$.amount_config.schema_version') = 1
  AND json_extract(${inputJson}, '$.source_amount_config.type') = 'line_items_import'
  AND json_extract(${inputJson}, '$.amount_config.type') = 'line_items_import'
  AND json_type(${inputJson}, '$.source_amount_config.harvest_project_ids') = 'array'
  AND json_type(${inputJson}, '$.amount_config.project_ids') = 'array'
  AND json_array_length(${inputJson}, '$.source_amount_config.harvest_project_ids') > 0
  AND json_array_length(${inputJson}, '$.source_amount_config.harvest_project_ids')
    = json_array_length(${inputJson}, '$.amount_config.project_ids')
  AND (
    SELECT count(*)
    FROM json_each(${inputJson}, '$.source_amount_config.harvest_project_ids')
  ) = (
    SELECT count(DISTINCT value)
    FROM json_each(${inputJson}, '$.source_amount_config.harvest_project_ids')
  )
  AND (
    SELECT count(*) FROM json_each(${inputJson}, '$.amount_config.project_ids')
  ) = (
    SELECT count(DISTINCT value) FROM json_each(${inputJson}, '$.amount_config.project_ids')
  )
  AND (${recurringSummaryMappingValid(inputJson, 'time', [
    'project',
    'task',
    'people',
    'detailed',
  ])})
  AND (${recurringSummaryMappingValid(inputJson, 'expenses', [
    'project',
    'category',
    'people',
    'detailed',
  ])})
  AND (
    json_type(${inputJson}, '$.source_amount_config.time') = 'object'
    OR json_type(${inputJson}, '$.source_amount_config.expenses') = 'object'
  )`

const recurringImportProjectsValid = (inputJson: string, clientId: string) => `NOT EXISTS (
  SELECT 1
  FROM json_each(${inputJson}, '$.source_amount_config.harvest_project_ids') source_project
  LEFT JOIN json_each(${inputJson}, '$.amount_config.project_ids') resolved_project
    ON resolved_project.key = source_project.key
  LEFT JOIN projects mapped_project
    ON mapped_project.harvest_id = source_project.value
    AND mapped_project.id = resolved_project.value
    AND mapped_project.client_id = ${clientId}
  WHERE source_project.type <> 'integer'
    OR source_project.value NOT BETWEEN 1 AND ${safeIntegerLimit}
    OR resolved_project.type <> 'integer'
    OR resolved_project.value NOT BETWEEN 1 AND ${safeIntegerLimit}
    OR mapped_project.id IS NULL
)`

/**
 * Durable, append-only evidence for the two source gaps that require manual UI
 * transcription. The domain rows remain ordinary retainers/recurring definitions;
 * this table distinguishes a confirmed zero balance from an untouched stub and
 * makes manual completion replayable without granting application code import power.
 */
export const migrationWorksheetCompletionsMigration = [
  `CREATE TABLE _ezacto_worksheet_import_authority (
    kind TEXT NOT NULL CHECK (
      kind IN ('retainer_balance','recurring_invoice_definition')
    ),
    harvest_id INTEGER NOT NULL
      CHECK (harvest_id BETWEEN 1 AND 9007199254740991),
    resource_id INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL
      CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    input_json TEXT NOT NULL
      CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
    target_updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('target_updated_at')}),
    PRIMARY KEY (kind, harvest_id),
    UNIQUE (kind, resource_id)
  ) STRICT`,
  `CREATE TABLE _ezacto_worksheet_completions (
    kind TEXT NOT NULL CHECK (
      kind IN ('retainer_balance','recurring_invoice_definition')
    ),
    harvest_id INTEGER NOT NULL
      CHECK (harvest_id BETWEEN 1 AND 9007199254740991),
    resource_id INTEGER NOT NULL,
    snapshot_sha256 TEXT NOT NULL
      CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
    context_sha256 TEXT NOT NULL
      CHECK (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
    input_sha256 TEXT NOT NULL
      CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
    input_json TEXT NOT NULL
      CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
    completed_at TEXT NOT NULL CHECK (${canonicalTimestamp('completed_at')}),
    PRIMARY KEY (kind, harvest_id),
    UNIQUE (kind, resource_id)
  ) STRICT`,
  `CREATE TRIGGER worksheet_authority_envelope_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN json_extract(NEW.input_json, '$.version') IS NOT 1
      OR json_extract(NEW.input_json, '$.kind') IS NOT NEW.kind
      OR EXISTS (
        SELECT 1 FROM _ezacto_worksheet_completions completion
        WHERE completion.kind = NEW.kind AND completion.harvest_id = NEW.harvest_id
      )
    BEGIN SELECT RAISE(ABORT, 'worksheet authority envelope is invalid'); END`,
  `CREATE TRIGGER worksheet_retainer_authority_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'retainer_balance' AND NOT coalesce((
      ${exactObjectKeys('NEW.input_json', retainerInputKeys)}
      AND json_extract(NEW.input_json, '$.harvest_retainer_id') IS NEW.harvest_id
      AND json_type(NEW.input_json, '$.balance_cents') = 'integer'
      AND json_extract(NEW.input_json, '$.balance_cents') BETWEEN 0 AND 9000000000000
      AND json_type(NEW.input_json, '$.occurred_on') = 'text'
      AND date(json_extract(NEW.input_json, '$.occurred_on'))
        IS json_extract(NEW.input_json, '$.occurred_on')
      AND json_type(NEW.input_json, '$.notes') = 'text'
      AND length(trim(json_extract(NEW.input_json, '$.notes'))) > 0
      AND EXISTS (
        SELECT 1 FROM retainers retainer
        WHERE retainer.id = NEW.resource_id AND retainer.harvest_id = NEW.harvest_id
          AND retainer.client_id IS NOT NULL AND retainer.denomination = 'money'
          AND NOT EXISTS (
            SELECT 1 FROM retainer_ledger entry WHERE entry.retainer_id = retainer.id
          )
      )
    ), 0)
    BEGIN SELECT RAISE(ABORT, 'retainer worksheet authority is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition' AND NOT coalesce((
      ${exactObjectKeys('NEW.input_json', recurringInputKeys)}
      AND json_extract(NEW.input_json, '$.harvest_recurring_invoice_id') IS NEW.harvest_id
      AND json_type(NEW.input_json, '$.subject_template') = 'text'
      AND length(trim(json_extract(NEW.input_json, '$.subject_template'))) > 0
      AND json_type(NEW.input_json, '$.notes_template') = 'text'
      AND json_type(NEW.input_json, '$.every_n_months') = 'integer'
      AND json_extract(NEW.input_json, '$.every_n_months') BETWEEN 1 AND ${safeIntegerLimit}
      AND json_type(NEW.input_json, '$.day_of_month') = 'integer'
      AND json_extract(NEW.input_json, '$.day_of_month') BETWEEN 1 AND 31
      AND json_type(NEW.input_json, '$.next_issue_on') = 'text'
      AND date(json_extract(NEW.input_json, '$.next_issue_on'))
        IS json_extract(NEW.input_json, '$.next_issue_on')
      AND EXISTS (
        SELECT 1 FROM recurring_invoices recurring
        WHERE recurring.id = NEW.resource_id AND recurring.harvest_id = NEW.harvest_id
          AND (
            recurring.definition_status = 'incomplete'
            OR (
              recurring.definition_status = 'complete'
              AND recurring.updated_at = NEW.target_updated_at
              AND recurring.subject_template
                IS json_extract(NEW.input_json, '$.subject_template')
              AND recurring.notes_template
                IS json_extract(NEW.input_json, '$.notes_template')
              AND recurring.every_n_months
                IS json_extract(NEW.input_json, '$.every_n_months')
              AND recurring.day_of_month
                IS json_extract(NEW.input_json, '$.day_of_month')
              AND recurring.next_issue_on
                IS json_extract(NEW.input_json, '$.next_issue_on')
              AND recurring.amount_config
                IS json_extract(NEW.input_json, '$.amount_config')
              AND recurring.can_draw_from_retainer_id
                IS json_extract(NEW.input_json, '$.can_draw_from_retainer_id')
            )
          )
      )
    ), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet authority is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_source_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition' AND NOT EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.id = NEW.resource_id AND recurring.harvest_id = NEW.harvest_id
        AND coalesce((
          ${recurringSourceMappingValid('NEW.input_json', 'recurring.client_id')}
        ), 0)
    )
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet source mapping is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_config_type_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition' AND NOT coalesce((
      json_extract(NEW.input_json, '$.source_amount_config.type')
        IN ('fixed_lines','line_items_import')
      AND json_extract(NEW.input_json, '$.source_amount_config.type')
        IS json_extract(NEW.input_json, '$.amount_config.type')
    ), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet amount config type is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_fixed_shape_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'fixed_lines'
      AND NOT coalesce((${recurringFixedShapeValid('NEW.input_json')}), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet fixed-line shape is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_fixed_scalars_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'fixed_lines'
      AND NOT coalesce((${recurringFixedScalarsValid('NEW.input_json')}), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet fixed-line values are invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_fixed_projects_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'fixed_lines'
      AND NOT EXISTS (
        SELECT 1 FROM recurring_invoices recurring
        WHERE recurring.id = NEW.resource_id AND recurring.harvest_id = NEW.harvest_id
          AND coalesce((${recurringFixedProjectsValid('NEW.input_json', 'recurring.client_id')}), 0)
      )
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet fixed-line mapping is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_import_shape_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'line_items_import'
      AND NOT coalesce((${recurringImportShapeValid('NEW.input_json')}), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet import shape is invalid'); END`,
  `CREATE TRIGGER worksheet_recurring_authority_import_projects_insert
    BEFORE INSERT ON _ezacto_worksheet_import_authority
    WHEN NEW.kind = 'recurring_invoice_definition'
      AND json_extract(NEW.input_json, '$.source_amount_config.type') = 'line_items_import'
      AND NOT EXISTS (
        SELECT 1 FROM recurring_invoices recurring
        WHERE recurring.id = NEW.resource_id AND recurring.harvest_id = NEW.harvest_id
          AND coalesce((${recurringImportProjectsValid(
            'NEW.input_json',
            'recurring.client_id',
          )}), 0)
      )
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet import mapping is invalid'); END`,
  `CREATE TRIGGER worksheet_authority_immutable_update
    BEFORE UPDATE ON _ezacto_worksheet_import_authority
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet authority is immutable'); END`,
  `CREATE TRIGGER worksheet_authority_guard_delete
    BEFORE DELETE ON _ezacto_worksheet_import_authority
    WHEN NOT EXISTS (
      SELECT 1 FROM _ezacto_worksheet_completions completion
      WHERE completion.kind = OLD.kind AND completion.harvest_id = OLD.harvest_id
        AND completion.resource_id = OLD.resource_id
        AND completion.input_sha256 = OLD.input_sha256
        AND completion.input_json = OLD.input_json
    )
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet authority cannot clear before completion'); END`,
  `CREATE TRIGGER worksheet_authority_project_mapping_update
    BEFORE UPDATE OF id, harvest_id, client_id ON projects
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_import_authority authority
      WHERE authority.kind = 'recurring_invoice_definition'
    )
    BEGIN SELECT RAISE(ABORT, 'project source mapping is locked by worksheet authority'); END`,
  `CREATE TRIGGER worksheet_authority_project_mapping_delete
    BEFORE DELETE ON projects
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_import_authority authority
      WHERE authority.kind = 'recurring_invoice_definition'
    )
    BEGIN SELECT RAISE(ABORT, 'project source mapping is locked by worksheet authority'); END`,
  `CREATE TRIGGER worksheet_authority_retainer_mapping_update
    BEFORE UPDATE OF id, harvest_id, client_id, denomination ON retainers
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_import_authority authority
      WHERE authority.kind = 'recurring_invoice_definition'
    )
    BEGIN SELECT RAISE(ABORT, 'retainer source mapping is locked by worksheet authority'); END`,
  `CREATE TRIGGER worksheet_authority_retainer_mapping_delete
    BEFORE DELETE ON retainers
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_import_authority authority
      WHERE authority.kind = 'recurring_invoice_definition'
    )
    BEGIN SELECT RAISE(ABORT, 'retainer source mapping is locked by worksheet authority'); END`,
  `CREATE TRIGGER worksheet_completion_envelope_insert
    BEFORE INSERT ON _ezacto_worksheet_completions
    WHEN json_extract(NEW.input_json, '$.version') IS NOT 1
      OR json_extract(NEW.input_json, '$.kind') IS NOT NEW.kind
      OR json_extract(NEW.input_json, '$.snapshot_sha256') IS NOT NEW.snapshot_sha256
      OR json_extract(NEW.input_json, '$.context_sha256') IS NOT NEW.context_sha256
    BEGIN SELECT RAISE(ABORT, 'worksheet completion envelope is invalid'); END`,
  `CREATE TRIGGER worksheet_completion_retainer_insert
    BEFORE INSERT ON _ezacto_worksheet_completions
    WHEN NEW.kind = 'retainer_balance' AND NOT coalesce((
      ${exactObjectKeys('NEW.input_json', retainerInputKeys)}
      AND json_extract(NEW.input_json, '$.harvest_retainer_id') IS NEW.harvest_id
      AND json_type(NEW.input_json, '$.balance_cents') = 'integer'
      AND json_extract(NEW.input_json, '$.balance_cents') BETWEEN 0 AND 9000000000000
      AND json_type(NEW.input_json, '$.occurred_on') = 'text'
      AND date(json_extract(NEW.input_json, '$.occurred_on'))
        IS json_extract(NEW.input_json, '$.occurred_on')
      AND json_type(NEW.input_json, '$.notes') = 'text'
      AND length(trim(json_extract(NEW.input_json, '$.notes'))) > 0
      AND EXISTS (
        SELECT 1 FROM _ezacto_worksheet_import_authority authority
        JOIN retainers retainer
          ON retainer.id = authority.resource_id AND retainer.harvest_id = authority.harvest_id
        WHERE authority.kind = NEW.kind
          AND authority.harvest_id = NEW.harvest_id
          AND authority.resource_id = NEW.resource_id
          AND authority.input_sha256 = NEW.input_sha256
          AND authority.input_json = NEW.input_json
          AND authority.target_updated_at = NEW.completed_at
          AND retainer.id = NEW.resource_id AND retainer.harvest_id = NEW.harvest_id
          AND retainer.client_id IS NOT NULL AND retainer.denomination = 'money'
          AND (
            (json_extract(NEW.input_json, '$.balance_cents') = 0 AND NOT EXISTS (
              SELECT 1 FROM retainer_ledger entry WHERE entry.retainer_id = retainer.id
            )) OR (
              json_extract(NEW.input_json, '$.balance_cents') > 0
              AND (SELECT count(*) FROM retainer_ledger entry
                WHERE entry.retainer_id = retainer.id) = 1
              AND EXISTS (
                SELECT 1 FROM retainer_ledger entry
                WHERE entry.retainer_id = retainer.id
                  AND entry.id = 'harvest-retainer:' || NEW.harvest_id || ':opening'
                  AND entry.kind = 'adjustment' AND entry.unit = 'cents'
                  AND entry.amount = json_extract(NEW.input_json, '$.balance_cents')
                  AND entry.invoice_id IS NULL
                  AND entry.occurred_on = json_extract(NEW.input_json, '$.occurred_on')
                  AND entry.notes = json_extract(NEW.input_json, '$.notes')
                  AND entry.created_at = NEW.completed_at
              )
            )
          )
      )
    ), 0)
    BEGIN SELECT RAISE(ABORT, 'retainer worksheet completion does not match its opening ledger'); END`,
  `CREATE TRIGGER worksheet_completion_recurring_insert
    BEFORE INSERT ON _ezacto_worksheet_completions
    WHEN NEW.kind = 'recurring_invoice_definition' AND NOT coalesce((
      ${exactObjectKeys('NEW.input_json', recurringInputKeys)}
      AND json_extract(NEW.input_json, '$.harvest_recurring_invoice_id') IS NEW.harvest_id
      AND EXISTS (
        SELECT 1 FROM _ezacto_worksheet_import_authority authority
        JOIN recurring_invoices recurring
          ON recurring.id = authority.resource_id
          AND recurring.harvest_id = authority.harvest_id
        WHERE authority.kind = NEW.kind
          AND authority.harvest_id = NEW.harvest_id
          AND authority.resource_id = NEW.resource_id
          AND authority.input_sha256 = NEW.input_sha256
          AND authority.input_json = NEW.input_json
          AND authority.target_updated_at = recurring.updated_at
          AND recurring.definition_status = 'complete'
          AND recurring.subject_template
            IS json_extract(NEW.input_json, '$.subject_template')
          AND recurring.notes_template
            IS json_extract(NEW.input_json, '$.notes_template')
          AND recurring.every_n_months
            IS json_extract(NEW.input_json, '$.every_n_months')
          AND recurring.day_of_month
            IS json_extract(NEW.input_json, '$.day_of_month')
          AND recurring.next_issue_on
            IS json_extract(NEW.input_json, '$.next_issue_on')
          AND recurring.amount_config
            IS json_extract(NEW.input_json, '$.amount_config')
          AND recurring.can_draw_from_retainer_id
            IS json_extract(NEW.input_json, '$.can_draw_from_retainer_id')
      )
    ), 0)
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet completion does not match its authority'); END`,
  `CREATE TRIGGER worksheet_recurring_completion_update
    BEFORE UPDATE OF definition_status, subject_template, notes_template,
      every_n_months, day_of_month, next_issue_on, amount_config,
      can_draw_from_retainer_id, updated_at ON recurring_invoices
    WHEN OLD.definition_status = 'incomplete' AND NEW.definition_status = 'complete'
      AND NOT EXISTS (
        SELECT 1 FROM _ezacto_worksheet_import_authority authority
        WHERE authority.kind = 'recurring_invoice_definition'
          AND authority.harvest_id = OLD.harvest_id
          AND authority.resource_id = OLD.id
          AND authority.target_updated_at = NEW.updated_at
          AND json_extract(authority.input_json, '$.harvest_recurring_invoice_id')
            IS OLD.harvest_id
          AND json_extract(authority.input_json, '$.subject_template')
            IS NEW.subject_template
          AND json_extract(authority.input_json, '$.notes_template')
            IS NEW.notes_template
          AND json_extract(authority.input_json, '$.every_n_months')
            IS NEW.every_n_months
          AND json_extract(authority.input_json, '$.day_of_month')
            IS NEW.day_of_month
          AND json_extract(authority.input_json, '$.next_issue_on')
            IS NEW.next_issue_on
          AND json_extract(authority.input_json, '$.amount_config')
            IS NEW.amount_config
          AND json_extract(authority.input_json, '$.can_draw_from_retainer_id')
            IS NEW.can_draw_from_retainer_id
      )
    BEGIN SELECT RAISE(ABORT, 'recurring worksheet completion requires exact import authority'); END`,
  `CREATE TRIGGER worksheet_completion_immutable_update
    BEFORE UPDATE ON _ezacto_worksheet_completions
    BEGIN SELECT RAISE(ABORT, 'worksheet completion is immutable'); END`,
  `CREATE TRIGGER worksheet_completion_immutable_delete
    BEFORE DELETE ON _ezacto_worksheet_completions
    BEGIN SELECT RAISE(ABORT, 'worksheet completion is immutable'); END`,
  `CREATE TRIGGER worksheet_completion_retainer_identity_update
    BEFORE UPDATE OF id, harvest_id ON retainers
    WHEN (OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id)
      AND EXISTS (
        SELECT 1 FROM _ezacto_worksheet_completions completion
        WHERE completion.kind = 'retainer_balance'
          AND completion.resource_id = OLD.id
          AND completion.harvest_id = OLD.harvest_id
      )
    BEGIN SELECT RAISE(ABORT, 'completed retainer worksheet identity is immutable'); END`,
  `CREATE TRIGGER worksheet_completion_retainer_delete
    BEFORE DELETE ON retainers
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_completions completion
      WHERE completion.kind = 'retainer_balance'
        AND completion.resource_id = OLD.id
        AND completion.harvest_id = OLD.harvest_id
    )
    BEGIN SELECT RAISE(ABORT, 'completed retainer worksheet resource is immutable'); END`,
  `CREATE TRIGGER worksheet_completion_recurring_identity_update
    BEFORE UPDATE OF id, harvest_id ON recurring_invoices
    WHEN (OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id)
      AND EXISTS (
        SELECT 1 FROM _ezacto_worksheet_completions completion
        WHERE completion.kind = 'recurring_invoice_definition'
          AND completion.resource_id = OLD.id
          AND completion.harvest_id = OLD.harvest_id
      )
    BEGIN SELECT RAISE(ABORT, 'completed recurring worksheet identity is immutable'); END`,
  `CREATE TRIGGER worksheet_completion_recurring_delete
    BEFORE DELETE ON recurring_invoices
    WHEN EXISTS (
      SELECT 1 FROM _ezacto_worksheet_completions completion
      WHERE completion.kind = 'recurring_invoice_definition'
        AND completion.resource_id = OLD.id
        AND completion.harvest_id = OLD.harvest_id
    )
    BEGIN SELECT RAISE(ABORT, 'completed recurring worksheet resource is immutable'); END`,
] as const
