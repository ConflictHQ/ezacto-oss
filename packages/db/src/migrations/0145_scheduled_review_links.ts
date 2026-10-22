import { canonicalTimestamp } from './0029_outbox_delivery.js'
export const scheduledReviewLinksMigration = [
  `CREATE TABLE scheduled_run_review_links (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    run_id INTEGER NOT NULL REFERENCES proposed_runs(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expires_at TEXT NOT NULL CHECK(${canonicalTimestamp('expires_at')}),
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    consumed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    consumed_at TEXT CHECK(consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
    UNIQUE(run_id,user_id),
    CHECK(julianday(expires_at)>julianday(created_at)),
    CHECK((consumed_by_user_id IS NULL)=(consumed_at IS NULL)),
    CHECK(consumed_by_user_id IS NULL OR consumed_by_user_id=user_id)
  ) STRICT`,
  `CREATE TRIGGER scheduled_review_link_issuance BEFORE INSERT ON scheduled_run_review_links
    WHEN NOT EXISTS(SELECT 1 FROM proposed_runs run JOIN users person ON person.id=NEW.user_id
      JOIN notification_deliveries notice ON notice.kind='scheduled_manifest' AND notice.user_id=person.id
        AND notice.scope=CAST(run.id AS TEXT) AND notice.period=run.occurrence_key AND notice.outcome='queued'
      JOIN user_emails email ON email.user_id=person.id AND email.is_primary=1
        AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL AND email.address=notice.to_email
      WHERE run.id=NEW.run_id AND run.state='proposed' AND run.expires_at=NEW.expires_at
        AND person.is_active=1 AND person.profile='administrator')
    BEGIN SELECT RAISE(ABORT,'A review link requires its active administrator and atomic notification receipt'); END`,
  `CREATE TRIGGER scheduled_review_link_identity_final BEFORE UPDATE ON scheduled_run_review_links
    WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.run_id IS NOT OLD.run_id OR NEW.user_id IS NOT OLD.user_id
      OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS NOT OLD.consumed_at OR NEW.consumed_by_user_id IS NOT OLD.consumed_by_user_id))
    BEGIN SELECT RAISE(ABORT,'The review link identity and recorded opening are final'); END`,
  `CREATE TRIGGER scheduled_review_link_consume_guard BEFORE UPDATE ON scheduled_run_review_links
    WHEN NEW.consumed_at IS NOT NULL AND (julianday(NEW.consumed_at)>=julianday(NEW.expires_at)
      OR julianday(NEW.consumed_at)<julianday(NEW.created_at)
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1 AND profile='administrator'))
    BEGIN SELECT RAISE(ABORT,'The review link requires a live administrator and an unexpired deadline'); END`,
  `CREATE TRIGGER scheduled_review_link_no_delete BEFORE DELETE ON scheduled_run_review_links
    BEGIN SELECT RAISE(ABORT,'Review link receipts are permanent'); END`,
] as const
