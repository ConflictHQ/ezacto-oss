import { invoiceGenerationMigration } from './0026_invoice_generation.js'

/**
 * The outbox guard 0026 installed lets an `invoice.created` event through only
 * when a pending estimate command or a pending `invoice.create` command backs
 * it. Recurring generation now has its own creating kind, so that authority
 * clause has to admit it too. Extended by replacement over 0026's own text, the
 * way 0026 extended 0021's, and asserted first so a reshaped guard fails the
 * migration instead of silently losing the check.
 */
const historicalEventOutboxInsertGuard = invoiceGenerationMigration.find(
  (statement) => statement.startsWith('CREATE TRIGGER event_outbox_insert_guard'),
)
if (historicalEventOutboxInsertGuard === undefined) {
  throw new Error('recurring generate migration could not find the historical event guard')
}

const createAuthority = `                  AND command.command_kind = 'invoice.create'`
const createOrRecurringAuthority =
  `                  AND command.command_kind IN ('invoice.create','recurring.generate')`

if (historicalEventOutboxInsertGuard.split(createAuthority).length - 1 !== 1) {
  throw new Error('recurring generate migration found an unexpected creation authority')
}

const eventOutboxInsertGuardMigration = historicalEventOutboxInsertGuard.replace(
  createAuthority,
  createOrRecurringAuthority,
)

/**
 * Recurring generation creates an invoice, so its command has to be a creating
 * command — but it is not an `invoice.create`.
 *
 * `invoice.create` means "generated from tracked work": migration 0026 requires
 * its request to carry a non-empty `project_ids` array, summary types, a time
 * and expense count, and both a source and a line manifest. A recurring
 * fixed-lines invoice has none of those. Its lines may legitimately carry no
 * project at all (`RecurringFixedLineV1.project_id` is `number | null`), so a
 * recurring definition without one cannot produce a legal `invoice.create`
 * request without inventing a project.
 *
 * So `recurring.generate` is admitted as a creating kind in its own right, with
 * the invariants that actually fit it: a request naming the definition, period
 * and total; a line manifest, because it does create lines; and no source
 * manifest, because it sources nothing.
 *
 * This also closes a hole. The engine already emitted `invoice.created` events,
 * but every guard in 0026 matches on `command_kind = 'invoice.create'`, so with
 * an unrecognised kind all of them silently passed and recurring generation was
 * writing creation events nothing verified. The two guards added here are the
 * 0026 ones, re-pointed at this kind.
 *
 * The table is rebuilt rather than altered because SQLite cannot change a CHECK
 * in place; this is the same rename-copy-drop that 0026 itself used.
 */
