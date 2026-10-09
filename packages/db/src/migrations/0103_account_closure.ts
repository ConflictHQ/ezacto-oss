const credentialTables = [
  'user_passwords',
  'sessions',
  'api_tokens',
  'staff_magic_links',
  'oidc_app_codes',
  'two_factor_challenges',
  'user_totp_enrolments',
  'user_recovery_codes',
  'user_identities',
  'user_emails',
] as const

/** Closure is irreversible; residual retention/external work remains independently reviewable. */
export const accountClosureMigration = [
  `CREATE TABLE account_deletion_status_access (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES account_deletion_requests(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK(unixepoch(expires_at)>unixepoch(issued_at))
  ) STRICT`,
  `CREATE TRIGGER account_deletion_status_access_limit AFTER INSERT ON account_deletion_status_access BEGIN
    DELETE FROM account_deletion_status_access WHERE request_id=NEW.request_id AND id NOT IN
      (SELECT id FROM account_deletion_status_access WHERE request_id=NEW.request_id ORDER BY id DESC LIMIT 5);
  END`,
  `CREATE TABLE account_deletion_status_limits (
    window_minute INTEGER PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 601)
  ) STRICT`,

  `CREATE TABLE account_closure_security (
    id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL CHECK (length(secret) = 64)
  ) STRICT`,
  `INSERT INTO account_closure_security VALUES (1, lower(hex(randomblob(32))))`,
  `CREATE TABLE account_closures (
    request_id TEXT PRIMARY KEY REFERENCES account_deletion_requests(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    closed_at TEXT NOT NULL CHECK (unixepoch(closed_at) IS NOT NULL),
    policy_version INTEGER NOT NULL REFERENCES account_retention_policies(version) ON DELETE RESTRICT,
    policy_snapshot TEXT NOT NULL CHECK (json_valid(policy_snapshot)),
    inventory_json TEXT NOT NULL CHECK (json_valid(inventory_json)),
    replay_keys TEXT NOT NULL CHECK (json_valid(replay_keys) AND json_type(replay_keys) = 'array'),
    retained_identity INTEGER NOT NULL CHECK (retained_identity IN (0,1)),
    apple_cleanup TEXT NOT NULL CHECK (apple_cleanup IN ('not_linked','pending'))
  ) STRICT`,
  `CREATE TABLE closed_account_sign_in_guards (
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    request_id TEXT NOT NULL REFERENCES account_closures(request_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('email','provider')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (digest, request_id)
  ) STRICT`,
  `CREATE TRIGGER account_closures_immutable BEFORE UPDATE ON account_closures
    WHEN NEW.request_id IS NOT OLD.request_id OR NEW.user_id IS NOT OLD.user_id
      OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.closed_at IS NOT OLD.closed_at
      OR NEW.policy_version IS NOT OLD.policy_version OR NEW.policy_snapshot IS NOT OLD.policy_snapshot
      OR NEW.inventory_json IS NOT OLD.inventory_json OR NEW.retained_identity IS NOT OLD.retained_identity
      OR NEW.apple_cleanup IS NOT OLD.apple_cleanup OR (NEW.replay_keys IS NOT OLD.replay_keys AND NEW.replay_keys <> '[]')
    BEGIN SELECT RAISE(ABORT, 'account closure evidence is immutable'); END`,
  `CREATE TRIGGER account_closures_cannot_delete BEFORE DELETE ON account_closures
    BEGIN SELECT RAISE(ABORT, 'account closure cannot be reversed'); END`,
  `CREATE TRIGGER account_closures_authority BEFORE INSERT ON account_closures
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_user_id AND profile = 'administrator' AND is_active = 1)
      OR NOT EXISTS (SELECT 1 FROM account_deletion_requests WHERE id = NEW.request_id AND user_id = NEW.user_id AND status <> 'completed')
      OR EXISTS (SELECT 1 FROM organization_owner WHERE user_id = NEW.user_id)
      OR EXISTS (SELECT 1 FROM time_entries WHERE user_id = NEW.user_id AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL)))
      OR NOT EXISTS (SELECT 1 FROM account_retention_policies WHERE version = NEW.policy_version AND policy_json = NEW.policy_snapshot)
    BEGIN SELECT RAISE(ABORT, 'account closure requires administrator, request, policy and owner succession'); END`,
  `CREATE TRIGGER account_closures_erase_local AFTER INSERT ON account_closures BEGIN
    INSERT INTO closed_account_sign_in_guards (digest, request_id, kind, created_at)
      SELECT json_extract(value,'$.digest'), NEW.request_id, json_extract(value,'$.kind'), NEW.closed_at
      FROM json_each(NEW.replay_keys) WHERE 1 ON CONFLICT(digest, request_id) DO NOTHING;
    UPDATE account_closures SET replay_keys='[]' WHERE request_id=NEW.request_id;
    UPDATE email_log SET status = 'failed', failure_code = 'provider_rejected', failure_reason = 'account_closed',
      active_attempt_id = NULL, attempt_lease_expires_at = NULL, updated_at = NEW.closed_at
      WHERE status = 'queued' AND EXISTS (
        SELECT 1 FROM json_each(email_log.to_json) recipient JOIN user_emails address
          ON lower(address.address) = lower(json_extract(recipient.value,'$.email')) WHERE address.user_id = NEW.user_id
      );
    DELETE FROM auth_tokens WHERE user_email_id IN (SELECT id FROM user_emails WHERE user_id = NEW.user_id);
    ${credentialTables.map((table) => `DELETE FROM ${table} WHERE user_id = NEW.user_id;`).join('\n    ')}
    DELETE FROM quickbooks_oauth_states WHERE requested_by_user_id = NEW.user_id;
    DELETE FROM notification_preferences WHERE user_id = NEW.user_id;
    DELETE FROM user_roles WHERE user_id = NEW.user_id;
    DELETE FROM user_departments WHERE user_id = NEW.user_id;
    DELETE FROM teammate_assignments WHERE user_id = NEW.user_id OR manager_id = NEW.user_id;
    DELETE FROM saved_report_pins WHERE user_id = NEW.user_id;
    DELETE FROM saved_report_shares WHERE user_id = NEW.user_id;
    DELETE FROM saved_reports WHERE owner_user_id = NEW.user_id;
    UPDATE users SET is_active = 0, profile = 'member', manager_grants = '[]',
      first_name = CASE WHEN NEW.retained_identity = 1 THEN first_name ELSE 'Closed' END,
      last_name = CASE WHEN NEW.retained_identity = 1 THEN last_name ELSE 'account' END,
      telephone = NULL, employee_id = NULL, avatar_url = NULL, harvest_id = NULL,
      timezone = 'UTC', is_contractor = 0, has_access_to_all_future_projects = 0,
      weekly_capacity = 0, saml_exempt = 0, time_entry_notes_minimum_length = NULL,
      team_write_token = NULL, invoice_email_copy = 0, version = version + 1, updated_at = NEW.closed_at
      WHERE id = NEW.user_id;
    UPDATE account_deletion_requests SET status = 'action_required', version = version + 1,
      message = 'Account access is closed and local sign-in credentials were removed. Retained records and external cleanup remain under operator review.',
      updated_at = NEW.closed_at, updated_by_user_id = NEW.actor_user_id WHERE id = NEW.request_id;
  END`,
  `CREATE TRIGGER closed_accounts_cannot_reactivate BEFORE UPDATE OF is_active, profile, manager_grants ON users
    WHEN EXISTS (SELECT 1 FROM account_closures WHERE user_id = OLD.id)
      AND (NEW.is_active <> 0 OR NEW.profile <> 'member' OR NEW.manager_grants <> '[]')
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot be reactivated'); END`,
  `CREATE TRIGGER closed_accounts_profile_minimization BEFORE UPDATE ON users
    WHEN OLD.is_active = 0 AND EXISTS (SELECT 1 FROM account_closures WHERE user_id = OLD.id)
      AND (NEW.telephone IS NOT NULL OR NEW.employee_id IS NOT NULL OR NEW.avatar_url IS NOT NULL
        OR NEW.harvest_id IS NOT NULL OR NEW.team_write_token IS NOT NULL
        OR ((NEW.first_name IS NOT OLD.first_name OR NEW.last_name IS NOT OLD.last_name)
          AND (NEW.first_name <> 'Closed' OR NEW.last_name <> 'account')))
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot receive personal profile data'); END`,
  ...credentialTables.flatMap((table) =>
    ['INSERT', 'UPDATE'].map(
      (
        operation,
      ) => `CREATE TRIGGER ${table}_closed_account_${operation.toLowerCase()}_guard BEFORE ${operation} ON ${table}
    WHEN EXISTS (SELECT 1 FROM account_closures WHERE user_id = NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot receive sign-in credentials'); END`,
    ),
  ),
  ...['INSERT', 'UPDATE'].map(
    (
      operation,
    ) => `CREATE TRIGGER time_entries_closed_account_${operation.toLowerCase()}_guard BEFORE ${operation} ON time_entries
    WHEN (NEW.timer_started_at IS NOT NULL OR (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL))
      AND EXISTS (SELECT 1 FROM account_closures WHERE user_id = NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot run a timer'); END`,
  ),
  `CREATE TRIGGER auth_tokens_closed_account_guard BEFORE INSERT ON auth_tokens
    WHEN EXISTS (SELECT 1 FROM user_emails address JOIN account_closures closure ON closure.user_id = address.user_id WHERE address.id = NEW.user_email_id)
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot receive sign-in credentials'); END`,
  `CREATE TRIGGER quickbooks_oauth_states_closed_account_guard BEFORE INSERT ON quickbooks_oauth_states
    WHEN EXISTS (SELECT 1 FROM account_closures WHERE user_id = NEW.requested_by_user_id)
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot authorize an integration'); END`,
] as const
