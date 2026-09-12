// Provenance: ezacto-oss #543, and the same guarantee #103 asks for.
//
// The transfer log. Its whole job is that the same work cannot be paid twice.
//
// Why the seam is shared rather than per vendor. A contractor is paid through
// Deel or through their own Wise account, and which one is THEIR choice rather
// than the organisation's. Two vendor-shaped tables would mean two places for
// "has this period already been paid?" to be answered, and the first time they
// disagreed somebody would be paid twice. So the log is about the work and the
// person; the provider is a value on the row, the way it already is on
// `user_payout_accounts`.
//
// Why a period rather than a set of time entries. Payroll runs in periods, and
// the question anyone actually asks is "has this person been paid for that
// fortnight?" -- a transfer that quietly covered a different set of entries for
// the same period is the failure, and a period key catches it where a per-entry
// join would let two partial transfers through. The entries that made up the
// amount stay answerable from the time entries themselves, which already carry
// their own dates.
//
// Why `payout_account_id` is a reference and not an external id. The account is
// the thing that was already checked for uniqueness and immutability in 0042,
// and recording the provider's id again here would be a second copy of a fact
// that can drift. What money followed is then answerable by joining, even after
// the account is detached, because 0042 keeps detached rows.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const payoutTransfersMigration = [
  `CREATE TABLE payout_transfers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- The work this paid for. Inclusive on both ends, as a timesheet period is.
    period_start TEXT NOT NULL CHECK (period_start GLOB '????-??-??'),
    period_end TEXT NOT NULL CHECK (period_end GLOB '????-??-??'),
    -- Where it went. Detached accounts are kept by 0042, so this stays
    -- answerable after somebody moves providers.
    payout_account_id INTEGER NOT NULL
      REFERENCES user_payout_accounts(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    -- 'planned' is a row claiming the period before anything is sent, which is
    -- what makes the claim exclusive. 'sent' is money that moved. 'failed' is
    -- an attempt that did not, and is the only state that releases the period
    -- for another try.
    state TEXT NOT NULL DEFAULT 'planned'
      CHECK (state IN ('planned','sent','failed')),
    -- The provider's own id for the transfer, once there is one. Required by
    -- the time it is sent: a transfer nobody can look up at the provider is one
    -- nobody can reconcile.
    external_transfer_id TEXT
      CHECK (external_transfer_id IS NULL
        OR length(trim(external_transfer_id)) BETWEEN 1 AND 255),
    failure_reason TEXT
      CHECK (failure_reason IS NULL OR length(trim(failure_reason)) BETWEEN 1 AND 2000),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (period_end >= period_start),
    CHECK (state <> 'sent' OR external_transfer_id IS NOT NULL),
    CHECK (state = 'failed' OR failure_reason IS NULL)
  ) STRICT`,

  // One live claim on a person's period. Partial, so a failed attempt releases
  // it and the history of what was tried stays readable.
  `CREATE UNIQUE INDEX payout_transfers_period_claim
    ON payout_transfers(user_id, period_start, period_end)
    WHERE state <> 'failed'`,

  `CREATE INDEX payout_transfers_user ON payout_transfers(user_id)`,
  `CREATE INDEX payout_transfers_account ON payout_transfers(payout_account_id)`,

  // A transfer that has been sent is a record of money that moved, so what it
  // paid and who it paid cannot be edited afterwards. Correcting one is a new
  // row describing the correction, not a rewrite of what happened.
  `CREATE TRIGGER payout_transfers_sent_immutable
    BEFORE UPDATE ON payout_transfers
    FOR EACH ROW WHEN OLD.state = 'sent' AND (
      NEW.user_id IS NOT OLD.user_id
      OR NEW.period_start IS NOT OLD.period_start
      OR NEW.period_end IS NOT OLD.period_end
      OR NEW.payout_account_id IS NOT OLD.payout_account_id
      OR NEW.amount_cents IS NOT OLD.amount_cents
      OR NEW.currency IS NOT OLD.currency
      OR NEW.external_transfer_id IS NOT OLD.external_transfer_id
      OR NEW.state IS NOT OLD.state
    )
    BEGIN SELECT RAISE(ABORT, 'a sent payout transfer is immutable'); END`,
] as const
