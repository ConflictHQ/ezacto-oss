/** Hosted bootstrap may mark practice projects; ordinary project history stays intact. */
export const exampleProjectsMigration = [
  `ALTER TABLE projects ADD COLUMN is_example INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1))`,
  `CREATE VIEW report_projects AS SELECT * FROM projects WHERE is_example = 0 OR is_active = 1`,
  `CREATE VIEW report_time_entries AS SELECT entry.* FROM time_entries entry
    JOIN report_projects project ON project.id = entry.project_id`,
  `CREATE VIEW report_expenses AS SELECT expense.* FROM expenses expense
    JOIN report_projects project ON project.id = expense.project_id`,
] as const
