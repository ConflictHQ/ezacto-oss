// Provenance: ezacto-pvt #1007, slice 3. Days a person is away, entered by an
// administrator, that reduce the capacity the planning view counts as available.
//
// Time off is not work and not leave management: there is no request or approval
// column, and it shares no table with `time_entries`, rates or invoices. Dates
// are plain local calendar days, like `allocations`. `seconds_per_day` NULL
// means a whole day (a fifth of the person's weekly capacity); a figure means
// that many seconds away on each working day in the range.
//
// Two entries for one person may not overlap, so a day is never taken off
// twice; the trigger refuses it where two concurrent writes cannot both slip
// past a read.
//
// Account closure erases a person's time off: it is personal, and not time worked.
const canonicalDate = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) = ${column}`

export const timeOffMigration = [
  `CREATE TABLE time_off (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    start_date TEXT NOT NULL CHECK (${canonicalDate('start_date')}),
    end_date TEXT NOT NULL CHECK (${canonicalDate('end_date')}),
    kind TEXT NOT NULL CHECK (kind IN ('vacation', 'sick', 'holiday', 'other')),
    seconds_per_day INTEGER CHECK (seconds_per_day IS NULL OR seconds_per_day BETWEEN 1 AND 86400),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date >= start_date)
  ) STRICT`,
  `CREATE INDEX time_off_user_dates ON time_off(user_id, start_date, end_date)`,
  `CREATE TRIGGER time_off_no_overlap_insert
    BEFORE INSERT ON time_off
    WHEN EXISTS (
      SELECT 1 FROM time_off other
      WHERE other.user_id = NEW.user_id
        AND other.start_date <= NEW.end_date AND other.end_date >= NEW.start_date
    )
    BEGIN SELECT RAISE(ABORT, 'time off overlaps other time off'); END`,
  `CREATE TRIGGER time_off_no_overlap_update
    BEFORE UPDATE OF user_id, start_date, end_date ON time_off
    WHEN EXISTS (
      SELECT 1 FROM time_off other
      WHERE other.id <> NEW.id AND other.user_id = NEW.user_id
        AND other.start_date <= NEW.end_date AND other.end_date >= NEW.start_date
    )
    BEGIN SELECT RAISE(ABORT, 'time off overlaps other time off'); END`,
  `CREATE TRIGGER account_closures_erase_time_off
    AFTER INSERT ON account_closures
    BEGIN DELETE FROM time_off WHERE user_id = NEW.user_id; END`,
] as const
