// #900: advances use the existing reviewed payment-run transport, but never
// reserve or settle a month of earnings. Reinstall only the affected triggers;
// the historical migration arrays (and their checksums) remain unchanged.
import { paymentRunsMigration } from './0093_payment_runs.js'
import { paymentActualsMigration } from './0094_payment_actuals.js'
import { paymentAllocationsMigration } from './0125_payment_allocations.js'

const reinstall = (
  statements: readonly string[],
  names: string[],
  transform: (sql: string) => string,
) =>
  names.flatMap((name) => {
    const original = statements.find((statement) => statement.startsWith(`CREATE TRIGGER ${name} `))
    if (!original) throw new Error(`Missing advance migration trigger ${name}`)
    return [`DROP TRIGGER ${name}`, transform(original)]
  })
const earningReservations = (statement: string) =>
  statement.replaceAll(
    'FROM payment_run_items WHERE user_id',
    "FROM payment_run_items WHERE purpose='earnings' AND user_id",
  )

const paymentEvent = (kind: 'payment' | 'void', id: string, application: string, note: string) => `
  INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id)
  SELECT ${id},a.user_id,a.month,b.version+1,'${kind}',
    json_object('id',${id},'user_id',a.user_id,'month',a.month,'expected_version',b.version,'kind','${kind}',
      'amount_cents',${kind === 'payment' ? 'a.amount_cents' : 'NULL'},'currency',${kind === 'payment' ? 'a.currency' : 'NULL'},
      'paid_on',${kind === 'payment' ? 'substr(NEW.recorded_at,1,10)' : 'NULL'},'due_on',NULL,
      'reference',a.advance_item_id,'note',${note},'payment_id',${kind === 'void' ? "'advance-application:'||a.id" : 'NULL'},'source','advance_credit'),
    NEW.actor_id,NEW.recorded_at,NEW.request_id
  FROM staff_advance_applications a JOIN staff_payment_balances b ON b.user_id=a.user_id AND b.month=a.month
  WHERE a.id=${application};`

