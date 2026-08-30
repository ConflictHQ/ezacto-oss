const timestampMilliseconds = (column: string) =>
  `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000
    + CASE WHEN instr(${column}, '.') = 0 THEN 0 ELSE
      CAST(substr(${column}, 21, length(${column}) - 21)
        || substr('000', 1, 3 - (length(${column}) - 21)) AS INTEGER)
    END)`

/** Narrow authority and source identity required by the snapshot loader. */
export const migrationImportAuthorityMigration = [
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
          AND json_array_length(OLD.line_manifest_json) = (
            SELECT count(*) FROM invoice_line_items line
            WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_line_items line
            WHERE line.invoice_id = OLD.invoice_id AND line.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.line_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = 0
                    OR json_extract(member.value, '$.id') = line.id)
                  AND json_extract(member.value, '$.harvest_id') = line.harvest_id
                  AND json_extract(member.value, '$.updated_at') = line.updated_at))
          AND json_array_length(OLD.message_manifest_json) = (
            SELECT count(*) FROM invoice_messages message
            WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_messages message
            WHERE message.invoice_id = OLD.invoice_id AND message.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.message_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = 0
                    OR json_extract(member.value, '$.id') = message.id)
                  AND json_extract(member.value, '$.harvest_id') = message.harvest_id
                  AND json_extract(member.value, '$.updated_at') = message.updated_at))
          AND json_array_length(OLD.payment_manifest_json) = (
            SELECT count(*) FROM invoice_payments payment
            WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM invoice_payments payment
            WHERE payment.invoice_id = OLD.invoice_id AND payment.harvest_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM json_each(OLD.payment_manifest_json) member
                WHERE (json_extract(member.value, '$.id') = 0
                    OR json_extract(member.value, '$.id') = payment.id)
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
      SELECT 1 FROM invoice_import_reconciliations import,
        json_each(import.message_manifest_json) member
      WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
        AND (json_extract(member.value, '$.id') = NEW.id
          OR (json_extract(member.value, '$.id') = 0 AND NEW.id = -1))
        AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
        AND json_extract(member.value, '$.updated_at') = NEW.updated_at
    ))
    BEGIN SELECT RAISE(ABORT, 'invoice message insert requires exact pending authority'); END`,
  `DROP TRIGGER invoice_messages_d22_source_update_guard`,
  `CREATE TRIGGER invoice_messages_d22_source_update_guard
    BEFORE UPDATE ON invoice_messages
    WHEN (OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.sent_by IS NOT NEW.sent_by
      OR OLD.sent_by_email IS NOT NEW.sent_by_email OR OLD.sent_from IS NOT NEW.sent_from
      OR OLD.sent_from_email IS NOT NEW.sent_from_email OR OLD.recipients IS NOT NEW.recipients
      OR OLD.subject IS NOT NEW.subject OR OLD.body IS NOT NEW.body
      OR OLD.attach_pdf IS NOT NEW.attach_pdf OR OLD.send_me_a_copy IS NOT NEW.send_me_a_copy
      OR OLD.thank_you IS NOT NEW.thank_you OR OLD.reminder IS NOT NEW.reminder
      OR OLD.send_reminder_on IS NOT NEW.send_reminder_on
      OR OLD.event_type IS NOT NEW.event_type OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at)
      AND NOT (OLD.id IS NEW.id AND OLD.harvest_id IS NEW.harvest_id
        AND OLD.invoice_id IS NEW.invoice_id AND OLD.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_import_reconciliations import,
          json_each(import.message_manifest_json) member
        WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
          AND json_extract(member.value, '$.id') = OLD.id
          AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
          AND json_extract(member.value, '$.updated_at') = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice message source mutation requires exact import authority'); END`,
  `DROP TRIGGER invoice_messages_d22_delete_guard`,
  `CREATE TRIGGER invoice_messages_d22_delete_guard
    BEFORE DELETE ON invoice_messages
    WHEN NOT (OLD.harvest_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
        AND NOT EXISTS (SELECT 1 FROM json_each(import.message_manifest_json) member
          WHERE (json_extract(member.value, '$.id') = 0
              OR json_extract(member.value, '$.id') = OLD.id)
            AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
            AND json_extract(member.value, '$.updated_at') = OLD.updated_at)))
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
      SELECT 1 FROM invoice_import_reconciliations import,
        json_each(import.payment_manifest_json) member
      WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
        AND import.target_state <> 'draft'
        AND (json_extract(member.value, '$.id') = NEW.id
          OR (json_extract(member.value, '$.id') = 0 AND NEW.id = -1))
        AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
        AND json_extract(member.value, '$.updated_at') = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice payment insert requires its pending command'); END`,
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
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
        AND NOT EXISTS (SELECT 1 FROM json_each(import.payment_manifest_json) member
          WHERE (json_extract(member.value, '$.id') = 0
              OR json_extract(member.value, '$.id') = OLD.id)
            AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
            AND json_extract(member.value, '$.updated_at') = OLD.updated_at)))
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
      SELECT 1 FROM invoice_import_reconciliations import,
        json_each(import.line_manifest_json) member
      WHERE import.invoice_id = NEW.invoice_id AND import.completed = 0
        AND (json_extract(member.value, '$.id') = NEW.id
          OR (json_extract(member.value, '$.id') = 0 AND NEW.id = -1))
        AND json_extract(member.value, '$.harvest_id') = NEW.harvest_id
        AND json_extract(member.value, '$.updated_at') = NEW.updated_at))
    BEGIN SELECT RAISE(ABORT, 'invoice line insert requires its pending command'); END`,
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
      SELECT 1 FROM invoice_import_reconciliations import
      WHERE import.invoice_id = OLD.invoice_id AND import.completed = 0
        AND NOT EXISTS (SELECT 1 FROM json_each(import.line_manifest_json) member
          WHERE (json_extract(member.value, '$.id') = 0
              OR json_extract(member.value, '$.id') = OLD.id)
            AND json_extract(member.value, '$.harvest_id') = OLD.harvest_id
            AND json_extract(member.value, '$.updated_at') = OLD.updated_at)))
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
