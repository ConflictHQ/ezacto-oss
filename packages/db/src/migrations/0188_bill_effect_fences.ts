/**
 * Durable fences around BILL provider effects (issue 1252).
 *
 * BILL has no idempotency key, so a provider create whose reply is lost cannot
 * be told from one that never happened. A fence is committed before each effect
 * and held until the effect and its local link are both recorded. While held,
 * the native fields the provider request was built from cannot change, so a
 * retry reconciles against the same request. Fences are never deleted.
 */
export const billEffectFencesMigration = [
  `CREATE TABLE bill_effect_fences (
    effect_id TEXT PRIMARY KEY CHECK(length(effect_id)=36),
    owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    connection_generation INTEGER NOT NULL CHECK(connection_generation>0),
    kind TEXT NOT NULL CHECK(kind IN ('customer-create','invoice-create','invoice-send','invoice-link')),
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('held','released')),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX bill_effect_fences_invoice ON bill_effect_fences(invoice_id) WHERE state='held'`,
  `CREATE INDEX bill_effect_fences_client ON bill_effect_fences(client_id) WHERE state='held'`,
  `CREATE TRIGGER bill_effect_fences_insert_guard BEFORE INSERT ON bill_effect_fences
    WHEN NEW.state<>'held' OR NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND client_id=NEW.client_id)
      OR NOT EXISTS(SELECT 1 FROM bill_managed_connection WHERE singleton=1 AND generation=NEW.connection_generation
        AND status IN ('configured','connected') AND sealed_credential IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'bill_effect_fence_invalid'); END`,
  `CREATE TRIGGER bill_effect_fences_identity BEFORE UPDATE ON bill_effect_fences
    WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.invoice_id IS NOT OLD.invoice_id
      OR NEW.client_id IS NOT OLD.client_id OR NEW.connection_generation IS NOT OLD.connection_generation OR NEW.kind IS NOT OLD.kind
      OR NEW.request_digest IS NOT OLD.request_digest OR NEW.created_at IS NOT OLD.created_at
      OR NOT (OLD.state='held' AND NEW.state='released')
    BEGIN SELECT RAISE(ABORT,'bill_effect_fence_immutable'); END`,
  `CREATE TRIGGER bill_effect_fences_retain BEFORE DELETE ON bill_effect_fences
    BEGIN SELECT RAISE(ABORT,'bill_effect_fence_retained'); END`,
  `CREATE TRIGGER bill_effect_invoice_source_update BEFORE UPDATE OF client_id,number,currency,issue_date,due_date,subject ON invoices
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE invoice_id=OLD.id AND state='held')
      AND (NEW.client_id IS NOT OLD.client_id OR NEW.number IS NOT OLD.number OR NEW.currency IS NOT OLD.currency
        OR NEW.issue_date IS NOT OLD.issue_date OR NEW.due_date IS NOT OLD.due_date OR NEW.subject IS NOT OLD.subject)
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_invoice_source_delete BEFORE DELETE ON invoices
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE invoice_id=OLD.id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_line_insert BEFORE INSERT ON invoice_line_items
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE invoice_id=NEW.invoice_id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_line_update BEFORE UPDATE OF invoice_id,position,description,quantity,unit_price_cents,amount_cents ON invoice_line_items
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE invoice_id IN (OLD.invoice_id,NEW.invoice_id) AND state='held')
      AND (NEW.invoice_id IS NOT OLD.invoice_id OR NEW.position IS NOT OLD.position OR NEW.description IS NOT OLD.description
        OR NEW.quantity IS NOT OLD.quantity OR NEW.unit_price_cents IS NOT OLD.unit_price_cents OR NEW.amount_cents IS NOT OLD.amount_cents)
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_line_delete BEFORE DELETE ON invoice_line_items
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE invoice_id=OLD.invoice_id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_client_name BEFORE UPDATE OF name ON clients
    WHEN NEW.name IS NOT OLD.name AND EXISTS(SELECT 1 FROM bill_effect_fences WHERE client_id=OLD.id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_contact_insert BEFORE INSERT ON contacts
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE client_id=NEW.client_id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_contact_update BEFORE UPDATE OF id,client_id,email,invoice_recipient_status ON contacts
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE client_id IN (OLD.client_id,NEW.client_id) AND state='held')
      AND (NEW.id IS NOT OLD.id OR NEW.client_id IS NOT OLD.client_id OR NEW.email IS NOT OLD.email OR NEW.invoice_recipient_status IS NOT OLD.invoice_recipient_status)
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_contact_delete BEFORE DELETE ON contacts
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE client_id=OLD.client_id AND state='held')
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
  `CREATE TRIGGER bill_effect_link_delete BEFORE DELETE ON bill_links
    WHEN EXISTS(SELECT 1 FROM bill_effect_fences WHERE state='held' AND
      ((OLD.kind='customer' AND client_id=OLD.ezacto_id) OR (OLD.kind='invoice' AND invoice_id=OLD.ezacto_id)))
    BEGIN SELECT RAISE(ABORT,'bill_effect_source_held'); END`,
] as const
