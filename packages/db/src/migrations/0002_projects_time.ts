const runningPredicate = `timer_started_at IS NOT NULL
      OR (started_time IS NOT NULL AND ended_time IS NULL)`

const maxSafeSeconds = 9_007_199_254_740_991

const secondsCheck = (column: string) => `abs(${column}) <= ${maxSafeSeconds}`

const newRunningPredicate = `NEW.timer_started_at IS NOT NULL
      OR (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL)`

const stopBoundary = `COALESCE(
      NEW.timer_started_at,
      NEW.spent_date || 'T' || NEW.started_time || ':00Z'
    )`

const timestampMilliseconds = (
  timestamp: string,
) => `(CAST(strftime('%s', ${timestamp}) AS INTEGER) * 1000
      + CAST(substr(strftime('%f', ${timestamp}), 4, 3) AS INTEGER))`

const runningStart = `COALESCE(
      timer_started_at,
      spent_date || 'T' || started_time || ':00Z'
    )`

const stopBoundaryMilliseconds = timestampMilliseconds(stopBoundary)
const runningStartMilliseconds = timestampMilliseconds(runningStart)

const elapsedAtBoundary = `seconds_without_timer + MAX(
      0,
      CAST(
        (${stopBoundaryMilliseconds} - ${runningStartMilliseconds}) / 1000 AS INTEGER
      )
    )`

const roundedSeconds = (seconds: string) => `CASE (
      SELECT time_rounding FROM organizations WHERE id = 1
    )
      WHEN 'none' THEN ${seconds}
      WHEN 'nearest_6' THEN CAST((${seconds} + 180) / 360 AS INTEGER) * 360
      WHEN 'nearest_15' THEN CAST((${seconds} + 450) / 900 AS INTEGER) * 900
      WHEN 'nearest_30' THEN CAST((${seconds} + 900) / 1800 AS INTEGER) * 1800
      WHEN 'up_6' THEN CAST((${seconds} + 359) / 360 AS INTEGER) * 360
      WHEN 'up_15' THEN CAST((${seconds} + 899) / 900 AS INTEGER) * 900
      WHEN 'up_30' THEN CAST((${seconds} + 1799) / 1800 AS INTEGER) * 1800
    END`

const stopPreviousRunningEntry = `UPDATE time_entries
    SET
      seconds = ${elapsedAtBoundary},
      seconds_without_timer = ${elapsedAtBoundary},
      rounded_seconds = ${roundedSeconds(elapsedAtBoundary)},
      timer_started_at = NULL,
      ended_time = CASE
        WHEN started_time IS NOT NULL AND ended_time IS NULL
          THEN COALESCE(NEW.started_time, substr(NEW.timer_started_at, 12, 5))
        ELSE ended_time
      END,
      updated_at = COALESCE(NEW.timer_started_at, NEW.updated_at)
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND (${runningPredicate})`

const rejectBackwardBoundary = `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM time_entries
      WHERE user_id = NEW.user_id
        AND id <> NEW.id
        AND (${runningPredicate})
        AND ${stopBoundaryMilliseconds} < ${runningStartMilliseconds}
    ) THEN RAISE(ABORT, 'timer start cannot precede running entry start') END`

const rejectUnsafeTotal = `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM time_entries
      WHERE user_id = NEW.user_id
        AND id <> NEW.id
        AND (${runningPredicate})
        AND (
          ${elapsedAtBoundary} > ${maxSafeSeconds}
          OR ${roundedSeconds(elapsedAtBoundary)} > ${maxSafeSeconds}
        )
    ) THEN RAISE(ABORT, 'timer total exceeds safe integer range') END`

