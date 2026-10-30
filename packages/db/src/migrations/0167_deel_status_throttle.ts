// One lease and cooldown cover every page and scheduled status poll in an
// instance. Per-timesheet leases alone cannot enforce an organization API rate.
export const deelStatusThrottleMigration = [
  `CREATE TABLE deel_status_refresh_lock (
    id INTEGER PRIMARY KEY CHECK(id=1),
    lease_id TEXT,
    lease_until TEXT,
    cooldown_until TEXT NOT NULL,
    CHECK((lease_id IS NULL)=(lease_until IS NULL))
  ) STRICT`,
  `INSERT INTO deel_status_refresh_lock(id,cooldown_until) VALUES(1,'1970-01-01T00:00:00.000Z')`,
] as const
