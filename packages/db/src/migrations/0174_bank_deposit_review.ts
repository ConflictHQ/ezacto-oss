/** Review state extends the existing deposit ledger without a second money model. */
const authority = (
  user: string,
  session: string,
) => `EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
  WHERE u.id=${user} AND s.id=${session} AND u.is_active=1 AND u.profile IN ('administrator','accounting')
    AND s.revoked_at IS NULL AND s.profile_snapshot=u.profile AND json(s.manager_grants_snapshot)=json(u.manager_grants)
    AND julianday(s.idle_expires_at)>julianday('now') AND julianday(s.absolute_expires_at)>julianday('now')
    AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id))`
export const bankDepositReviewMigration = [
  `CREATE TABLE bank_deposit_write_guard(singleton INTEGER PRIMARY KEY CHECK(singleton=1), ok INTEGER NOT NULL CHECK(ok=1))`,
  `CREATE TABLE bank_feed_accounts (
    provider_account_id INTEGER PRIMARY KEY REFERENCES payment_provider_accounts(id) ON DELETE RESTRICT,
    created_by_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
    cursor TEXT, version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), last_synced_at TEXT
  )`,
  `CREATE TABLE bank_deposit_reviews (
    deposit_id INTEGER PRIMARY KEY REFERENCES bank_deposits(id) ON DELETE RESTRICT,
    source_fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
    source_status TEXT NOT NULL DEFAULT 'unknown' CHECK(source_status IN ('final','pending','reversed','unknown')),
    classification TEXT NOT NULL DEFAULT 'ambiguous_credit' CHECK(classification IN ('external_credit','internal_transfer','ambiguous_credit')),
    source_reason TEXT, verified_at TEXT, verified_by_user_id INTEGER REFERENCES users(id), verification_reference TEXT, rejected_at TEXT, rejected_by_user_id INTEGER REFERENCES users(id),
    CHECK((rejected_at IS NULL)=(rejected_by_user_id IS NULL))
  )`,
  `CREATE TABLE bank_deposit_audit (
    command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation TEXT NOT NULL
      CHECK(operation IN ('account','import','assign','confirm','reject','reopen','verify')),
    actor_user_id INTEGER REFERENCES users(id), actor_type TEXT NOT NULL DEFAULT 'user' CHECK(actor_type IN ('user','system')),
    provider_account_id INTEGER REFERENCES payment_provider_accounts(id),
    deposit_id INTEGER REFERENCES bank_deposits(id), invoice_id INTEGER REFERENCES invoices(id),
    payment_id INTEGER, before_version INTEGER, after_version INTEGER, occurred_at TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json))
  )`,
  `CREATE TRIGGER bank_deposit_audit_immutable BEFORE UPDATE ON bank_deposit_audit
    BEGIN SELECT RAISE(ABORT,'bank_deposit_audit_immutable'); END`,
  `CREATE TABLE bank_deposit_confirmation_permits (
    command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    deposit_id INTEGER NOT NULL REFERENCES bank_deposits(id), invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    payment_id INTEGER NOT NULL UNIQUE, expected_version INTEGER NOT NULL,
    expected_invoice_version INTEGER NOT NULL, expected_updated_at TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL REFERENCES users(id), session_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER bank_deposit_review_source_immutable BEFORE UPDATE OF provider_account_id,provider_transaction_id,currency,posted_at,amount_cents,memo,counterparty ON bank_deposits
    WHEN EXISTS(SELECT 1 FROM bank_deposit_reviews r WHERE r.deposit_id=OLD.id)
      AND (OLD.provider_account_id IS NOT NEW.provider_account_id OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
        OR OLD.currency IS NOT NEW.currency OR OLD.posted_at IS NOT NEW.posted_at OR OLD.amount_cents IS NOT NEW.amount_cents
        OR OLD.memo IS NOT NEW.memo OR OLD.counterparty IS NOT NEW.counterparty)
    BEGIN SELECT RAISE(ABORT,'bank_deposit_source_immutable'); END`,
  `CREATE TRIGGER bank_deposit_review_version AFTER UPDATE OF match_state,suggested_invoice_id,updated_at ON bank_deposits
    BEGIN UPDATE bank_deposit_reviews SET version=version+1 WHERE deposit_id=NEW.id; END`,
  `CREATE TRIGGER bank_deposit_review_confirmation_guard BEFORE INSERT ON invoice_payments
    WHEN NEW.bank_deposit_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM bank_deposit_reviews r WHERE r.deposit_id=NEW.bank_deposit_id)
      AND NOT EXISTS(SELECT 1 FROM bank_deposit_confirmation_permits p
        JOIN bank_deposit_reviews r ON r.deposit_id=p.deposit_id
        JOIN bank_deposits d ON d.id=p.deposit_id
        JOIN invoice_command_ledger l ON l.invoice_id=p.invoice_id AND l.command_id=p.command_id
        WHERE p.deposit_id=NEW.bank_deposit_id AND p.invoice_id=NEW.invoice_id AND p.payment_id=NEW.id
          AND p.expected_version=r.version AND r.rejected_at IS NULL AND ((r.source_status='final' AND r.classification='external_credit') OR (r.source_status='unknown' AND r.classification<>'internal_transfer' AND r.verified_at IS NOT NULL)) AND d.updated_at=p.expected_updated_at
          AND p.expected_invoice_version=l.expected_invoice_version AND l.completed=0
          AND l.actor_type='user' AND l.actor_id=p.actor_user_id
          AND NOT EXISTS(SELECT 1 FROM bank_deposit_audit a WHERE a.command_id=p.command_id)
          AND ${authority('p.actor_user_id', 'p.session_id')})
    BEGIN SELECT RAISE(ABORT,'bank_deposit_confirmation_authority_changed'); END`,
  `CREATE TRIGGER bank_deposit_review_confirmation_audit AFTER INSERT ON invoice_payments
    WHEN NEW.bank_deposit_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_deposit_reviews r WHERE r.deposit_id=NEW.bank_deposit_id)
    BEGIN
      INSERT INTO bank_deposit_audit(command_id,fingerprint,operation,actor_user_id,provider_account_id,deposit_id,invoice_id,payment_id,before_version,after_version,occurred_at,result_json)
      SELECT p.command_id,p.fingerprint,'confirm',p.actor_user_id,NEW.provider_account_id,p.deposit_id,p.invoice_id,NEW.id,
        p.expected_version,p.expected_version+1,p.occurred_at,json_object('deposit_id',p.deposit_id,'invoice_id',p.invoice_id,'payment_id',NEW.id)
      FROM bank_deposit_confirmation_permits p WHERE p.deposit_id=NEW.bank_deposit_id AND p.payment_id=NEW.id;
    END`,
] as const
export const bankDepositReviewAuthority = authority
