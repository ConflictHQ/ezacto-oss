// The import lineage a refresh compares against (#665, #407).
//
// `invoices` has carried `source_updated_at` since the import authority landed,
// and it is the column the reconciliation triggers compare: a refresh is
// admitted when the snapshot's timestamp has advanced past the one last loaded.
// It is deliberately not `updated_at`, which a person moves by editing the row,
// so an edit here neither blocks an upstream change nor is silently taken for
// one.
//
// Every other harvest-sourced table had only `updated_at`, which meant the same
// sentence -- "newer upstream wins" -- would have meant two different things
// depending on which table it was said about. A client edited five minutes ago
// would have looked newer than the snapshot and won; an invoice edited five
// minutes ago would not. That is the kind of difference nobody sees until a
// refresh quietly keeps the wrong row.
//
// So the column goes everywhere the loader writes a harvest id, and the rule
// means one thing.
//
// Backfilled from `updated_at`, which is exact for every row nothing has
// touched -- the loader copies the snapshot's `updated_at` into the row. For a
// row somebody has since edited it records a lineage slightly newer than the
// truth, and that errs toward refusing a refresh rather than overwriting an
// edit, which is the safe direction to be wrong in.

// Invoice and estimate children are absent for a different reason. An invoice
// message or payment is refreshed through the reconciliation protocol, which
// already declares them by manifest and refuses a bare UPDATE without a pending
// command -- so their lineage is the invoice's own, and a column here would be
// a second answer to a question already answered.
//
// Rates are absent deliberately. `user_billable_rates` and `user_cost_rates`
// are append-only -- 0000 refuses an UPDATE outright -- because a rate that
// changed upstream arrives as a new effective-dated row rather than an edit to
// the old one. A refresh can never write them, so a lineage column on them
// would be a value nothing reads. The backfill below discovered this by being
// refused, which is the right way round.
const TABLES = [
  'users',
  'roles',
  'clients',
  'contacts',
  'tasks',
  'expense_categories',
  'invoice_item_categories',
  'estimate_item_categories',
  'projects',
  'task_assignments',
  'user_assignments',
  'estimates',
  'time_entries',
  'expenses',
] as const

export const sourceLineageMigration = [
  ...TABLES.flatMap((table) => [
    `ALTER TABLE ${table} ADD COLUMN source_updated_at TEXT`,
    // Only rows that came from an import. A row created in this system has no
    // upstream to be newer than it, and giving it a lineage would invite a
    // refresh to compare against something that never existed.
    `UPDATE ${table} SET source_updated_at = updated_at WHERE harvest_id IS NOT NULL`,
  ]),
] as const
