// #902: one accepted reconciliation is one SQLite statement, including its
// existing allocation/advance ledger writes. The same triggers run on D1.
const scopedTables: Record<string, (row: string) => string> = {
  organizations: () => "SELECT 'all' AS scope",
  projects: () => "SELECT 'all' AS scope",
  users: (r) => `SELECT 'person:'||${r}.id AS scope`,
  user_payout_accounts: (r) => `SELECT 'person:'||${r}.user_id AS scope`,
  time_entries: (r) => `SELECT 'month:'||${r}.user_id||':'||substr(${r}.spent_date,1,7) AS scope`,
  staff_payment_events: (r) => `SELECT 'person:'||${r}.user_id AS scope`,
  staff_payment_actuals: (r) => `SELECT 'month:'||${r}.user_id||':'||${r}.month AS scope`,
  staff_payment_period_moves: (r) => `SELECT 'person:'||${r}.user_id AS scope`,
  staff_payment_provider_events: (r) =>
    `SELECT CASE WHEN ${r}.user_id IS NULL THEN 'all' ELSE 'person:'||${r}.user_id END AS scope`,
  staff_payment_allocations: (r) => `SELECT 'month:'||${r}.user_id||':'||${r}.month AS scope`,
  staff_payment_allocation_reversals: (r) =>
    `SELECT 'month:'||a.user_id||':'||a.month AS scope FROM staff_payment_allocations a WHERE a.id=${r}.allocation_id`,
  staff_invoice_versions: (r) => `SELECT 'person:'||${r}.user_id AS scope`,
  staff_invoice_documents: (r) =>
    `SELECT 'person:'||i.user_id AS scope FROM staff_invoices i WHERE i.id=${r}.invoice_id`,
  payment_runs: (r) =>
    `SELECT DISTINCT 'person:'||i.user_id AS scope FROM payment_run_items i WHERE i.run_id=${r}.id`,
  payment_run_items: (r) =>
    `SELECT CASE WHEN ${r}.purpose='advance' THEN 'person:'||${r}.user_id ELSE 'month:'||${r}.user_id||':'||${r}.month END AS scope`,
  staff_advance_settlements: (r) =>
    `SELECT 'person:'||i.user_id AS scope FROM payment_run_items i WHERE i.id=${r}.advance_item_id`,
  staff_advance_applications: (r) => `SELECT 'person:'||${r}.user_id AS scope`,
  staff_advance_reversals: (r) =>
    `SELECT 'person:'||a.user_id AS scope FROM staff_advance_applications a WHERE a.id=${r}.application_id`,
  staff_advance_returns: (r) =>
    `SELECT 'person:'||i.user_id AS scope FROM payment_run_items i WHERE i.id=${r}.advance_item_id`,
}
export const contractorSourceRevisionSql = (user: string, month: string) => `json_array(
  COALESCE((SELECT revision FROM contractor_source_versions WHERE scope='all'),0),
  COALESCE((SELECT revision FROM contractor_source_versions WHERE scope='person:'||${user}),0),
  COALESCE((SELECT revision FROM contractor_source_versions WHERE scope='month:'||${user}||':'||${month}),0))`
