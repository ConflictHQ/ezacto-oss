// A provider observation is separate from the append-only staging receipt and
// the payment ledger. A failed read retains the last known provider status.
export const deelPaymentStatusMigration = [
  `CREATE TABLE deel_timesheet_status (
    timesheet_id TEXT PRIMARY KEY,
    status TEXT CHECK(status IN ('approved','declined','not_payable','paid','pending','processing')),
    checked_at TEXT,
    last_attempt_at TEXT NOT NULL,
    last_error TEXT,
    lease_id TEXT,
    lease_until TEXT,
    CHECK((lease_id IS NULL) = (lease_until IS NULL)),
    CHECK((status IS NULL) = (checked_at IS NULL))
  ) STRICT`,
  `CREATE INDEX deel_timesheet_status_due ON deel_timesheet_status(last_attempt_at)`,
] as const
