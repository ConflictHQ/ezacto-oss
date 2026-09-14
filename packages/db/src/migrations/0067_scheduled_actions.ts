// The model a scheduled action needs before anything can be scheduled (#63).
//
// The shape is four tables because the issue's own sentence has four nouns in
// it, and each one exists to stop a different failure:
//
//   scheduled_jobs   what would be done, on what cadence, to whose work
//   proposed_runs    one materialized occurrence, with a deadline
//   run_items        the concrete things that occurrence would do
//   -- the transfer log already exists as `payout_transfers` (0051)
//
// Why a proposed run is materialized rather than computed at confirmation.
// "Send last month's pack" evaluated twice is two different sets: somebody logs
// an hour, an invoice is raised, a person leaves. An operator who confirms a
// figure has to be confirming the figure they were shown, so the run stores
// what it would do and the confirmation acts on that, not on a fresh read.
//
// Why the manifest is rows rather than a count. From the issue: "never counts
// alone". A run that says "38 invoices" is not something a person can agree to
// -- they are agreeing to the 38, and the only way to disagree with one of them
// is to be shown it. `run_items` is that list, and a run with no items is a run
// with nothing to confirm.
//
// Why expiry is a state rather than a deletion. "Nothing expires into action"
// is the other acceptance, and the honest way to hold it is that expiry moves a
// run to `expired` and nothing else ever reads an expired run. Deleting it
// would leave no record that something was proposed and allowed to lapse, which
// is exactly what somebody asks about later.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const scheduledActionsMigration = [
  `CREATE TABLE scheduled_jobs (
    id INTEGER PRIMARY KEY,
    -- What the job does. A value rather than a column per action, for the same
    -- reason a payout provider is a value: the second action is then a row.
    action TEXT NOT NULL CHECK (action IN ('month_end_pack')),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    -- The saved filter the run is materialized from, as the caller wrote it.
    -- Not parsed here: what a scope means belongs to the action that reads it.
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    -- Cron-ish cadence, held as text. Validated by whoever schedules, because a
    -- database that half-understands a cadence is one that disagrees with the
    -- scheduler about when a month ends.
    cadence TEXT NOT NULL CHECK (length(trim(cadence)) BETWEEN 1 AND 64),
    -- Whether a person must agree before the run acts. 'required' is the F13
    -- gate; 'none' is for actions that are safe unattended, and no action is
    -- born that way -- a job has to say so.
    confirmation TEXT NOT NULL DEFAULT 'required'
      CHECK (confirmation IN ('required', 'none')),
    -- How long a proposal stands. A run nobody answered must not sit forever
    -- looking like it might still fire.
    confirm_within_minutes INTEGER NOT NULL DEFAULT 1440
      CHECK (confirm_within_minutes BETWEEN 1 AND 20160),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,

  `CREATE TABLE proposed_runs (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE RESTRICT,
    -- The occurrence this run is for, so the same month cannot be proposed
    -- twice by a scheduler that fired twice.
    occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) BETWEEN 1 AND 64),
    state TEXT NOT NULL DEFAULT 'proposed'
      CHECK (state IN ('proposed', 'confirmed', 'cancelled', 'expired', 'completed')),
    proposed_at TEXT NOT NULL CHECK (${canonicalTimestamp('proposed_at')}),
    -- When it stops being answerable. Stored rather than derived, because the
    -- job's window can change and a run that was proposed under the old one
    -- keeps the deadline the operator was shown.
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TEXT CHECK (confirmed_at IS NULL OR (${canonicalTimestamp('confirmed_at')})),
    settled_at TEXT CHECK (settled_at IS NULL OR (${canonicalTimestamp('settled_at')})),
    -- Why it is not standing any more, where that was a decision: a person
    -- cancelled it, or the deadline passed.
    settled_reason TEXT CHECK (settled_reason IS NULL OR length(settled_reason) <= 255),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (expires_at > proposed_at),
    -- Confirmation is a person and an instant together. Either alone is a row
    -- that cannot say who agreed, or when.
    CHECK ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL)),
    CHECK (state <> 'confirmed' OR confirmed_by_user_id IS NOT NULL)
  ) STRICT`,

  // One run per occurrence per job. A scheduler that fires twice for the same
  // month finds the run already there rather than proposing the pack twice.
  `CREATE UNIQUE INDEX proposed_runs_occurrence
    ON proposed_runs(job_id, occurrence_key)`,

  `CREATE INDEX proposed_runs_standing
    ON proposed_runs(expires_at)
    WHERE state = 'proposed'`,

  `CREATE TABLE run_items (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES proposed_runs(id) ON DELETE CASCADE,
    -- The concrete thing this item would do, in the words a person reads.
    -- "never counts alone" is the acceptance: an operator confirming a pack is
    -- agreeing to these rows, and disagreeing with one means seeing it.
    subject_type TEXT NOT NULL CHECK (length(trim(subject_type)) BETWEEN 1 AND 40),
    subject_id INTEGER NOT NULL CHECK (subject_id > 0),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
    -- What it is worth, where it is worth anything. Nullable because not every
    -- action moves money, and zero would be a figure nobody stated.
    amount_cents INTEGER,
    currency TEXT CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]'),
    -- Where it would go: an email address, an account, a person. Text, because
    -- what a target means belongs to the action.
    target TEXT CHECK (target IS NULL OR length(target) <= 500),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    -- An amount without its unit is not an amount.
    CHECK ((amount_cents IS NULL) = (currency IS NULL))
  ) STRICT`,

  `CREATE INDEX run_items_run ON run_items(run_id)`,

  // A run that cannot render its manifest does not propose. Enforced rather
  // than promised: the issue says so in its own description, and a run that
  // reaches an operator with nothing to show is one they can only agree to
  // blindly.
  `CREATE TRIGGER proposed_runs_manifest_required
    BEFORE UPDATE OF state ON proposed_runs
    WHEN NEW.state = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM run_items WHERE run_id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'a run with no items has nothing to confirm'); END`,

  // Nothing expires into action. An expired or cancelled run is final: it can
  // never become confirmed, which is the whole of the second acceptance.
  `CREATE TRIGGER proposed_runs_settled_final
    BEFORE UPDATE OF state ON proposed_runs
    WHEN OLD.state IN ('expired', 'cancelled', 'completed')
      AND NEW.state IS NOT OLD.state
    BEGIN SELECT RAISE(ABORT, 'a settled run cannot change state'); END`,

  // The manifest is what was agreed to. Editing it after a person confirmed
  // would make the confirmation a signature on a document that then changed.
  `CREATE TRIGGER run_items_frozen_after_confirmation
    BEFORE INSERT ON run_items
    WHEN EXISTS (
      SELECT 1 FROM proposed_runs WHERE id = NEW.run_id AND state <> 'proposed'
    )
    BEGIN SELECT RAISE(ABORT, 'a run that is no longer proposed cannot gain items'); END`,
] as const
