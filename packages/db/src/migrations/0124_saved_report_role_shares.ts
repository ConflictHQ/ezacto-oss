// Provenance: ezacto-pvt #933. A saved report is private to its author and is
// shared with named people (saved_report_shares, 0082) or, with this table,
// with a whole role. A role share reaches every user whose profile matches at
// the moment they ask, so a person promoted into the role sees the report and
// a person moved out of it stops seeing it, without anyone editing the share.
//
// The profile list is the one in users.profile. Administrators are not a
// special case here: they see every report whether or not it is shared.
export const savedReportRoleSharesMigration = [
  `CREATE TABLE saved_report_role_shares (
    report_id TEXT NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
    profile TEXT NOT NULL CHECK (profile IN
      ('member', 'project_manager', 'people_admin', 'accounting', 'executive_manager', 'administrator')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (report_id, profile)
  ) STRICT`,
  `CREATE INDEX saved_report_role_shares_profile ON saved_report_role_shares(profile, report_id)`,
] as const
