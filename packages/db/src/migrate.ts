import type BetterSqlite3 from 'better-sqlite3'
import { orgPeopleMigration } from './migrations/0000_org_people.js'
import { clientsMigration } from './migrations/0001_clients.js'
import { projectsTimeMigration } from './migrations/0002_projects_time.js'
import { rateResolverMigration } from './migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from './migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from './migrations/0005_invoice_payments_totals.js'
import { expensesMigration } from './migrations/0007_expenses.js'
import { retainerLedgerMigration } from './migrations/0008_retainer_ledger.js'
import { threeAxisStateMigration } from './migrations/0009_three_axis_state.js'
import { recurringInvoicesMigration } from './migrations/0010_recurring_invoices.js'
import { apiTokensMigration } from './migrations/0011_api_tokens.js'
import { instanceBootstrapMigration } from './migrations/0012_instance_bootstrap.js'

const ledger = `CREATE TABLE IF NOT EXISTS _ezacto_migrations (
  id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
) STRICT`

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

const timestampEpochMilliseconds = (column: string) =>
  `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000
    + CASE WHEN instr(${column}, '.') = 0 THEN 0 ELSE
      CAST(substr(${column}, 21, length(${column}) - 21)
        || substr('000', 1, 3 - (length(${column}) - 21)) AS INTEGER)
    END)`

const invoiceLifecyclePreflight = `WITH payment_counts AS (
    SELECT invoice.id, invoice.state, invoice.due_amount_cents, invoice.reminder_policy,
      invoice.paid_at, invoice.paid_date, count(payment.id) AS payment_count
    FROM invoices invoice
    LEFT JOIN invoice_payments payment ON payment.invoice_id = invoice.id
    GROUP BY invoice.id
  ), violations AS (
    SELECT id, 1 AS priority, 'draft_has_payment' AS code
    FROM payment_counts WHERE state = 'draft' AND payment_count > 0
    UNION ALL
    SELECT id, 2, 'active_paid_state_mismatch'
    FROM payment_counts
    WHERE state IN ('open','paid')
      AND ((state = 'paid') <> (payment_count > 0 AND due_amount_cents <= 0))
    UNION ALL
    SELECT id, 3, 'paid_timestamp_missing'
    FROM payment_counts
    WHERE state = 'paid' AND paid_at IS NULL AND paid_date IS NULL
    UNION ALL
    SELECT id, 4, 'paid_timestamp_conflict'
    FROM payment_counts WHERE paid_at IS NOT NULL AND paid_date IS NOT NULL
    UNION ALL
    SELECT id,
      CASE
        WHEN state IN ('draft','open') AND (paid_at IS NOT NULL OR paid_date IS NOT NULL)
          THEN 5
        ELSE 6
      END,
      CASE
        WHEN state IN ('draft','open') AND (paid_at IS NOT NULL OR paid_date IS NOT NULL)
          THEN 'active_nonpaid_timestamp_present'
        ELSE 'invalid_reminder_policy'
      END
    FROM payment_counts
    WHERE (state IN ('draft','open') AND (paid_at IS NOT NULL OR paid_date IS NOT NULL))
      OR (reminder_policy IS NOT NULL AND NOT (
        json_valid(reminder_policy) AND json_type(reminder_policy) = 'object'
        AND (SELECT count(*) FROM json_each(reminder_policy)) = 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(reminder_policy)
          WHERE key NOT IN ('first_after_days','every_days')
        )
        AND json_type(reminder_policy, '$.first_after_days') = 'integer'
        AND json_extract(reminder_policy, '$.first_after_days')
          BETWEEN 0 AND 9007199254740991
        AND json_type(reminder_policy, '$.every_days') = 'integer'
        AND json_extract(reminder_policy, '$.every_days')
          BETWEEN 1 AND 9007199254740991
      ))
  ), selected AS (
    SELECT code FROM violations ORDER BY priority, id LIMIT 1
  )
  SELECT id, code FROM violations
  WHERE code = (SELECT code FROM selected)
  ORDER BY id LIMIT 11`

