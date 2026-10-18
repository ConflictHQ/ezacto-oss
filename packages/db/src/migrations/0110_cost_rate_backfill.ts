// Pricing the cost of hours tracked before a person had a cost rate (#750).
//
// A time entry carries the cost rate it was stamped with, and adding a rate to a
// person does not reach backwards, so years of tracked hours stay unpriced and
// every figure derived from cost answers nothing for them. The mechanism for
// changing a stamped rate already exists: `time_entry_rate_reprices` from 0003,
// applied by trigger so the snapshot cannot move without its audit row. What
// that table cannot say is who asked for a change or which run it belonged to,
// and a bulk write over years of money data needs both: the question afterwards
// is always "what did that run actually do", and a timestamp range is a worse
// answer than a key.
//
// Both columns are nullable, because the rows already there (and the ones a
// single-entry reprice still writes) have neither. They are added rather than
// put in a second table so there is still exactly one place a rate snapshot
// change is recorded.
export const costRateBackfillMigration = [
  `ALTER TABLE time_entry_rate_reprices
    ADD COLUMN run_id TEXT
    CHECK (run_id IS NULL OR (
      length(run_id) BETWEEN 1 AND 128 AND run_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ))`,
  `ALTER TABLE time_entry_rate_reprices
    ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `CREATE INDEX time_entry_rate_reprices_run ON time_entry_rate_reprices(run_id, id)`,
] as const
