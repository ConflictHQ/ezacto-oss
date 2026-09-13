// Provenance: issues 280 and 421, which are blocked on the same missing column.
//
// A payout provider matches a person on an address, and the address it matches
// on is the personal one -- Deel and Wise accounts were opened against personal
// addresses, which is why the migration deliberately kept the source system's
// address primary. So the payroll export reads `is_primary`, and `is_primary`
// is being asked to mean two things at once: "the address we write to" and "the
// address a payout provider knows them by". Those are the same address today by
// coincidence, and the day they stop being, somebody is paid to the wrong one.
//
// `kind` names what an address is for, so the export can ask for what it
// actually wants.
//
// Null is "nobody has said", which is every address that exists today. The
// export falls back to the primary address exactly as it does now when no
// payroll address is named, so this changes no behaviour until somebody names
// one.
//
// At most one payroll address per person, partial on the live rows -- an
// invalidated address keeps its kind for the history without blocking the one
// that replaced it. The same shape `user_emails_one_primary_per_user` already
// uses, for the same reason.
//
// What this deliberately does not do is make the match automatic. 421 is
// explicit that an address match is a guess whose failure mode is paying the
// wrong person, and that the real link is the provider's own identifier. This
// column makes the *proposal* honest; it is not the join.

export const userEmailKindMigration = [
  `ALTER TABLE user_emails ADD COLUMN kind TEXT
    CHECK (kind IS NULL OR kind IN ('work','personal','payroll'))`,

  `CREATE UNIQUE INDEX user_emails_one_payroll_per_user ON user_emails(user_id)
    WHERE kind = 'payroll' AND invalidated_at IS NULL`,

  // A payroll address has to be one we can actually reach: an unverified or
  // invalidated address is not somewhere to send a payment reference, and
  // proposing one to a provider is proposing a guess about a guess.
  `CREATE TRIGGER user_emails_payroll_must_be_live_insert
    BEFORE INSERT ON user_emails
    WHEN NEW.kind = 'payroll'
      AND (NEW.verified_at IS NULL OR NEW.invalidated_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a payroll address must be verified and live'); END`,
  // On designation only. Retiring a payroll address later is ordinary -- the
  // partial index and the report both already exclude invalidated rows, and the
  // kind stays on the dead row so the history still says what it was for.
  // Firing on every update would have made a payroll address impossible to
  // retire, which is the opposite of a guard.
  `CREATE TRIGGER user_emails_payroll_must_be_live_update
    BEFORE UPDATE OF kind ON user_emails
    WHEN NEW.kind = 'payroll' AND OLD.kind IS NOT 'payroll'
      AND (NEW.verified_at IS NULL OR NEW.invalidated_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a payroll address must be verified and live'); END`,
] as const
