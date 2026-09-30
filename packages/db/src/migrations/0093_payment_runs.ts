// The database owns reservations and settlement. Triggers make the same
// transactions atomic on D1 and SQLite, including concurrent manual entries.
const reserved = (user: string, month: string, excluding = "''") =>
  `(SELECT COALESCE(SUM(amount_cents),0) FROM payment_run_items WHERE user_id = ${user} AND month = ${month}
    AND id <> ${excluding} AND state IN ('queued','creating','funding','processing','attention'))`
export const paymentRunsMigration = [
  `CREATE VIEW staff_payment_balances AS SELECT e.user_id, e.month, MAX(e.version) AS version,
    (SELECT json_extract(a.command_json,'$.amount_cents') FROM staff_payment_events a WHERE a.user_id=e.user_id AND a.month=e.month AND a.kind='amount' ORDER BY a.version DESC LIMIT 1) AS amount_cents,
    (SELECT json_extract(a.command_json,'$.currency') FROM staff_payment_events a WHERE a.user_id=e.user_id AND a.month=e.month AND a.kind='amount' ORDER BY a.version DESC LIMIT 1) AS currency,
    COALESCE(SUM(CASE WHEN e.kind='payment' AND NOT EXISTS(SELECT 1 FROM staff_payment_events v WHERE v.kind='void' AND json_extract(v.command_json,'$.payment_id')=e.id)
      THEN json_extract(e.command_json,'$.amount_cents') ELSE 0 END),0) AS paid_cents
    FROM staff_payment_events e GROUP BY e.user_id,e.month`,
  `CREATE TABLE payment_runs (
    id TEXT PRIMARY KEY, command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    name TEXT NOT NULL, source_currency TEXT NOT NULL, scheduled_at TEXT NOT NULL, timezone TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','approved','cancelled')),
    actor_id INTEGER NOT NULL REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL, approved_at TEXT, request_id TEXT NOT NULL,
    approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json))
  ) STRICT`,
  `CREATE TABLE payment_run_items (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES payment_runs(id),
    user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL, expected_version INTEGER NOT NULL,
    name TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL,
    destination_json TEXT NOT NULL CHECK(json_valid(destination_json)),
    quote_json TEXT NOT NULL CHECK(json_valid(quote_json)), execution_quote_json TEXT CHECK(execution_quote_json IS NULL OR json_valid(execution_quote_json)),
    max_source_cents INTEGER NOT NULL CHECK(max_source_cents>0),
    state TEXT NOT NULL CHECK(state IN ('draft','queued','creating','funding','processing','paid','failed','attention','cancelled')),
    transfer_id TEXT UNIQUE, provider_status TEXT, failure TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
    UNIQUE(run_id,user_id,month)
  ) STRICT`,
  `CREATE INDEX payment_run_due ON payment_run_items(state,next_attempt_at)`,
  `CREATE INDEX payment_run_ledger ON payment_run_items(user_id,month,state)`,
  `CREATE TABLE payment_run_audit (id INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES payment_runs(id),item_id TEXT,
    action TEXT NOT NULL,actor_id INTEGER REFERENCES users(id),request_id TEXT NOT NULL,recorded_at TEXT NOT NULL,detail TEXT NOT NULL) STRICT`,
  `CREATE TRIGGER payment_run_audit_no_update BEFORE UPDATE ON payment_run_audit BEGIN SELECT RAISE(ABORT,'payment run audit is immutable'); END`,
  `CREATE TRIGGER payment_run_audit_no_delete BEFORE DELETE ON payment_run_audit BEGIN SELECT RAISE(ABORT,'payment run audit is immutable'); END`,
  `CREATE TRIGGER payment_run_create AFTER INSERT ON payment_runs BEGIN
    INSERT INTO payment_run_items(id,run_id,user_id,month,expected_version,name,amount_cents,currency,destination_json,quote_json,max_source_cents,state,next_attempt_at,updated_at)
    SELECT json_extract(value,'$.id'),NEW.id,json_extract(value,'$.user_id'),json_extract(value,'$.month'),json_extract(value,'$.expected_version'),
      json_extract(value,'$.name'),json_extract(value,'$.amount_cents'),json_extract(value,'$.currency'),json_extract(value,'$.destination'),json_extract(value,'$.quote'),
      json_extract(value,'$.quote.source_cents'),'draft',NEW.scheduled_at,NEW.created_at FROM json_each(NEW.command_json,'$.items');
    INSERT INTO payment_run_audit(run_id,action,actor_id,request_id,recorded_at,detail) VALUES(NEW.id,'preview',NEW.actor_id,NEW.request_id,NEW.created_at,NEW.command_json);
  END`,
  `CREATE TRIGGER payment_run_approve AFTER UPDATE OF state ON payment_runs WHEN NEW.state='approved' AND OLD.state='draft' BEGIN
    UPDATE payment_run_items SET state='queued', max_source_cents=(SELECT json_extract(value,'$.max_source_cents') FROM json_each(NEW.approval_json,'$.limits') WHERE json_extract(value,'$.item_id')=payment_run_items.id),updated_at=NEW.approved_at,version=version+1 WHERE run_id=NEW.id;
    INSERT INTO payment_run_audit(run_id,action,actor_id,request_id,recorded_at,detail) VALUES(NEW.id,'approve',NEW.approved_by,NEW.request_id,NEW.approved_at,NEW.approval_json);
  END`,
  `CREATE TRIGGER payment_item_reserve BEFORE UPDATE OF state ON payment_run_items WHEN OLD.state='draft' AND NEW.state='queued' BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_payment_balances b WHERE b.user_id=NEW.user_id AND b.month=NEW.month AND b.version=NEW.expected_version
      AND b.currency=NEW.currency AND b.amount_cents-b.paid_cents-${reserved('NEW.user_id', 'NEW.month', 'NEW.id')}>=NEW.amount_cents)
      THEN RAISE(ABORT,'payment balance changed or reserved') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM user_payout_accounts a WHERE a.id=json_extract(NEW.destination_json,'$.id') AND a.user_id=NEW.user_id AND a.provider='wise' AND a.detached_at IS NULL AND a.verified_at IS NOT NULL)
      THEN RAISE(ABORT,'payment destination changed') END;
  END`,
  `CREATE TRIGGER staff_payment_reservation_guard BEFORE INSERT ON staff_payment_events BEGIN
    SELECT CASE WHEN NEW.kind='payment' AND NEW.id NOT LIKE 'run-payment:%' AND json_extract(NEW.command_json,'$.source')='wise'
      AND EXISTS(SELECT 1 FROM payment_run_items WHERE transfer_id=json_extract(NEW.command_json,'$.reference'))
      THEN RAISE(ABORT,'provider payments require reconciliation') END;
    SELECT CASE WHEN NEW.kind='payment' AND json_extract(NEW.command_json,'$.amount_cents') + ${reserved('NEW.user_id', 'NEW.month')} >
      (SELECT amount_cents-paid_cents FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month)
      THEN RAISE(ABORT,'payment balance is reserved') END;
    SELECT CASE WHEN NEW.kind='amount' AND ${reserved('NEW.user_id', 'NEW.month')}>0 AND
      (json_extract(NEW.command_json,'$.currency') IS NOT (SELECT currency FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month)
       OR json_extract(NEW.command_json,'$.amount_cents') < (SELECT paid_cents FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month)+${reserved('NEW.user_id', 'NEW.month')})
      THEN RAISE(ABORT,'payment balance is reserved') END;
    SELECT CASE WHEN NEW.kind='void' AND NEW.id NOT LIKE 'run-refund:%' AND json_extract(NEW.command_json,'$.payment_id') LIKE 'run-payment:%'
      THEN RAISE(ABORT,'provider payments require a confirmed refund') END;
  END`,
  `CREATE TRIGGER payment_item_settle AFTER UPDATE OF state ON payment_run_items WHEN NEW.state='paid' AND OLD.state<>'paid' BEGIN
    INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id)
    SELECT 'run-payment:'||NEW.id,NEW.user_id,NEW.month,COALESCE(b.version,0)+1,'payment',
      json_object('id','run-payment:'||NEW.id,'user_id',NEW.user_id,'month',NEW.month,'expected_version',COALESCE(b.version,0),'kind','payment',
      'amount_cents',NEW.amount_cents,'currency',NEW.currency,'paid_on',COALESCE((SELECT strftime('%Y-%m-%d',occurred_at) FROM wise_webhook_deliveries WHERE transfer_id=NEW.transfer_id AND current_state='outgoing_payment_sent' AND julianday(occurred_at)<=julianday(NEW.updated_at) AND julianday(occurred_at)>=julianday(r.approved_at) ORDER BY occurred_at LIMIT 1),substr(NEW.updated_at,1,10)),'due_on',NULL,'reference',NEW.transfer_id,
      'note','Wise confirmed outgoing payment; provider event date when available, otherwise confirmation date','payment_id',NULL,'source','wise'),r.approved_by,NEW.updated_at,r.request_id
    FROM payment_runs r LEFT JOIN staff_payment_balances b ON b.user_id=NEW.user_id AND b.month=NEW.month WHERE r.id=NEW.run_id;
  END`,
  `CREATE TRIGGER payment_item_refund AFTER UPDATE OF state ON payment_run_items WHEN OLD.state='paid' AND NEW.state='failed' BEGIN
    INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id)
    SELECT 'run-refund:'||NEW.id,NEW.user_id,NEW.month,b.version+1,'void',json_object('id','run-refund:'||NEW.id,'user_id',NEW.user_id,'month',NEW.month,
      'expected_version',b.version,'kind','void','amount_cents',NULL,'currency',NULL,'paid_on',NULL,'due_on',NULL,'reference','',
      'note','Wise confirmed transfer refund','payment_id','run-payment:'||NEW.id,'source','wise'),r.approved_by,NEW.updated_at,r.request_id
    FROM payment_runs r JOIN staff_payment_balances b ON b.user_id=NEW.user_id AND b.month=NEW.month WHERE r.id=NEW.run_id;
  END`,
  `CREATE TRIGGER payment_run_wise_delivery AFTER INSERT ON wise_webhook_deliveries WHEN NEW.transfer_id IS NOT NULL BEGIN
    UPDATE payment_run_items SET next_attempt_at=NEW.received_at WHERE transfer_id=NEW.transfer_id AND state NOT IN ('failed','cancelled');
  END`,
  `CREATE TRIGGER payment_item_audit AFTER UPDATE ON payment_run_items WHEN OLD.state<>NEW.state OR OLD.failure IS NOT NEW.failure BEGIN
    INSERT INTO payment_run_audit(run_id,item_id,action,request_id,recorded_at,detail) VALUES(NEW.run_id,NEW.id,NEW.state,NEW.id,NEW.updated_at,
      json_object('transfer_id',NEW.transfer_id,'provider_status',NEW.provider_status,'failure',NEW.failure));
  END`,
] as const
