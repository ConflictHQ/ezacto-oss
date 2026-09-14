// What counts as work a band absorbed (#708).
//
// The generation command claims `billable = 1` only. For an hourly engagement
// that is right: non-billable time is not work anybody is charged for. For a
// band it is wrong, and wrong in the direction that hides cost.
//
// Under a fixed amount per period the client bought the team's period. Every
// hour the team tracked against those projects was absorbed by that amount,
// whether or not somebody ticked billable on it. Leaving the non-billable hours
// out makes the band look cheaper to deliver than it was, and the hours sit
// outside every figure that describes the engagement -- the cost ratio, the
// effective rate, what the next band should cost.
//
// ## Why it is a setting and not a fix
//
// Both readings are somebody's real practice. A firm that tracks internal work
// -- a retrospective, an unbilled fix, time somebody logged to the wrong
// project -- against a client project wants it counted against what the band
// paid for. A firm that keeps that work on an internal project does not, and
// for them non-billable time on a client project means "explicitly not part of
// this deal".
//
// It is the same decision as "do we care whether this project went over
// budget", so it belongs on the definition beside the ceiling rather than being
// chosen once for everybody.
//
// The default is `billable`, which is what every existing definition does
// today. A migration that widened what a live band claims would, at the next
// generation, quietly pull months of non-billable hours onto an invoice.
//
// ## A non-billable hour is worth zero, not unknown
//
// The money ceiling in 0074 stops at an entry it cannot price, because a
// billable entry with no rate is missing data and counting it as free would
// make the deciding figure smallest exactly where the data is worst.
//
// A non-billable entry is not that. Its billable value at list *is* zero --
// that is what non-billable means -- so it is a fact, not a gap, and it passes
// through a money ceiling contributing nothing. The engine narrows the stop to
// billable entries with no rate for exactly this reason.

export const bandClaimScopeMigration = [
  `ALTER TABLE recurring_invoices ADD COLUMN claim_scope TEXT NOT NULL DEFAULT 'billable'
    CHECK (claim_scope IN ('billable', 'tracked'))`,
  // Same rule the claim mode carries: a setting about what a band claims is
  // meaningless on a definition that claims nothing, and a value nothing
  // applies is a value somebody later assumes applied.
  `CREATE TRIGGER recurring_invoices_claim_scope_needs_projects_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.claim_scope <> 'billable' AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a claim scope needs the projects it claims from'); END`,
  `CREATE TRIGGER recurring_invoices_claim_scope_needs_projects_update
    BEFORE UPDATE OF claim_scope, claims_project_ids ON recurring_invoices
    WHEN NEW.claim_scope <> 'billable' AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a claim scope needs the projects it claims from'); END`,
] as const
