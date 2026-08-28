export const threeAxisStateMigration = [
  `ALTER TABLE time_entries ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'unsubmitted'
    CHECK (approval_status IN ('unsubmitted','submitted','approved'))`,
] as const
