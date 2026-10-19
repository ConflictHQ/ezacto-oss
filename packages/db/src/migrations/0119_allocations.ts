// Provenance: ezacto-pvt #1007, slices 1 and 2. Planned hours per week for a
// person on a project over a range of dates.
//
// This is deliberately its own table. `user_assignments` is Harvest-shaped and
// imported, so dates on it would put the importer at risk; and a plan is not
// work, so nothing here shares a table with `time_entries`, rates or invoices.
// There is no money column, on purpose: planned hours are never billed.
//
// Dates are plain local calendar days, with no time zone, so a week is the same
// seven days whoever reads it. The capacity view counts the full weekly figure
// for every week the range touches.
//
// Planning the same person on the same project twice for the same week would
// only double the figure, so the overlap is refused here, where two concurrent
// writes cannot both slip past a read. Different projects may overlap freely:
// that is what over-allocation is.
//
// Account closure erases a person's allocations: a plan for someone who has
// left is moot, and it is not time worked.
const canonicalDate = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) = ${column}`

export const allocationsMigration = [
  `CREATE TABLE allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    start_date TEXT NOT NULL CHECK (${canonicalDate('start_date')}),
    end_date TEXT NOT NULL CHECK (${canonicalDate('end_date')}),
    planned_seconds_per_week INTEGER NOT NULL
      CHECK (planned_seconds_per_week BETWEEN 1 AND 604800),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date >= start_date)
  ) STRICT`,
  `CREATE INDEX allocations_user_dates ON allocations(user_id, start_date, end_date)`,
  `CREATE INDEX allocations_project_dates ON allocations(project_id, start_date, end_date)`,
  `CREATE TRIGGER allocations_no_overlap_insert
    BEFORE INSERT ON allocations
    WHEN EXISTS (
      SELECT 1 FROM allocations other
      WHERE other.user_id = NEW.user_id AND other.project_id = NEW.project_id
        AND other.start_date <= NEW.end_date AND other.end_date >= NEW.start_date
    )
    BEGIN SELECT RAISE(ABORT, 'allocation overlaps another allocation'); END`,
  `CREATE TRIGGER allocations_no_overlap_update
    BEFORE UPDATE OF user_id, project_id, start_date, end_date ON allocations
    WHEN EXISTS (
      SELECT 1 FROM allocations other
      WHERE other.id <> NEW.id
        AND other.user_id = NEW.user_id AND other.project_id = NEW.project_id
        AND other.start_date <= NEW.end_date AND other.end_date >= NEW.start_date
    )
    BEGIN SELECT RAISE(ABORT, 'allocation overlaps another allocation'); END`,
  `CREATE TRIGGER account_closures_erase_allocations
    AFTER INSERT ON account_closures
    BEGIN DELETE FROM allocations WHERE user_id = NEW.user_id; END`,
] as const
