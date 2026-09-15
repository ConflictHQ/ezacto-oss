// A billable rate and a cost rate are not each other's evidence (#746).
//
// 0076 let the current rate be removed while nothing had been priced from it,
// and tested "priced" by asking whether any time entry inside the rate's window
// had been created, or repriced, after the rate existed.
//
// That question is blind to which *kind* of rate the entry actually took. A
// non-billable entry carrying only a cost rate then blocks the removal of a
// billable rate it could never have been priced by -- which is exactly the case
// that appeared in practice: two non-billable entries with no billable rate at
// all made a mistyped billable rate permanent.
//
// The guard was meant to be conservative. Being conservative about the wrong
// column is not caution, it is a rule that refuses for a reason that is not
// true, and a rule that refuses untruthfully is one people route around.
//
// So the test narrows to the kind being removed: a billable rate is held by
// entries that carry a billable rate, and a cost rate by entries that carry a
// cost one. The reprice check narrows the same way -- a reprice that moved the
// cost figure is no evidence about the billable rate, whichever direction it
// moved it, so both the new and previous columns for that kind count.

const kinds = [
  { table: 'user_billable_rates', column: 'billable_rate_cents' },
  { table: 'user_cost_rates', column: 'cost_rate_cents' },
] as const

export const rateRemovalByKindMigration = [
  ...kinds.flatMap(({ table, column }) => [
    `DROP TRIGGER ${table}_delete_unpriced_only`,
    `CREATE TRIGGER ${table}_delete_unpriced_only BEFORE DELETE ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM time_entries entry
        WHERE entry.user_id = OLD.user_id
          AND entry.spent_date >= coalesce(OLD.start_date, '0000-01-01')
          AND (
            -- Created after this rate existed, and carrying a figure of this
            -- kind, so this rate is a candidate for where that figure came from.
            (entry.created_at > OLD.created_at AND entry.${column} IS NOT NULL)
            OR EXISTS (
              SELECT 1 FROM time_entry_rate_reprices reprice
              WHERE reprice.time_entry_id = entry.id
                AND reprice.repriced_at > OLD.created_at
                AND (
                  reprice.${column} IS NOT NULL
                  OR reprice.previous_${column} IS NOT NULL
                )
            )
          )
      )
      BEGIN SELECT RAISE(ABORT, 'a rate that has priced work cannot be removed'); END`,
  ]),
] as const
