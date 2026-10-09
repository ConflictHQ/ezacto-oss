/** Policy versions remain available to explain the terms of an earlier request. */
export const accountRetentionPolicyMigration = [
  `CREATE TABLE account_retention_policies (
    version INTEGER PRIMARY KEY CHECK (version BETWEEN 1 AND 9007199254740991),
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)
      AND json_type(policy_json) = 'object'
      AND coalesce(json_type(policy_json, '$.acknowledged') = 'true', 0)),
    published_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    published_at TEXT NOT NULL CHECK (unixepoch(published_at) IS NOT NULL)
  ) STRICT`,
  `CREATE TRIGGER account_retention_policy_version_immutable BEFORE UPDATE ON account_retention_policies
    WHEN OLD.version IS NOT NEW.version
      OR OLD.policy_json IS NOT NEW.policy_json
      OR OLD.published_at IS NOT NEW.published_at
      OR (OLD.published_by_user_id IS NOT NEW.published_by_user_id AND NEW.published_by_user_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'publish a new account retention policy version'); END`,
] as const