export const contractorAcceptanceMigration = [
  `CREATE TABLE contractor_source_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)) STRICT`,
  `INSERT INTO contractor_source_clock VALUES(1,0)`,
  `CREATE TABLE contractor_source_versions(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)) STRICT`,
  ...Object.entries(scopedTables).flatMap(([table, scopes]) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((event) => {
      const rows = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW']
      return `CREATE TRIGGER contractor_source_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
      UPDATE contractor_source_clock SET revision=revision+1 WHERE id=1;
      INSERT INTO contractor_source_versions(scope,revision)
        SELECT scope,(SELECT revision FROM contractor_source_clock WHERE id=1) FROM (${rows.map(scopes).join(' UNION ')}) WHERE 1
        ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision;
    END`
    }),
  ),
  `CREATE TABLE contractor_acceptances (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 60 AND id NOT GLOB '*[^a-zA-Z0-9._-]*'),
    user_id INTEGER NOT NULL REFERENCES users(id),month TEXT NOT NULL,currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
    review_version TEXT NOT NULL CHECK(length(review_version)=64),source_revision TEXT NOT NULL CHECK(json_valid(source_revision)),
    command_json TEXT NOT NULL CHECK(json_valid(command_json)),allocations_json TEXT NOT NULL CHECK(json_type(allocations_json)='array'),
    credits_json TEXT NOT NULL CHECK(json_type(credits_json)='array'),reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
    actor_id INTEGER NOT NULL REFERENCES users(id),recorded_at TEXT NOT NULL,request_id TEXT NOT NULL,
    CHECK(json_array_length(allocations_json)+json_array_length(credits_json) BETWEEN 1 AND 500)
  ) STRICT`,
  `CREATE INDEX contractor_acceptances_month_person ON contractor_acceptances(month,user_id,recorded_at)`,
  `CREATE TRIGGER contractor_acceptance_guard BEFORE INSERT ON contractor_acceptances BEGIN
    SELECT CASE WHEN NEW.source_revision<>${contractorSourceRevisionSql('NEW.user_id', 'NEW.month')}
      THEN RAISE(ABORT,'contractor reconciliation source changed') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1 AND is_contractor=1)
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND profile='administrator' AND is_active=1)
      THEN RAISE(ABORT,'contractor reconciliation requires an active contractor and administrator') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_payment_actuals WHERE user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency)
      THEN RAISE(ABORT,'contractor reconciliation requires reviewed earnings') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) WHERE json_extract(value,'$.user_id') IS NOT NEW.user_id
        OR json_extract(value,'$.month') IS NOT NEW.month OR json_extract(value,'$.scope') IS NOT 'month'
        OR json_extract(value,'$.reason') IS NOT NEW.reason)
      OR EXISTS(SELECT 1 FROM json_each(NEW.credits_json) WHERE json_extract(value,'$.user_id') IS NOT NEW.user_id
        OR json_extract(value,'$.month') IS NOT NEW.month OR json_extract(value,'$.currency') IS NOT NEW.currency
        OR json_extract(value,'$.scope') IS NOT 'month' OR json_extract(value,'$.reason') IS NOT NEW.reason)
      THEN RAISE(ABORT,'contractor reconciliation command scope changed') END;
  END`,
  `CREATE TRIGGER contractor_acceptance_apply AFTER INSERT ON contractor_acceptances BEGIN
    INSERT INTO staff_payment_allocations(id,payment_kind,payment_id,user_id,month,currency,scope,project_id,project_name,entry_id,seconds,rate_cents,
      amount_cents,snapshot_json,command_json,reason,actor_id,recorded_at,request_id)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.payment_kind'),json_extract(value,'$.payment_id'),NEW.user_id,NEW.month,NEW.currency,
      'month',NULL,NULL,NULL,NULL,NULL,json_extract(value,'$.amount_cents'),NULL,value,NEW.reason,NEW.actor_id,NEW.recorded_at,NEW.request_id
      FROM json_each(NEW.allocations_json);
    INSERT INTO staff_advance_applications(id,advance_item_id,user_id,currency,month,amount_cents,scope,project_id,entry_id,reason,command_json,actor_id,recorded_at,request_id)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.advance_item_id'),NEW.user_id,NEW.currency,NEW.month,json_extract(value,'$.amount_cents'),
      'month',NULL,NULL,NEW.reason,value,NEW.actor_id,NEW.recorded_at,NEW.request_id FROM json_each(NEW.credits_json);
  END`,
  ...['UPDATE', 'DELETE'].map(
    (
      event,
    ) => `CREATE TRIGGER contractor_acceptance_no_${event.toLowerCase()} BEFORE ${event} ON contractor_acceptances BEGIN
    SELECT RAISE(ABORT,'contractor reconciliation acceptance is immutable'); END`,
  ),
] as const
