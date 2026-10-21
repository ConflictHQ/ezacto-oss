// Provenance: ezacto-pvt #1102 (follow-up to #103). Operator control of the
// Deel time sync.
//
// One row holds the organization's sync mode. `manual` is the default, so a
// deployment that has never touched this setting submits nothing on a schedule.
// `automatic` lets the hourly cron run the sync once a day at `run_time`, in the
// organization's timezone. `last_automatic_date` is the day an automatic run was
// claimed, so the hourly cron cannot start a second run for the same day.

export const deelSyncSettingsMigration = [
  `CREATE TABLE deel_sync_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'automatic')),
    run_time TEXT NOT NULL DEFAULT '03:00'
      CHECK (run_time GLOB '[01][0-9]:[0-5][0-9]' OR run_time GLOB '2[0-3]:[0-5][0-9]'),
    last_automatic_date TEXT
      CHECK (last_automatic_date IS NULL OR last_automatic_date GLOB '????-??-??'),
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER
  ) STRICT`,
  `INSERT INTO deel_sync_settings (id, mode, run_time, updated_at)
    VALUES (1, 'manual', '03:00', '1970-01-01T00:00:00.000Z')`,
] as const
