/** Durable, permissioned report definitions (#715). */
export const savedReportsMigration = [
  `CREATE TABLE saved_reports (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    version INTEGER NOT NULL CHECK (version > 0),
    is_custom INTEGER NOT NULL DEFAULT 1 CHECK (is_custom IN (0,1)),
    presentation_json TEXT NOT NULL CHECK (json_valid(presentation_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX saved_reports_owner_updated ON saved_reports(owner_user_id, updated_at DESC)`,
  `CREATE TABLE saved_report_shares (
    report_id TEXT NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (report_id, user_id)
  ) STRICT`,
  `CREATE INDEX saved_report_shares_user ON saved_report_shares(user_id, report_id)`,
  `CREATE TABLE saved_report_pins (
    report_id TEXT NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (report_id, user_id)
  ) STRICT`,
] as const
