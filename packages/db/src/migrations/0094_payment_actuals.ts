/** Immutable review snapshots and auditable work-period corrections. */
export const paymentActualsMigration = [
  `CREATE TABLE staff_payment_period_moves (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    from_month TEXT NOT NULL, to_month TEXT NOT NULL, through_version INTEGER NOT NULL,
    actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
    request_id TEXT NOT NULL, note TEXT NOT NULL CHECK(length(trim(note))>0),
    UNIQUE(user_id,from_month), UNIQUE(user_id,to_month), CHECK(from_month<>to_month),
    CHECK(from_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(from_month,6,2) BETWEEN '01' AND '12'),
    CHECK(to_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(to_month,6,2) BETWEEN '01' AND '12'),
    CHECK(through_version>0)
  ) STRICT`,
  `CREATE TRIGGER staff_payment_period_move_guard BEFORE INSERT ON staff_payment_period_moves BEGIN
    SELECT CASE WHEN NEW.through_version IS NOT (SELECT MAX(version) FROM staff_payment_events WHERE user_id=NEW.user_id AND month=NEW.from_month)
      OR EXISTS(SELECT 1 FROM staff_payment_events WHERE user_id=NEW.user_id AND month=NEW.to_month)
      OR EXISTS(SELECT 1 FROM staff_payment_period_moves WHERE user_id=NEW.user_id AND (to_month=NEW.from_month OR from_month=NEW.to_month))
      OR EXISTS(SELECT 1 FROM payment_run_items WHERE user_id=NEW.user_id AND month IN (NEW.from_month,NEW.to_month) AND state NOT IN ('paid','cancelled','failed'))
      OR EXISTS(SELECT 1 FROM staff_payment_events WHERE user_id=NEW.user_id AND month=NEW.from_month AND kind='opening')
      THEN RAISE(ABORT,'period correction requires an unchanged completed register and empty destination') END;
  END`,
  `CREATE TRIGGER staff_payment_period_move_apply AFTER INSERT ON staff_payment_period_moves BEGIN
    INSERT INTO payment_run_audit(run_id,item_id,action,actor_id,request_id,recorded_at,detail)
      SELECT run_id,id,'work_month_corrected',NEW.actor_id,NEW.request_id,NEW.recorded_at,
        json_object('from_month',NEW.from_month,'to_month',NEW.to_month,'note',NEW.note)
      FROM payment_run_items WHERE user_id=NEW.user_id AND month=NEW.from_month;
    UPDATE payment_run_items SET month=NEW.to_month,version=version+1
      WHERE user_id=NEW.user_id AND month=NEW.from_month;
  END`,
  // Original records stay immutable. Their old period retains correction notes
  // and versions; financial entries are projected into the corrected period.
  `CREATE VIEW staff_payment_effective_events AS
    SELECT e.id,e.user_id,COALESCE(m.to_month,e.month) AS month,e.version,e.kind,
      CASE WHEN m.id IS NULL THEN e.command_json ELSE json_set(e.command_json,'$.month',m.to_month,
        '$.note',json_extract(e.command_json,'$.note')||' [Work month corrected from '||m.from_month||': '||m.note||']') END AS command_json,
      e.actor_id,e.recorded_at,e.request_id
    FROM staff_payment_events e LEFT JOIN staff_payment_period_moves m ON m.user_id=e.user_id AND m.from_month=e.month AND e.version<=m.through_version
    UNION ALL SELECT 'period-moved:'||e.id,e.user_id,e.month,e.version,'note',
      json_set(e.command_json,'$.id','period-moved:'||e.id,'$.kind','note','$.amount_cents',NULL,'$.currency',NULL,
        '$.paid_on',NULL,'$.due_on',NULL,'$.reference','','$.payment_id',NULL,
        '$.note','Moved to work month '||m.to_month||': '||m.note),m.actor_id,m.recorded_at,m.request_id
    FROM staff_payment_events e JOIN staff_payment_period_moves m ON m.user_id=e.user_id AND m.from_month=e.month AND e.version<=m.through_version`,
  `DROP VIEW staff_payment_balances`,
  `CREATE VIEW staff_payment_balances AS SELECT e.user_id,e.month,MAX(e.version) AS version,
    (SELECT json_extract(a.command_json,'$.amount_cents') FROM staff_payment_effective_events a WHERE a.user_id=e.user_id AND a.month=e.month AND a.kind='amount' ORDER BY a.version DESC LIMIT 1) AS amount_cents,
    (SELECT json_extract(a.command_json,'$.currency') FROM staff_payment_effective_events a WHERE a.user_id=e.user_id AND a.month=e.month AND a.kind='amount' ORDER BY a.version DESC LIMIT 1) AS currency,
    COALESCE(SUM(CASE WHEN e.kind='payment' AND NOT EXISTS(SELECT 1 FROM staff_payment_effective_events v WHERE v.kind='void' AND json_extract(v.command_json,'$.payment_id')=e.id)
      THEN json_extract(e.command_json,'$.amount_cents') ELSE 0 END),0) AS paid_cents
    FROM staff_payment_effective_events e GROUP BY e.user_id,e.month`,
  `CREATE TABLE staff_payment_actuals (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),month TEXT NOT NULL,
    command_json TEXT NOT NULL CHECK(json_valid(command_json)), entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),currency TEXT NOT NULL,
    expected_version INTEGER NOT NULL,actor_id INTEGER NOT NULL REFERENCES users(id),
    recorded_at TEXT NOT NULL,request_id TEXT NOT NULL,note TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER staff_payment_actuals_guard BEFORE INSERT ON staff_payment_actuals BEGIN
    SELECT CASE WHEN NEW.expected_version<>COALESCE((SELECT version FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month),0)
      THEN RAISE(ABORT,'actuals ledger changed') END;
    SELECT CASE WHEN NEW.currency IS NOT (SELECT upper(currency) FROM organizations WHERE id=1)
      OR EXISTS(SELECT 1 FROM json_each(NEW.entries_json) j WHERE NOT EXISTS(
        SELECT 1 FROM time_entries t JOIN projects p ON p.id=t.project_id WHERE p.name=json_extract(j.value,'$.project_name') AND t.id=json_extract(j.value,'$.entry_id') AND t.user_id=NEW.user_id
          AND t.spent_date=json_extract(j.value,'$.spent_date') AND t.project_id=json_extract(j.value,'$.project_id')
          AND t.rounded_seconds=json_extract(j.value,'$.rounded_seconds') AND t.cost_rate_cents IS json_extract(j.value,'$.cost_rate_cents')))
      THEN RAISE(ABORT,'actuals source changed') END;
    SELECT CASE WHEN NEW.amount_cents < COALESCE((SELECT paid_cents FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month),0)
      +(SELECT COALESCE(SUM(amount_cents),0) FROM payment_run_items WHERE user_id=NEW.user_id AND month=NEW.month AND state IN ('queued','creating','funding','processing','attention'))
      THEN RAISE(ABORT,'actuals amount is below paid or reserved funds') END;
    INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id)
      VALUES(NEW.id,NEW.user_id,NEW.month,NEW.expected_version+1,'amount',
        json_object('id',NEW.id,'user_id',NEW.user_id,'month',NEW.month,'expected_version',NEW.expected_version,'kind','amount',
          'amount_cents',NEW.amount_cents,'currency',NEW.currency,'paid_on',NULL,'due_on',
          (SELECT json_extract(command_json,'$.due_on') FROM staff_payment_effective_events WHERE user_id=NEW.user_id AND month=NEW.month AND kind='amount' ORDER BY version DESC LIMIT 1),
          'reference','','note',NEW.note,
          'payment_id',NULL,'source','historical'),NEW.actor_id,NEW.recorded_at,NEW.request_id);
  END`,
  ...['staff_payment_period_moves', 'staff_payment_actuals'].flatMap((table) => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'payment history is immutable'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'payment history is immutable'); END`,
  ]),
] as const
