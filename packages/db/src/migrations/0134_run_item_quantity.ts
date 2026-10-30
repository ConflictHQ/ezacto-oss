// Provenance: ezacto-pvt issue 63, slice B; the manifest showed hours only
// inside `description`, so a person could read them but nothing could assert
// or sort them.

/**
 * Hours and the client's name as data on a run item.
 *
 * Both columns are nullable. `quantity_seconds` is null for an action that is
 * not about time, and zero would be a figure nobody stated. Existing runs and
 * items keep null in both: nothing is rewritten.
 */
export const runItemQuantityMigration = [
  `ALTER TABLE run_items ADD COLUMN quantity_seconds INTEGER
    CHECK (quantity_seconds IS NULL OR quantity_seconds >= 0)`,
  `ALTER TABLE run_items ADD COLUMN client_name TEXT
    CHECK (client_name IS NULL OR length(client_name) <= 200)`,
] as const
