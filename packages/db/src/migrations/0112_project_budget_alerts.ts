// Provenance: ezacto-pvt #934. Projects carried `notify_when_over_budget` and an
// `over_budget_pct` and nothing ever acted on them.
//
// `project_budget_alerts` is one row per crossing of a project's budget
// threshold. At most one is open per project (the partial unique index), so two
// evaluators racing on the same crossing write one alert, and a project whose
// usage falls back under the line has its open row closed so that the next
// crossing is a new alert. `period` is the month for a monthly budget and
// 'lifetime' otherwise, so a monthly budget alerts once per month.
//
// `notification_deliveries` is the ledger the mail for a crossing is recorded
// in before it is queued: one row per (kind, person, scope, period). The key is
// what makes a redelivered outbox event, or a sweep that runs twice, unable to
// mail anybody a second time; the schema refuses it rather than a check
// somebody has to remember. The `kind` is a closed vocabulary in code, not a
// CHECK, so a later notification does not need a table rebuild.
//
// `organizations.budget_alerts_include_admins` is the company setting behind
// "and admins if configured". Off by default: nobody starts receiving mail
// because a deployment was upgraded. Administrators are mailed regardless when
// a project has no manager to tell, so an alert never goes to nobody.
export const projectBudgetAlertsMigration = [
  `CREATE TABLE project_budget_alerts (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period TEXT NOT NULL CHECK (
      period = 'lifetime' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    ),
    unit TEXT NOT NULL CHECK (unit IN ('seconds','cents')),
    budget_amount INTEGER NOT NULL CHECK (budget_amount > 0),
    spent_amount INTEGER NOT NULL CHECK (spent_amount >= 0),
    threshold_pct REAL NOT NULL CHECK (threshold_pct > 0),
    crossed_at TEXT NOT NULL CHECK (unixepoch(crossed_at) IS NOT NULL),
    closed_at TEXT CHECK (closed_at IS NULL OR unixepoch(closed_at) IS NOT NULL)
  ) STRICT`,
  `CREATE UNIQUE INDEX project_budget_alerts_one_open
    ON project_budget_alerts(project_id) WHERE closed_at IS NULL`,
  `CREATE INDEX project_budget_alerts_project ON project_budget_alerts(project_id, id)`,
  `CREATE TABLE notification_deliveries (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64 AND kind NOT GLOB '*[^a-z_]*'),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT '' CHECK (length(scope) <= 128),
    period TEXT NOT NULL CHECK (length(period) BETWEEN 1 AND 128),
    outcome TEXT NOT NULL CHECK (outcome IN ('queued','skipped')),
    skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 256),
    delivery_id INTEGER REFERENCES email_log(id) ON DELETE RESTRICT,
    to_email TEXT CHECK (to_email IS NULL OR length(to_email) BETWEEN 3 AND 320),
    subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 998),
    text_body TEXT CHECK (text_body IS NULL OR length(text_body) <= 100000),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    UNIQUE (kind, user_id, scope, period),
    CHECK (
      (outcome = 'queued' AND delivery_id IS NOT NULL AND to_email IS NOT NULL
        AND subject IS NOT NULL AND text_body IS NOT NULL AND skip_reason IS NULL)
      OR (outcome = 'skipped' AND delivery_id IS NULL AND skip_reason IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX notification_deliveries_delivery ON notification_deliveries(delivery_id)`,
  `ALTER TABLE organizations ADD COLUMN budget_alerts_include_admins INTEGER NOT NULL DEFAULT 0
    CHECK (budget_alerts_include_admins IN (0,1))`,
] as const
