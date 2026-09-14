// How much of a period a band claims (#707).
//
// #484 gave a recurring definition `claims_project_ids`, which makes the flat
// invoice consume the hours it covers instead of pricing them. That models one
// deal: the band covers whatever the team does, and over-delivery is the firm's
// cost. It is all-or-nothing -- named projects means every unbilled hour up to
// the issue date, and no named projects means none.
//
// The shape it cannot express is the one where the band covers work up to a
// point and the rest is ordinary time and materials on the same project. Run as
// claim-everything, that deal writes off hours the client agreed to pay for;
// run as unbanded, it leaves hours reading as uninvoiced that nobody will bill.
// Neither is an error anybody sees.
//
// ## The ceiling is time, not money
//
// A band already carries a money amount -- what the client is charged -- so a
// second money figure on the same definition would be two numbers in the same
// unit meaning different things, and the one a reader reaches for first would
// be whichever they saw last. Time is unambiguous beside it, and it is what a
// team band actually sells: a capacity promise for the period.
//
// A money ceiling ("the band covers work worth up to X at list") is a coherent
// different deal, and adding it later is a nullable column beside this one plus
// a rule that at most one is set. It is deliberately not built on a guess about
// whether anybody writes that contract.
//
// ## Ordering
//
// Oldest first, by spent date then id. It is the only ordering that is stable
// under a re-run: any rule depending on entry creation order would claim a
// different subset the second time, and a band that claims different hours on a
// retry is one whose numbers nobody can reconcile.
//
// An entry that would straddle the ceiling is left out whole rather than split.
// Half a time entry belongs to nothing -- it has one rate, one person and one
// approval state -- and splitting one would invent a row nobody tracked.

export const bandClaimModesMigration = [
  `ALTER TABLE recurring_invoices ADD COLUMN claim_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (claim_mode IN ('all', 'ceiling'))`,
  `ALTER TABLE recurring_invoices ADD COLUMN claim_ceiling_seconds INTEGER
    CHECK (claim_ceiling_seconds IS NULL OR claim_ceiling_seconds > 0)`,

  // A ceiling with no number is a band that claims nothing and reads like one
  // that claims everything; a number with no ceiling is a value nothing applies.
  // Both are refused rather than interpreted.
  `CREATE TRIGGER recurring_invoices_claim_ceiling_insert
    BEFORE INSERT ON recurring_invoices
    WHEN (NEW.claim_mode = 'ceiling') IS NOT (NEW.claim_ceiling_seconds IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a ceiling claim needs a ceiling, and only a ceiling claim may carry one'); END`,
  `CREATE TRIGGER recurring_invoices_claim_ceiling_update
    BEFORE UPDATE OF claim_mode, claim_ceiling_seconds ON recurring_invoices
    WHEN (NEW.claim_mode = 'ceiling') IS NOT (NEW.claim_ceiling_seconds IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a ceiling claim needs a ceiling, and only a ceiling claim may carry one'); END`,

  // A claim mode on a definition that claims no projects is a setting with
  // nothing to apply to. Refused on the way in rather than left to read as a
  // band that does nothing.
  `CREATE TRIGGER recurring_invoices_claim_mode_needs_projects_insert
    BEFORE INSERT ON recurring_invoices
    WHEN NEW.claim_mode <> 'all' AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a claim mode needs the projects it claims from'); END`,
  `CREATE TRIGGER recurring_invoices_claim_mode_needs_projects_update
    BEFORE UPDATE OF claim_mode, claims_project_ids ON recurring_invoices
    WHEN NEW.claim_mode <> 'all' AND NEW.claims_project_ids IS NULL
    BEGIN SELECT RAISE(ABORT, 'a claim mode needs the projects it claims from'); END`,
] as const
