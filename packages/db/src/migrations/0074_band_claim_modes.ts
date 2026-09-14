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
// ## The ceiling is time or money, and the unit is explicit
//
// Both contracts get written. "The band covers 400 hours" is a capacity
// promise; "the band covers work worth up to X at list" is a budget. They are
// different deals and neither is a rounding of the other.
//
// The risk in carrying a money ceiling is that a definition then holds two
// money figures -- what the client is charged, and what the band covers -- and
// a reader reaches for whichever they saw last. That is answered by making the
// unit explicit and refusing anything ambiguous: exactly one of the two columns
// is set, never both, never neither, and never either without a ceiling mode.
//
// A money ceiling measures billable value at list -- rounded seconds times the
// billable rate -- which is the same figure `foregone_billable_cents` records,
// so the ceiling and the absorbed value agree by construction rather than by
// two implementations happening to match.
//
// ## An unpriced hour stops a money ceiling rather than passing through it
//
// An entry with no billable rate contributes nothing to a running money total,
// so a naive money ceiling would claim past it forever and a project of
// unpriced work would be claimed whole however small the ceiling. That is the
// same class of mistake as counting a missing rate as zero cost: the figure
// that decides looks smaller precisely where the data is least trustworthy.
//
// So the claim stops at the first unpriced entry. The band takes what it can
// price and the rest stays billable, which is visible and correctable, rather
// than absorbing work nobody can value.
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
  `ALTER TABLE recurring_invoices ADD COLUMN claim_ceiling_cents INTEGER
    CHECK (claim_ceiling_cents IS NULL OR claim_ceiling_cents > 0)`,

  // A ceiling with no number is a band that claims nothing and reads like one
  // that claims everything; a number with no ceiling is a value nothing applies.
  // Both are refused rather than interpreted.
  `CREATE TRIGGER recurring_invoices_claim_ceiling_insert
    BEFORE INSERT ON recurring_invoices
    WHEN (NEW.claim_mode = 'ceiling') IS NOT (
      (NEW.claim_ceiling_seconds IS NOT NULL) <> (NEW.claim_ceiling_cents IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'a ceiling claim needs exactly one ceiling, in time or in money'); END`,
  `CREATE TRIGGER recurring_invoices_claim_ceiling_update
    BEFORE UPDATE OF claim_mode, claim_ceiling_seconds, claim_ceiling_cents
    ON recurring_invoices
    WHEN (NEW.claim_mode = 'ceiling') IS NOT (
      (NEW.claim_ceiling_seconds IS NOT NULL) <> (NEW.claim_ceiling_cents IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'a ceiling claim needs exactly one ceiling, in time or in money'); END`,

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
