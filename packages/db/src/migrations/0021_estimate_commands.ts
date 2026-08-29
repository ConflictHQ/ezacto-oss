// Provenance: ezacto-oss #15; D21/D22; domain model §2.14-2.19; DV-6.
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

export const estimateCommandsMigration = [
  `CREATE TABLE estimate_command_ledger (
    estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    command_kind TEXT NOT NULL CHECK (command_kind IN (
      'estimate.send','estimate.accept','estimate.decline','estimate.re-open','estimate.convert'
    )),
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    actor_user_id INTEGER NOT NULL,
    expected_estimate_version INTEGER NOT NULL
      CHECK (expected_estimate_version BETWEEN 0 AND 9007199254740991),
    message_id INTEGER NOT NULL UNIQUE,
    invoice_id INTEGER UNIQUE,
    event_id TEXT UNIQUE,
    occurred_at TEXT NOT NULL CHECK (${canonicalTimestamp('occurred_at')}),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
    result_json TEXT,
    completed_at TEXT,
    PRIMARY KEY (estimate_id, command_id),
    CHECK (
      (command_kind = 'estimate.convert' AND invoice_id IS NOT NULL AND event_id IS NOT NULL)
      OR (command_kind <> 'estimate.convert' AND invoice_id IS NULL AND event_id IS NULL)
    ),
    CHECK (
      (completed = 0 AND result_json IS NULL AND completed_at IS NULL)
      OR (completed = 1 AND result_json IS NOT NULL AND json_valid(result_json)
        AND json_extract(result_json, '$.schema_version') = 1
        AND completed_at IS NOT NULL AND (${canonicalTimestamp('completed_at')}))
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX estimate_messages_invoice_event_unique
    ON estimate_messages(estimate_id) WHERE event_type = 'invoice'`,
  `CREATE TRIGGER estimate_command_ledger_reject_identity_collision
    BEFORE INSERT ON estimate_command_ledger
    WHEN EXISTS (
      SELECT 1 FROM estimate_command_ledger existing
      WHERE existing.estimate_id = NEW.estimate_id
        AND existing.command_id = NEW.command_id
    ) OR EXISTS (
      SELECT 1 FROM estimate_command_ledger existing
      WHERE existing.message_id = NEW.message_id
    ) OR (NEW.invoice_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimate_command_ledger existing
      WHERE existing.invoice_id = NEW.invoice_id
    )) OR (NEW.event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM estimate_command_ledger existing
      WHERE existing.event_id = NEW.event_id
    ))
    BEGIN SELECT RAISE(ABORT, 'estimate command identity already exists'); END`,
  `CREATE TRIGGER estimate_messages_invoice_event_reject_collision
    BEFORE INSERT ON estimate_messages
    WHEN NEW.event_type = 'invoice' AND EXISTS (
      SELECT 1 FROM estimate_messages existing
      WHERE existing.estimate_id = NEW.estimate_id
        AND existing.event_type = 'invoice'
    )
    BEGIN SELECT RAISE(ABORT, 'estimate invoice event already exists'); END`,
  `CREATE TRIGGER estimate_command_ledger_causation_immutable
    BEFORE UPDATE OF estimate_id, command_id, command_kind, input_fingerprint,
      actor_user_id, expected_estimate_version, message_id, invoice_id, event_id, occurred_at
    ON estimate_command_ledger
    BEGIN SELECT RAISE(ABORT, 'estimate command causation is immutable'); END`,
  `CREATE TRIGGER estimate_command_ledger_completion_immutable
    BEFORE UPDATE OF completed, result_json, completed_at ON estimate_command_ledger
    WHEN OLD.completed = 1 OR NEW.completed < OLD.completed
    BEGIN SELECT RAISE(ABORT, 'estimate command completion is immutable'); END`,
  `CREATE TRIGGER estimate_command_ledger_reject_delete
    BEFORE DELETE ON estimate_command_ledger
    BEGIN SELECT RAISE(ABORT, 'estimate command receipts are append-only'); END`,
  `DROP TRIGGER event_outbox_insert_guard`,
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
        WHEN NEW.aggregate_type = 'invoice' AND NEW.event_type = 'invoice.created' AND (
            NEW.command_id IS NULL OR NEW.event_index IS NOT 0
            OR NEW.available_at IS NOT NEW.occurred_at
            OR NOT EXISTS (
              SELECT 1 FROM estimate_command_ledger command
              JOIN invoices invoice ON invoice.id = command.invoice_id
              WHERE command.estimate_id = invoice.estimate_id
                AND command.command_id = NEW.command_id
                AND command.command_kind = 'estimate.convert'
                AND command.invoice_id = NEW.aggregate_id
                AND command.event_id = NEW.id
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
                AND json_extract(NEW.payload_json, '$.command.event_index') = NEW.event_index
                AND json_extract(NEW.payload_json, '$.actor.type') = 'user'
                AND json_extract(NEW.payload_json, '$.actor.id') = command.actor_user_id
                AND json_extract(NEW.payload_json, '$.trigger.type') = 'estimate_message'
                AND json_extract(NEW.payload_json, '$.trigger.id') = command.message_id
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
            )
          ) THEN RAISE(ABORT, 'invoice creation event requires its pending estimate command')
        WHEN NEW.aggregate_type = 'invoice' AND NEW.event_type <> 'invoice.created' AND (
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
                AND json_extract(NEW.payload_json, '$.invoice.after.payment_count') = (
                  SELECT count(*) FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
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
                        SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id
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
                  WHEN command.command_kind = 'invoice.financials_update' THEN 'invoice_financials'
                END
            )
          ) THEN RAISE(ABORT, 'invoice outbox event requires its pending command')
      END;
    END`,
] as const