const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
      AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
      AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
      AND (
        ${column} GLOB '????-??-??T??:??:??Z'
        OR ${column} GLOB '????-??-??T??:??:??.???Z'
      )`

export const recurringGenerateCommandMigration = [
  `PRAGMA legacy_alter_table = ON`,
  `DROP TRIGGER invoice_command_ledger_insert_guard`,
  `DROP TRIGGER invoice_command_ledger_update_guard`,
  `DROP TRIGGER invoice_command_ledger_delete_guard`,
  `ALTER TABLE invoice_command_ledger RENAME TO invoice_command_ledger_0036`,
  `CREATE TABLE invoice_command_ledger (
    invoice_id INTEGER NOT NULL,
    command_id TEXT NOT NULL CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'invoice.create','invoice.delete','invoice.send','invoice.view','invoice.draft','invoice.cancel',
      'invoice.write_off','invoice.reopen','invoice.source_close','invoice.update',
      'invoice.line_insert','invoice.line_update','invoice.line_delete',
      'invoice.financials_update','payment.record','payment.update','payment.delete',
      'recurring.generate'
    )),
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','contact','system')),
    actor_id INTEGER,
    expected_invoice_version INTEGER,
    occurred_at TEXT NOT NULL,
    request_json TEXT,
    source_manifest_json TEXT,
    line_manifest_json TEXT,
    event_count INTEGER,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
    first_aggregate_sequence INTEGER,
    result_json TEXT,
    completed_at TEXT,
    PRIMARY KEY (invoice_id, command_id),
    CHECK ((actor_type = 'system' AND actor_id IS NULL)
      OR (actor_type IN ('user','contact') AND actor_id IS NOT NULL)),
    CHECK ((command_kind = 'invoice.view' AND expected_invoice_version IS NULL)
      OR (command_kind <> 'invoice.view' AND expected_invoice_version >= 0)),
    CHECK (${canonicalTimestamp('occurred_at')}),
    CHECK ((command_kind = 'invoice.create' AND COALESCE((
        json_valid(request_json) AND json_type(request_json) = 'object'
        AND json_extract(request_json, '$.schema_version') = 1
        AND json_type(request_json, '$.schema_version') = 'integer'
        AND json_extract(request_json, '$.expected_version') = 0
        AND json_type(request_json, '$.expected_version') = 'integer'
        AND json_type(request_json, '$.client_id') = 'integer'
        AND json_extract(request_json, '$.client_id') > 0
        AND json_type(request_json, '$.from') = 'text'
        AND date(json_extract(request_json, '$.from')) = json_extract(request_json, '$.from')
        AND json_type(request_json, '$.to') = 'text'
        AND date(json_extract(request_json, '$.to')) = json_extract(request_json, '$.to')
        AND json_extract(request_json, '$.from') <= json_extract(request_json, '$.to')
        AND json_type(request_json, '$.project_ids') = 'array'
        AND json_array_length(request_json, '$.project_ids') > 0
        AND (json_type(request_json, '$.time_summary_type') IN ('text','null')
          AND (json_extract(request_json, '$.time_summary_type') IS NULL
            OR json_extract(request_json, '$.time_summary_type')
              IN ('project','task','people','detailed')))
        AND (json_type(request_json, '$.expense_summary_type') IN ('text','null')
          AND (json_extract(request_json, '$.expense_summary_type') IS NULL
            OR json_extract(request_json, '$.expense_summary_type')
              IN ('project','category','people','detailed')))
        AND json_type(request_json, '$.currency') = 'text'
        AND length(json_extract(request_json, '$.currency')) = 3
        AND json_type(request_json, '$.amount_cents') = 'integer'
        AND json_extract(request_json, '$.amount_cents') >= 0
        AND json_type(request_json, '$.line_count') = 'integer'
        AND json_extract(request_json, '$.line_count') > 0
        AND json_type(request_json, '$.time_entry_count') = 'integer'
        AND json_extract(request_json, '$.time_entry_count') >= 0
        AND json_type(request_json, '$.expense_count') = 'integer'
        AND json_extract(request_json, '$.expense_count') >= 0
        AND json_valid(source_manifest_json) AND json_type(source_manifest_json) = 'object'
        AND json_extract(source_manifest_json, '$.schema_version') = 1
        AND json_type(source_manifest_json, '$.time_entries') = 'array'
        AND json_type(source_manifest_json, '$.expenses') = 'array'
        AND json_valid(line_manifest_json) AND json_type(line_manifest_json) = 'object'
        AND json_extract(line_manifest_json, '$.schema_version') = 1
        AND json_type(line_manifest_json, '$.lines') = 'array'
      ), 0))
      OR (command_kind = 'recurring.generate' AND COALESCE((
        json_valid(request_json) AND json_type(request_json) = 'object'
        AND json_extract(request_json, '$.schema_version') = 1
        AND json_type(request_json, '$.schema_version') = 'integer'
        AND json_extract(request_json, '$.expected_version') = 0
        AND json_type(request_json, '$.definition_id') = 'integer'
        AND json_extract(request_json, '$.definition_id') > 0
        AND json_type(request_json, '$.client_id') = 'integer'
        AND json_extract(request_json, '$.client_id') > 0
        AND json_type(request_json, '$.period') = 'text'
        AND date(json_extract(request_json, '$.period')) = json_extract(request_json, '$.period')
        AND json_type(request_json, '$.currency') = 'text'
        AND length(json_extract(request_json, '$.currency')) = 3
        AND json_type(request_json, '$.amount_cents') = 'integer'
        AND json_extract(request_json, '$.amount_cents') >= 0
        AND json_type(request_json, '$.line_count') = 'integer'
        AND json_extract(request_json, '$.line_count') > 0
        -- Recurring generation sources no tracked work, so there is nothing for
        -- a source manifest to describe and its absence is the invariant.
        AND source_manifest_json IS NULL
        AND json_valid(line_manifest_json) AND json_type(line_manifest_json) = 'object'
        AND json_extract(line_manifest_json, '$.schema_version') = 1
        AND json_type(line_manifest_json, '$.lines') = 'array'
      ), 0))
      OR (command_kind NOT IN ('invoice.create','recurring.generate') AND request_json IS NULL
        AND source_manifest_json IS NULL AND line_manifest_json IS NULL)),
    CHECK ((completed = 0 AND event_count IS NULL
        AND first_aggregate_sequence IS NULL AND result_json IS NULL AND completed_at IS NULL)
      OR (completed = 1 AND event_count BETWEEN 1 AND 2
        AND first_aggregate_sequence >= 1 AND result_json IS NOT NULL
        AND json_valid(result_json) AND json_extract(result_json, '$.schema_version') = 1
        AND completed_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR (${canonicalTimestamp('completed_at')}))
  ) STRICT`,
  `INSERT INTO invoice_command_ledger (\n    invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
    expected_invoice_version, occurred_at, request_json, source_manifest_json,
    line_manifest_json, event_count, completed, first_aggregate_sequence, result_json,
    completed_at\n  ) SELECT invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
    expected_invoice_version, occurred_at, request_json, source_manifest_json,
    line_manifest_json, event_count, completed, first_aggregate_sequence, result_json,
    completed_at\n  FROM invoice_command_ledger_0036`,
  `DROP TABLE invoice_command_ledger_0036`,
  `PRAGMA legacy_alter_table = OFF`,
  `CREATE UNIQUE INDEX invoice_command_ledger_pending_invoice_unique\n    ON invoice_command_ledger(invoice_id) WHERE completed = 0`,
  `CREATE TRIGGER invoice_command_ledger_insert_guard
    BEFORE INSERT ON invoice_command_ledger
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM invoice_command_ledger existing
          WHERE existing.invoice_id = NEW.invoice_id AND existing.command_id = NEW.command_id
        ) THEN RAISE(ABORT, 'invoice command identity already exists')
        WHEN NEW.command_kind IN ('invoice.create','recurring.generate')
          AND EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id)
          THEN RAISE(ABORT, 'invoice creation id already exists')
        WHEN NEW.command_kind NOT IN ('invoice.create','recurring.generate')
          AND NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id)
          THEN RAISE(ABORT, 'invoice command invoice does not exist')
        WHEN EXISTS (
          SELECT 1 FROM invoice_command_ledger existing
          WHERE existing.invoice_id = NEW.invoice_id AND existing.completed = 0
        ) THEN RAISE(ABORT, 'invoice already has a pending command')
        WHEN NEW.command_kind NOT IN ('invoice.create','invoice.view','recurring.generate') AND NOT EXISTS (
          SELECT 1 FROM invoices invoice
          WHERE invoice.id = NEW.invoice_id AND invoice.version = NEW.expected_invoice_version
        ) THEN RAISE(ABORT, 'invoice command expected version mismatch')
      END;
    END`,
  `CREATE TRIGGER invoice_command_ledger_update_guard
    BEFORE UPDATE ON invoice_command_ledger
    BEGIN
      SELECT CASE
        WHEN OLD.invoice_id IS NOT NEW.invoice_id OR OLD.command_id IS NOT NEW.command_id
          OR OLD.command_kind IS NOT NEW.command_kind
          OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
          OR OLD.actor_type IS NOT NEW.actor_type OR OLD.actor_id IS NOT NEW.actor_id
          OR OLD.expected_invoice_version IS NOT NEW.expected_invoice_version
          OR OLD.occurred_at IS NOT NEW.occurred_at
          OR OLD.request_json IS NOT NEW.request_json
          OR OLD.source_manifest_json IS NOT NEW.source_manifest_json
          OR OLD.line_manifest_json IS NOT NEW.line_manifest_json
          THEN RAISE(ABORT, 'invoice command causation is immutable')
        WHEN OLD.completed = 1 AND (
          NEW.completed IS NOT OLD.completed OR NEW.event_count IS NOT OLD.event_count
          OR NEW.first_aggregate_sequence IS NOT OLD.first_aggregate_sequence
          OR NEW.result_json IS NOT OLD.result_json OR NEW.completed_at IS NOT OLD.completed_at
        ) THEN RAISE(ABORT, 'completed invoice command is immutable')
        WHEN OLD.completed = 0 AND NEW.completed = 0 AND (
          NEW.event_count IS NOT NULL OR NEW.first_aggregate_sequence IS NOT NULL
          OR NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL
        ) THEN RAISE(ABORT, 'pending invoice command cannot carry a result')
        WHEN OLD.completed = 0 AND NEW.completed = 1 AND (
          NEW.event_count NOT BETWEEN 1 AND 2 OR NEW.first_aggregate_sequence IS NULL
          OR NEW.result_json IS NULL OR NEW.completed_at IS NULL
          OR NEW.event_count <> (
            SELECT CASE
              WHEN OLD.command_kind IN (
                'payment.record','payment.update','payment.delete','invoice.update',
                'invoice.line_insert','invoice.line_update','invoice.line_delete',
                'invoice.financials_update'
              ) AND json_extract(event.payload_json, '$.invoice.before.payment_status')
                <> json_extract(event.payload_json, '$.invoice.after.payment_status')
                THEN 2 ELSE 1 END
            FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
              AND event.command_id = OLD.command_id AND event.event_index = 0
          )
          OR (SELECT count(*) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
                AND event.command_id = OLD.command_id) <> NEW.event_count
          OR (SELECT min(event_index) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
                AND event.command_id = OLD.command_id) <> 0
          OR (SELECT max(event_index) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
                AND event.command_id = OLD.command_id) <> NEW.event_count - 1
          OR (SELECT min(aggregate_sequence) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
                AND event.command_id = OLD.command_id) <> NEW.first_aggregate_sequence
          OR (SELECT max(aggregate_sequence) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
                AND event.command_id = OLD.command_id)
                <> NEW.first_aggregate_sequence + NEW.event_count - 1
          OR (NEW.event_count = 2 AND EXISTS (
            SELECT 1 FROM event_outbox first_event
            JOIN event_outbox second_event
              ON second_event.aggregate_type = first_event.aggregate_type
              AND second_event.aggregate_id = first_event.aggregate_id
              AND second_event.command_id = first_event.command_id
              AND second_event.event_index = 1
            WHERE first_event.aggregate_type = 'invoice'
              AND first_event.aggregate_id = OLD.invoice_id
              AND first_event.command_id = OLD.command_id AND first_event.event_index = 0
              AND (
                json_extract(first_event.payload_json, '$.invoice.before')
                  <> json_extract(second_event.payload_json, '$.invoice.before')
                OR json_extract(first_event.payload_json, '$.invoice.after')
                  <> json_extract(second_event.payload_json, '$.invoice.after')
                OR json_extract(first_event.payload_json, '$.payment')
                  <> json_extract(second_event.payload_json, '$.payment')
              )
          ))
          OR NOT EXISTS (
            SELECT 1 FROM invoices invoice
            WHERE invoice.id = OLD.invoice_id AND (
              invoice.state = 'closed'
              OR (invoice.state = 'draft' AND NOT EXISTS (
                SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
              ))
              OR (invoice.state = 'open' AND NOT (
                EXISTS (
                  SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
                ) AND invoice.due_amount_cents <= 0
              ))
              OR (invoice.state = 'paid'
                AND EXISTS (
                  SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
                ) AND invoice.due_amount_cents <= 0)
            )
          )
        ) THEN RAISE(ABORT, 'invoice command event set is incomplete')
        WHEN OLD.completed = 1 AND NEW.completed = 0
          THEN RAISE(ABORT, 'completed invoice command cannot be reopened')
      END;
    END`,
  `CREATE TRIGGER invoice_command_ledger_delete_guard
    BEFORE DELETE ON invoice_command_ledger
    BEGIN SELECT RAISE(ABORT, 'invoice command receipts are immutable'); END`,
  `CREATE TRIGGER recurring_generation_event_outbox_guard
  BEFORE INSERT ON event_outbox
  WHEN NEW.aggregate_type = 'invoice' AND NEW.event_type = 'invoice.created'
    AND EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = NEW.aggregate_id
        AND command.command_id = NEW.command_id
        AND command.command_kind = 'recurring.generate'
        AND command.completed = 0
    )
  BEGIN
    SELECT CASE WHEN (
      NEW.event_index IS NOT 0 OR NEW.aggregate_sequence IS NOT 1
      OR NEW.available_at IS NOT NEW.occurred_at
      OR NOT EXISTS (
        SELECT 1 FROM invoice_command_ledger command
        JOIN invoices invoice ON invoice.id = command.invoice_id
        WHERE command.invoice_id = NEW.aggregate_id
          AND command.command_id = NEW.command_id
          AND command.command_kind = 'recurring.generate'
          AND command.expected_invoice_version = 0
          AND command.completed = 0
          AND command.occurred_at = NEW.occurred_at
          AND json_valid(NEW.payload_json)
          AND json_extract(NEW.payload_json, '$.schema_version') = 1
          AND json_extract(NEW.payload_json, '$.event_id') = NEW.id
          AND json_extract(NEW.payload_json, '$.event_type') = NEW.event_type
          AND json_extract(NEW.payload_json, '$.occurred_at') = NEW.occurred_at
          AND json_extract(NEW.payload_json, '$.aggregate.type') = 'invoice'
          AND json_extract(NEW.payload_json, '$.aggregate.id') = NEW.aggregate_id
          AND json_extract(NEW.payload_json, '$.aggregate.sequence') = NEW.aggregate_sequence
          AND json_extract(NEW.payload_json, '$.command.id') = NEW.command_id
          AND json_extract(NEW.payload_json, '$.command.kind') = command.command_kind
          AND json_extract(NEW.payload_json, '$.command.event_index') = 0
          AND json_extract(NEW.payload_json, '$.actor.type') = command.actor_type
          AND json_extract(NEW.payload_json, '$.actor.id') IS command.actor_id
          AND json_extract(NEW.payload_json, '$.trigger.type') = 'recurring_invoice'
          AND json_extract(NEW.payload_json, '$.trigger.id') = invoice.recurring_invoice_id
          AND json_extract(NEW.payload_json, '$.invoice.before') IS NULL
          AND json_extract(NEW.payload_json, '$.invoice.after.version') = invoice.version
          AND json_extract(NEW.payload_json, '$.invoice.after.updated_at') = invoice.updated_at
          AND json_extract(NEW.payload_json, '$.invoice.after.state') = invoice.state
          AND json_extract(NEW.payload_json, '$.invoice.after.close_reason') IS invoice.close_reason
          AND json_extract(NEW.payload_json, '$.invoice.after.close_write_off_cents')
            = invoice.close_write_off_cents
          AND json_extract(NEW.payload_json, '$.invoice.after.sent_at') IS invoice.sent_at
          AND json_extract(NEW.payload_json, '$.invoice.after.paid_at') IS invoice.paid_at
          AND json_extract(NEW.payload_json, '$.invoice.after.paid_date') IS invoice.paid_date
          AND json_extract(NEW.payload_json, '$.invoice.after.closed_at') IS invoice.closed_at
          AND json_extract(NEW.payload_json, '$.invoice.after.amount_cents') = invoice.amount_cents
          AND json_extract(NEW.payload_json, '$.invoice.after.due_amount_cents')
            = invoice.due_amount_cents
          AND json_extract(NEW.payload_json, '$.invoice.after.written_off_cents')
            = invoice.written_off_cents
          AND json_extract(NEW.payload_json, '$.invoice.after.payment_count') = 0
          AND json_extract(NEW.payload_json, '$.invoice.after.payment_status') = 'unpaid'
          AND json_extract(command.request_json, '$.expected_version') = 0
          AND json_extract(command.request_json, '$.client_id') = invoice.client_id
          AND json_extract(command.request_json, '$.currency') = invoice.currency
          AND json_extract(command.request_json, '$.amount_cents') = invoice.amount_cents
      )
    ) THEN RAISE(ABORT, 'recurring generation event does not match its pending command') END;
  END`,
  `CREATE TRIGGER recurring_generation_line_manifest_guard
  BEFORE INSERT ON event_outbox
  WHEN NEW.aggregate_type = 'invoice' AND NEW.event_type = 'invoice.created'
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = NEW.aggregate_id
        AND command.command_id = NEW.command_id
        AND command.command_kind = 'recurring.generate' AND command.completed = 0 AND (
        json_extract(command.request_json, '$.line_count') <> (
          SELECT count(*) FROM invoice_line_items line WHERE line.invoice_id = NEW.aggregate_id
        )
        OR json_extract(command.request_json, '$.line_count')
          <> json_array_length(command.line_manifest_json, '$.lines')
        OR EXISTS (
          SELECT 1 FROM json_each(command.line_manifest_json, '$.lines') member
          WHERE NOT EXISTS (
            SELECT 1 FROM invoice_line_items line
            WHERE line.invoice_id = NEW.aggregate_id
              AND line.id = json_extract(member.value, '$.id')
              AND line.position = json_extract(member.value, '$.position')
              AND line.kind = json_extract(member.value, '$.kind')
              -- description and project_id are nullable on a recurring line,
              -- and equality is never true for NULL, so they use IS.
              AND line.description IS json_extract(member.value, '$.description')
              AND line.quantity = json_extract(member.value, '$.quantity')
              AND line.unit_price_cents = json_extract(member.value, '$.unit_price_cents')
              AND line.amount_cents = json_extract(member.value, '$.amount_cents')
              AND line.project_id IS json_extract(member.value, '$.project_id')
          )
        )
      )
    ) THEN RAISE(ABORT, 'recurring generation lines do not match their manifest') END;
  END`,
  `DROP TRIGGER event_outbox_insert_guard`,
  eventOutboxInsertGuardMigration,
]