export const contractorAdvancesMigration = [
  `ALTER TABLE payment_run_items ADD COLUMN purpose TEXT NOT NULL DEFAULT 'earnings' CHECK(purpose IN ('earnings','advance'))`,
  `ALTER TABLE payment_run_items ADD COLUMN advance_project_id INTEGER REFERENCES projects(id)`,
  `ALTER TABLE payment_run_items ADD COLUMN advance_reason TEXT`,
  ...reinstall(paymentRunsMigration, ['payment_run_create'], (statement) =>
    statement
      .replace(
        'max_source_cents,state,next_attempt_at,updated_at)',
        'max_source_cents,state,next_attempt_at,updated_at,purpose,advance_project_id,advance_reason)',
      )
      .replace(
        "'draft',NEW.scheduled_at,NEW.created_at FROM",
        "'draft',NEW.scheduled_at,NEW.created_at,COALESCE(json_extract(value,'$.purpose'),'earnings'),json_extract(value,'$.advance_project_id'),json_extract(value,'$.advance_reason') FROM",
      ),
  ),
  ...reinstall(paymentRunsMigration, ['payment_item_reserve'], (statement) =>
    earningReservations(statement).replace(
      'WHEN NOT EXISTS(SELECT 1 FROM staff_payment_balances',
      "WHEN NEW.purpose='earnings' AND NOT EXISTS(SELECT 1 FROM staff_payment_balances",
    ),
  ),
  ...reinstall(paymentRunsMigration, ['staff_payment_reservation_guard'], earningReservations),
  ...reinstall(paymentRunsMigration, ['payment_item_settle', 'payment_item_refund'], (statement) =>
    statement.replace('WHEN ', "WHEN NEW.purpose='earnings' AND "),
  ),
  ...reinstall(
    paymentActualsMigration,
    ['staff_payment_actuals_guard', 'staff_payment_period_move_guard'],
    earningReservations,
  ),
  ...reinstall(paymentActualsMigration, ['staff_payment_period_move_apply'], (statement) =>
    statement.replaceAll(
      'WHERE user_id=NEW.user_id AND month=NEW.from_month',
      "WHERE purpose='earnings' AND user_id=NEW.user_id AND month=NEW.from_month",
    ),
  ),
  ...reinstall(paymentAllocationsMigration, ['staff_payment_allocations_guard'], (statement) =>
    statement.replace('AND i.month=NEW.month', "AND i.purpose='earnings' AND i.month=NEW.month"),
  ),
  `CREATE TRIGGER payment_advance_insert_guard BEFORE INSERT ON payment_run_items WHEN NEW.purpose='advance' BEGIN
    SELECT CASE WHEN length(trim(COALESCE(NEW.advance_reason,''))) NOT BETWEEN 1 AND 2000
      OR NEW.month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR substr(NEW.month,6,2) NOT BETWEEN '01' AND '12'
      OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]' OR NEW.amount_cents>9000000000000
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1 AND is_contractor=1)
      OR (NEW.advance_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.advance_project_id))
      THEN RAISE(ABORT,'advance requires an active contractor, currency and reason') END;
  END`,
  `CREATE TRIGGER payment_advance_intent_immutable BEFORE UPDATE ON payment_run_items
    WHEN NEW.purpose<>OLD.purpose OR NEW.advance_project_id IS NOT OLD.advance_project_id OR NEW.advance_reason IS NOT OLD.advance_reason
      OR (OLD.purpose='advance' AND (NEW.user_id<>OLD.user_id OR NEW.month<>OLD.month OR NEW.currency<>OLD.currency OR NEW.amount_cents<>OLD.amount_cents))
    BEGIN SELECT RAISE(ABORT,'advance intent is immutable'); END`,
  `CREATE TABLE staff_advance_settlements (
    advance_item_id TEXT PRIMARY KEY REFERENCES payment_run_items(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
    recorded_at TEXT NOT NULL, transfer_id TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE staff_advance_applications (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100), advance_item_id TEXT NOT NULL REFERENCES staff_advance_settlements(advance_item_id),
    user_id INTEGER NOT NULL REFERENCES users(id), currency TEXT NOT NULL, month TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=9000000000000),
    scope TEXT NOT NULL CHECK(scope IN ('month','project','entry')), project_id INTEGER, entry_id INTEGER,
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE staff_advance_reversals (
    id TEXT PRIMARY KEY, application_id TEXT NOT NULL UNIQUE REFERENCES staff_advance_applications(id),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE staff_advance_returns (
    id TEXT PRIMARY KEY, advance_item_id TEXT NOT NULL REFERENCES staff_advance_settlements(advance_item_id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=9000000000000),
    reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 255),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    actor_id INTEGER NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL, request_id TEXT NOT NULL,
    UNIQUE(advance_item_id,reference)
  ) STRICT`,
  `CREATE VIEW staff_advance_balances AS SELECT i.id AS advance_item_id,i.user_id,i.currency,i.month,i.advance_project_id,i.advance_reason,i.state,
    i.amount_cents,COALESCE(s.amount_cents,0) AS settled_cents,s.recorded_at AS settled_at,
    COALESCE((SELECT SUM(a.amount_cents) FROM staff_advance_applications a WHERE a.advance_item_id=i.id AND NOT EXISTS(
      SELECT 1 FROM staff_advance_reversals r WHERE r.application_id=a.id)),0) AS applied_cents,
    COALESCE((SELECT SUM(r.amount_cents) FROM staff_advance_returns r WHERE r.advance_item_id=i.id),0) AS returned_cents
    FROM payment_run_items i LEFT JOIN staff_advance_settlements s ON s.advance_item_id=i.id WHERE i.purpose='advance'`,
  `CREATE TRIGGER staff_advance_settlement_guard BEFORE INSERT ON staff_advance_settlements BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payment_run_items WHERE id=NEW.advance_item_id AND purpose='advance' AND state='paid'
      AND amount_cents=NEW.amount_cents AND transfer_id=NEW.transfer_id)
      THEN RAISE(ABORT,'advance requires confirmed settlement') END;
  END`,
  `CREATE TRIGGER payment_advance_settle AFTER UPDATE OF state ON payment_run_items
    WHEN NEW.purpose='advance' AND NEW.state='paid' AND OLD.state<>'paid' BEGIN
    INSERT INTO staff_advance_settlements(advance_item_id,amount_cents,recorded_at,transfer_id)
      VALUES(NEW.id,NEW.amount_cents,NEW.updated_at,NEW.transfer_id);
  END`,
  `CREATE TRIGGER staff_advance_application_guard BEFORE INSERT ON staff_advance_applications BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_advance_balances b WHERE b.advance_item_id=NEW.advance_item_id
      AND b.user_id=NEW.user_id AND b.currency=NEW.currency AND b.state='paid'
      AND b.settled_at<=NEW.recorded_at AND b.settled_cents-b.applied_cents-b.returned_cents>=NEW.amount_cents)
      THEN RAISE(ABORT,'advance credit unavailable for this person and currency') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_payment_balances b WHERE b.user_id=NEW.user_id AND b.month=NEW.month
      AND b.currency=NEW.currency AND b.amount_cents-b.paid_cents>=NEW.amount_cents)
      OR NOT EXISTS(SELECT 1 FROM staff_payment_actuals WHERE user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency)
      THEN RAISE(ABORT,'advance application requires eligible reviewed earnings') END;
  END`,
  `CREATE TRIGGER staff_advance_application_apply AFTER INSERT ON staff_advance_applications BEGIN
    ${paymentEvent('payment', "'advance-application:'||NEW.id", 'NEW.id', 'NEW.reason')}
    INSERT INTO staff_payment_allocations(id,payment_kind,payment_id,user_id,month,currency,scope,project_id,project_name,entry_id,
      seconds,rate_cents,amount_cents,snapshot_json,command_json,reason,actor_id,recorded_at,request_id)
    SELECT 'advance-allocation:'||NEW.id,'event','advance-application:'||NEW.id,NEW.user_id,NEW.month,NEW.currency,NEW.scope,NEW.project_id,
      (SELECT name FROM projects WHERE id=NEW.project_id),NEW.entry_id,NULL,
      CASE WHEN NEW.scope='entry' THEN json_extract(j.value,'$.cost_rate_cents') ELSE NULL END,
      NEW.amount_cents,CASE WHEN NEW.scope='entry' THEN j.value ELSE NULL END,NEW.command_json,NEW.reason,NEW.actor_id,NEW.recorded_at,NEW.request_id
    FROM (SELECT 1) LEFT JOIN json_each((SELECT entries_json FROM staff_payment_actuals WHERE user_id=NEW.user_id AND month=NEW.month ORDER BY expected_version DESC LIMIT 1)) j
      ON NEW.scope='entry' AND json_extract(j.value,'$.entry_id')=NEW.entry_id
    WHERE NEW.scope<>'entry' OR j.value IS NOT NULL;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_payment_allocations WHERE id='advance-allocation:'||NEW.id)
      THEN RAISE(ABORT,'advance application entry is missing from the review') END;
  END`,
  `CREATE TRIGGER staff_advance_reversal_guard BEFORE INSERT ON staff_advance_reversals BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_advance_applications WHERE id=NEW.application_id AND recorded_at<=NEW.recorded_at)
      THEN RAISE(ABORT,'advance reversal must follow its application') END;
  END`,
  `CREATE TRIGGER staff_advance_reversal_apply AFTER INSERT ON staff_advance_reversals BEGIN
    ${paymentEvent('void', "'advance-reversal:'||NEW.id", 'NEW.application_id', 'NEW.reason')}
  END`,
  `CREATE TRIGGER staff_advance_payment_void_guard BEFORE INSERT ON staff_payment_events
    WHEN NEW.kind='void' AND json_extract(NEW.command_json,'$.payment_id') LIKE 'advance-application:%' AND NEW.id NOT LIKE 'advance-reversal:%'
    BEGIN SELECT RAISE(ABORT,'reverse the advance application to restore its credit'); END`,
  `CREATE TRIGGER staff_advance_return_guard BEFORE INSERT ON staff_advance_returns BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_advance_balances WHERE advance_item_id=NEW.advance_item_id
      AND settled_at<=NEW.recorded_at AND settled_cents-applied_cents-returned_cents>=NEW.amount_cents)
      THEN RAISE(ABORT,'return exceeds unapplied advance credit') END;
  END`,
  `CREATE TRIGGER payment_advance_refund AFTER UPDATE OF state ON payment_run_items
    WHEN NEW.purpose='advance' AND OLD.state='paid' AND NEW.state='failed' BEGIN
    INSERT INTO staff_advance_reversals(id,application_id,reason,command_json,actor_id,recorded_at,request_id)
      SELECT 'provider-refund:'||a.id,a.id,'Provider confirmed advance refund','{}',r.approved_by,NEW.updated_at,NEW.id
      FROM staff_advance_applications a JOIN payment_runs r ON r.id=NEW.run_id WHERE a.advance_item_id=NEW.id
      AND NOT EXISTS(SELECT 1 FROM staff_advance_reversals x WHERE x.application_id=a.id);
    INSERT INTO staff_advance_returns(id,advance_item_id,amount_cents,reference,reason,command_json,actor_id,recorded_at,request_id)
      SELECT 'provider-refund:'||NEW.id,NEW.id,b.settled_cents-b.returned_cents,NEW.transfer_id,'Provider confirmed advance refund','{}',r.approved_by,NEW.updated_at,NEW.id
      FROM staff_advance_balances b JOIN payment_runs r ON r.id=NEW.run_id WHERE b.advance_item_id=NEW.id AND b.settled_cents>b.returned_cents;
  END`,
  // Applications stay tied to their work month until reversed; period corrections
  // must not silently move the earning underneath a credit application.
  `CREATE TRIGGER staff_advance_period_move_guard BEFORE INSERT ON staff_payment_period_moves BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM staff_advance_applications a WHERE a.user_id=NEW.user_id AND a.month IN (NEW.from_month,NEW.to_month)
      AND NOT EXISTS(SELECT 1 FROM staff_advance_reversals r WHERE r.application_id=a.id))
      THEN RAISE(ABORT,'reverse advance applications before correcting the work month') END;
  END`,
  ...[
    'staff_advance_settlements',
    'staff_advance_applications',
    'staff_advance_reversals',
    'staff_advance_returns',
  ].flatMap((table) => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'advance history is immutable'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'advance history is immutable'); END`,
  ]),
] as const
