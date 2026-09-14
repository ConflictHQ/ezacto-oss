// The exchange rate store, removed (issue 522).
//
// 0062 built `exchange_rates` before either of the two steps that issue puts
// ahead of it, and against its own instruction:
//
//   "only then build a rate store. Not before, because a rate store with no
//    decided semantics is worse than two honest figures."
//
// The decision it was waiting on has now been made, and it is no consolidation.
// Reports go on grouping per currency and refusing to add across them, which is
// what they already did and what the banded-month bug fixed in 0000-era
// reporting was about: a figure summed across currencies is a right number in
// the wrong unit, and nobody questions those.
//
// Dropped rather than left dormant. Nothing ever read it, and an empty table
// with an immutability trigger on it reads as an unfinished feature -- the next
// person to find `exchange_rates` would reasonably wire it up, and the
// semantics that make conversion safe still would not be decided.
//
// If consolidation is ever wanted, the shape is in the issue: a rate per date,
// a decision per surface about which date applies, and a rule that a converted
// figure on a sent document is frozen. That is the work, not the table.

export const dropExchangeRatesMigration = [
  `DROP TABLE IF EXISTS exchange_rates`,
] as const