const invoiceLifecycleMigration = [
  `CREATE TABLE invoice_messages_0006 (
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
    event_type TEXT CHECK (
      event_type IS NULL OR event_type IN (
        'send','view','draft','cancel','write_off','re-open','close'
      )
    ),
    delivery_status TEXT CHECK (
      delivery_status IS NULL
      OR delivery_status IN ('queued','sent','bounced','complained','failed')
    ),
    provider_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (send_reminder_on IS NULL OR date(send_reminder_on) IS send_reminder_on),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `INSERT INTO invoice_messages_0006 (
    id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
    recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
    send_reminder_on, event_type, delivery_status, provider_message_id, created_at, updated_at
  ) SELECT
    id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
    recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
    send_reminder_on, event_type, delivery_status, provider_message_id, created_at, updated_at
  FROM invoice_messages`,
  `DROP TABLE invoice_messages`,
  `ALTER TABLE invoice_messages_0006 RENAME TO invoice_messages`,
  `CREATE INDEX invoice_messages_invoice_created_id
    ON invoice_messages(invoice_id, created_at, id)`,
  `CREATE INDEX invoice_messages_provider_message_id
    ON invoice_messages(provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE TRIGGER invoice_messages_reject_identity_collision
    BEFORE INSERT ON invoice_messages
    WHEN EXISTS (SELECT 1 FROM invoice_messages existing WHERE existing.id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_messages existing WHERE existing.harvest_id = NEW.harvest_id
      ))
    BEGIN SELECT RAISE(ABORT, 'invoice message identity already exists'); END`,
  `CREATE TRIGGER invoice_messages_reject_update_identity_collision
    BEFORE UPDATE OF id, harvest_id ON invoice_messages
    WHEN EXISTS (
      SELECT 1 FROM invoice_messages existing
      WHERE existing.id = NEW.id AND existing.id <> OLD.id
    ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_messages existing
      WHERE existing.harvest_id = NEW.harvest_id AND existing.id <> OLD.id
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice message identity belongs to another row'); END`,
  `CREATE TRIGGER invoice_messages_sender_snapshots_immutable
    BEFORE UPDATE OF sent_by, sent_by_email, sent_from, sent_from_email ON invoice_messages
    WHEN OLD.sent_by IS NOT NEW.sent_by OR OLD.sent_by_email IS NOT NEW.sent_by_email
      OR OLD.sent_from IS NOT NEW.sent_from OR OLD.sent_from_email IS NOT NEW.sent_from_email
    BEGIN SELECT RAISE(ABORT, 'invoice message sender snapshots are immutable'); END`,
  `ALTER TABLE invoices ADD COLUMN version INTEGER NOT NULL DEFAULT 0
    CHECK (version BETWEEN 0 AND 9007199254740991)`,
  `ALTER TABLE invoices ADD COLUMN close_reason TEXT
    CHECK (close_reason IS NULL OR close_reason IN ('cancelled','written_off','source_closed'))`,
  `ALTER TABLE invoices ADD COLUMN close_write_off_cents INTEGER NOT NULL DEFAULT 0
    CHECK (close_write_off_cents BETWEEN 0 AND 9000000000000)`,
  `UPDATE invoices SET close_reason = 'source_closed' WHERE state = 'closed'`,
  `CREATE TABLE invoice_command_ledger (
    invoice_id INTEGER NOT NULL,
    command_id TEXT NOT NULL CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'invoice.send','invoice.view','invoice.draft','invoice.cancel',
      'invoice.write_off','invoice.reopen','invoice.source_close','invoice.update',
      'invoice.line_insert','invoice.line_update','invoice.line_delete',
      'invoice.financials_update','payment.record','payment.update','payment.delete'
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
    CHECK ((completed = 0 AND event_count IS NULL
        AND first_aggregate_sequence IS NULL AND result_json IS NULL AND completed_at IS NULL)
      OR (completed = 1 AND event_count BETWEEN 1 AND 2
        AND first_aggregate_sequence >= 1 AND result_json IS NOT NULL
        AND json_valid(result_json) AND json_extract(result_json, '$.schema_version') = 1
        AND completed_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR (${canonicalTimestamp('completed_at')}))
  ) STRICT`,
  `CREATE UNIQUE INDEX invoice_command_ledger_pending_invoice_unique
    ON invoice_command_ledger(invoice_id) WHERE completed = 0`,
  `CREATE TABLE invoice_import_reconciliations (
    invoice_id INTEGER NOT NULL,
    source_updated_at TEXT NOT NULL,
    expected_source_updated_at TEXT,
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    source_manifest_json TEXT NOT NULL
      CHECK (json_valid(source_manifest_json) AND json_type(source_manifest_json) = 'object'),
    source_manifest_hash TEXT NOT NULL CHECK (
      length(source_manifest_hash) = 71
      AND substr(source_manifest_hash, 1, 7) = 'sha256:'
      AND substr(source_manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    line_manifest_json TEXT NOT NULL
      CHECK (json_valid(line_manifest_json) AND json_type(line_manifest_json) = 'array'),
    line_manifest_hash TEXT NOT NULL CHECK (
      length(line_manifest_hash) = 71
      AND substr(line_manifest_hash, 1, 7) = 'sha256:'
      AND substr(line_manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    message_manifest_json TEXT NOT NULL
      CHECK (json_valid(message_manifest_json) AND json_type(message_manifest_json) = 'array'),
    message_manifest_hash TEXT NOT NULL CHECK (
      length(message_manifest_hash) = 71
      AND substr(message_manifest_hash, 1, 7) = 'sha256:'
      AND substr(message_manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    payment_manifest_json TEXT NOT NULL
      CHECK (json_valid(payment_manifest_json) AND json_type(payment_manifest_json) = 'array'),
    payment_manifest_hash TEXT NOT NULL CHECK (
      length(payment_manifest_hash) = 71
      AND substr(payment_manifest_hash, 1, 7) = 'sha256:'
      AND substr(payment_manifest_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    source_state TEXT NOT NULL CHECK (source_state IN ('draft','open','paid','closed')),
    target_state TEXT NOT NULL CHECK (target_state IN ('draft','open','paid','closed')),
    target_version INTEGER NOT NULL CHECK (target_version BETWEEN 0 AND 9007199254740991),
    target_updated_at TEXT NOT NULL,
    target_close_reason TEXT CHECK (
      target_close_reason IS NULL
      OR target_close_reason IN ('cancelled','written_off','source_closed')
    ),
    target_close_write_off_cents INTEGER NOT NULL
      CHECK (target_close_write_off_cents BETWEEN 0 AND 9000000000000),
    target_written_off_cents INTEGER NOT NULL
      CHECK (target_written_off_cents BETWEEN 0 AND 9000000000000),
    target_sent_at TEXT,
    target_paid_at TEXT,
    target_paid_date TEXT,
    target_closed_at TEXT,
    outbox_count_before INTEGER NOT NULL CHECK (outbox_count_before >= 0),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
    PRIMARY KEY (invoice_id, source_updated_at),
    CHECK (${canonicalTimestamp('source_updated_at')}),
    CHECK (expected_source_updated_at IS NULL
      OR (${canonicalTimestamp('expected_source_updated_at')})),
    CHECK (${canonicalTimestamp('target_updated_at')}),
    CHECK (target_sent_at IS NULL OR (${canonicalTimestamp('target_sent_at')})),
    CHECK (target_paid_at IS NULL OR (${canonicalTimestamp('target_paid_at')})),
    CHECK (target_paid_date IS NULL OR date(target_paid_date) IS target_paid_date),
    CHECK (target_closed_at IS NULL OR (${canonicalTimestamp('target_closed_at')})),
    CHECK ((target_state = 'closed') = (target_close_reason IS NOT NULL)),
    CHECK ((target_close_reason = 'written_off'
        AND target_close_write_off_cents BETWEEN 1 AND target_written_off_cents)
      OR (target_close_reason IS NOT 'written_off' AND target_close_write_off_cents = 0)),
    CHECK ((target_state = 'paid'
        AND ((target_paid_at IS NULL) <> (target_paid_date IS NULL)))
      OR (target_state IN ('draft','open')
        AND target_paid_at IS NULL AND target_paid_date IS NULL)
      OR (target_state = 'closed'
        AND NOT (target_paid_at IS NOT NULL AND target_paid_date IS NOT NULL)))
  ) STRICT`,
  `CREATE UNIQUE INDEX invoice_import_reconciliations_pending_invoice_unique
    ON invoice_import_reconciliations(invoice_id) WHERE completed = 0`,
  `ALTER TABLE event_outbox ADD COLUMN command_id TEXT CHECK (
    command_id IS NULL OR (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  )`,
  `ALTER TABLE event_outbox ADD COLUMN event_index INTEGER CHECK (
    (command_id IS NULL AND event_index IS NULL)
    OR (command_id IS NOT NULL AND event_index BETWEEN 0 AND 1)
  )`,
  `CREATE UNIQUE INDEX event_outbox_command_event_unique
    ON event_outbox(aggregate_type, aggregate_id, command_id, event_index)
    WHERE command_id IS NOT NULL`,
  `DROP TRIGGER event_outbox_reject_identity_collision`,
  `DROP TRIGGER event_outbox_reject_update_identity_collision`,
  `DROP TRIGGER event_outbox_event_immutable`,
  `CREATE TRIGGER event_outbox_insert_guard
    BEFORE INSERT ON event_outbox
    BEGIN
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM event_outbox existing WHERE existing.id = NEW.id)
          OR EXISTS (
            SELECT 1 FROM event_outbox existing
            WHERE existing.aggregate_type = NEW.aggregate_type
              AND existing.aggregate_id = NEW.aggregate_id
              AND existing.aggregate_sequence = NEW.aggregate_sequence
          )
          THEN RAISE(ABORT, 'outbox event identity already exists')
        WHEN NEW.command_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM event_outbox existing
            WHERE existing.aggregate_type = NEW.aggregate_type
              AND existing.aggregate_id = NEW.aggregate_id
              AND existing.command_id = NEW.command_id
              AND existing.event_index = NEW.event_index
          )
          THEN RAISE(ABORT, 'outbox event causation already exists')
        WHEN NEW.aggregate_type = 'invoice' AND (
            NEW.command_id IS NULL OR NEW.event_index IS NULL
            OR NEW.event_type NOT IN (
              'invoice.sent','invoice.viewed','invoice.updated','invoice.drafted',
              'invoice.reopened','invoice.cancelled','invoice.written_off','invoice.closed',
              'invoice.unpaid','invoice.partially_paid','invoice.paid',
              'payment.recorded','payment.updated','payment.deleted'
            )
            OR NEW.available_at IS NOT NEW.occurred_at
            OR NOT EXISTS (
              SELECT 1 FROM invoice_command_ledger command
              JOIN invoices invoice ON invoice.id = command.invoice_id
              WHERE command.invoice_id = NEW.aggregate_id
                AND command.command_id = NEW.command_id AND command.completed = 0
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
                AND json_extract(NEW.payload_json, '$.command.event_index') = NEW.event_index
                AND json_extract(NEW.payload_json, '$.actor.type') = command.actor_type
                AND json_extract(NEW.payload_json, '$.actor.id') IS command.actor_id
                AND json_extract(NEW.payload_json, '$.invoice.after.version') = invoice.version
                AND json_extract(NEW.payload_json, '$.invoice.after.updated_at') = invoice.updated_at
                AND json_extract(NEW.payload_json, '$.invoice.after.state') = invoice.state
                AND json_extract(NEW.payload_json, '$.invoice.after.close_reason')
                  IS invoice.close_reason
                AND json_extract(NEW.payload_json, '$.invoice.after.close_write_off_cents')
                  = invoice.close_write_off_cents
                AND json_extract(NEW.payload_json, '$.invoice.after.sent_at') IS invoice.sent_at
                AND json_extract(NEW.payload_json, '$.invoice.after.paid_at') IS invoice.paid_at
                AND json_extract(NEW.payload_json, '$.invoice.after.paid_date') IS invoice.paid_date
                AND json_extract(NEW.payload_json, '$.invoice.after.closed_at') IS invoice.closed_at
                AND json_extract(NEW.payload_json, '$.invoice.after.amount_cents')
                  = invoice.amount_cents
                AND json_extract(NEW.payload_json, '$.invoice.after.due_amount_cents')
                  = invoice.due_amount_cents
                AND json_extract(NEW.payload_json, '$.invoice.after.written_off_cents')
                  = invoice.written_off_cents
                AND json_extract(NEW.payload_json, '$.invoice.after.payment_count') = (
                  SELECT count(*) FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
                )
                AND json_extract(NEW.payload_json, '$.invoice.after.payment_status') = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
                  ) THEN 'unpaid'
                  WHEN invoice.due_amount_cents <= 0 THEN 'paid'
                  ELSE 'partial'
                END
                AND CASE
                  WHEN NEW.event_index = 0 THEN NEW.event_type = CASE command.command_kind
                    WHEN 'invoice.send' THEN 'invoice.sent'
                    WHEN 'invoice.view' THEN 'invoice.viewed'
                    WHEN 'invoice.draft' THEN 'invoice.drafted'
                    WHEN 'invoice.cancel' THEN 'invoice.cancelled'
                    WHEN 'invoice.write_off' THEN 'invoice.written_off'
                    WHEN 'invoice.reopen' THEN 'invoice.reopened'
                    WHEN 'invoice.source_close' THEN 'invoice.closed'
                    WHEN 'payment.record' THEN 'payment.recorded'
                    WHEN 'payment.update' THEN 'payment.updated'
                    WHEN 'payment.delete' THEN 'payment.deleted'
                    WHEN 'invoice.update' THEN 'invoice.updated'
                    WHEN 'invoice.line_insert' THEN 'invoice.updated'
                    WHEN 'invoice.line_update' THEN 'invoice.updated'
                    WHEN 'invoice.line_delete' THEN 'invoice.updated'
                    WHEN 'invoice.financials_update' THEN 'invoice.updated'
                  END
                  WHEN NEW.event_index = 1 THEN
                    command.command_kind IN (
                      'payment.record','payment.update','payment.delete','invoice.update',
                      'invoice.line_insert','invoice.line_update','invoice.line_delete',
                      'invoice.financials_update'
                    ) AND NEW.event_type = CASE
                      WHEN NOT EXISTS (
                        SELECT 1 FROM invoice_payments payment
                        WHERE payment.invoice_id = invoice.id
                      ) THEN 'invoice.unpaid'
                      WHEN invoice.due_amount_cents <= 0 THEN 'invoice.paid'
                      ELSE 'invoice.partially_paid'
                    END
                    AND json_extract(NEW.payload_json, '$.invoice.before.payment_status')
                      <> json_extract(NEW.payload_json, '$.invoice.after.payment_status')
                  ELSE 0
                END
                AND json_extract(NEW.payload_json, '$.trigger.type') = CASE
                  WHEN command.command_kind IN (
                    'invoice.send','invoice.view','invoice.draft','invoice.cancel',
                    'invoice.write_off','invoice.reopen','invoice.source_close'
                  ) THEN 'invoice_message'
                  WHEN command.command_kind LIKE 'payment.%' THEN 'invoice_payment'
                  WHEN command.command_kind = 'invoice.update' THEN 'invoice_header'
                  WHEN command.command_kind LIKE 'invoice.line_%' THEN 'invoice_line_item'
                  WHEN command.command_kind = 'invoice.financials_update'
                    THEN 'invoice_financials'
                END
            )
          ) THEN RAISE(ABORT, 'invoice outbox event requires its pending command')
      END;
    END`,
  `CREATE TRIGGER event_outbox_update_guard
    BEFORE UPDATE OF id, aggregate_type, aggregate_id, aggregate_sequence,
      event_type, command_id, event_index, payload_json, occurred_at ON event_outbox
    WHEN OLD.id IS NOT NEW.id OR OLD.aggregate_type IS NOT NEW.aggregate_type
      OR OLD.aggregate_id IS NOT NEW.aggregate_id
      OR OLD.aggregate_sequence IS NOT NEW.aggregate_sequence
      OR OLD.event_type IS NOT NEW.event_type OR OLD.command_id IS NOT NEW.command_id
      OR OLD.event_index IS NOT NEW.event_index OR OLD.payload_json IS NOT NEW.payload_json
      OR OLD.occurred_at IS NOT NEW.occurred_at
    BEGIN SELECT RAISE(ABORT, 'outbox event identity, causation, and payload are immutable'); END`,
  `CREATE TRIGGER event_outbox_invoice_delete_guard
    BEFORE DELETE ON event_outbox
    WHEN OLD.aggregate_type = 'invoice'
    BEGIN SELECT RAISE(ABORT, 'invoice outbox events are immutable'); END`,
  `CREATE TRIGGER invoice_command_ledger_insert_guard
    BEFORE INSERT ON invoice_command_ledger
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM invoice_command_ledger existing
          WHERE existing.invoice_id = NEW.invoice_id AND existing.command_id = NEW.command_id
        ) THEN RAISE(ABORT, 'invoice command identity already exists')
        WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id)
          THEN RAISE(ABORT, 'invoice command invoice does not exist')
        WHEN EXISTS (
          SELECT 1 FROM invoice_command_ledger existing
          WHERE existing.invoice_id = NEW.invoice_id AND existing.completed = 0
        ) THEN RAISE(ABORT, 'invoice already has a pending command')
        WHEN NEW.command_kind <> 'invoice.view' AND NOT EXISTS (
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
                SELECT 1 FROM invoice_payments payment
                WHERE payment.invoice_id = invoice.id
              ))
              OR (invoice.state = 'open' AND NOT (
                EXISTS (
                  SELECT 1 FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
                ) AND invoice.due_amount_cents <= 0
              ))
              OR (invoice.state = 'paid'
                AND EXISTS (
                  SELECT 1 FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
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
  `CREATE TRIGGER invoice_import_reconciliations_insert_guard
    BEFORE INSERT ON invoice_import_reconciliations
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM invoice_import_reconciliations existing
          WHERE existing.invoice_id = NEW.invoice_id
            AND existing.source_updated_at = NEW.source_updated_at
        ) THEN RAISE(ABORT, 'invoice import reconciliation identity already exists')
        WHEN EXISTS (
          SELECT 1 FROM invoice_import_reconciliations existing
          WHERE existing.invoice_id = NEW.invoice_id AND existing.completed = 0
        ) THEN RAISE(ABORT, 'invoice already has a pending import reconciliation')
        WHEN (SELECT count(*) FROM json_each(NEW.source_manifest_json)) <> 2
          OR json_extract(NEW.source_manifest_json, '$.invoice_id') <> NEW.invoice_id
          OR json_extract(NEW.source_manifest_json, '$.source_updated_at')
            <> NEW.source_updated_at
          THEN RAISE(ABORT, 'invoice import source manifest is invalid')
        WHEN EXISTS (
          SELECT 1 FROM (
            SELECT value FROM json_each(NEW.line_manifest_json)
            UNION ALL SELECT value FROM json_each(NEW.message_manifest_json)
            UNION ALL SELECT value FROM json_each(NEW.payment_manifest_json)
          ) member
          WHERE (SELECT count(*) FROM json_each(member.value)) <> 3
            OR json_type(member.value, '$.id') <> 'integer'
            OR json_extract(member.value, '$.id') <= 0
            OR json_type(member.value, '$.harvest_id') <> 'integer'
            OR json_extract(member.value, '$.harvest_id') <= 0
            OR json_type(member.value, '$.updated_at') <> 'text'
            OR NOT (${canonicalTimestamp("json_extract(member.value, '$.updated_at')")})
        ) THEN RAISE(ABORT, 'invoice import set manifest is invalid')
        WHEN EXISTS (
          SELECT 1 FROM json_each(NEW.line_manifest_json) member
          JOIN json_each(NEW.line_manifest_json) successor
            ON CAST(successor.key AS INTEGER) = CAST(member.key AS INTEGER) + 1
          WHERE json_extract(successor.value, '$.harvest_id')
              < json_extract(member.value, '$.harvest_id')
            OR (json_extract(successor.value, '$.harvest_id')
                = json_extract(member.value, '$.harvest_id')
              AND json_extract(successor.value, '$.id')
                <= json_extract(member.value, '$.id'))
        ) OR EXISTS (
          SELECT 1 FROM json_each(NEW.message_manifest_json) member
          JOIN json_each(NEW.message_manifest_json) successor
            ON CAST(successor.key AS INTEGER) = CAST(member.key AS INTEGER) + 1
          WHERE json_extract(successor.value, '$.harvest_id')
              < json_extract(member.value, '$.harvest_id')
            OR (json_extract(successor.value, '$.harvest_id')
                = json_extract(member.value, '$.harvest_id')
              AND json_extract(successor.value, '$.id')
                <= json_extract(member.value, '$.id'))
        ) OR EXISTS (
          SELECT 1 FROM json_each(NEW.payment_manifest_json) member
          JOIN json_each(NEW.payment_manifest_json) successor
            ON CAST(successor.key AS INTEGER) = CAST(member.key AS INTEGER) + 1
          WHERE json_extract(successor.value, '$.harvest_id')
              < json_extract(member.value, '$.harvest_id')
            OR (json_extract(successor.value, '$.harvest_id')
                = json_extract(member.value, '$.harvest_id')
              AND json_extract(successor.value, '$.id')
                <= json_extract(member.value, '$.id'))
        ) THEN RAISE(ABORT, 'invoice import set manifest must be strictly sorted')
        WHEN NOT EXISTS (
          SELECT 1 FROM invoices invoice
          WHERE invoice.id = NEW.invoice_id AND invoice.harvest_id IS NOT NULL
            AND invoice.version + 1 = NEW.target_version
            AND invoice.source_updated_at IS NEW.expected_source_updated_at
            AND NEW.target_updated_at = NEW.source_updated_at
            AND ${timestampEpochMilliseconds('NEW.source_updated_at')}
              > COALESCE(${timestampEpochMilliseconds('invoice.source_updated_at')}, -1)
        ) THEN RAISE(ABORT, 'invoice import reconciliation source is not newer')
        WHEN (NEW.source_state = 'closed' AND (
            NEW.target_state <> 'closed' OR NEW.target_close_reason <> 'source_closed'
          )) OR (NEW.source_state <> 'closed' AND NEW.target_close_reason = 'source_closed')
          THEN RAISE(ABORT, 'invoice import reconciliation source state is inconsistent')
        WHEN (NEW.source_state = 'draft' AND NEW.target_state <> 'draft')
          OR (NEW.source_state IN ('open','paid')
            AND NEW.target_state NOT IN ('open','paid'))
          THEN RAISE(ABORT, 'invoice import reconciliation target state is inconsistent')
        WHEN NEW.outbox_count_before <> (
          SELECT count(*) FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = NEW.invoice_id
        ) THEN RAISE(ABORT, 'invoice import reconciliation outbox count is stale')
      END;
    END`,
  `CREATE TRIGGER invoice_import_reconciliations_update_guard
    BEFORE UPDATE ON invoice_import_reconciliations
    BEGIN
      SELECT CASE
        WHEN OLD.invoice_id IS NOT NEW.invoice_id
          OR OLD.source_updated_at IS NOT NEW.source_updated_at
          OR OLD.expected_source_updated_at IS NOT NEW.expected_source_updated_at
          OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
          OR OLD.source_manifest_json IS NOT NEW.source_manifest_json
          OR OLD.source_manifest_hash IS NOT NEW.source_manifest_hash
          OR OLD.line_manifest_json IS NOT NEW.line_manifest_json
          OR OLD.line_manifest_hash IS NOT NEW.line_manifest_hash
          OR OLD.message_manifest_json IS NOT NEW.message_manifest_json
          OR OLD.message_manifest_hash IS NOT NEW.message_manifest_hash
          OR OLD.payment_manifest_json IS NOT NEW.payment_manifest_json
          OR OLD.payment_manifest_hash IS NOT NEW.payment_manifest_hash
          OR OLD.source_state IS NOT NEW.source_state OR OLD.target_state IS NOT NEW.target_state
          OR OLD.target_version IS NOT NEW.target_version
          OR OLD.target_updated_at IS NOT NEW.target_updated_at
          OR OLD.target_close_reason IS NOT NEW.target_close_reason
          OR OLD.target_close_write_off_cents IS NOT NEW.target_close_write_off_cents
          OR OLD.target_written_off_cents IS NOT NEW.target_written_off_cents
          OR OLD.target_sent_at IS NOT NEW.target_sent_at
          OR OLD.target_paid_at IS NOT NEW.target_paid_at
          OR OLD.target_paid_date IS NOT NEW.target_paid_date
          OR OLD.target_closed_at IS NOT NEW.target_closed_at
          OR OLD.outbox_count_before IS NOT NEW.outbox_count_before
          THEN RAISE(ABORT, 'invoice import reconciliation authority is immutable')
        WHEN OLD.completed = 1 AND NEW.completed IS NOT OLD.completed
          THEN RAISE(ABORT, 'completed invoice import reconciliation is immutable')
        WHEN OLD.completed = 0 AND NEW.completed = 1 AND NOT EXISTS (
          SELECT 1 FROM invoices invoice
          WHERE invoice.id = OLD.invoice_id AND invoice.harvest_id IS NOT NULL
            AND invoice.source_updated_at = OLD.source_updated_at
            AND invoice.version = OLD.target_version
            AND invoice.updated_at = OLD.target_updated_at
            AND invoice.state = OLD.target_state
            AND invoice.close_reason IS OLD.target_close_reason
            AND invoice.close_write_off_cents = OLD.target_close_write_off_cents
            AND invoice.written_off_cents = OLD.target_written_off_cents
            AND invoice.sent_at IS OLD.target_sent_at
            AND invoice.paid_at IS OLD.target_paid_at
            AND invoice.paid_date IS OLD.target_paid_date
            AND invoice.closed_at IS OLD.target_closed_at
            AND (
              invoice.state = 'closed'
              OR (invoice.state = 'draft'
                AND NOT EXISTS (
                  SELECT 1 FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
                ))
              OR (invoice.state = 'open' AND NOT (
                EXISTS (
                  SELECT 1 FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
                ) AND invoice.due_amount_cents <= 0
              ))
              OR (invoice.state = 'paid'
                AND EXISTS (
                  SELECT 1 FROM invoice_payments payment
                  WHERE payment.invoice_id = invoice.id
                ) AND invoice.due_amount_cents <= 0)
            )
            AND OLD.outbox_count_before = (
              SELECT count(*) FROM event_outbox event
              WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id
            )
            AND json_array_length(OLD.line_manifest_json) = (
              SELECT count(*) FROM invoice_line_items line
              WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM invoice_line_items line
              WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(OLD.line_manifest_json) member
                  WHERE json_extract(member.value, '$.id') = line.id
                    AND json_extract(member.value, '$.harvest_id') = line.harvest_id
                    AND json_extract(member.value, '$.updated_at') = line.updated_at
                )
            )
            AND json_array_length(OLD.message_manifest_json) = (
              SELECT count(*) FROM invoice_messages message
              WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM invoice_messages message
              WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(OLD.message_manifest_json) member
                  WHERE json_extract(member.value, '$.id') = message.id
                    AND json_extract(member.value, '$.harvest_id') = message.harvest_id
                    AND json_extract(member.value, '$.updated_at') = message.updated_at
                )
            )
            AND json_array_length(OLD.payment_manifest_json) = (
              SELECT count(*) FROM invoice_payments payment
              WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM invoice_payments payment
              WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(OLD.payment_manifest_json) member
                  WHERE json_extract(member.value, '$.id') = payment.id
                    AND json_extract(member.value, '$.harvest_id') = payment.harvest_id
                    AND json_extract(member.value, '$.updated_at') = payment.updated_at
                )
            )
        ) THEN RAISE(ABORT, 'invoice import reconciliation target is incomplete')
        WHEN OLD.completed = 1 AND NEW.completed = 0
          THEN RAISE(ABORT, 'completed invoice import reconciliation cannot be reopened')
      END;
    END`,
  `CREATE TRIGGER invoice_import_reconciliations_delete_guard
    BEFORE DELETE ON invoice_import_reconciliations
    BEGIN SELECT RAISE(ABORT, 'invoice import reconciliation receipts are immutable'); END`,
  `CREATE TRIGGER invoices_d22_source_observation_update
    BEFORE UPDATE OF source_amount_cents, source_due_amount_cents,
      source_tax_amount_cents, source_tax2_amount_cents, source_discount_amount_cents,
      source_payment_options, source_updated_at ON invoices
    WHEN (
      OLD.source_amount_cents IS NOT NEW.source_amount_cents
      OR OLD.source_due_amount_cents IS NOT NEW.source_due_amount_cents
      OR OLD.source_tax_amount_cents IS NOT NEW.source_tax_amount_cents
      OR OLD.source_tax2_amount_cents IS NOT NEW.source_tax2_amount_cents
      OR OLD.source_discount_amount_cents IS NOT NEW.source_discount_amount_cents
      OR OLD.source_payment_options IS NOT NEW.source_payment_options
      OR OLD.source_updated_at IS NOT NEW.source_updated_at
    ) AND NOT EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.id AND import.completed = 0
        AND OLD.harvest_id IS NOT NULL AND NEW.harvest_id IS OLD.harvest_id
        AND OLD.source_updated_at IS import.expected_source_updated_at
        AND NEW.source_updated_at = import.source_updated_at
        AND NEW.version = OLD.version + 1 AND NEW.version = import.target_version
        AND NEW.updated_at = import.target_updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'invoice source observation requires exact pending import authority'); END`,
  `CREATE TRIGGER invoice_messages_d22_insert_guard
    BEFORE INSERT ON invoice_messages
    WHEN NOT (
      NEW.harvest_id IS NULL AND EXISTS (
        SELECT 1 FROM invoice_command_ledger command
        WHERE command.invoice_id = NEW.invoice_id AND command.completed = 0
          AND NEW.event_type = CASE command.command_kind
            WHEN 'invoice.send' THEN 'send'
            WHEN 'invoice.view' THEN 'view'
            WHEN 'invoice.draft' THEN 'draft'
            WHEN 'invoice.cancel' THEN 'cancel'
            WHEN 'invoice.write_off' THEN 'write_off'
            WHEN 'invoice.reopen' THEN 're-open'
            WHEN 'invoice.source_close' THEN 'close'
          END
      )
    ) AND NOT (
      NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import,
          json_each(import.message_manifest_json) member
        WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
          AND json_extract(member.value, '$.id') = NEW.id
          AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
          AND json_extract(member.value, '$.updated_at') = NEW.updated_at
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice message insert requires exact pending authority'); END`,
  `CREATE TRIGGER invoice_messages_d22_source_update_guard
    BEFORE UPDATE ON invoice_messages
    WHEN (
      OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.sent_by IS NOT NEW.sent_by
      OR OLD.sent_by_email IS NOT NEW.sent_by_email OR OLD.sent_from IS NOT NEW.sent_from
      OR OLD.sent_from_email IS NOT NEW.sent_from_email OR OLD.recipients IS NOT NEW.recipients
      OR OLD.subject IS NOT NEW.subject OR OLD.body IS NOT NEW.body
      OR OLD.attach_pdf IS NOT NEW.attach_pdf OR OLD.send_me_a_copy IS NOT NEW.send_me_a_copy
      OR OLD.thank_you IS NOT NEW.thank_you OR OLD.reminder IS NOT NEW.reminder
      OR OLD.send_reminder_on IS NOT NEW.send_reminder_on
      OR OLD.event_type IS NOT NEW.event_type OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at
    ) AND NOT (
      OLD.harvest_id IS NOT NULL AND NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import,
          json_each(import.message_manifest_json) member
        WHERE import.invoice_id = OLD.invoice_id AND import.invoice_id = NEW.invoice_id
          AND import.completed = 0
          AND json_extract(member.value, '$.id') = NEW.id
          AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
          AND json_extract(member.value, '$.updated_at') = NEW.updated_at
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice message source mutation requires exact import authority'); END`,
  `CREATE TRIGGER invoice_messages_d22_delete_guard
    BEFORE DELETE ON invoice_messages
    WHEN NOT (
      OLD.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import
        WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
          AND NOT EXISTS (
            SELECT 1 FROM json_each(import.message_manifest_json) member
            WHERE json_extract(member.value, '$.id') = OLD.id
              AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
              AND json_extract(member.value, '$.updated_at') = OLD.updated_at
          )
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice message delete requires exact import authority'); END`,
  `CREATE TRIGGER invoices_d22_shape_insert
    BEFORE INSERT ON invoices
    WHEN ((NEW.state = 'closed') <> (NEW.close_reason IS NOT NULL))
      OR (NEW.close_reason = 'written_off' AND NOT (
        NEW.close_write_off_cents BETWEEN 1 AND NEW.written_off_cents
      ))
      OR (NEW.close_reason IS NOT 'written_off' AND NEW.close_write_off_cents <> 0)
      OR (NEW.state = 'paid' AND NOT ((NEW.paid_at IS NULL) <> (NEW.paid_date IS NULL)))
      OR (NEW.state IN ('draft','open') AND (NEW.paid_at IS NOT NULL OR NEW.paid_date IS NOT NULL))
      OR (NEW.state = 'closed' AND NEW.paid_at IS NOT NULL AND NEW.paid_date IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'invalid invoice lifecycle shape'); END`,
  `CREATE TRIGGER invoices_d22_identity_immutable
    BEFORE UPDATE OF id, harvest_id ON invoices
    WHEN OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
    BEGIN SELECT RAISE(ABORT, 'invoice storage identity and origin are immutable'); END`,
  `CREATE TRIGGER invoices_d22_creator_relation_update
    BEFORE UPDATE OF created_by_user_id ON invoices
    WHEN OLD.created_by_user_id IS NOT NEW.created_by_user_id
      AND NOT (
        OLD.harvest_id IS NOT NULL AND OLD.created_by_user_id IS NULL
        AND NEW.created_by_user_id IS NOT NULL AND OLD.source_creator_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users user
          WHERE user.id = NEW.created_by_user_id
            AND user.harvest_id = OLD.source_creator_id
        )
      )
      AND NOT (
        OLD.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM users user WHERE user.id = OLD.created_by_user_id)
      )
    BEGIN SELECT RAISE(ABORT, 'invoice creator relation requires exact provenance'); END`,
  `CREATE TRIGGER invoices_d22_shape_update
    BEFORE UPDATE ON invoices
    WHEN ((NEW.state = 'closed') <> (NEW.close_reason IS NOT NULL))
      OR (NEW.close_reason = 'written_off' AND NOT (
        NEW.close_write_off_cents BETWEEN 1 AND NEW.written_off_cents
      ))
      OR (NEW.close_reason IS NOT 'written_off' AND NEW.close_write_off_cents <> 0)
      OR (NEW.state = 'paid' AND NOT ((NEW.paid_at IS NULL) <> (NEW.paid_date IS NULL)))
      OR (NEW.state IN ('draft','open') AND (NEW.paid_at IS NOT NULL OR NEW.paid_date IS NOT NULL))
      OR (NEW.state = 'closed' AND NEW.paid_at IS NOT NULL AND NEW.paid_date IS NOT NULL)
      OR (NEW.state = 'draft' AND EXISTS (
        SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = NEW.id
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid invoice lifecycle shape'); END`,
  `CREATE TRIGGER invoices_d22_transition_guard
    BEFORE UPDATE OF version, updated_at, state, close_reason, close_write_off_cents,
      written_off_cents, sent_at, paid_at, paid_date, closed_at ON invoices
    WHEN (OLD.version IS NOT NEW.version OR OLD.updated_at IS NOT NEW.updated_at
      OR OLD.state IS NOT NEW.state
      OR OLD.close_reason IS NOT NEW.close_reason
      OR OLD.close_write_off_cents IS NOT NEW.close_write_off_cents
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.paid_at IS NOT NEW.paid_at
      OR OLD.written_off_cents IS NOT NEW.written_off_cents
      OR OLD.paid_date IS NOT NEW.paid_date OR OLD.closed_at IS NOT NEW.closed_at)
      AND NOT EXISTS (
        SELECT 1 FROM invoice_command_ledger command
        WHERE command.invoice_id = OLD.id AND command.completed = 0
          AND command.command_kind <> 'invoice.view'
          AND command.expected_invoice_version = OLD.version
          AND NEW.version = OLD.version + 1 AND NEW.updated_at = command.occurred_at
          AND CASE command.command_kind
            WHEN 'invoice.send' THEN
              OLD.state IN ('draft','open') AND NEW.state = 'open'
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS COALESCE(OLD.sent_at, command.occurred_at)
              AND NEW.paid_at IS OLD.paid_at AND NEW.paid_date IS OLD.paid_date
              AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.draft' THEN
              OLD.state = 'open' AND NEW.state = 'draft'
              AND NOT EXISTS (
                SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = OLD.id
              ) AND OLD.written_off_cents = 0
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.paid_at IS OLD.paid_at
              AND NEW.paid_date IS OLD.paid_date AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.cancel' THEN
              OLD.state IN ('draft','open') AND NEW.state = 'closed'
              AND NEW.close_reason = 'cancelled' AND NEW.close_write_off_cents = 0
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.paid_at IS OLD.paid_at
              AND NEW.paid_date IS OLD.paid_date AND NEW.closed_at = command.occurred_at
            WHEN 'invoice.write_off' THEN
              OLD.state = 'open' AND OLD.due_amount_cents > 0 AND NEW.state = 'closed'
              AND NEW.close_reason = 'written_off'
              AND NEW.close_write_off_cents = OLD.due_amount_cents
              AND NEW.written_off_cents = OLD.written_off_cents + OLD.due_amount_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.paid_at IS OLD.paid_at
              AND NEW.paid_date IS OLD.paid_date AND NEW.closed_at = command.occurred_at
            WHEN 'invoice.reopen' THEN
              OLD.state = 'closed' AND NEW.state IN ('open','paid')
              AND NEW.close_reason IS NULL AND NEW.close_write_off_cents = 0
              AND NEW.written_off_cents = OLD.written_off_cents - OLD.close_write_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS NULL
              AND (
                (NEW.state = 'open' AND NEW.paid_at IS NULL AND NEW.paid_date IS NULL)
                OR (NEW.state = 'paid'
                  AND ((NEW.paid_at IS NULL) <> (NEW.paid_date IS NULL)))
              )
            WHEN 'invoice.source_close' THEN
              OLD.state IN ('draft','open','paid') AND NEW.state = 'closed'
              AND NEW.close_reason = 'source_closed' AND NEW.close_write_off_cents = 0
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.paid_at IS OLD.paid_at
              AND NEW.paid_date IS OLD.paid_date AND NEW.closed_at = command.occurred_at
            WHEN 'payment.record' THEN
              OLD.state IN ('open','paid') AND NEW.state IN ('open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'payment.update' THEN
              OLD.state IN ('open','paid') AND NEW.state IN ('open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'payment.delete' THEN
              OLD.state IN ('open','paid') AND NEW.state IN ('open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.update' THEN
              OLD.state <> 'closed' AND NEW.state IN ('draft','open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.line_insert' THEN
              OLD.state <> 'closed' AND NEW.state IN ('draft','open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.line_update' THEN
              OLD.state <> 'closed' AND NEW.state IN ('draft','open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.line_delete' THEN
              OLD.state <> 'closed' AND NEW.state IN ('draft','open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            WHEN 'invoice.financials_update' THEN
              OLD.state <> 'closed' AND NEW.state IN ('draft','open','paid')
              AND NEW.close_reason IS OLD.close_reason
              AND NEW.close_write_off_cents = OLD.close_write_off_cents
              AND NEW.written_off_cents = OLD.written_off_cents
              AND NEW.sent_at IS OLD.sent_at AND NEW.closed_at IS OLD.closed_at
            ELSE 0
          END
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import
        WHERE import.invoice_id = OLD.id AND import.completed = 0
          AND OLD.harvest_id IS NOT NULL AND NEW.harvest_id IS OLD.harvest_id
          AND OLD.source_updated_at IS import.expected_source_updated_at
          AND NEW.source_updated_at = import.source_updated_at
          AND NEW.version = OLD.version + 1 AND NEW.version = import.target_version
          AND NEW.updated_at = import.target_updated_at AND NEW.state = import.target_state
          AND NEW.close_reason IS import.target_close_reason
          AND NEW.close_write_off_cents = import.target_close_write_off_cents
          AND NEW.written_off_cents = import.target_written_off_cents
          AND NEW.sent_at IS import.target_sent_at AND NEW.paid_at IS import.target_paid_at
          AND NEW.paid_date IS import.target_paid_date AND NEW.closed_at IS import.target_closed_at
      )
    BEGIN SELECT RAISE(ABORT, 'invoice lifecycle mutation requires its pending command'); END`,
  `CREATE TRIGGER invoices_d22_created_at_immutable
    BEFORE UPDATE OF created_at ON invoices
    WHEN OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'invoice created_at is immutable'); END`,
  `CREATE TRIGGER invoice_payments_d22_state_insert
    BEFORE INSERT ON invoice_payments
    WHEN NOT (
      NEW.harvest_id IS NULL AND EXISTS (
        SELECT 1 FROM invoices invoice
        JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
        WHERE invoice.id = NEW.invoice_id AND invoice.state IN ('open','paid')
          AND command.completed = 0 AND command.command_kind = 'payment.record'
          AND command.expected_invoice_version = invoice.version
      )
    ) AND NOT (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import,
          json_each(import.payment_manifest_json) member
        WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
          AND import.target_state <> 'draft'
          AND json_extract(member.value, '$.id') = NEW.id
          AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
          AND json_extract(member.value, '$.updated_at') = NEW.updated_at
      ))
    BEGIN SELECT RAISE(ABORT, 'invoice payment insert requires its pending command'); END`,
  `CREATE TRIGGER invoice_payments_d22_state_update
    BEFORE UPDATE ON invoice_payments
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
      WHERE invoice.id = NEW.invoice_id AND invoice.state IN ('open','paid')
        AND command.completed = 0 AND command.command_kind = 'payment.update'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT (
      OLD.harvest_id IS NOT NULL
      AND (
        (OLD.recorded_by_user_id IS NULL AND NEW.recorded_by_user_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM users WHERE id = NEW.recorded_by_user_id))
        OR (OLD.recorded_by_user_id IS NOT NULL AND NEW.recorded_by_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.recorded_by_user_id))
      )
      AND OLD.id IS NEW.id AND OLD.harvest_id IS NEW.harvest_id
      AND OLD.invoice_id IS NEW.invoice_id AND OLD.currency IS NEW.currency
      AND OLD.amount_cents IS NEW.amount_cents AND OLD.paid_at IS NEW.paid_at
      AND OLD.paid_date IS NEW.paid_date AND OLD.source_paid_at IS NEW.source_paid_at
      AND OLD.source_paid_date IS NEW.source_paid_date
      AND OLD.source_recorded_by_name IS NEW.source_recorded_by_name
      AND OLD.source_recorded_by_email IS NEW.source_recorded_by_email
      AND OLD.source_gateway_id IS NEW.source_gateway_id
      AND OLD.source_gateway_name IS NEW.source_gateway_name
      AND OLD.notes IS NEW.notes AND OLD.provider IS NEW.provider
      AND OLD.provider_shape IS NEW.provider_shape
      AND OLD.provider_account_id IS NEW.provider_account_id
      AND OLD.provider_transaction_id IS NEW.provider_transaction_id
      AND OLD.bank_deposit_id IS NEW.bank_deposit_id
      AND OLD.created_at IS NEW.created_at AND OLD.updated_at IS NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'invoice payment update requires its pending command'); END`,
  `CREATE TRIGGER invoice_payments_d22_state_delete
    BEFORE DELETE ON invoice_payments
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
      WHERE invoice.id = OLD.invoice_id AND invoice.state IN ('open','paid')
        AND command.completed = 0 AND command.command_kind = 'payment.delete'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(import.payment_manifest_json) member
          WHERE json_extract(member.value, '$.id') = OLD.id
            AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
            AND json_extract(member.value, '$.updated_at') = OLD.updated_at
        )
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice payment delete requires its pending command'); END`,
  `CREATE TRIGGER invoice_header_d22_command_update
    BEFORE UPDATE OF client_id, number, subject, purchase_order, notes, currency,
      issue_date, due_date, payment_terms, project_id, reminder_policy,
      payment_options, client_key, reference_token ON invoices
    WHEN NOT EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = OLD.id AND command.completed = 0
        AND command.command_kind = 'invoice.update'
        AND command.expected_invoice_version = OLD.version
    ) AND NOT (
      OLD.harvest_id IS NULL AND OLD.state = 'draft' AND OLD.version = 0
      AND OLD.sent_at IS NULL AND OLD.closed_at IS NULL AND OLD.close_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = OLD.id
      ) AND NOT EXISTS (
        SELECT 1 FROM invoice_messages message WHERE message.invoice_id = OLD.id
      ) AND NOT EXISTS (
        SELECT 1 FROM event_outbox event
        WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice header mutation requires its pending command'); END`,
  `CREATE TRIGGER invoices_d22_reminder_policy_insert
    BEFORE INSERT ON invoices
    WHEN NEW.reminder_policy IS NOT NULL AND NOT (
      json_valid(NEW.reminder_policy) AND json_type(NEW.reminder_policy) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.reminder_policy)) = 2
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.reminder_policy)
        WHERE key NOT IN ('first_after_days','every_days')
      )
      AND json_type(NEW.reminder_policy, '$.first_after_days') = 'integer'
      AND json_extract(NEW.reminder_policy, '$.first_after_days')
        BETWEEN 0 AND 9007199254740991
      AND json_type(NEW.reminder_policy, '$.every_days') = 'integer'
      AND json_extract(NEW.reminder_policy, '$.every_days')
        BETWEEN 1 AND 9007199254740991
    )
    BEGIN SELECT RAISE(ABORT, 'invoice reminder policy shape is invalid'); END`,
  `CREATE TRIGGER invoices_d22_reminder_policy_update
    BEFORE UPDATE OF reminder_policy ON invoices
    WHEN OLD.reminder_policy IS NOT NEW.reminder_policy AND NEW.reminder_policy IS NOT NULL
      AND NOT (
        json_valid(NEW.reminder_policy) AND json_type(NEW.reminder_policy) = 'object'
        AND (SELECT count(*) FROM json_each(NEW.reminder_policy)) = 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.reminder_policy)
          WHERE key NOT IN ('first_after_days','every_days')
        )
        AND json_type(NEW.reminder_policy, '$.first_after_days') = 'integer'
        AND json_extract(NEW.reminder_policy, '$.first_after_days')
          BETWEEN 0 AND 9007199254740991
        AND json_type(NEW.reminder_policy, '$.every_days') = 'integer'
        AND json_extract(NEW.reminder_policy, '$.every_days')
          BETWEEN 1 AND 9007199254740991
      )
    BEGIN SELECT RAISE(ABORT, 'invoice reminder policy shape is invalid'); END`,
  `CREATE TRIGGER invoice_period_d22_derived_update
    BEFORE UPDATE OF period_start, period_end ON invoices
    WHEN OLD.period_start IS NOT NEW.period_start OR OLD.period_end IS NOT NEW.period_end
    BEGIN SELECT RAISE(ABORT, 'invoice period is derived and cannot be edited directly'); END`,
  `CREATE TRIGGER invoice_financials_d22_command_update
    BEFORE UPDATE OF tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm ON invoices
    WHEN NOT EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = OLD.id AND command.completed = 0
        AND command.command_kind = 'invoice.financials_update'
        AND command.expected_invoice_version = OLD.version
    ) AND NOT (
      OLD.harvest_id IS NULL AND OLD.state = 'draft' AND OLD.version = 0
      AND OLD.sent_at IS NULL AND OLD.closed_at IS NULL AND OLD.close_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = OLD.id
      ) AND NOT EXISTS (
        SELECT 1 FROM invoice_messages message WHERE message.invoice_id = OLD.id
      ) AND NOT EXISTS (
        SELECT 1 FROM event_outbox event
        WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice financial mutation requires its pending command'); END`,
  `CREATE TRIGGER invoice_line_items_d22_closed_insert
    BEFORE INSERT ON invoice_line_items
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
      WHERE invoice.id = NEW.invoice_id AND invoice.state <> 'closed'
        AND command.completed = 0 AND command.command_kind = 'invoice.line_insert'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoices invoice WHERE invoice.id = NEW.invoice_id
        AND invoice.harvest_id IS NULL AND invoice.state = 'draft' AND invoice.version = 0
        AND invoice.sent_at IS NULL AND invoice.closed_at IS NULL
        AND invoice.close_reason IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
        )
    ) AND NOT (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import,
        json_each(import.line_manifest_json) member
      WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
        AND json_extract(member.value, '$.id') = NEW.id
        AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
        AND json_extract(member.value, '$.updated_at') = NEW.updated_at
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice line insert requires its pending command'); END`,
  `CREATE TRIGGER invoice_line_items_d22_closed_update
    BEFORE UPDATE ON invoice_line_items
    WHEN OLD.invoice_id <> NEW.invoice_id OR NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
      WHERE invoice.id = OLD.invoice_id AND invoice.state <> 'closed'
        AND command.completed = 0 AND command.command_kind = 'invoice.line_update'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoices invoice WHERE invoice.id = OLD.invoice_id
        AND invoice.harvest_id IS NULL AND invoice.state = 'draft' AND invoice.version = 0
        AND invoice.sent_at IS NULL AND invoice.closed_at IS NULL
        AND invoice.close_reason IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
        )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice line update requires its pending command'); END`,
  `CREATE TRIGGER invoice_line_items_d22_closed_delete
    BEFORE DELETE ON invoice_line_items
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN invoice_command_ledger command ON command.invoice_id = invoice.id
      WHERE invoice.id = OLD.invoice_id AND invoice.state <> 'closed'
        AND command.completed = 0 AND command.command_kind = 'invoice.line_delete'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoices invoice WHERE invoice.id = OLD.invoice_id
        AND invoice.harvest_id IS NULL AND invoice.state = 'draft' AND invoice.version = 0
        AND invoice.sent_at IS NULL AND invoice.closed_at IS NULL
        AND invoice.close_reason IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id
        ) AND NOT EXISTS (
          SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id
        )
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(import.line_manifest_json) member
          WHERE json_extract(member.value, '$.id') = OLD.id
            AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
            AND json_extract(member.value, '$.updated_at') = OLD.updated_at
        )
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice line delete requires its pending command'); END`,
  `CREATE TRIGGER invoices_d22_closed_financials_update
    BEFORE UPDATE OF tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, written_off_cents
    ON invoices
    WHEN OLD.state = 'closed' AND NOT EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = OLD.id AND command.completed = 0
        AND command.command_kind = 'invoice.reopen'
        AND command.expected_invoice_version = OLD.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.id AND import.completed = 0
        AND OLD.harvest_id IS NOT NULL
        AND OLD.source_updated_at IS import.expected_source_updated_at
        AND NEW.source_updated_at = import.source_updated_at
        AND NEW.version = import.target_version
        AND NEW.written_off_cents = import.target_written_off_cents
    )
    BEGIN SELECT RAISE(ABORT, 'closed invoice financials are immutable'); END`,
] as const

