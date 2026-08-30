const timestampMilliseconds = (column: string) =>
  `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000
    + CASE WHEN instr(${column}, '.') = 0 THEN 0 ELSE
      CAST(substr(${column}, 21, length(${column}) - 21)
        || substr('000', 1, 3 - (length(${column}) - 21)) AS INTEGER)
    END)`

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

/** Narrow authority and source identity required by the snapshot loader. */
export const migrationImportAuthorityMigration = [
  `CREATE TABLE invoice_import_operations (
    invoice_id INTEGER NOT NULL,
    source_updated_at TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('line','message','payment')),
    action TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
    harvest_id INTEGER NOT NULL CHECK (harvest_id BETWEEN 1 AND 9007199254740991),
    native_id INTEGER CHECK (native_id BETWEEN 1 AND 9007199254740991),
    old_updated_at TEXT,
    new_updated_at TEXT,
    input_fingerprint TEXT NOT NULL CHECK (
      length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
    PRIMARY KEY (invoice_id, source_updated_at, resource_kind, action, harvest_id),
    FOREIGN KEY (invoice_id, source_updated_at)
      REFERENCES invoice_import_reconciliations(invoice_id, source_updated_at)
      ON DELETE RESTRICT,
    CHECK (old_updated_at IS NULL OR (${canonicalTimestamp('old_updated_at')})),
    CHECK (new_updated_at IS NULL OR (${canonicalTimestamp('new_updated_at')})),
    CHECK ((action = 'insert' AND old_updated_at IS NULL AND new_updated_at IS NOT NULL)
      OR (action = 'update' AND old_updated_at IS NOT NULL AND new_updated_at IS NOT NULL)
      OR (action = 'delete' AND old_updated_at IS NOT NULL AND new_updated_at IS NULL)),
    CHECK (action = 'insert' OR native_id IS NOT NULL)
  ) STRICT`,
  `CREATE UNIQUE INDEX invoice_import_operations_pending_invoice_unique
    ON invoice_import_operations(invoice_id) WHERE completed = 0`,
  `CREATE TRIGGER invoice_import_operations_insert_guard
    BEFORE INSERT ON invoice_import_operations
    WHEN NEW.completed <> 0 OR NOT EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = NEW.invoice_id
        AND import.source_updated_at = NEW.source_updated_at
        AND import.input_fingerprint = NEW.input_fingerprint
        AND import.completed = 0
    )
    BEGIN SELECT RAISE(ABORT, 'invoice import operation authority is invalid'); END`,
  `CREATE TRIGGER invoice_import_operations_update_guard
    BEFORE UPDATE ON invoice_import_operations
    WHEN OLD.invoice_id IS NOT NEW.invoice_id
      OR OLD.source_updated_at IS NOT NEW.source_updated_at
      OR OLD.resource_kind IS NOT NEW.resource_kind OR OLD.action IS NOT NEW.action
      OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.old_updated_at IS NOT NEW.old_updated_at
      OR OLD.new_updated_at IS NOT NEW.new_updated_at
      OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
      OR OLD.completed = 1
      OR NOT (
        (OLD.action = 'insert' AND OLD.native_id IS NULL AND NEW.native_id IS NOT NULL
          AND OLD.completed = 0 AND NEW.completed = 0
          AND CASE OLD.resource_kind
            WHEN 'line' THEN EXISTS (SELECT 1 FROM invoice_line_items child
              WHERE child.invoice_id = OLD.invoice_id AND child.id = NEW.native_id
                AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
            WHEN 'message' THEN EXISTS (SELECT 1 FROM invoice_messages child
              WHERE child.invoice_id = OLD.invoice_id AND child.id = NEW.native_id
                AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
            WHEN 'payment' THEN EXISTS (SELECT 1 FROM invoice_payments child
              WHERE child.invoice_id = OLD.invoice_id AND child.id = NEW.native_id
                AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
          END)
        OR (OLD.native_id IS NEW.native_id AND OLD.completed = 0 AND NEW.completed = 1
          AND CASE
            WHEN OLD.action IN ('insert','update') AND OLD.resource_kind = 'line'
              THEN EXISTS (SELECT 1 FROM invoice_line_items child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
            WHEN OLD.action IN ('insert','update') AND OLD.resource_kind = 'message'
              THEN EXISTS (SELECT 1 FROM invoice_messages child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
            WHEN OLD.action IN ('insert','update') AND OLD.resource_kind = 'payment'
              THEN EXISTS (SELECT 1 FROM invoice_payments child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id AND child.updated_at = OLD.new_updated_at)
            WHEN OLD.action = 'delete' AND OLD.resource_kind = 'line'
              THEN NOT EXISTS (SELECT 1 FROM invoice_line_items child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id)
            WHEN OLD.action = 'delete' AND OLD.resource_kind = 'message'
              THEN NOT EXISTS (SELECT 1 FROM invoice_messages child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id)
            WHEN OLD.action = 'delete' AND OLD.resource_kind = 'payment'
              THEN NOT EXISTS (SELECT 1 FROM invoice_payments child
                WHERE child.invoice_id = OLD.invoice_id AND child.id = OLD.native_id
                  AND child.harvest_id = OLD.harvest_id)
            ELSE 0
          END)
      )
    BEGIN SELECT RAISE(ABORT, 'invoice import operation transition is invalid'); END`,
  `CREATE TRIGGER invoice_import_operations_delete_guard
    BEFORE DELETE ON invoice_import_operations
    BEGIN SELECT RAISE(ABORT, 'invoice import operation receipts are immutable'); END`,
  `DROP TRIGGER invoice_import_reconciliations_insert_guard`,
  `CREATE TRIGGER invoice_import_reconciliations_insert_guard
    BEFORE INSERT ON invoice_import_reconciliations
    WHEN EXISTS (
      SELECT 1 FROM invoice_import_reconciliations existing
      WHERE existing.invoice_id = NEW.invoice_id
        AND (existing.source_updated_at = NEW.source_updated_at OR existing.completed = 0)
    ) OR json_extract(NEW.source_manifest_json, '$.invoice_id') <> NEW.invoice_id
      OR json_extract(NEW.source_manifest_json, '$.source_updated_at') <> NEW.source_updated_at
      OR EXISTS (
        SELECT 1 FROM (
          SELECT value FROM json_each(NEW.line_manifest_json)
          UNION ALL SELECT value FROM json_each(NEW.message_manifest_json)
          UNION ALL SELECT value FROM json_each(NEW.payment_manifest_json)
        ) member
        WHERE json_type(member.value, '$.id') <> 'integer'
          OR json_extract(member.value, '$.id') < 0
          OR json_type(member.value, '$.harvest_id') <> 'integer'
          OR json_extract(member.value, '$.harvest_id') <= 0
          OR json_type(member.value, '$.updated_at') <> 'text'
      ) OR NOT EXISTS (
        SELECT 1 FROM invoices invoice
        WHERE invoice.id = NEW.invoice_id AND invoice.harvest_id IS NOT NULL
          AND invoice.version + 1 = NEW.target_version
          AND invoice.source_updated_at IS NEW.expected_source_updated_at
          AND NEW.target_updated_at = NEW.source_updated_at
          AND (invoice.source_updated_at IS NULL OR
            ${timestampMilliseconds('NEW.source_updated_at')} >
              ${timestampMilliseconds('invoice.source_updated_at')})
      )
    BEGIN SELECT RAISE(ABORT, 'invoice import reconciliation authority is invalid'); END`,
  `DROP TRIGGER invoice_import_reconciliations_update_guard`,
  `CREATE TRIGGER invoice_import_reconciliations_update_guard
    BEFORE UPDATE ON invoice_import_reconciliations
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
      OR OLD.completed = 1
      OR (OLD.completed = 0 AND NEW.completed = 1 AND NOT EXISTS (
        SELECT 1 FROM invoices invoice
        WHERE invoice.id = OLD.invoice_id AND invoice.harvest_id IS NOT NULL
          AND invoice.source_updated_at = OLD.source_updated_at
          AND invoice.version = OLD.target_version AND invoice.updated_at = OLD.target_updated_at
          AND invoice.state = OLD.target_state
          AND invoice.close_reason IS OLD.target_close_reason
          AND invoice.close_write_off_cents = OLD.target_close_write_off_cents
          AND invoice.written_off_cents = OLD.target_written_off_cents
          AND invoice.sent_at IS OLD.target_sent_at
          AND invoice.paid_at IS OLD.target_paid_at
          AND invoice.paid_date IS OLD.target_paid_date
          AND invoice.closed_at IS OLD.target_closed_at
          AND OLD.outbox_count_before = (
            SELECT count(*) FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.invoice_id)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_import_operations operation
            WHERE operation.invoice_id = OLD.invoice_id
              AND operation.source_updated_at = OLD.source_updated_at
              AND operation.completed = 0)
          AND json_array_length(OLD.line_manifest_json) = (
            SELECT count(*) FROM invoice_line_items line
            WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_line_items line
            WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.line_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = line.id
                    OR (json_extract(member.value, '$.id') = 0 AND EXISTS (
                      SELECT 1 FROM invoice_import_operations operation
                      WHERE operation.invoice_id = OLD.invoice_id
                        AND operation.source_updated_at = OLD.source_updated_at
                        AND operation.resource_kind = 'line' AND operation.action = 'insert'
                        AND operation.harvest_id = line.harvest_id
                        AND operation.native_id = line.id AND operation.completed = 1)))
                  AND json_extract(member.value, '$.harvest_id') = line.harvest_id
                  AND json_extract(member.value, '$.updated_at') = line.updated_at))
          AND json_array_length(OLD.message_manifest_json) = (
            SELECT count(*) FROM invoice_messages message
            WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_messages message
            WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.message_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = message.id
                    OR (json_extract(member.value, '$.id') = 0 AND EXISTS (
                      SELECT 1 FROM invoice_import_operations operation
                      WHERE operation.invoice_id = OLD.invoice_id
                        AND operation.source_updated_at = OLD.source_updated_at
                        AND operation.resource_kind = 'message' AND operation.action = 'insert'
                        AND operation.harvest_id = message.harvest_id
                        AND operation.native_id = message.id AND operation.completed = 1)))
                  AND json_extract(member.value, '$.harvest_id') = message.harvest_id
                  AND json_extract(member.value, '$.updated_at') = message.updated_at))
          AND json_array_length(OLD.payment_manifest_json) = (
            SELECT count(*) FROM invoice_payments payment
            WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_payments payment
            WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.payment_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = payment.id
                    OR (json_extract(member.value, '$.id') = 0 AND EXISTS (
                      SELECT 1 FROM invoice_import_operations operation
                      WHERE operation.invoice_id = OLD.invoice_id
                        AND operation.source_updated_at = OLD.source_updated_at
                        AND operation.resource_kind = 'payment' AND operation.action = 'insert'
                        AND operation.harvest_id = payment.harvest_id
                        AND operation.native_id = payment.id AND operation.completed = 1)))
                  AND json_extract(member.value, '$.harvest_id') = payment.harvest_id
                  AND json_extract(member.value, '$.updated_at') = payment.updated_at))
      ))
    BEGIN SELECT RAISE(ABORT, 'invoice import reconciliation target is incomplete'); END`,
  `DROP TRIGGER invoice_messages_d22_insert_guard`,
  `CREATE TRIGGER invoice_messages_d22_insert_guard
    BEFORE INSERT ON invoice_messages
    WHEN NOT (NEW.harvest_id IS NULL AND EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = NEW.invoice_id AND command.completed = 0
        AND NEW.event_type = CASE command.command_kind
          WHEN 'invoice.send' THEN 'send' WHEN 'invoice.view' THEN 'view'
          WHEN 'invoice.draft' THEN 'draft' WHEN 'invoice.cancel' THEN 'cancel'
          WHEN 'invoice.write_off' THEN 'write_off' WHEN 'invoice.reopen' THEN 're-open'
          WHEN 'invoice.source_close' THEN 'close' END
    )) AND NOT (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = NEW.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'message' AND operation.action = 'insert'
        AND operation.harvest_id = NEW.harvest_id
        AND ((operation.native_id IS NULL AND NEW.id = -1) OR operation.native_id = NEW.id)
        AND operation.new_updated_at = NEW.updated_at
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice message insert requires exact pending authority'); END`,
  `CREATE TRIGGER invoice_messages_d23_import_insert_bind
    AFTER INSERT ON invoice_messages
    WHEN NEW.harvest_id IS NOT NULL
    BEGIN
      UPDATE invoice_import_operations SET native_id = NEW.id
      WHERE invoice_id = NEW.invoice_id AND resource_kind = 'message' AND action = 'insert'
        AND harvest_id = NEW.harvest_id AND new_updated_at = NEW.updated_at
        AND native_id IS NULL AND completed = 0;
    END`,
  `DROP TRIGGER invoice_messages_d22_source_update_guard`,
  `CREATE TRIGGER invoice_messages_d22_source_update_guard
    BEFORE UPDATE ON invoice_messages
    WHEN OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.sent_by IS NOT NEW.sent_by
      OR OLD.sent_by_email IS NOT NEW.sent_by_email OR OLD.sent_from IS NOT NEW.sent_from
      OR OLD.sent_from_email IS NOT NEW.sent_from_email OR OLD.created_at IS NOT NEW.created_at
      OR ((OLD.recipients IS NOT NEW.recipients OR OLD.subject IS NOT NEW.subject
        OR OLD.body IS NOT NEW.body OR OLD.attach_pdf IS NOT NEW.attach_pdf
        OR OLD.send_me_a_copy IS NOT NEW.send_me_a_copy
        OR OLD.thank_you IS NOT NEW.thank_you OR OLD.reminder IS NOT NEW.reminder
        OR OLD.send_reminder_on IS NOT NEW.send_reminder_on
        OR OLD.event_type IS NOT NEW.event_type OR OLD.updated_at IS NOT NEW.updated_at)
        AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM invoice_import_operations operation
          WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
            AND operation.resource_kind = 'message' AND operation.action = 'update'
            AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
            AND operation.old_updated_at = OLD.updated_at
            AND operation.new_updated_at = NEW.updated_at)))
    BEGIN SELECT RAISE(ABORT, 'invoice message source mutation requires exact import authority'); END`,
  `DROP TRIGGER invoice_messages_d22_delete_guard`,
  `CREATE TRIGGER invoice_messages_d22_delete_guard
    BEFORE DELETE ON invoice_messages
    WHEN NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'message' AND operation.action = 'delete'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice message delete requires exact import authority'); END`,
  `DROP TRIGGER invoice_payments_d22_state_insert`,
  `CREATE TRIGGER invoice_payments_d22_state_insert
    BEFORE INSERT ON invoice_payments
    WHEN NOT (NEW.harvest_id IS NULL AND EXISTS (
      SELECT 1 FROM invoices invoice JOIN invoice_command_ledger command
        ON command.invoice_id = invoice.id
      WHERE invoice.id = NEW.invoice_id AND invoice.state IN ('open','paid')
        AND command.completed = 0 AND command.command_kind = 'payment.record'
        AND command.expected_invoice_version = invoice.version
    )) AND NOT (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      JOIN invoice_import_reconciliations import
        ON import.invoice_id = operation.invoice_id
          AND import.source_updated_at = operation.source_updated_at
      WHERE operation.invoice_id = NEW.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'payment' AND operation.action = 'insert'
        AND operation.harvest_id = NEW.harvest_id
        AND ((operation.native_id IS NULL AND NEW.id = -1) OR operation.native_id = NEW.id)
        AND operation.new_updated_at = NEW.updated_at AND import.target_state <> 'draft'))
    BEGIN SELECT RAISE(ABORT, 'invoice payment insert requires its pending command'); END`,
  `CREATE TRIGGER invoice_payments_d23_import_insert_bind
    AFTER INSERT ON invoice_payments
    WHEN NEW.harvest_id IS NOT NULL
    BEGIN
      UPDATE invoice_import_operations SET native_id = NEW.id
      WHERE invoice_id = NEW.invoice_id AND resource_kind = 'payment' AND action = 'insert'
        AND harvest_id = NEW.harvest_id AND new_updated_at = NEW.updated_at
        AND native_id IS NULL AND completed = 0;
    END`,
  `DROP TRIGGER invoice_payments_imported_immutable`,
  `CREATE TRIGGER invoice_payments_imported_immutable
    BEFORE UPDATE OF amount_cents, paid_at, paid_date, notes, updated_at ON invoice_payments
    WHEN OLD.harvest_id IS NOT NULL AND (
      OLD.amount_cents IS NOT NEW.amount_cents OR OLD.paid_at IS NOT NEW.paid_at
      OR OLD.paid_date IS NOT NEW.paid_date OR OLD.notes IS NOT NEW.notes
      OR OLD.updated_at IS NOT NEW.updated_at
    ) AND NOT EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'payment' AND operation.action = 'update'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at
        AND operation.new_updated_at = NEW.updated_at)
    BEGIN SELECT RAISE(ABORT, 'imported invoice payment is immutable'); END`,
  `DROP TRIGGER invoice_payments_d22_state_update`,
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
      AND ((OLD.recorded_by_user_id IS NULL AND NEW.recorded_by_user_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM users WHERE id = NEW.recorded_by_user_id))
        OR (OLD.recorded_by_user_id IS NOT NULL AND NEW.recorded_by_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.recorded_by_user_id)))
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
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'payment' AND operation.action = 'update'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at
        AND operation.new_updated_at = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice payment update requires its pending command'); END`,
  `CREATE TRIGGER invoice_payments_d23_import_update_guard
    BEFORE UPDATE ON invoice_payments
    WHEN OLD.harvest_id IS NOT NULL AND (
      OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.currency IS NOT NEW.currency
      OR OLD.paid_at IS NOT NEW.paid_at OR OLD.paid_date IS NOT NEW.paid_date
      OR OLD.source_paid_at IS NOT NEW.source_paid_at
      OR OLD.source_paid_date IS NOT NEW.source_paid_date
      OR OLD.source_recorded_by_name IS NOT NEW.source_recorded_by_name
      OR OLD.source_recorded_by_email IS NOT NEW.source_recorded_by_email
      OR OLD.source_gateway_id IS NOT NEW.source_gateway_id
      OR OLD.source_gateway_name IS NOT NEW.source_gateway_name
      OR OLD.provider IS NOT NEW.provider OR OLD.provider_shape IS NOT NEW.provider_shape
      OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
      OR OLD.created_at IS NOT NEW.created_at
      OR ((OLD.amount_cents IS NOT NEW.amount_cents OR OLD.notes IS NOT NEW.notes
        OR OLD.recorded_by_user_id IS NOT NEW.recorded_by_user_id
        OR OLD.updated_at IS NOT NEW.updated_at) AND NOT EXISTS (
        SELECT 1 FROM invoice_import_operations operation
        WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
          AND operation.resource_kind = 'payment' AND operation.action = 'update'
          AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
          AND operation.old_updated_at = OLD.updated_at
          AND operation.new_updated_at = NEW.updated_at
      ) AND NOT (
        ((OLD.recorded_by_user_id IS NULL AND NEW.recorded_by_user_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM users WHERE id = NEW.recorded_by_user_id))
          OR (OLD.recorded_by_user_id IS NOT NULL AND NEW.recorded_by_user_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.recorded_by_user_id)))
        AND OLD.amount_cents IS NEW.amount_cents AND OLD.notes IS NEW.notes
        AND OLD.updated_at IS NEW.updated_at
      ))
    )
    BEGIN SELECT RAISE(ABORT, 'invoice payment update requires exact import authority'); END`,
  `DROP TRIGGER invoice_payments_d22_state_delete`,
  `CREATE TRIGGER invoice_payments_d22_state_delete
    BEFORE DELETE ON invoice_payments
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice JOIN invoice_command_ledger command
        ON command.invoice_id = invoice.id
      WHERE invoice.id = OLD.invoice_id AND invoice.state IN ('open','paid')
        AND command.completed = 0 AND command.command_kind = 'payment.delete'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'payment' AND operation.action = 'delete'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice payment delete requires its pending command'); END`,
  `DROP TRIGGER invoice_line_items_d22_closed_insert`,
  `CREATE TRIGGER invoice_line_items_d22_closed_insert
    BEFORE INSERT ON invoice_line_items
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice JOIN invoice_command_ledger command
        ON command.invoice_id = invoice.id
      WHERE invoice.id = NEW.invoice_id AND invoice.state <> 'closed'
        AND command.completed = 0 AND command.command_kind = 'invoice.line_insert'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoices invoice WHERE invoice.id = NEW.invoice_id
        AND invoice.harvest_id IS NULL AND invoice.state = 'draft' AND invoice.version = 0
        AND NOT EXISTS (SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id)
    ) AND NOT (NEW.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = NEW.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'line' AND operation.action = 'insert'
        AND operation.harvest_id = NEW.harvest_id
        AND ((operation.native_id IS NULL AND NEW.id = -1) OR operation.native_id = NEW.id)
        AND operation.new_updated_at = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice line insert requires its pending command'); END`,
  `CREATE TRIGGER invoice_line_items_d23_import_insert_bind
    AFTER INSERT ON invoice_line_items
    WHEN NEW.harvest_id IS NOT NULL
    BEGIN
      UPDATE invoice_import_operations SET native_id = NEW.id
      WHERE invoice_id = NEW.invoice_id AND resource_kind = 'line' AND action = 'insert'
        AND harvest_id = NEW.harvest_id AND new_updated_at = NEW.updated_at
        AND native_id IS NULL AND completed = 0;
    END`,
  `DROP TRIGGER invoice_line_items_d22_closed_update`,
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
        AND NOT EXISTS (SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id)
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'line' AND operation.action = 'update'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at
        AND operation.new_updated_at = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice line update requires its pending command'); END`,
  `CREATE TRIGGER invoice_line_items_d23_import_update_guard
    BEFORE UPDATE ON invoice_line_items
    WHEN OLD.harvest_id IS NOT NULL
      AND (OLD.position IS NOT NEW.position OR OLD.kind IS NOT NEW.kind
        OR OLD.description IS NOT NEW.description OR OLD.quantity IS NOT NEW.quantity
        OR OLD.unit_price_cents IS NOT NEW.unit_price_cents
        OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.taxed IS NOT NEW.taxed
        OR OLD.taxed2 IS NOT NEW.taxed2 OR OLD.project_id IS NOT NEW.project_id
        OR OLD.updated_at IS NOT NEW.updated_at)
      AND NOT EXISTS (
        SELECT 1 FROM invoice_import_operations operation
        WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
          AND operation.resource_kind = 'line' AND operation.action = 'update'
          AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
          AND operation.old_updated_at = OLD.updated_at
          AND operation.new_updated_at = NEW.updated_at
      )
    BEGIN SELECT RAISE(ABORT, 'invoice line update requires exact import authority'); END`,
  `CREATE TRIGGER invoice_line_items_d23_import_identity_guard
    BEFORE UPDATE ON invoice_line_items
    WHEN OLD.harvest_id IS NOT NULL AND (
      OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.created_at IS NOT NEW.created_at)
    BEGIN SELECT RAISE(ABORT, 'invoice line identity is immutable'); END`,
  `DROP TRIGGER invoice_line_items_d22_closed_delete`,
  `CREATE TRIGGER invoice_line_items_d22_closed_delete
    BEFORE DELETE ON invoice_line_items
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice JOIN invoice_command_ledger command
        ON command.invoice_id = invoice.id
      WHERE invoice.id = OLD.invoice_id AND invoice.state <> 'closed'
        AND command.completed = 0 AND command.command_kind = 'invoice.line_delete'
        AND command.expected_invoice_version = invoice.version
    ) AND NOT EXISTS (
      SELECT 1 FROM invoices invoice WHERE invoice.id = OLD.invoice_id
        AND invoice.harvest_id IS NULL AND invoice.state = 'draft' AND invoice.version = 0
        AND NOT EXISTS (SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_messages message WHERE message.invoice_id = invoice.id)
        AND NOT EXISTS (SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = invoice.id)
    ) AND NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_operations operation
      WHERE operation.invoice_id = OLD.invoice_id AND operation.completed = 0
        AND operation.resource_kind = 'line' AND operation.action = 'delete'
        AND operation.harvest_id = OLD.harvest_id AND operation.native_id = OLD.id
        AND operation.old_updated_at = OLD.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice line delete requires its pending command'); END`,
  `DROP TRIGGER invoice_period_d22_derived_update`,
  `CREATE TRIGGER invoice_period_d22_derived_update
    BEFORE UPDATE OF period_start, period_end ON invoices
    WHEN (OLD.period_start IS NOT NEW.period_start OR OLD.period_end IS NOT NEW.period_end)
      AND NOT EXISTS (SELECT 1 FROM invoice_import_reconciliations import
        WHERE import.invoice_id = OLD.id AND import.completed = 0
          AND OLD.harvest_id IS NOT NULL
          AND import.expected_source_updated_at IS OLD.source_updated_at)
    BEGIN SELECT RAISE(ABORT, 'invoice period is derived and cannot be edited directly'); END`,
  `DROP TRIGGER invoice_financials_d22_command_update`,
  `CREATE TRIGGER invoice_financials_d22_command_update
    BEFORE UPDATE OF tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm ON invoices
    WHEN NOT EXISTS (SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = OLD.id AND command.completed = 0
        AND command.command_kind = 'invoice.financials_update'
        AND command.expected_invoice_version = OLD.version)
      AND NOT (OLD.harvest_id IS NULL AND OLD.state = 'draft' AND OLD.version = 0
        AND OLD.sent_at IS NULL AND OLD.closed_at IS NULL AND OLD.close_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoice_payments payment WHERE payment.invoice_id = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_messages message WHERE message.invoice_id = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM event_outbox event
          WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = OLD.id))
      AND NOT EXISTS (SELECT 1 FROM invoice_import_reconciliations import
        WHERE import.invoice_id = OLD.id AND import.completed = 0
          AND OLD.harvest_id IS NOT NULL
          AND import.expected_source_updated_at IS OLD.source_updated_at)
    BEGIN SELECT RAISE(ABORT, 'invoice financial mutation requires its pending command'); END`,
  `DROP TRIGGER invoice_header_d22_command_update`,
  `CREATE TRIGGER invoice_header_d22_command_update
    BEFORE UPDATE OF client_id, number, subject, purchase_order, notes, currency,
      issue_date, due_date, payment_terms, project_id, estimate_id, reminder_policy,
      payment_options, client_key, reference_token ON invoices
    WHEN (OLD.client_id IS NOT NEW.client_id OR OLD.number IS NOT NEW.number
      OR OLD.subject IS NOT NEW.subject OR OLD.purchase_order IS NOT NEW.purchase_order
      OR OLD.notes IS NOT NEW.notes OR OLD.currency IS NOT NEW.currency
      OR OLD.issue_date IS NOT NEW.issue_date OR OLD.due_date IS NOT NEW.due_date
      OR OLD.payment_terms IS NOT NEW.payment_terms OR OLD.project_id IS NOT NEW.project_id
      OR OLD.estimate_id IS NOT NEW.estimate_id
      OR OLD.reminder_policy IS NOT NEW.reminder_policy
      OR OLD.payment_options IS NOT NEW.payment_options
      OR OLD.client_key IS NOT NEW.client_key OR OLD.reference_token IS NOT NEW.reference_token)
    AND NOT EXISTS (
      SELECT 1 FROM invoice_command_ledger command
      WHERE command.invoice_id = OLD.id AND command.completed = 0
        AND command.command_kind = 'invoice.update'
        AND command.expected_invoice_version = OLD.version
    ) AND NOT (
      OLD.client_key IS NEW.client_key AND OLD.reference_token IS NEW.reference_token
      AND OLD.reminder_policy IS NEW.reminder_policy
      AND OLD.payment_options IS NEW.payment_options
      AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import
        WHERE OLD.harvest_id IS NOT NULL
          AND import.invoice_id = OLD.id AND import.completed = 0
          AND import.expected_source_updated_at IS OLD.source_updated_at
      )
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
  `CREATE TABLE harvest_expense_receipts (
    source_expense_id INTEGER PRIMARY KEY,
    expense_id INTEGER NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
    attachment_id INTEGER NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `DROP TRIGGER invoices_client_consistent_with_children_update`,
  `CREATE TRIGGER invoices_client_consistent_with_children_update
    BEFORE UPDATE OF client_id ON invoices
    WHEN OLD.client_id IS NOT NEW.client_id AND (
      EXISTS (SELECT 1 FROM invoice_line_items line JOIN projects project ON project.id = line.project_id
        WHERE line.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id)
      OR EXISTS (SELECT 1 FROM time_entries entry JOIN projects project ON project.id = entry.project_id
        WHERE entry.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id)
      OR EXISTS (SELECT 1 FROM project_milestones milestone JOIN projects project ON project.id = milestone.project_id
        WHERE milestone.invoiced_invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id)
      OR EXISTS (SELECT 1 FROM expenses expense JOIN projects project ON project.id = expense.project_id
        WHERE expense.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id)
    )
    BEGIN SELECT RAISE(ABORT, 'invoice client must match every linked project'); END`,
] as const
