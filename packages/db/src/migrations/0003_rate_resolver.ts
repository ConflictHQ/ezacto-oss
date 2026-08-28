export const rateResolverMigration = [
  `CREATE TABLE time_entry_rate_reprices (
    id INTEGER PRIMARY KEY,
    time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
    previous_billable_rate_cents INTEGER
      CHECK (previous_billable_rate_cents IS NULL OR previous_billable_rate_cents >= 0),
    billable_rate_cents INTEGER
      CHECK (billable_rate_cents IS NULL OR billable_rate_cents >= 0),
    previous_cost_rate_cents INTEGER
      CHECK (previous_cost_rate_cents IS NULL OR previous_cost_rate_cents >= 0),
    cost_rate_cents INTEGER
      CHECK (cost_rate_cents IS NULL OR cost_rate_cents >= 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    repriced_at TEXT NOT NULL CHECK (
      unixepoch(repriced_at) IS NOT NULL
      AND substr(repriced_at, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', repriced_at)
      AND CAST(substr(repriced_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(repriced_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(repriced_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
      AND repriced_at GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
    )
  ) STRICT`,
  `CREATE INDEX time_entry_rate_reprices_entry_id
    ON time_entry_rate_reprices(time_entry_id, id)`,
  `CREATE TRIGGER time_entry_rate_reprices_reject_id_collision
    BEFORE INSERT ON time_entry_rate_reprices
    WHEN EXISTS (
      SELECT 1 FROM time_entry_rate_reprices existing WHERE existing.id = NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'rate reprice audit id already exists'); END`,
  `CREATE TRIGGER time_entry_rate_reprices_apply
    AFTER INSERT ON time_entry_rate_reprices
    BEGIN
      UPDATE time_entries
      SET billable_rate_cents = NEW.billable_rate_cents,
          cost_rate_cents = NEW.cost_rate_cents,
          updated_at = NEW.repriced_at
      WHERE id = NEW.time_entry_id;
    END`,
  `CREATE TRIGGER time_entry_rate_reprices_immutable_update
    BEFORE UPDATE ON time_entry_rate_reprices
    BEGIN SELECT RAISE(ABORT, 'rate reprice audit is append-only'); END`,
  `CREATE TRIGGER time_entry_rate_reprices_immutable_delete
    BEFORE DELETE ON time_entry_rate_reprices
    BEGIN SELECT RAISE(ABORT, 'rate reprice audit is append-only'); END`,
] as const
