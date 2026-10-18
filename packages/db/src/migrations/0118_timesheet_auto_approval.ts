// Provenance: ezacto-pvt #1009, slices 1 and 2. Optional automatic approval of
// a submitted week once nobody has acted on it for a number of days.
//
// Off by default and not retroactive. Four columns on the one organization row:
//
// - `auto_approval_enabled`: nothing is ever approved until an administrator
//   turns it on.
// - `auto_approval_window_days`: calendar days, counted from the week's
//   `submitted_at`, which every resubmission rewrites. There is deliberately no
//   default: the number is a business decision, so enabling without one is
//   refused by the CHECK below as well as by the API.
// - `auto_approval_effective_from`: the instant the policy was last switched on.
//   A submission made before it is never swept, so enabling cannot approve a
//   backlog nobody has looked at.
// - `auto_approval_actor_user_id`: whose standing authority the sweep acts under.
//   `timesheet_submissions.reviewed_by_user_id` must name a real user for an
//   approved week, and a reserved system user is a decision for the next slice;
//   until then the approval is recorded under the administrator who enabled the
//   policy, and the activity log says it was automatic.
//
// An enabled policy must be complete, so a half-configured row cannot exist.
export const timesheetAutoApprovalMigration = [
  `ALTER TABLE organizations ADD COLUMN auto_approval_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (auto_approval_enabled IN (0,1))`,
  `ALTER TABLE organizations ADD COLUMN auto_approval_window_days INTEGER
    CHECK (auto_approval_window_days IS NULL OR auto_approval_window_days BETWEEN 1 AND 60)`,
  `ALTER TABLE organizations ADD COLUMN auto_approval_effective_from TEXT
    CHECK (auto_approval_effective_from IS NULL OR unixepoch(auto_approval_effective_from) IS NOT NULL)`,
  `ALTER TABLE organizations ADD COLUMN auto_approval_actor_user_id INTEGER
    REFERENCES users(id) ON DELETE RESTRICT`,
  `CREATE TRIGGER organizations_auto_approval_complete_insert
    BEFORE INSERT ON organizations
    WHEN NEW.auto_approval_enabled = 1 AND (
      NEW.auto_approval_window_days IS NULL OR NEW.auto_approval_effective_from IS NULL
      OR NEW.auto_approval_actor_user_id IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'automatic approval needs a window, a start and an actor'); END`,
  `CREATE TRIGGER organizations_auto_approval_complete_update
    BEFORE UPDATE OF auto_approval_enabled, auto_approval_window_days,
      auto_approval_effective_from, auto_approval_actor_user_id ON organizations
    WHEN NEW.auto_approval_enabled = 1 AND (
      NEW.auto_approval_window_days IS NULL OR NEW.auto_approval_effective_from IS NULL
      OR NEW.auto_approval_actor_user_id IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'automatic approval needs a window, a start and an actor'); END`,
] as const
