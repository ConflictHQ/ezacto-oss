export const timeEntryNoteRequirementsMigration = [
  `ALTER TABLE organizations
    ADD COLUMN time_entry_notes_minimum_length INTEGER NOT NULL DEFAULT 1
      CHECK (time_entry_notes_minimum_length BETWEEN 1 AND 10000)`,
  `ALTER TABLE projects
    ADD COLUMN time_entry_notes_minimum_length INTEGER
      CHECK (
        time_entry_notes_minimum_length IS NULL
        OR time_entry_notes_minimum_length BETWEEN 1 AND 10000
      )`,
  `ALTER TABLE users
    ADD COLUMN time_entry_notes_minimum_length INTEGER
      CHECK (
        time_entry_notes_minimum_length IS NULL
        OR time_entry_notes_minimum_length BETWEEN 1 AND 10000
      )`,
  `ALTER TABLE user_assignments
    ADD COLUMN time_entry_notes_minimum_length INTEGER
      CHECK (
        time_entry_notes_minimum_length IS NULL
        OR time_entry_notes_minimum_length BETWEEN 1 AND 10000
      )`,
  `CREATE TRIGGER instance_bootstrap_note_requirements_exact_state
    BEFORE UPDATE ON instance_bootstrap
    WHEN NOT EXISTS (
      SELECT 1 FROM organizations organization
      WHERE organization.id = 1
        AND organization.time_entry_notes_minimum_length = 1
    ) OR NOT EXISTS (
      SELECT 1 FROM users user
      WHERE user.id = 1
        AND user.time_entry_notes_minimum_length IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'instance bootstrap state mismatch'); END`,
] as const
