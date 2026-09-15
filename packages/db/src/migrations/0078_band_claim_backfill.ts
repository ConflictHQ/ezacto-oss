// Claiming the hours a band was issued before it could claim them (#712).
//
// `claims_project_ids` makes a flat invoice consume the hours it covers, and
// the claim is written inside the generation command. An invoice raised before
// the definition carried that setting claimed nothing, and there was no way to
// correct it afterwards. Those hours read as uninvoiced for ever. They are not:
// they were paid for, by a flat invoice that has settled. Every figure asking
// "what has been delivered and not billed" counts them, which is the exact
// distortion #484 was filed about, surviving its own fix.
//
// ## Why this is a table and not an UPDATE
//
// The schema permits the write. The 0054 trigger refuses to *release* time
// while its invoice stands and says nothing about claiming unclaimed time, so a
// direct UPDATE would work -- which is precisely why it must not be how this is
// done. A money-data write with no record of who did it, when, or as part of
// what is the 2am fix-up script that trigger exists to make impossible.
//
// So the claim happens by inserting the record of it, and a trigger applies it.
// The shape is `time_entry_rate_reprices` from 0003, which solved the same
// problem for the other column on this row that nobody may quietly change.
//
// ## Idempotency is a rule here, not a convention in a script
//
// An entry that already belongs to an invoice cannot be claimed again, stated
// where it cannot be skipped. That is what makes running the backfill twice a
// no-op rather than something whose safety depends on remembering a WHERE
// clause -- and it is the same guard whether the second run is a retry, a copy
// of the script, or somebody being thorough.
//
// A run carries an id so the rows it wrote can be read back together, because
// the question after a backfill of this size is always "what did that run
// actually do", and a timestamp range is a worse answer than a key.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'`

export const bandClaimBackfillMigration = [
  `CREATE TABLE time_entry_claim_backfills (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL CHECK (
      length(run_id) BETWEEN 1 AND 128
      AND run_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    recurring_invoice_id INTEGER REFERENCES recurring_invoices(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    claimed_at TEXT NOT NULL CHECK (${canonicalTimestamp('claimed_at')}),
    UNIQUE(time_entry_id)
  ) STRICT`,
  `CREATE INDEX time_entry_claim_backfills_run ON time_entry_claim_backfills(run_id, id)`,
  `CREATE INDEX time_entry_claim_backfills_invoice
    ON time_entry_claim_backfills(invoice_id, id)`,
  // The rule that makes a second run a no-op, stated where nobody can skip it.
  // An entry already on an invoice is not unbilled, whatever a caller believes.
  `CREATE TRIGGER time_entry_claim_backfills_only_unclaimed
    BEFORE INSERT ON time_entry_claim_backfills
    WHEN EXISTS (
      SELECT 1 FROM time_entries entry
      WHERE entry.id = NEW.time_entry_id AND entry.invoice_id IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'that time entry is already on an invoice'); END`,
  // A band claims its own client's work. The same rule 0004 enforces on the
  // column itself, said earlier so the failure names the reason.
  `CREATE TRIGGER time_entry_claim_backfills_same_client
    BEFORE INSERT ON time_entry_claim_backfills
    WHEN NOT EXISTS (
      SELECT 1 FROM time_entries entry
      JOIN projects project ON project.id = entry.project_id
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE entry.id = NEW.time_entry_id AND invoice.client_id = project.client_id
    )
    BEGIN SELECT RAISE(ABORT, 'a band cannot claim another client work'); END`,
  // Claiming work an invoice was raised before it happened would attribute it
  // to a period it was not in, which is the distortion this exists to remove
  // rather than relocate.
  `CREATE TRIGGER time_entry_claim_backfills_within_period
    BEFORE INSERT ON time_entry_claim_backfills
    WHEN EXISTS (
      SELECT 1 FROM time_entries entry
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE entry.id = NEW.time_entry_id AND entry.spent_date > invoice.issue_date
    )
    BEGIN SELECT RAISE(ABORT, 'a band cannot claim work done after it was issued'); END`,
  `CREATE TRIGGER time_entry_claim_backfills_apply
    AFTER INSERT ON time_entry_claim_backfills
    BEGIN
      UPDATE time_entries
      SET invoice_id = NEW.invoice_id, updated_at = NEW.claimed_at
      WHERE id = NEW.time_entry_id;
    END`,
  `CREATE TRIGGER time_entry_claim_backfills_immutable_update
    BEFORE UPDATE ON time_entry_claim_backfills
    BEGIN SELECT RAISE(ABORT, 'a claim backfill record is append-only'); END`,
  `CREATE TRIGGER time_entry_claim_backfills_immutable_delete
    BEFORE DELETE ON time_entry_claim_backfills
    BEGIN SELECT RAISE(ABORT, 'a claim backfill record is append-only'); END`,
] as const