type MigrationPreflightRow = { id: number; code: string }

const assertInvoiceLifecyclePreflight = (rows: MigrationPreflightRow[]): void => {
  if (rows.length === 0) return
  const shown = rows
    .slice(0, 10)
    .map(({ id }) => id)
    .join(',')
  const more = rows.length > 10 ? ',…' : ''
  throw new Error(
    `invoice lifecycle migration preflight failed: code=${rows[0]!.code} invoice_ids=${shown}${more}`,
  )
}

const migrations = [
  { id: '0000_org_people', statements: orgPeopleMigration },
  { id: '0001_clients', statements: clientsMigration },
  { id: '0002_projects_time', statements: projectsTimeMigration },
  { id: '0003_rate_resolver', statements: rateResolverMigration },
  { id: '0004_invoice_foundation', statements: invoiceFoundationMigration },
  { id: '0005_invoice_payments_totals', statements: invoicePaymentsTotalsMigration },
  {
    id: '0006_invoice_state_events',
    statements: invoiceLifecycleMigration,
    preflight: invoiceLifecyclePreflight,
  },
  { id: '0007_expenses', statements: expensesMigration },
  { id: '0008_retainer_ledger', statements: retainerLedgerMigration },
  { id: '0009_three_axis_state', statements: threeAxisStateMigration },
  { id: '0010_recurring_invoices', statements: recurringInvoicesMigration },
  { id: '0011_api_tokens', statements: apiTokensMigration },
  { id: '0012_instance_bootstrap', statements: instanceBootstrapMigration },
] as const

