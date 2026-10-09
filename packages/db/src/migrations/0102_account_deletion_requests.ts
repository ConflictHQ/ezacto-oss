/** Requests survive mail failures; policy snapshots are never silently replaced. */
export const accountDeletionRequestsMigration = [
  `CREATE TABLE account_deletion_requests (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    requested_at TEXT NOT NULL CHECK (unixepoch(requested_at) IS NOT NULL),
    policy_version INTEGER REFERENCES account_retention_policies(version) ON DELETE RESTRICT,
    policy_snapshot TEXT CHECK (policy_snapshot IS NULL OR json_valid(policy_snapshot)),
    policy_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (policy_reviewed IN (0,1)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','action_required','completed')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
    message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 5000),
    expected_completion_at TEXT CHECK (expected_completion_at IS NULL OR unixepoch(expected_completion_at) IS NOT NULL),
    completed_at TEXT CHECK (completed_at IS NULL OR unixepoch(completed_at) IS NOT NULL),
    completion_confirmation TEXT CHECK (completion_confirmation IS NULL OR length(completion_confirmation) BETWEEN 1 AND 5000),
    notification TEXT NOT NULL DEFAULT 'pending' CHECK (notification IN ('pending','sending','queued','failed','unavailable')),
    notification_updated_at TEXT NOT NULL CHECK (unixepoch(notification_updated_at) IS NOT NULL),
    notification_delivery_id INTEGER REFERENCES email_log(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    CHECK ((policy_version IS NULL AND policy_snapshot IS NULL) OR (policy_version IS NOT NULL AND policy_snapshot IS NOT NULL)),
    CHECK ((status = 'completed' AND completed_at IS NOT NULL AND completion_confirmation IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL AND completion_confirmation IS NULL))
  ) STRICT`,
  `CREATE TRIGGER account_deletion_request_snapshot_immutable BEFORE UPDATE ON account_deletion_requests
    WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id
      OR OLD.requested_at IS NOT NEW.requested_at OR OLD.policy_version IS NOT NEW.policy_version
      OR OLD.policy_snapshot IS NOT NEW.policy_snapshot OR OLD.policy_reviewed IS NOT NEW.policy_reviewed
    BEGIN SELECT RAISE(ABORT, 'account deletion request snapshot is immutable'); END`,
  `CREATE TABLE account_deletion_request_updates (
    request_id TEXT NOT NULL REFERENCES account_deletion_requests(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    expected_completion_at TEXT,
    occurred_at TEXT NOT NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (request_id, version)
  ) STRICT`,
  `CREATE TRIGGER account_deletion_request_update_history AFTER UPDATE ON account_deletion_requests
    WHEN OLD.version <> NEW.version
    BEGIN INSERT INTO account_deletion_request_updates
      (request_id, version, status, message, expected_completion_at, occurred_at, actor_user_id)
      VALUES (NEW.id, NEW.version, NEW.status, NEW.message, NEW.expected_completion_at, NEW.updated_at, NEW.updated_by_user_id); END`,
  // An old request remains actionable; its original disclosure is unknown.
  `INSERT INTO account_deletion_requests (id, user_id, requested_at, notification, notification_updated_at, updated_at)
    SELECT 'legacy-' || user.id, user.id, min(event.occurred_at), 'unavailable', min(event.occurred_at), min(event.occurred_at)
    FROM event_outbox event JOIN users user ON user.id = event.aggregate_id
    WHERE event.aggregate_type = 'user_account' AND event.event_type = 'account.deletion_requested'
    GROUP BY user.id`,
] as const
