import { canonicalTimestamp } from './0029_outbox_delivery.js'
// Explicit local calendar dates entered by the operator; no country/provider holiday assumptions.
export const organizationHolidaysMigration = [
  `CREATE TABLE organization_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date TEXT NOT NULL UNIQUE CHECK(holiday_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND coalesce(date(holiday_date,'+0 days')=holiday_date,0)),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120 AND name=trim(name)),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')}),
    CHECK(julianday(updated_at)>=julianday(created_at))
  ) STRICT`,
  `CREATE TRIGGER organization_holiday_identity BEFORE UPDATE ON organization_holidays
    WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'organization_holiday_immutable'); END`,
] as const
