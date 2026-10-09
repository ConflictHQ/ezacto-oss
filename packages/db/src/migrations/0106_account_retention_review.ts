const areas = [
  'documents_and_notes',
  'attachments',
  'email_copies',
  'integrations_and_exports',
  'backups',
  'restore_safeguards',
  'apple_authorization',
]
const seed = (
  where: string,
) => `INSERT INTO account_retention_obligations(request_id,area,kind,original_reason,original_period,next_review_at,hold_active)
  SELECT closure.request_id,json_extract(rule.value,'$.category'),'retained_category',json_extract(rule.value,'$.reason'),json_extract(rule.value,'$.period'),
    strftime('%Y-%m-%dT%H:%M:%fZ',closure.closed_at,'+' || json_extract(rule.value,'$.review_after_days') || ' days'),json_extract(rule.value,'$.category')='legal_hold'
  FROM account_closures closure,json_each(closure.policy_snapshot,'$.retained_records') rule WHERE ${where};
  ${areas
    .map(
      (
        area,
      ) => `INSERT INTO account_retention_obligations(request_id,area,kind,original_reason,original_period,next_review_at)
    SELECT closure.request_id,'${area}','downstream','Inspect applicable copies and record the actual result.','Operator-reviewed handling with no automatic expiry.',closure.closed_at FROM account_closures closure WHERE ${where};`,
    )
    .join('\n')}`
export const accountRetentionReviewMigration = [
  `CREATE TABLE account_retention_obligations (
    request_id TEXT NOT NULL REFERENCES account_closures(request_id) ON DELETE RESTRICT,
    area TEXT NOT NULL CHECK(area IN ('time_and_worker_attribution','billing_and_payments','audit_and_security','legal_hold',${areas.map((x) => `'${x}'`).join(',')})),
    kind TEXT NOT NULL CHECK(kind IN ('retained_category','downstream')),
    original_reason TEXT NOT NULL,original_period TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','retain','removed','not_applicable','failed','release_hold')),
    basis TEXT NOT NULL DEFAULT '' CHECK(length(basis)<=2000),release_condition TEXT NOT NULL DEFAULT '' CHECK(length(release_condition)<=2000),
    evidence TEXT NOT NULL DEFAULT '' CHECK(length(evidence)<=2000),
    next_review_at TEXT CHECK(next_review_at IS NULL OR unixepoch(next_review_at) IS NOT NULL),
    hold_active INTEGER NOT NULL DEFAULT 0 CHECK(hold_active IN (0,1)),version INTEGER NOT NULL DEFAULT 1,
    reviewed_at TEXT,actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    PRIMARY KEY(request_id,area)
  ) STRICT`,
  `CREATE TABLE account_retention_review_events (
    request_id TEXT NOT NULL,area TEXT NOT NULL,version INTEGER NOT NULL,
    decision TEXT NOT NULL,basis TEXT NOT NULL,release_condition TEXT NOT NULL,evidence TEXT NOT NULL,next_review_at TEXT,
    hold_active INTEGER NOT NULL,occurred_at TEXT NOT NULL,actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    PRIMARY KEY(request_id,area,version),FOREIGN KEY(request_id,area) REFERENCES account_retention_obligations(request_id,area) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TRIGGER account_retention_obligations_immutable BEFORE UPDATE ON account_retention_obligations
    WHEN NEW.request_id IS NOT OLD.request_id OR NEW.area IS NOT OLD.area OR NEW.kind IS NOT OLD.kind OR NEW.original_reason IS NOT OLD.original_reason OR NEW.original_period IS NOT OLD.original_period
    BEGIN SELECT RAISE(ABORT,'retention disclosure is immutable'); END`,
  `CREATE TRIGGER account_retention_review_history AFTER UPDATE ON account_retention_obligations WHEN NEW.version<>OLD.version BEGIN
    INSERT INTO account_retention_review_events VALUES(NEW.request_id,NEW.area,NEW.version,NEW.decision,NEW.basis,NEW.release_condition,NEW.evidence,NEW.next_review_at,NEW.hold_active,NEW.reviewed_at,NEW.actor_user_id);
  END`,
  `CREATE TRIGGER account_retention_review_events_immutable BEFORE UPDATE ON account_retention_review_events BEGIN SELECT RAISE(ABORT,'retention review history is immutable'); END`,
  `CREATE TRIGGER account_retention_review_events_keep BEFORE DELETE ON account_retention_review_events BEGIN SELECT RAISE(ABORT,'retention review history cannot be silently removed'); END`,
  ...seed('1')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean),
  `CREATE TRIGGER account_closure_retention_obligations AFTER INSERT ON account_closures BEGIN ${seed('closure.request_id=NEW.request_id')} END`,
] as const
