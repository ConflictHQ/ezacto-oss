const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const scheduledRemindersMigration = [
  `CREATE TABLE scheduled_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    scheduled_at TEXT NOT NULL,
    interval_days INTEGER NOT NULL CHECK (
      interval_days BETWEEN 1 AND 9007199254740991
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending','sent','cancelled')
    ),
    template TEXT NOT NULL DEFAULT 'reminder' CHECK (
      length(template) BETWEEN 1 AND 128
    ),
    causation_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('scheduled_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (julianday(updated_at) >= julianday(created_at))
  ) STRICT`,
  `CREATE INDEX scheduled_reminders_pending_due
    ON scheduled_reminders(status, scheduled_at)
    WHERE status = 'pending'`,
  `CREATE INDEX scheduled_reminders_invoice_status
    ON scheduled_reminders(invoice_id, status)`,
  `CREATE UNIQUE INDEX scheduled_reminders_causation_unique
    ON scheduled_reminders(causation_event_id)
    WHERE status = 'pending'`,
] as const
