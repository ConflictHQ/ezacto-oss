const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
      AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
      AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
      AND (
        ${column} GLOB '????-??-??T??:??:??Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
      )`

const moneyUpperBound = 9_000_000_000_000
const maxSafeInteger = 9_007_199_254_740_991

const invoiceClientConsistencyTrigger = `CREATE TRIGGER invoices_client_consistent_with_children_update
    BEFORE UPDATE OF client_id ON invoices
    WHEN OLD.client_id IS NOT NEW.client_id AND (
      EXISTS (
        SELECT 1 FROM invoice_line_items line
        JOIN projects project ON project.id = line.project_id
        WHERE line.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
      OR EXISTS (
        SELECT 1 FROM time_entries entry
        JOIN projects project ON project.id = entry.project_id
        WHERE entry.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
      OR EXISTS (
        SELECT 1 FROM project_milestones milestone
        JOIN projects project ON project.id = milestone.project_id
        WHERE milestone.invoiced_invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
      OR EXISTS (
        SELECT 1 FROM expenses expense
        JOIN projects project ON project.id = expense.project_id
        WHERE expense.invoice_id = OLD.id AND project.client_id IS NOT NEW.client_id
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice client must match every linked project'); END`

const projectClientImmutabilityTrigger = `CREATE TRIGGER projects_client_immutable_while_invoiced
    BEFORE UPDATE OF client_id ON projects
    WHEN OLD.client_id IS NOT NEW.client_id
      AND (
        EXISTS (SELECT 1 FROM invoices WHERE project_id = OLD.id)
        OR EXISTS (SELECT 1 FROM invoice_line_items WHERE project_id = OLD.id)
        OR EXISTS (
          SELECT 1 FROM time_entries
          WHERE project_id = OLD.id AND invoice_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM project_milestones
          WHERE project_id = OLD.id AND invoiced_invoice_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM expenses
          WHERE project_id = OLD.id AND invoice_id IS NOT NULL
        )
      )
    BEGIN SELECT RAISE(ABORT, 'project client is immutable while invoices are linked'); END`

export const expensesMigration = [
  `CREATE TABLE expense_categories (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    unit_name TEXT,
    unit_price_cents INTEGER
      CHECK (unit_price_cents IS NULL OR unit_price_cents BETWEEN 0 AND ${moneyUpperBound}),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    expense_category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
    spent_date TEXT NOT NULL,
    notes TEXT,
    units INTEGER CHECK (units IS NULL OR units BETWEEN 0 AND ${maxSafeInteger}),
    total_cost_cents INTEGER NOT NULL
      CHECK (abs(total_cost_cents) <= ${moneyUpperBound}),
    billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0,1)),
    approval_status TEXT NOT NULL DEFAULT 'unsubmitted'
      CHECK (approval_status IN ('unsubmitted','submitted','approved')),
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
    reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0,1)),
    reimbursement_status TEXT NOT NULL DEFAULT 'none'
      CHECK (reimbursement_status IN ('none','pending','approved','paid')),
    payout_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (date(spent_date) IS spent_date),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX expenses_user_spent_date ON expenses(user_id, spent_date)`,
  `CREATE INDEX expenses_project_spent_date ON expenses(project_id, spent_date)`,
  `CREATE INDEX expenses_expense_category_id ON expenses(expense_category_id)`,
  `CREATE INDEX expenses_invoice_id ON expenses(invoice_id)`,
  `CREATE TRIGGER expenses_invoice_client_insert
    BEFORE INSERT ON expenses
    WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'expense project must belong to invoice client'); END`,
  `CREATE TRIGGER expenses_invoice_client_update
    BEFORE UPDATE OF invoice_id, project_id ON expenses
    WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      JOIN projects project ON project.id = NEW.project_id
      WHERE invoice.id = NEW.invoice_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'expense project must belong to invoice client'); END`,
  `DROP TRIGGER invoices_client_consistent_with_children_update`,
  invoiceClientConsistencyTrigger,
  `DROP TRIGGER projects_client_immutable_while_invoiced`,
  projectClientImmutabilityTrigger,
] as const
