/** Durable bounded sweep progress. This table never grants permission to resend. */
export const reminderReconciliationMigration = [
  `CREATE TABLE reminder_reconciliation_cursor (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    after_id INTEGER NOT NULL DEFAULT 0 CHECK(after_id BETWEEN 0 AND 9007199254740991),
    next_due INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
  ) STRICT`,
  `INSERT INTO reminder_reconciliation_cursor(id) VALUES(1)`,
  `CREATE TABLE invoice_feedback_recovery_cursor (
    id INTEGER PRIMARY KEY CHECK(id = 1), after_event_id TEXT NOT NULL DEFAULT '', next_due INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_expires_at INTEGER,
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
  ) STRICT`,
  `INSERT INTO invoice_feedback_recovery_cursor(id) VALUES(1)`,
  `CREATE INDEX invoice_feedback_recovery_candidates ON email_feedback_events(event_id)
    WHERE processed_at IS NOT NULL AND (event_type = 'complained' OR (event_type = 'failed' AND severity = 'permanent'))`,
  `CREATE INDEX email_log_held_mailgun_id ON email_log(id)
    WHERE status = 'queued' AND provider = 'mailgun' AND active_attempt_id IS NOT NULL`,
  `CREATE TABLE reminder_reconciliation_feedback (
    delivery_id INTEGER PRIMARY KEY REFERENCES email_log(id),
    attempt_id TEXT NOT NULL UNIQUE,
    provider_message_id TEXT NOT NULL CHECK(length(trim(provider_message_id)) BETWEEN 1 AND 512),
    feedback_json TEXT NOT NULL CHECK(json_valid(feedback_json) AND json_type(feedback_json) = 'array'
      AND json_array_length(feedback_json) BETWEEN 1 AND 100),
    recorded_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE reminder_reconciliation_webhook_tokens (
    signature_token TEXT PRIMARY KEY CHECK(length(trim(signature_token)) BETWEEN 1 AND 255),
    event_id TEXT NOT NULL REFERENCES email_feedback_events(event_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE invoice_feedback_provider_evidence (
    event_id TEXT PRIMARY KEY REFERENCES email_feedback_events(event_id) ON DELETE RESTRICT,
    verified_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER invoice_feedback_provider_evidence_guard BEFORE INSERT ON invoice_feedback_provider_evidence
    BEGIN SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM email_feedback_events f JOIN email_log e ON e.id = f.delivery_id
      JOIN invoice_email_recipients r ON r.delivery_id = e.id AND lower(r.email) = lower(f.recipient)
      WHERE f.event_id = NEW.event_id AND e.template LIKE 'invoice:%' AND e.provider = 'mailgun'
        AND e.provider_message_id IS NOT NULL AND e.provider_message_id = f.provider_message_id
        AND (f.event_type = 'complained' OR (f.event_type = 'failed' AND f.severity = 'permanent'))
    ) THEN RAISE(ABORT, 'invoice feedback evidence mismatch') END; END`,
  `CREATE TRIGGER invoice_feedback_provider_evidence_immutable BEFORE UPDATE ON invoice_feedback_provider_evidence
    BEGIN SELECT RAISE(ABORT, 'invoice feedback evidence is immutable'); END`,
  `CREATE TRIGGER invoice_feedback_provider_evidence_append_only BEFORE DELETE ON invoice_feedback_provider_evidence
    BEGIN SELECT RAISE(ABORT, 'invoice feedback evidence is append-only'); END`,
  `CREATE TRIGGER reminder_reconciliation_feedback_guard BEFORE INSERT ON reminder_reconciliation_feedback
    BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM email_log e WHERE e.id = NEW.delivery_id
        AND e.status = 'queued' AND e.provider = 'mailgun' AND e.template LIKE 'reminder:%'
        AND e.active_attempt_id = NEW.attempt_id) THEN RAISE(ABORT, 'reminder claim changed') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.feedback_json) f
        WHERE json_type(f.value, '$.eventId') IS NOT 'text'
          OR length(trim(json_extract(f.value, '$.eventId'))) NOT BETWEEN 1 AND 255
          OR json_type(f.value, '$.recipient') IS NOT 'text'
          OR json_extract(f.value, '$.recipient') <> lower(trim(json_extract(f.value, '$.recipient')))
          OR json_type(f.value, '$.type') IS NOT 'text'
          OR json_extract(f.value, '$.type') NOT IN ('failed','complained')
          OR NOT EXISTS (SELECT 1 FROM email_log e, json_each(e.to_json) p WHERE e.id = NEW.delivery_id
             AND json_extract(p.value, '$.email') = json_extract(f.value, '$.recipient')
            UNION ALL SELECT 1 FROM email_log e, json_each(e.cc_json) p WHERE e.id = NEW.delivery_id
             AND json_extract(p.value, '$.email') = json_extract(f.value, '$.recipient')))
        THEN RAISE(ABORT, 'invalid reminder feedback') END;
    END`,
  `CREATE TRIGGER reminder_reconciliation_feedback_apply AFTER INSERT ON reminder_reconciliation_feedback
    BEGIN
      UPDATE email_log SET status = 'sent', provider_message_id = NEW.provider_message_id,
        active_attempt_id = NULL, attempt_lease_expires_at = NULL, updated_at = NEW.recorded_at
        WHERE id = NEW.delivery_id AND status = 'queued' AND active_attempt_id = NEW.attempt_id;
      INSERT INTO email_feedback_events(event_id, signature_token, event_type, severity, recipient,
        provider_message_id, delivery_id, received_at)
        SELECT json_extract(f.value, '$.eventId'), 'reconciliation:' || NEW.attempt_id || ':' || f.key,
          json_extract(f.value, '$.type'), CASE WHEN json_extract(f.value, '$.type') = 'failed' THEN 'permanent' END,
          json_extract(f.value, '$.recipient'), NEW.provider_message_id, NEW.delivery_id, NEW.recorded_at
        FROM json_each(NEW.feedback_json) f;
      UPDATE email_feedback_events SET processed_at = NEW.recorded_at,
        outcome = CASE event_type WHEN 'failed' THEN 'bounced' ELSE 'complained' END
        WHERE event_id IN (SELECT json_extract(f.value, '$.eventId') FROM json_each(NEW.feedback_json) f)
          AND processed_at IS NULL;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.feedback_json) f
        WHERE NOT EXISTS (SELECT 1 FROM email_suppression_events s WHERE s.provider_event_id = json_extract(f.value, '$.eventId')))
        THEN RAISE(ABORT, 'reminder suppression missing') END;
      UPDATE email_log SET status = CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.feedback_json) f
        WHERE json_extract(f.value, '$.type') = 'complained') THEN 'complained' ELSE 'bounced' END,
        updated_at = NEW.recorded_at WHERE id = NEW.delivery_id AND status = 'sent';
    END`,
  `CREATE TRIGGER reminder_reconciliation_feedback_immutable BEFORE UPDATE ON reminder_reconciliation_feedback
    BEGIN SELECT RAISE(ABORT, 'reminder feedback is immutable'); END`,
  `CREATE TRIGGER reminder_reconciliation_feedback_append_only BEFORE DELETE ON reminder_reconciliation_feedback
    BEGIN SELECT RAISE(ABORT, 'reminder feedback is append-only'); END`,
] as const