export const migrateContainer = (database: BetterSqlite3.Database): void => {
  database.pragma('foreign_keys = ON')
  database.exec(ledger)
  for (const migration of migrations) {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (database.prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?').get(migration.id)) {
        database.exec('COMMIT')
        continue
      }
      if ('preflight' in migration) {
        assertInvoiceLifecyclePreflight(
          database.prepare(migration.preflight).all() as MigrationPreflightRow[],
        )
      }
      for (const statement of migration.statements) database.exec(statement)
      database
        .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

export const migrateD1 = async (database: D1Database): Promise<void> => {
  // The ledger insert leads the atomic batch. If two Worker isolates observe a
  // migration as absent, D1 serializes their batches: one commits the complete
  // migration and the other's unique ledger insert aborts before any DDL runs.
  // Re-reading the ledger distinguishes that safe race from a real migration
  // failure. This retains the deploy/admin seam while making a cold runtime's
  // fail-closed readiness check safe and idempotent.
  await database.exec('PRAGMA foreign_keys = ON')
  await database.prepare(ledger).run()
  for (const migration of migrations) {
    if (
      await database
        .prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?')
        .bind(migration.id)
        .first()
    ) {
      continue
    }
    if ('preflight' in migration) {
      assertInvoiceLifecyclePreflight(
        (await database.prepare(migration.preflight).all<MigrationPreflightRow>()).results,
      )
    }
    try {
      await database.batch([
        database
          .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
          .bind(migration.id, new Date().toISOString()),
        ...migration.statements.map((sql) => database.prepare(sql)),
      ])
    } catch (error) {
      const completed = await database
        .prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?')
        .bind(migration.id)
        .first()
      if (completed === null) throw error
    }
  }
}
