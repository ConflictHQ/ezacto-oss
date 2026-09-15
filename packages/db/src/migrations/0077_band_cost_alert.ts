// The threshold a band's cost is read against (#710).
//
// Under a fixed amount per period, what decides whether a band is priced right
// is not what the work was worth at list -- it is what it cost to deliver
// against what was charged. A band comfortably under is healthy, one
// approaching is a deal to renegotiate, and one over is being delivered at a
// loss nobody has noticed.
//
// ## Per engagement, with an organisation default
//
// Deals differ. A band that is mostly senior time runs at a different ratio
// from one that is mostly delivery, so a single global number would be either
// too loose to catch anything or tight enough to cry wolf. The definition may
// carry its own; where it does not, the organisation's applies.
//
// ## Basis points, not a percentage
//
// The `_pct REAL` columns elsewhere in this schema mirror Harvest's wire shape
// for tax and budget, and are that way because a vendor chose it. This figure
// mirrors nothing, and it is compared against a ratio of two money amounts, so
// it is an integer: 8000 is 80%. A float threshold invites a comparison that
// answers differently depending on which side rounded.
//
// The ceiling is 200% rather than 100%. A band deliberately run at a loss for a
// quarter is a real arrangement, and a threshold nobody can set to describe
// their own deal is a threshold they turn off.

export const bandCostAlertMigration = [
  `ALTER TABLE organizations ADD COLUMN band_cost_alert_basis_points INTEGER NOT NULL
    DEFAULT 8000 CHECK (band_cost_alert_basis_points BETWEEN 1 AND 20000)`,
  `ALTER TABLE recurring_invoices ADD COLUMN cost_alert_basis_points INTEGER
    CHECK (cost_alert_basis_points IS NULL
      OR cost_alert_basis_points BETWEEN 1 AND 20000)`,
  // Same rule the claim settings carry: a threshold on a definition that
  // absorbs no time is a number nothing applies, and a number nothing applies
  // is a number somebody later assumes applied.
  `CREATE TRIGGER recurring_invoices_cost_alert_needs_projects_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.cost_alert_basis_points IS NOT NULL AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a cost alert needs the projects it claims from'); END`,
  `CREATE TRIGGER recurring_invoices_cost_alert_needs_projects_update
    BEFORE UPDATE OF cost_alert_basis_points, claims_project_ids ON recurring_invoices
    WHEN NEW.cost_alert_basis_points IS NOT NULL AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a cost alert needs the projects it claims from'); END`,
] as const
