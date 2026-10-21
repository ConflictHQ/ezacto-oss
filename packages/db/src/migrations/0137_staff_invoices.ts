// #901: payable documents reference existing earnings. These triggers never
// insert/update a staff payment, earning, allocation or customer invoice.
export const staffInvoicesMigration = [
  `CREATE TABLE staff_invoices (
    id INTEGER PRIMARY KEY CHECK(id>0), user_id INTEGER NOT NULL REFERENCES users(id),
    month TEXT NOT NULL, currency TEXT NOT NULL, reference TEXT NOT NULL COLLATE NOCASE,
    UNIQUE(user_id,reference), CHECK(length(trim(reference)) BETWEEN 1 AND 200)
  ) STRICT`,
  `CREATE TABLE staff_invoice_versions (
    command_id TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES staff_invoices(id) DEFERRABLE INITIALLY DEFERRED,
    expected_version INTEGER NOT NULL CHECK(expected_version>=0), user_id INTEGER NOT NULL REFERENCES users(id),
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
    currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'), reference TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('draft','received','void')), lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 0 AND 9000000000000), review_id TEXT REFERENCES staff_payment_actuals(id),
    document_id TEXT REFERENCES staff_invoice_documents(id), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
    command_json TEXT NOT NULL CHECK(json_valid(command_json)), actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL,
    paid_cents_at_recording INTEGER NOT NULL CHECK(paid_cents_at_recording>=0), has_payment_history INTEGER NOT NULL CHECK(has_payment_history IN (0,1)), UNIQUE(invoice_id,expected_version)
  ) STRICT`,
  `CREATE TRIGGER staff_invoice_version_guard BEFORE INSERT ON staff_invoice_versions BEGIN
    SELECT CASE WHEN NEW.expected_version=0 AND (EXISTS(SELECT 1 FROM staff_invoices WHERE id=NEW.invoice_id)
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_contractor=1))
      THEN RAISE(ABORT,'staff invoice requires a contractor and unused identity') END;
    SELECT CASE WHEN NEW.expected_version>0 AND NOT EXISTS(SELECT 1 FROM staff_invoices i WHERE i.id=NEW.invoice_id AND i.user_id=NEW.user_id
      AND i.reference=NEW.reference
      AND NEW.expected_version=(SELECT MAX(expected_version)+1 FROM staff_invoice_versions WHERE invoice_id=i.id))
      THEN RAISE(ABORT,'staff invoice version or identity changed') END;
    SELECT CASE WHEN NEW.expected_version>0 AND NEW.kind='draft' AND EXISTS(SELECT 1 FROM staff_invoice_versions WHERE invoice_id=NEW.invoice_id AND kind IN ('received','void'))
      THEN RAISE(ABORT,'a received staff invoice cannot silently return to draft') END;
    SELECT CASE WHEN NEW.review_id IS NOT (SELECT id FROM staff_payment_actuals WHERE user_id=NEW.user_id AND month=NEW.month ORDER BY expected_version DESC LIMIT 1)
      THEN RAISE(ABORT,'staff invoice earning review changed') END;
    SELECT CASE WHEN NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staff_invoice_documents WHERE id=NEW.document_id AND invoice_id=NEW.invoice_id)
      THEN RAISE(ABORT,'staff invoice document belongs to another invoice') END;
    SELECT CASE WHEN NEW.paid_cents_at_recording IS NOT COALESCE((SELECT paid_cents FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency),0)
      OR NEW.has_payment_history IS NOT (EXISTS(SELECT 1 FROM staff_payment_balances WHERE user_id=NEW.user_id AND month IN (NEW.month,COALESCE((SELECT month FROM staff_invoice_versions WHERE invoice_id=NEW.invoice_id ORDER BY expected_version DESC LIMIT 1),NEW.month)) AND paid_cents>0)
        OR EXISTS(SELECT 1 FROM staff_invoice_versions WHERE invoice_id=NEW.invoice_id AND has_payment_history=1))
      OR (NEW.expected_version>0 AND NEW.has_payment_history=1 AND json_extract(NEW.command_json,'$.acknowledge_paid_history') IS NOT 1)
      THEN RAISE(ABORT,'staff invoice correction requires review of existing payments') END;
  END`,
  `CREATE TRIGGER staff_invoice_version_create AFTER INSERT ON staff_invoice_versions WHEN NEW.expected_version=0 BEGIN
    INSERT INTO staff_invoices(id,user_id,month,currency,reference) VALUES(NEW.invoice_id,NEW.user_id,NEW.month,NEW.currency,NEW.reference);
  END`,
  `CREATE TABLE staff_invoice_documents (
    id TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES staff_invoices(id), file_object_id INTEGER NOT NULL REFERENCES file_objects(id),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255), command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL
  ) STRICT`,
  ...['staff_invoices', 'staff_invoice_versions', 'staff_invoice_documents'].flatMap((table) => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'staff invoice history is immutable'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'staff invoice history is immutable'); END`,
  ]),
  `CREATE TABLE staff_invoice_document_commands (
    id TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES staff_invoices(id), content_hash TEXT NOT NULL, file_key TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 0 AND 26214400), content_type TEXT NOT NULL, name TEXT NOT NULL,
    command_json TEXT NOT NULL CHECK(json_valid(command_json)), actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER staff_invoice_document_record AFTER INSERT ON staff_invoice_document_commands BEGIN
    INSERT INTO file_objects(content_hash,file_key,byte_size,content_type,created_at,updated_at)
      SELECT NEW.content_hash,NEW.file_key,NEW.byte_size,NEW.content_type,NEW.recorded_at,NEW.recorded_at
      WHERE NOT EXISTS(SELECT 1 FROM file_objects WHERE content_hash=NEW.content_hash);
    INSERT INTO staff_invoice_documents(id,invoice_id,file_object_id,name,command_json,actor_id,recorded_at,request_id)
      SELECT NEW.id,NEW.invoice_id,f.id,NEW.name,NEW.command_json,NEW.actor_id,NEW.recorded_at,NEW.request_id FROM file_objects f
      WHERE f.content_hash=NEW.content_hash AND f.file_key=NEW.file_key AND f.byte_size=NEW.byte_size AND f.content_type=NEW.content_type;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_invoice_documents WHERE id=NEW.id) THEN RAISE(ABORT,'staff invoice file identity collision') END;
  END`,
  `CREATE TRIGGER staff_invoice_document_commands_no_update BEFORE UPDATE ON staff_invoice_document_commands BEGIN SELECT RAISE(ABORT,'staff invoice history is immutable'); END`,
  `CREATE TRIGGER staff_invoice_document_commands_no_delete BEFORE DELETE ON staff_invoice_document_commands BEGIN SELECT RAISE(ABORT,'staff invoice history is immutable'); END`,
] as const
