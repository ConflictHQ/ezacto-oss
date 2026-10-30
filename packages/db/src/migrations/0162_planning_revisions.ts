// Client-read versions fence edits independently of timestamp resolution (#1190).
export const planningRevisionsMigration = [
  ...['allocations', 'time_off'].flatMap(table => [
    `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 0
      CHECK(typeof(version) = 'integer' AND version BETWEEN 0 AND 9007199254740991)`,
    `CREATE TRIGGER ${table}_version_guard BEFORE UPDATE ON ${table}
      WHEN NEW.version <> OLD.version + 1
      BEGIN SELECT RAISE(ABORT, 'planning_version_must_advance'); END`,
  ]),
] as const
