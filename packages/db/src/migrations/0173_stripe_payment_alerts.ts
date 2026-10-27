/** Provider reports are evidence only: no receipt or invoice balance changes. */
export const stripePaymentAlertsMigration = [
  `CREATE TABLE stripe_payment_alert_inbox (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),
    payment_intent_id TEXT NOT NULL, object_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
    currency TEXT NOT NULL, provider_status TEXT NOT NULL, occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX stripe_payment_alert_inbox_due ON stripe_payment_alert_inbox(payment_intent_id,received_at)`,
  `CREATE TABLE stripe_payment_alerts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 255),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_id INTEGER NOT NULL,
    payment_intent_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9000000000000),
    currency TEXT NOT NULL CHECK(length(currency)=3),
    provider_status TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id),
    CHECK((reviewed_at IS NULL)=(reviewed_by IS NULL))
  )`,
  `CREATE INDEX stripe_payment_alerts_invoice ON stripe_payment_alerts(invoice_id,occurred_at,id)`,
  `CREATE TRIGGER stripe_payment_alerts_evidence_immutable BEFORE UPDATE ON stripe_payment_alerts
   WHEN OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.payment_id IS NOT NEW.payment_id
     OR OLD.payment_intent_id IS NOT NEW.payment_intent_id OR OLD.object_id IS NOT NEW.object_id
     OR OLD.event_type IS NOT NEW.event_type OR OLD.kind IS NOT NEW.kind OR OLD.amount_cents IS NOT NEW.amount_cents
     OR OLD.currency IS NOT NEW.currency OR OLD.provider_status IS NOT NEW.provider_status
     OR OLD.occurred_at IS NOT NEW.occurred_at OR OLD.received_at IS NOT NEW.received_at
   BEGIN SELECT RAISE(ABORT,'stripe_alert_evidence_immutable'); END`,
  `CREATE TABLE stripe_payment_alert_reviews (
    alert_id TEXT PRIMARY KEY REFERENCES stripe_payment_alerts(id) ON DELETE CASCADE,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    reviewed_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER stripe_payment_alert_reviews_immutable BEFORE UPDATE ON stripe_payment_alert_reviews BEGIN SELECT RAISE(ABORT,'stripe_alert_review_immutable'); END`,
  `CREATE TRIGGER stripe_payment_alert_notice_admission BEFORE INSERT ON notification_deliveries
    WHEN NEW.kind='stripe_payment_alert' AND NOT EXISTS(
      SELECT 1 FROM users u JOIN user_emails e ON e.user_id=u.id
      JOIN stripe_payment_alerts a ON a.id=NEW.period
      WHERE u.id=NEW.user_id AND u.is_active=1 AND u.profile='administrator'
        AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id)
        AND e.is_primary=1 AND e.verified_at IS NOT NULL AND e.invalidated_at IS NULL
        AND e.address=NEW.to_email AND CAST(a.invoice_id AS TEXT)=NEW.scope)
    BEGIN SELECT RAISE(ABORT,'stripe_alert_notice_recipient_changed'); END`,
] as const
