const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
      AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
      AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
      AND (
        ${column} GLOB '????-??-??T??:??:??Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
      )`

/**
 * The singleton is both an audit record and the concurrency claim for the
 * one-time instance bootstrap. Its update trigger turns an exact re-run into a
 * state assertion and rejects a different bootstrap or a partially changed
 * instance. The bootstrap writer executes the claim, seed, and assertion in
 * one transaction/batch.
 */
export const instanceBootstrapMigration = [
  `CREATE TABLE instance_bootstrap (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    organization_name TEXT NOT NULL CHECK (
      organization_name = trim(organization_name)
      AND length(organization_name) BETWEEN 1 AND 200
    ),
    owner_first_name TEXT NOT NULL CHECK (
      owner_first_name = trim(owner_first_name)
      AND length(owner_first_name) BETWEEN 1 AND 100
    ),
    owner_last_name TEXT NOT NULL CHECK (
      owner_last_name = trim(owner_last_name)
      AND length(owner_last_name) BETWEEN 1 AND 100
    ),
    owner_email TEXT NOT NULL CHECK (
      owner_email = lower(owner_email)
      AND owner_email = trim(owner_email)
      AND length(owner_email) BETWEEN 3 AND 254
      AND instr(owner_email, '@') BETWEEN 2 AND length(owner_email) - 1
    ),
    token_selector TEXT NOT NULL CHECK (
      length(token_selector) = 16
      AND token_selector NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    token_secret_hash TEXT NOT NULL CHECK (
      length(token_secret_hash) = 64
      AND token_secret_hash NOT GLOB '*[^0-9a-f]*'
    ),
    token_name TEXT NOT NULL,
    token_scopes TEXT NOT NULL CHECK (
      json_valid(token_scopes) AND json_type(token_scopes) = 'array'
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')})
  ) STRICT`,
  `CREATE TRIGGER instance_bootstrap_requires_empty_instance
    BEFORE INSERT ON instance_bootstrap
    WHEN NOT EXISTS (SELECT 1 FROM instance_bootstrap WHERE id = NEW.id)
      AND (
        EXISTS (SELECT 1 FROM organizations)
        OR EXISTS (SELECT 1 FROM users)
        OR EXISTS (SELECT 1 FROM organization_owner)
        OR EXISTS (SELECT 1 FROM user_emails)
        OR EXISTS (SELECT 1 FROM api_tokens)
      )
    BEGIN SELECT RAISE(ABORT, 'instance bootstrap requires empty identity state'); END`,
  `CREATE TRIGGER instance_bootstrap_exact_state
    BEFORE UPDATE ON instance_bootstrap
    WHEN OLD.id IS NOT NEW.id
      OR OLD.organization_name IS NOT NEW.organization_name
      OR OLD.owner_first_name IS NOT NEW.owner_first_name
      OR OLD.owner_last_name IS NOT NEW.owner_last_name
      OR OLD.owner_email IS NOT NEW.owner_email
      OR OLD.token_selector IS NOT NEW.token_selector
      OR OLD.token_secret_hash IS NOT NEW.token_secret_hash
      OR OLD.token_name IS NOT NEW.token_name
      OR OLD.token_scopes IS NOT NEW.token_scopes
      OR OLD.created_at IS NOT NEW.created_at
      OR (SELECT count(*) FROM organizations) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM organizations organization
        WHERE organization.id = 1
          AND organization.name = OLD.organization_name
          AND organization.address IS NULL
          AND organization.week_start_day = 'monday'
          AND organization.time_entry_mode = 'duration'
          AND organization.time_format = 'decimal'
          AND organization.clock = '12h'
          AND organization.date_format = '%Y-%m-%d'
          AND organization.currency = 'USD'
          AND organization.currency_code_display = 'iso_code_after'
          AND organization.currency_symbol_display = 'symbol_before'
          AND organization.decimal_symbol = '.'
          AND organization.thousands_separator = ','
          AND organization.weekly_capacity_default = 126000
          AND organization.fiscal_year_start_month = 1
          AND organization.timesheet_deadline IS NULL
          AND organization.reminder_policy IS NULL
          AND organization.auto_lock = 0
          AND organization.auto_submit = 0
          AND organization.time_entry_notes_required = 0
          AND organization.time_rounding = 'none'
          AND organization.modules = '{"expenses":true,"invoices":true}'
          AND organization.require_2fa = 0
          AND organization.require_sso = 0
          AND organization.created_at = OLD.created_at
          AND organization.updated_at = OLD.created_at
      )
      OR (SELECT count(*) FROM users) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM users user
        WHERE user.id = 1
          AND user.harvest_id IS NULL
          AND user.first_name = OLD.owner_first_name
          AND user.last_name = OLD.owner_last_name
          AND user.telephone IS NULL
          AND user.employee_id IS NULL
          AND user.timezone = 'UTC'
          AND user.is_contractor = 0
          AND user.is_active = 1
          AND user.has_access_to_all_future_projects = 1
          AND user.weekly_capacity = 126000
          AND user.profile = 'administrator'
          AND user.manager_grants = '[]'
          AND user.is_owner = 1
          AND user.avatar_url IS NULL
          AND user.saml_exempt = 0
          AND user.created_at = OLD.created_at
          AND user.updated_at = OLD.created_at
      )
      OR (SELECT count(*) FROM organization_owner) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM organization_owner owner
        WHERE owner.id = 1 AND owner.user_id = 1 AND owner.updated_at = OLD.created_at
      )
      OR (SELECT count(*) FROM user_emails) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM user_emails email
        WHERE email.id = 1
          AND email.user_id = 1
          AND email.address = OLD.owner_email
          AND email.verified_at = OLD.created_at
          AND email.is_primary = 1
          AND email.invalidated_at IS NULL
          AND email.created_at = OLD.created_at
          AND email.updated_at = OLD.created_at
      )
      OR (SELECT count(*) FROM api_tokens) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM api_tokens token
        WHERE token.id = 1
          AND token.user_id = 1
          AND token.selector = OLD.token_selector
          AND token.secret_hash = OLD.token_secret_hash
          AND token.name = OLD.token_name
          AND token.scopes = OLD.token_scopes
          AND token.expires_at IS NULL
          AND token.revoked_at IS NULL
          AND token.created_at = OLD.created_at
          AND julianday(token.updated_at) >= julianday(token.created_at)
      )
    BEGIN SELECT RAISE(ABORT, 'instance bootstrap state mismatch'); END`,
  `CREATE TRIGGER instance_bootstrap_cannot_delete
    BEFORE DELETE ON instance_bootstrap
    BEGIN SELECT RAISE(ABORT, 'instance bootstrap audit record cannot be deleted'); END`,
] as const
