export const orgPeopleMigration = [
  `CREATE TABLE organizations (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), name TEXT NOT NULL, address TEXT,
    week_start_day TEXT NOT NULL DEFAULT 'monday' CHECK (week_start_day IN ('saturday','sunday','monday')),
    time_entry_mode TEXT NOT NULL DEFAULT 'duration' CHECK (time_entry_mode IN ('duration','start_end')),
    time_format TEXT NOT NULL DEFAULT 'decimal' CHECK (time_format IN ('decimal','hours_minutes')),
    clock TEXT NOT NULL DEFAULT '12h' CHECK (clock IN ('12h','24h')), date_format TEXT NOT NULL DEFAULT '%Y-%m-%d',
    currency TEXT NOT NULL DEFAULT 'USD',
    currency_code_display TEXT NOT NULL DEFAULT 'iso_code_after' CHECK (currency_code_display IN ('iso_code_none','iso_code_before','iso_code_after')),
    currency_symbol_display TEXT NOT NULL DEFAULT 'symbol_before' CHECK (currency_symbol_display IN ('symbol_none','symbol_before','symbol_after')),
    decimal_symbol TEXT NOT NULL DEFAULT '.', thousands_separator TEXT NOT NULL DEFAULT ',',
    weekly_capacity_default INTEGER NOT NULL DEFAULT 126000 CHECK (weekly_capacity_default >= 0),
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    timesheet_deadline TEXT CHECK (timesheet_deadline IS NULL OR json_valid(timesheet_deadline)),
    reminder_policy TEXT CHECK (reminder_policy IS NULL OR json_valid(reminder_policy)),
    auto_lock INTEGER NOT NULL DEFAULT 0 CHECK (auto_lock IN (0,1)),
    auto_submit INTEGER NOT NULL DEFAULT 0 CHECK (auto_submit IN (0,1)),
    time_entry_notes_required INTEGER NOT NULL DEFAULT 0 CHECK (time_entry_notes_required IN (0,1)),
    time_rounding TEXT NOT NULL DEFAULT 'none' CHECK (time_rounding IN ('none','nearest_6','nearest_15','nearest_30','up_6','up_15','up_30')),
    modules TEXT NOT NULL CHECK (json_valid(modules)),
    require_2fa INTEGER NOT NULL DEFAULT 0 CHECK (require_2fa IN (0,1)), require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY, harvest_id INTEGER UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    telephone TEXT, employee_id TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', is_contractor INTEGER NOT NULL DEFAULT 0 CHECK (is_contractor IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)), has_access_to_all_future_projects INTEGER NOT NULL DEFAULT 0 CHECK (has_access_to_all_future_projects IN (0,1)),
    weekly_capacity INTEGER NOT NULL DEFAULT 126000 CHECK (weekly_capacity >= 0),
    profile TEXT NOT NULL DEFAULT 'member' CHECK (profile IN ('member','project_manager','people_admin','accounting','executive_manager','administrator')),
    manager_grants TEXT NOT NULL CHECK (json_valid(manager_grants)), is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
    avatar_url TEXT, saml_exempt INTEGER NOT NULL DEFAULT 0 CHECK (saml_exempt IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (is_owner = 0 OR profile = 'administrator')
  ) STRICT`,
  `CREATE UNIQUE INDEX users_single_owner ON users(is_owner) WHERE is_owner = 1`,
  `CREATE TABLE organization_owner (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER organization_owner_set_initial AFTER INSERT ON organization_owner BEGIN
    UPDATE users SET
      profile = CASE WHEN id = NEW.user_id THEN 'administrator' ELSE profile END,
      is_owner = CASE WHEN id = NEW.user_id THEN 1 ELSE 0 END;
  END`,
  `CREATE TRIGGER organization_owner_transfer AFTER UPDATE OF user_id ON organization_owner
    WHEN OLD.user_id IS NOT NEW.user_id BEGIN
    UPDATE users SET is_owner = 0 WHERE id = OLD.user_id;
    UPDATE users SET profile = 'administrator', is_owner = 1 WHERE id = NEW.user_id;
  END`,
  `CREATE TRIGGER organization_owner_cannot_delete BEFORE DELETE ON organization_owner
    BEGIN SELECT RAISE(ABORT, 'organization must have exactly one owner'); END`,
  `CREATE TRIGGER users_owner_is_derived BEFORE UPDATE OF is_owner ON users
    WHEN NEW.is_owner <> CASE WHEN NEW.id = (SELECT user_id FROM organization_owner WHERE id = 1) THEN 1 ELSE 0 END
    BEGIN SELECT RAISE(ABORT, 'is_owner is derived from organization_owner'); END`,
  `CREATE TRIGGER users_owner_insert_is_derived BEFORE INSERT ON users
    WHEN NEW.is_owner <> 0 BEGIN SELECT RAISE(ABORT, 'is_owner is derived from organization_owner'); END`,
  `CREATE TRIGGER users_first_becomes_owner AFTER INSERT ON users
    WHEN NOT EXISTS (SELECT 1 FROM organization_owner WHERE id = 1) BEGIN
      INSERT INTO organization_owner (id, user_id, updated_at) VALUES (1, NEW.id, NEW.updated_at);
    END`,
  `CREATE TABLE user_emails (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL, verified_at TEXT, is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)), invalidated_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (is_primary = 0 OR (verified_at IS NOT NULL AND invalidated_at IS NULL))
  ) STRICT`,
  `CREATE INDEX user_emails_user_id ON user_emails(user_id)`,
  `CREATE UNIQUE INDEX user_emails_verified_address_unique ON user_emails(lower(address))
    WHERE verified_at IS NOT NULL AND invalidated_at IS NULL`,
  `CREATE UNIQUE INDEX user_emails_one_primary_per_user ON user_emails(user_id)
    WHERE is_primary = 1 AND invalidated_at IS NULL`,
  `CREATE TRIGGER user_emails_verification_loses_race BEFORE UPDATE OF verified_at ON user_emails
    WHEN OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM user_emails winner WHERE lower(winner.address) = lower(NEW.address)
      AND winner.verified_at IS NOT NULL AND winner.invalidated_at IS NULL AND winner.id <> NEW.id
    ) BEGIN
      UPDATE user_emails SET invalidated_at = NEW.verified_at, is_primary = 0, updated_at = NEW.updated_at WHERE id = OLD.id;
      SELECT RAISE(IGNORE);
    END`,
  `CREATE TRIGGER user_emails_verification_invalidates_pending AFTER UPDATE OF verified_at ON user_emails
    WHEN OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL AND NEW.invalidated_at IS NULL BEGIN
      UPDATE user_emails SET invalidated_at = NEW.verified_at, is_primary = 0, updated_at = NEW.updated_at
      WHERE id <> NEW.id AND lower(address) = lower(NEW.address) AND verified_at IS NULL AND invalidated_at IS NULL;
    END`,
  `CREATE TRIGGER user_emails_verified_insert_invalidates_pending AFTER INSERT ON user_emails
    WHEN NEW.verified_at IS NOT NULL AND NEW.invalidated_at IS NULL BEGIN
      UPDATE user_emails SET invalidated_at = NEW.verified_at, is_primary = 0, updated_at = NEW.updated_at
      WHERE id <> NEW.id AND lower(address) = lower(NEW.address) AND verified_at IS NULL AND invalidated_at IS NULL;
    END`,
  `CREATE TRIGGER user_emails_verified_address_immutable BEFORE UPDATE OF address ON user_emails
    WHEN OLD.verified_at IS NOT NULL AND OLD.invalidated_at IS NULL AND lower(OLD.address) <> lower(NEW.address)
    BEGIN SELECT RAISE(ABORT, 'verified email address is immutable; add and verify a new address'); END`,
  `CREATE TABLE user_identities (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, provider_subject TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_subject)
  ) STRICT`,
  `CREATE INDEX user_identities_user_id ON user_identities(user_id)`,
  `CREATE TABLE roles (id INTEGER PRIMARY KEY, harvest_id INTEGER UNIQUE, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, role_id)
  ) STRICT`,
  `CREATE TABLE user_departments (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, department_id)
  ) STRICT`,
  `CREATE TABLE teammate_assignments (
    manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(manager_id, user_id), CHECK(manager_id <> user_id)
  ) STRICT`,
  `CREATE TABLE user_billable_rates (
    id INTEGER PRIMARY KEY, harvest_id INTEGER UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), start_date TEXT, end_date TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(user_id, start_date)
  ) STRICT`,
  `CREATE INDEX user_billable_rates_user_id ON user_billable_rates(user_id)`,
  `CREATE TABLE user_cost_rates (
    id INTEGER PRIMARY KEY, harvest_id INTEGER UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), start_date TEXT, end_date TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(user_id, start_date)
  ) STRICT`,
  `CREATE INDEX user_cost_rates_user_id ON user_cost_rates(user_id)`,
  ...['user_billable_rates', 'user_cost_rates'].flatMap((table) => [
    `CREATE TRIGGER ${table}_chronological BEFORE INSERT ON ${table}
      WHEN EXISTS (SELECT 1 FROM ${table} WHERE user_id = NEW.user_id
        AND coalesce(start_date, '0000-01-01') >= coalesce(NEW.start_date, '0000-01-01'))
      BEGIN SELECT RAISE(ABORT, 'rates must be appended chronologically'); END`,
    `CREATE TRIGGER ${table}_end_date_is_derived BEFORE INSERT ON ${table}
      WHEN NEW.end_date IS NOT NULL BEGIN SELECT RAISE(ABORT, 'rate end_date is derived'); END`,
    `CREATE TRIGGER ${table}_start_date_valid BEFORE INSERT ON ${table}
      WHEN NEW.start_date IS NOT NULL AND (date(NEW.start_date) IS NOT NEW.start_date OR date(NEW.start_date) > date('now'))
      BEGIN SELECT RAISE(ABORT, 'rate start_date must be a valid date that is not in the future'); END`,
    `CREATE TRIGGER ${table}_close_previous AFTER INSERT ON ${table} BEGIN
      UPDATE ${table} SET end_date = date(NEW.start_date, '-1 day')
      WHERE user_id = NEW.user_id AND id <> NEW.id AND end_date IS NULL;
    END`,
    `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table}
      WHEN OLD.end_date IS NOT NULL OR NEW.end_date IS NULL
        OR OLD.id <> NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id OR OLD.user_id <> NEW.user_id
        OR OLD.amount_cents <> NEW.amount_cents OR OLD.start_date IS NOT NEW.start_date
        OR OLD.created_at <> NEW.created_at OR OLD.updated_at <> NEW.updated_at
        OR NEW.end_date IS NOT date((SELECT min(next.start_date) FROM ${table} next
          WHERE next.user_id = OLD.user_id
          AND coalesce(next.start_date, '0000-01-01') > coalesce(OLD.start_date, '0000-01-01')), '-1 day')
      BEGIN SELECT RAISE(ABORT, 'rates are append-only'); END`,
    `CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'rates are append-only'); END`,
  ]),
] as const