export const projectsTimeMigration = [
  `CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    billing_method TEXT NOT NULL DEFAULT 'time_materials'
      CHECK (billing_method IN ('non_billable','time_materials','fixed_fee')),
    bill_by TEXT NOT NULL DEFAULT 'project'
      CHECK (bill_by IN ('project','tasks','people','none')),
    hourly_rate_cents INTEGER CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
    fee_cents INTEGER CHECK (fee_cents IS NULL OR fee_cents >= 0),
    budget_by TEXT NOT NULL DEFAULT 'none'
      CHECK (budget_by IN ('project','project_cost','task','task_fees','person','none')),
    budget_seconds INTEGER CHECK (budget_seconds IS NULL OR budget_seconds >= 0),
    cost_budget_cents INTEGER CHECK (cost_budget_cents IS NULL OR cost_budget_cents >= 0),
    budget_is_monthly INTEGER NOT NULL DEFAULT 0 CHECK (budget_is_monthly IN (0,1)),
    cost_budget_include_expenses INTEGER NOT NULL DEFAULT 0
      CHECK (cost_budget_include_expenses IN (0,1)),
    notify_when_over_budget INTEGER NOT NULL DEFAULT 0
      CHECK (notify_when_over_budget IN (0,1)),
    over_budget_pct REAL CHECK (over_budget_pct IS NULL OR over_budget_pct >= 0),
    over_budget_notified_on TEXT,
    show_budget_to_all INTEGER NOT NULL DEFAULT 0 CHECK (show_budget_to_all IN (0,1)),
    report_visibility TEXT NOT NULL DEFAULT 'managers'
      CHECK (report_visibility IN ('managers','everyone')),
    starts_on TEXT,
    ends_on TEXT,
    notes TEXT,
    billing_currency TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX projects_client_id ON projects(client_id)`,
  `CREATE TABLE project_tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE project_tag_assignments (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    project_tag_id INTEGER NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, project_tag_id)
  ) WITHOUT ROWID, STRICT`,
  `CREATE INDEX project_tag_assignments_tag_id ON project_tag_assignments(project_tag_id)`,
  `CREATE TABLE project_milestones (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    due_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX project_milestones_project_id ON project_milestones(project_id)`,
  `CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    billable_by_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_by_default IN (0,1)),
    default_hourly_rate_cents INTEGER
      CHECK (default_hourly_rate_cents IS NULL OR default_hourly_rate_cents >= 0),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE task_assignments (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    billable INTEGER NOT NULL CHECK (billable IN (0,1)),
    hourly_rate_cents INTEGER CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
    budget_seconds INTEGER CHECK (budget_seconds IS NULL OR budget_seconds >= 0),
    budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, task_id),
    UNIQUE (id, project_id, task_id)
  ) STRICT`,
  `CREATE INDEX task_assignments_task_id ON task_assignments(task_id)`,
  `CREATE TABLE user_assignments (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    is_project_manager INTEGER NOT NULL DEFAULT 0 CHECK (is_project_manager IN (0,1)),
    use_default_rates INTEGER NOT NULL DEFAULT 1 CHECK (use_default_rates IN (0,1)),
    hourly_rate_cents INTEGER CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
    budget_seconds INTEGER CHECK (budget_seconds IS NULL OR budget_seconds >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, user_id),
    UNIQUE (id, project_id, user_id)
  ) STRICT`,
  `CREATE INDEX user_assignments_user_id ON user_assignments(user_id)`,
  `CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY,
    harvest_id TEXT UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    user_assignment_id INTEGER NOT NULL,
    task_assignment_id INTEGER NOT NULL,
    spent_date TEXT NOT NULL,
    -- A duration is signed, like the money it prices. Harvest corrects an
    -- over-logged timesheet with a negative entry offsetting an earlier one,
    -- and a non-negative CHECK here forced the importer to skip those — which
    -- overstated one contractor's August by 1.0 h and $60, on a payroll run
    -- (#279). Budgets keep >= 0: a budget really is a magnitude.
    seconds INTEGER NOT NULL CHECK (${secondsCheck('seconds')}),
    seconds_without_timer INTEGER NOT NULL CHECK (${secondsCheck('seconds_without_timer')}),
    rounded_seconds INTEGER NOT NULL CHECK (${secondsCheck('rounded_seconds')}),
    timer_started_at TEXT,
    started_time TEXT,
    ended_time TEXT,
    notes TEXT,
    billable INTEGER NOT NULL CHECK (billable IN (0,1)),
    budgeted INTEGER NOT NULL DEFAULT 0 CHECK (budgeted IN (0,1)),
    billable_rate_cents INTEGER
      CHECK (billable_rate_cents IS NULL OR billable_rate_cents >= 0),
    cost_rate_cents INTEGER CHECK (cost_rate_cents IS NULL OR cost_rate_cents >= 0),
    external_ref TEXT CHECK (external_ref IS NULL OR json_valid(external_ref)),
    calendar_event_ref TEXT CHECK (calendar_event_ref IS NULL OR json_valid(calendar_event_ref)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_assignment_id, project_id, user_id)
      REFERENCES user_assignments(id, project_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (task_assignment_id, project_id, task_id)
      REFERENCES task_assignments(id, project_id, task_id) ON DELETE RESTRICT,
    CHECK (
      timer_started_at IS NULL OR (started_time IS NULL AND ended_time IS NULL)
    ),
    CHECK (
      timer_started_at IS NULL OR (
        unixepoch(timer_started_at) IS NOT NULL
        AND substr(timer_started_at, 1, 19)
          = strftime('%Y-%m-%dT%H:%M:%S', timer_started_at)
        AND CAST(substr(timer_started_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
        AND CAST(substr(timer_started_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
        AND CAST(substr(timer_started_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
        AND (
          timer_started_at GLOB '????-??-??T??:??:??Z'
          OR timer_started_at GLOB '????-??-??T??:??:??.[0-9]Z'
          OR timer_started_at GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
          OR timer_started_at GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
        )
      )
    ),
    CHECK (ended_time IS NULL OR started_time IS NOT NULL),
    CHECK (
      (${runningPredicate}) OR seconds_without_timer = seconds
    ),
    CHECK (
      started_time IS NULL OR (
        length(started_time) = 5 AND substr(started_time, 3, 1) = ':'
        AND printf('%02d', CAST(substr(started_time, 1, 2) AS INTEGER)) = substr(started_time, 1, 2)
        AND CAST(substr(started_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        AND printf('%02d', CAST(substr(started_time, 4, 2) AS INTEGER)) = substr(started_time, 4, 2)
        AND CAST(substr(started_time, 4, 2) AS INTEGER) BETWEEN 0 AND 59
      )
    ),
    CHECK (
      ended_time IS NULL OR (
        length(ended_time) = 5 AND substr(ended_time, 3, 1) = ':'
        AND printf('%02d', CAST(substr(ended_time, 1, 2) AS INTEGER)) = substr(ended_time, 1, 2)
        AND CAST(substr(ended_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        AND printf('%02d', CAST(substr(ended_time, 4, 2) AS INTEGER)) = substr(ended_time, 4, 2)
        AND CAST(substr(ended_time, 4, 2) AS INTEGER) BETWEEN 0 AND 59
      )
    )
  ) STRICT`,
  `CREATE INDEX time_entries_user_spent_date ON time_entries(user_id, spent_date)`,
  `CREATE INDEX time_entries_project_spent_date ON time_entries(project_id, spent_date)`,
  `CREATE INDEX time_entries_external_ref_id
    ON time_entries(CAST(json_extract(external_ref, '$.id') AS TEXT))
    WHERE external_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX time_entries_one_running_per_user
    ON time_entries(user_id) WHERE ${runningPredicate}`,
  `CREATE TRIGGER organizations_time_entry_mode_running
    BEFORE UPDATE OF time_entry_mode ON organizations
    WHEN NEW.time_entry_mode <> OLD.time_entry_mode
      AND EXISTS (SELECT 1 FROM time_entries WHERE ${runningPredicate})
    BEGIN
      SELECT RAISE(ABORT, 'stop running time entries before changing mode');
    END`,
  // A correction has no interval to record: Harvest writes it as a bare
  // negative duration even on a start_end account, so the shape rule cannot
  // ask it for a started_time it was never given.
  `CREATE TRIGGER time_entries_mode_insert BEFORE INSERT ON time_entries
    WHEN (
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'duration'
        AND (NEW.started_time IS NOT NULL OR NEW.ended_time IS NOT NULL)
    ) OR (
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'start_end'
        AND NEW.seconds >= 0
        AND (NEW.timer_started_at IS NOT NULL OR NEW.started_time IS NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'time entry shape does not match organization mode'); END`,
  `CREATE TRIGGER time_entries_mode_update
    BEFORE UPDATE OF timer_started_at, started_time, ended_time ON time_entries
    WHEN (${newRunningPredicate}) AND ((
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'duration'
        AND (NEW.started_time IS NOT NULL OR NEW.ended_time IS NOT NULL)
    ) OR (
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'start_end'
        AND (NEW.timer_started_at IS NOT NULL OR NEW.started_time IS NULL)
    ))
    BEGIN SELECT RAISE(ABORT, 'time entry shape does not match organization mode'); END`,
  `CREATE TRIGGER time_entries_stop_previous_insert BEFORE INSERT ON time_entries
    WHEN ${newRunningPredicate}
    BEGIN
      ${rejectBackwardBoundary};
      ${rejectUnsafeTotal};
      ${stopPreviousRunningEntry};
    END`,
  `CREATE TRIGGER time_entries_stop_previous_update
    BEFORE UPDATE OF user_id, timer_started_at, started_time, ended_time ON time_entries
    WHEN ${newRunningPredicate}
    BEGIN
      ${rejectBackwardBoundary};
      ${rejectUnsafeTotal};
      ${stopPreviousRunningEntry};
    END`,
] as const
