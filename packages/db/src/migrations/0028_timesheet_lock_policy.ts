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

const activeLockFor = (dateExpression: string) => `EXISTS (
  SELECT 1 FROM timesheet_lock_windows lock
  WHERE lock.unlocked_at IS NULL
    AND ${dateExpression} <= lock.period_end
    AND (lock.period_start IS NULL OR ${dateExpression} >= lock.period_start)
)`

const privilegedActor = (idExpression: string) => `EXISTS (
  SELECT 1 FROM users actor
  WHERE actor.id = ${idExpression}
    AND actor.profile IN ('administrator','executive_manager')
)`

const lockPolicyCompatibleInstanceBootstrapExactStateTrigger =
  approvalCompatibleInstanceBootstrapExactStateTrigger.replace(
    `AND organization.timesheet_deadline IS NULL`,
    `AND organization.timezone = 'UTC'
          AND organization.timesheet_deadline IS NULL`,
  )

const approvalModuleEnabled = `COALESCE(
  (SELECT json_extract(modules, '$.approval') FROM organizations WHERE id = 1),
  0
) = 1`

const harvestWeekStart = (entry = 'entry') => `date(${entry}.spent_date, '-' || (
  (CAST(strftime('%w', ${entry}.spent_date) AS INTEGER) - CASE (
    SELECT week_start_day FROM organizations WHERE id = 1
  ) WHEN 'sunday' THEN 0 WHEN 'monday' THEN 1 ELSE 6 END + 7) % 7
) || ' days')`

const withdrawnImportedOverride = `EXISTS (
  SELECT 1 FROM timesheet_submissions submission
  WHERE submission.user_id = NEW.user_id
    AND submission.period_start = ${harvestWeekStart('NEW')}
    AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
    AND submission.origin IN ('harvest_import','legacy_backfill')
    AND submission.status = 'unsubmitted'
    AND submission.source_status = NEW.source_approval_status
    AND submission.version > 0 AND submission.rejection_reason IS NOT NULL
)`

/**
 * Durable organization-wide policy facts. A manual fact is a global inclusive
 * cutoff (all tracked dates through period_end); an automatic fact is one exact
 * organization week. Neither depends on the approvals module remaining enabled.
 */
export const timesheetLockPolicyMigration = [
  `ALTER TABLE organizations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'
    CHECK (length(trim(timezone)) BETWEEN 1 AND 255)`,
  `CREATE TABLE timesheet_lock_windows (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('manual_cutoff','weekly_deadline')),
    period_start TEXT,
    period_end TEXT NOT NULL,
    locked_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    locked_at TEXT NOT NULL,
    lock_reason TEXT NOT NULL CHECK (length(trim(lock_reason)) BETWEEN 1 AND 10000),
    command_id TEXT,
    input_fingerprint TEXT,
    week_start_day TEXT CHECK (week_start_day IN ('saturday','sunday','monday')),
    deadline_day TEXT CHECK (deadline_day IN (
      'sunday','monday','tuesday','wednesday','thursday','friday','saturday'
    )),
    deadline_time TEXT,
    timezone TEXT,
    unlocked_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    unlocked_at TEXT,
    unlock_reason TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (period_start IS NULL OR date(period_start) IS period_start),
    CHECK (date(period_end) IS period_end),
    CHECK (period_start IS NULL OR period_start <= period_end),
    CHECK (${canonicalTimestamp('locked_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (unlocked_at IS NULL OR (${canonicalTimestamp('unlocked_at')})),
    CHECK (deadline_time IS NULL OR (
      length(deadline_time) = 5 AND deadline_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(deadline_time, 1, 2) <= '23'
    )),
    CHECK ((command_id IS NULL AND input_fingerprint IS NULL) OR (
      length(command_id) BETWEEN 1 AND 128
      AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND length(input_fingerprint) = 71
      AND substr(input_fingerprint, 1, 7) = 'sha256:'
      AND substr(input_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    )),
    CHECK (
      (kind = 'manual_cutoff' AND period_start IS NULL
        AND locked_by_user_id IS NOT NULL AND command_id IS NOT NULL
        AND input_fingerprint IS NOT NULL AND week_start_day IS NULL
        AND deadline_day IS NULL AND deadline_time IS NULL AND timezone IS NULL)
      OR (kind = 'weekly_deadline' AND period_start IS NOT NULL
        AND period_end = date(period_start, '+6 days')
        AND locked_by_user_id IS NULL AND week_start_day IS NOT NULL
        AND command_id IS NULL AND input_fingerprint IS NULL
        AND deadline_day IS NOT NULL AND deadline_time IS NOT NULL
        AND timezone IS NOT NULL AND length(trim(timezone)) BETWEEN 1 AND 255)
    ),
    CHECK (
      (version = 0 AND unlocked_by_user_id IS NULL
        AND unlocked_at IS NULL AND unlock_reason IS NULL)
      OR (version = 1 AND unlocked_by_user_id IS NOT NULL
        AND unlocked_at IS NOT NULL AND unlock_reason IS NOT NULL
        AND length(trim(unlock_reason)) BETWEEN 1 AND 10000)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX timesheet_lock_windows_weekly_fact
    ON timesheet_lock_windows(period_start, period_end)
    WHERE kind = 'weekly_deadline'`,
  `CREATE UNIQUE INDEX timesheet_lock_windows_manual_command
    ON timesheet_lock_windows(command_id) WHERE command_id IS NOT NULL`,
  `CREATE INDEX timesheet_lock_windows_active_dates
    ON timesheet_lock_windows(period_end, period_start)
    WHERE unlocked_at IS NULL`,
  `CREATE TRIGGER timesheet_lock_windows_insert_guard
    BEFORE INSERT ON timesheet_lock_windows
    BEGIN
      SELECT CASE
        WHEN NEW.kind = 'manual_cutoff' AND NOT (${privilegedActor('NEW.locked_by_user_id')})
          THEN RAISE(ABORT, 'timesheet lock actor is not an organization policy administrator')
        WHEN EXISTS (
          SELECT 1 FROM time_entries entry
          WHERE (entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
            AND entry.spent_date <= NEW.period_end
            AND (NEW.period_start IS NULL OR entry.spent_date >= NEW.period_start)
        ) THEN RAISE(ABORT, 'running time entries must be stopped before locking the period')
      END;
    END`,
  `CREATE TRIGGER timesheet_lock_windows_update_guard
    BEFORE UPDATE ON timesheet_lock_windows
    BEGIN
      SELECT CASE
        WHEN OLD.id <> NEW.id OR OLD.kind <> NEW.kind
          OR OLD.period_start IS NOT NEW.period_start OR OLD.period_end <> NEW.period_end
          OR OLD.locked_by_user_id IS NOT NEW.locked_by_user_id
          OR OLD.locked_at <> NEW.locked_at OR OLD.lock_reason <> NEW.lock_reason
          OR OLD.command_id IS NOT NEW.command_id
          OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
          OR OLD.week_start_day IS NOT NEW.week_start_day
          OR OLD.deadline_day IS NOT NEW.deadline_day
          OR OLD.deadline_time IS NOT NEW.deadline_time
          OR OLD.timezone IS NOT NEW.timezone OR OLD.created_at <> NEW.created_at
          THEN RAISE(ABORT, 'timesheet lock fact is immutable')
        WHEN OLD.version <> 0 OR NEW.version <> 1
          OR OLD.unlocked_by_user_id IS NOT NULL OR OLD.unlocked_at IS NOT NULL
          OR OLD.unlock_reason IS NOT NULL OR NEW.unlocked_by_user_id IS NULL
          OR NEW.unlocked_at IS NULL OR NEW.unlock_reason IS NULL
          THEN RAISE(ABORT, 'timesheet lock can only be unlocked once')
        WHEN NOT (${privilegedActor('NEW.unlocked_by_user_id')})
          THEN RAISE(ABORT, 'timesheet unlock actor is not an organization policy administrator')
      END;
    END`,
  `CREATE TRIGGER timesheet_lock_windows_delete_guard
    BEFORE DELETE ON timesheet_lock_windows
    BEGIN SELECT RAISE(ABORT, 'timesheet lock facts are append-only'); END`,

  `CREATE TRIGGER time_entries_policy_lock_insert_guard
    BEFORE INSERT ON time_entries
    WHEN ${activeLockFor('NEW.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'time entry date is locked by timesheet policy'); END`,
  `CREATE TRIGGER time_entries_policy_lock_update_guard
    BEFORE UPDATE OF user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, timer_started_at,
      started_time, ended_time, notes, billable, budgeted, billable_rate_cents,
      cost_rate_cents, external_ref, calendar_event_ref ON time_entries
    WHEN ${activeLockFor('OLD.spent_date')} OR ${activeLockFor('NEW.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'time entry date is locked by timesheet policy'); END`,
  `CREATE TRIGGER time_entries_policy_lock_delete_guard
    BEFORE DELETE ON time_entries
    WHEN ${activeLockFor('OLD.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'time entry date is locked by timesheet policy'); END`,
  `CREATE TRIGGER expenses_policy_lock_insert_guard
    BEFORE INSERT ON expenses
    WHEN ${activeLockFor('NEW.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'expense date is locked by timesheet policy'); END`,
  `CREATE TRIGGER expenses_policy_lock_update_guard
    BEFORE UPDATE OF user_id, project_id, expense_category_id, spent_date, notes,
      units, total_cost_cents, billable, reimbursable ON expenses
    WHEN ${activeLockFor('OLD.spent_date')} OR ${activeLockFor('NEW.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'expense date is locked by timesheet policy'); END`,
  `CREATE TRIGGER expenses_policy_lock_delete_guard
    BEFORE DELETE ON expenses
    WHEN ${activeLockFor('OLD.spent_date')}
    BEGIN SELECT RAISE(ABORT, 'expense date is locked by timesheet policy'); END`,

  `CREATE TRIGGER timesheet_lock_windows_event_insert
    AFTER INSERT ON timesheet_lock_windows
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT event.id, 'timesheet_lock', NEW.id, 1, 'timesheet.locked',
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', 'timesheet.locked', 'occurred_at', NEW.locked_at,
          'aggregate', json_object('type', 'timesheet_lock', 'id', NEW.id, 'sequence', 1),
          'actor', json_object(
            'type', CASE WHEN NEW.locked_by_user_id IS NULL THEN 'system' ELSE 'user' END,
            'id', NEW.locked_by_user_id
          ),
          'timesheet_lock', json_object(
            'kind', NEW.kind, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'reason', NEW.lock_reason,
            'week_start_day', NEW.week_start_day, 'deadline_day', NEW.deadline_day,
            'deadline_time', NEW.deadline_time, 'timezone', NEW.timezone
          )
        ), NEW.locked_at, NEW.locked_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`,
  `CREATE TRIGGER timesheet_lock_windows_event_unlock
    AFTER UPDATE OF unlocked_at ON timesheet_lock_windows
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT event.id, 'timesheet_lock', NEW.id, 2, 'timesheet.unlocked',
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', 'timesheet.unlocked', 'occurred_at', NEW.unlocked_at,
          'aggregate', json_object('type', 'timesheet_lock', 'id', NEW.id, 'sequence', 2),
          'actor', json_object('type', 'user', 'id', NEW.unlocked_by_user_id),
          'timesheet_lock', json_object(
            'kind', NEW.kind, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'reason', NEW.unlock_reason
          )
        ), NEW.unlocked_at, NEW.unlocked_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`,
  `CREATE TRIGGER event_outbox_timesheet_lock_insert_guard
    BEFORE INSERT ON event_outbox
    WHEN NEW.aggregate_type = 'timesheet_lock'
    BEGIN
      SELECT CASE WHEN NEW.command_id IS NOT NULL OR NEW.event_index IS NOT NULL
        OR NEW.event_type NOT IN ('timesheet.locked','timesheet.unlocked')
        OR NEW.available_at IS NOT NEW.occurred_at
        OR NOT EXISTS (
          SELECT 1 FROM timesheet_lock_windows lock
          WHERE lock.id = NEW.aggregate_id
            AND json_extract(NEW.payload_json, '$.schema_version') = 1
            AND json_extract(NEW.payload_json, '$.event_id') = NEW.id
            AND json_extract(NEW.payload_json, '$.event_type') = NEW.event_type
            AND json_extract(NEW.payload_json, '$.occurred_at') = NEW.occurred_at
            AND json_extract(NEW.payload_json, '$.aggregate.type') = NEW.aggregate_type
            AND json_extract(NEW.payload_json, '$.aggregate.id') = NEW.aggregate_id
            AND json_extract(NEW.payload_json, '$.aggregate.sequence') = NEW.aggregate_sequence
            AND ((NEW.event_type = 'timesheet.locked' AND NEW.aggregate_sequence = 1
              AND NEW.occurred_at = lock.locked_at
              AND json_extract(NEW.payload_json, '$.actor.type') = CASE
                WHEN lock.locked_by_user_id IS NULL THEN 'system' ELSE 'user' END
              AND json_extract(NEW.payload_json, '$.actor.id') IS lock.locked_by_user_id
              AND json_extract(NEW.payload_json, '$.timesheet_lock.kind') = lock.kind
              AND json_extract(NEW.payload_json, '$.timesheet_lock.period_start')
                IS lock.period_start
              AND json_extract(NEW.payload_json, '$.timesheet_lock.period_end') = lock.period_end
              AND json_extract(NEW.payload_json, '$.timesheet_lock.reason') = lock.lock_reason)
              OR (NEW.event_type = 'timesheet.unlocked' AND NEW.aggregate_sequence = 2
                AND NEW.occurred_at = lock.unlocked_at
                AND json_extract(NEW.payload_json, '$.actor.type') = 'user'
                AND json_extract(NEW.payload_json, '$.actor.id') = lock.unlocked_by_user_id
                AND json_extract(NEW.payload_json, '$.timesheet_lock.kind') = lock.kind
                AND json_extract(NEW.payload_json, '$.timesheet_lock.period_start')
                  IS lock.period_start
                AND json_extract(NEW.payload_json, '$.timesheet_lock.period_end') = lock.period_end
                AND json_extract(NEW.payload_json, '$.timesheet_lock.reason')
                  = lock.unlock_reason))
        ) THEN RAISE(ABORT, 'timesheet lock outbox event does not match its fact') END;
    END`,
  `CREATE TRIGGER event_outbox_timesheet_lock_delete_guard
    BEFORE DELETE ON event_outbox
    WHEN OLD.aggregate_type = 'timesheet_lock'
    BEGIN SELECT RAISE(ABORT, 'timesheet lock events are immutable'); END`,

  `DROP TRIGGER time_entries_source_approval_insert_guard`,
  `CREATE TRIGGER time_entries_source_approval_insert_guard
    BEFORE INSERT ON time_entries
    WHEN (NEW.harvest_id IS NULL) <> (NEW.source_approval_status IS NULL)
      OR (NEW.source_approval_status IS NOT NULL AND (
        NEW.approval_status <> 'unsubmitted' OR NEW.timesheet_submission_id IS NOT NULL
      ))
      OR (${approvalModuleEnabled}
        AND NEW.source_approval_status IN ('submitted','approved')
        AND (NEW.timer_started_at IS NOT NULL
          OR (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL)))
      OR (${approvalModuleEnabled} AND NEW.source_approval_status IS NOT NULL
        AND NOT (${withdrawnImportedOverride}) AND (
        EXISTS (
          SELECT 1 FROM time_entries peer
          WHERE peer.user_id = NEW.user_id
            AND ${harvestWeekStart('peer')} = ${harvestWeekStart('NEW')}
            AND coalesce(peer.source_approval_status, peer.approval_status)
              IS NOT NEW.source_approval_status
        ) OR EXISTS (
          SELECT 1 FROM expenses peer
          WHERE peer.user_id = NEW.user_id
            AND ${harvestWeekStart('peer')} = ${harvestWeekStart('NEW')}
            AND coalesce(peer.source_approval_status, peer.approval_status)
              IS NOT NEW.source_approval_status
        )
      ))
    BEGIN SELECT RAISE(ABORT, 'Harvest approval source state is inconsistent'); END`,
  `DROP TRIGGER expenses_source_approval_insert_guard`,
  `CREATE TRIGGER expenses_source_approval_insert_guard
    BEFORE INSERT ON expenses
    WHEN (NEW.harvest_id IS NULL) <> (NEW.source_approval_status IS NULL)
      OR (NEW.source_approval_status IS NOT NULL AND (
        NEW.approval_status <> 'unsubmitted' OR NEW.timesheet_submission_id IS NOT NULL
      ))
      OR (${approvalModuleEnabled} AND NEW.source_approval_status IS NOT NULL
        AND NOT (${withdrawnImportedOverride}) AND (
        EXISTS (
          SELECT 1 FROM time_entries peer
          WHERE peer.user_id = NEW.user_id
            AND ${harvestWeekStart('peer')} = ${harvestWeekStart('NEW')}
            AND coalesce(peer.source_approval_status, peer.approval_status)
              IS NOT NEW.source_approval_status
        ) OR EXISTS (
          SELECT 1 FROM expenses peer
          WHERE peer.user_id = NEW.user_id
            AND ${harvestWeekStart('peer')} = ${harvestWeekStart('NEW')}
            AND coalesce(peer.source_approval_status, peer.approval_status)
              IS NOT NEW.source_approval_status
        )
      ))
    BEGIN SELECT RAISE(ABORT, 'Harvest expense approval source state is inconsistent'); END`,
  `DROP TRIGGER time_entries_source_approval_normalize_insert`,
  `CREATE TRIGGER time_entries_source_approval_normalize_insert
    AFTER INSERT ON time_entries
    WHEN ${approvalModuleEnabled}
      AND NEW.source_approval_status IN ('submitted','approved')
    BEGIN
      INSERT INTO timesheet_submissions (
        user_id, period_start, period_end, status, origin, source_status,
        source_observed_at, submitted_by_user_id, submitted_at,
        reviewed_by_user_id, reviewed_at, rejection_reason, version, created_at, updated_at
      ) SELECT
        NEW.user_id, ${harvestWeekStart('NEW')},
        date(${harvestWeekStart('NEW')}, '+6 days'), NEW.source_approval_status,
        'harvest_import', NEW.source_approval_status, NEW.updated_at,
        NULL, NULL, NULL, NULL, NULL, 0, NEW.updated_at, NEW.updated_at
      WHERE NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.user_id = NEW.user_id
          AND submission.period_start = ${harvestWeekStart('NEW')}
          AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
      ) ON CONFLICT(user_id, period_start, period_end) DO NOTHING;
      UPDATE time_entries
      SET approval_status = coalesce((
          SELECT submission.status FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        ), 'unsubmitted'),
        timesheet_submission_id = (
          SELECT submission.id FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        )
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN ${harvestWeekStart('NEW')}
          AND date(${harvestWeekStart('NEW')}, '+6 days')
        AND source_approval_status = NEW.source_approval_status
        AND approval_status = 'unsubmitted';
      UPDATE expenses
      SET approval_status = coalesce((
          SELECT submission.status FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        ), 'unsubmitted'),
        timesheet_submission_id = (
          SELECT submission.id FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        )
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN ${harvestWeekStart('NEW')}
          AND date(${harvestWeekStart('NEW')}, '+6 days')
        AND source_approval_status = NEW.source_approval_status
        AND approval_status = 'unsubmitted';
    END`,
  `DROP TRIGGER expenses_source_approval_normalize_insert`,
  `CREATE TRIGGER expenses_source_approval_normalize_insert
    AFTER INSERT ON expenses
    WHEN ${approvalModuleEnabled}
      AND NEW.source_approval_status IN ('submitted','approved')
    BEGIN
      INSERT INTO timesheet_submissions (
        user_id, period_start, period_end, status, origin, source_status,
        source_observed_at, submitted_by_user_id, submitted_at,
        reviewed_by_user_id, reviewed_at, rejection_reason, version, created_at, updated_at
      ) SELECT
        NEW.user_id, ${harvestWeekStart('NEW')},
        date(${harvestWeekStart('NEW')}, '+6 days'), NEW.source_approval_status,
        'harvest_import', NEW.source_approval_status, NEW.updated_at,
        NULL, NULL, NULL, NULL, NULL, 0, NEW.updated_at, NEW.updated_at
      WHERE NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.user_id = NEW.user_id
          AND submission.period_start = ${harvestWeekStart('NEW')}
          AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
      ) ON CONFLICT(user_id, period_start, period_end) DO NOTHING;
      UPDATE expenses
      SET approval_status = coalesce((
          SELECT submission.status FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        ), 'unsubmitted'),
        timesheet_submission_id = (
          SELECT submission.id FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        )
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN ${harvestWeekStart('NEW')}
          AND date(${harvestWeekStart('NEW')}, '+6 days')
        AND source_approval_status = NEW.source_approval_status
        AND approval_status = 'unsubmitted';
      UPDATE time_entries
      SET approval_status = coalesce((
          SELECT submission.status FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        ), 'unsubmitted'),
        timesheet_submission_id = (
          SELECT submission.id FROM timesheet_submissions submission
          WHERE submission.user_id = NEW.user_id
            AND submission.period_start = ${harvestWeekStart('NEW')}
            AND submission.period_end = date(${harvestWeekStart('NEW')}, '+6 days')
            AND submission.source_status = NEW.source_approval_status
        )
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN ${harvestWeekStart('NEW')}
          AND date(${harvestWeekStart('NEW')}, '+6 days')
        AND source_approval_status = NEW.source_approval_status
        AND approval_status = 'unsubmitted';
    END`,

  `DROP TRIGGER timesheet_submissions_update_guard`,
  `CREATE TRIGGER timesheet_submissions_update_guard
    BEFORE UPDATE ON timesheet_submissions
    BEGIN
      SELECT CASE
        WHEN COALESCE((SELECT json_extract(modules, '$.approval') FROM organizations WHERE id = 1), 0) <> 1
          THEN RAISE(ABORT, 'timesheet approval module is disabled')
        WHEN OLD.id <> NEW.id OR OLD.user_id <> NEW.user_id
          OR OLD.period_start <> NEW.period_start OR OLD.period_end <> NEW.period_end
          OR OLD.origin <> NEW.origin OR OLD.source_status IS NOT NEW.source_status
          OR OLD.source_observed_at IS NOT NEW.source_observed_at
          OR (OLD.submitted_by_user_id IS NOT NEW.submitted_by_user_id AND NOT (
            OLD.status = 'unsubmitted' AND NEW.status = 'submitted'
            AND OLD.submitted_by_user_id IS NULL AND NEW.submitted_by_user_id = NEW.user_id
          )) OR OLD.created_at <> NEW.created_at
          THEN RAISE(ABORT, 'timesheet submission identity is immutable')
        WHEN NEW.version <> OLD.version + 1
          THEN RAISE(ABORT, 'timesheet submission version must advance once')
        WHEN NOT ((OLD.status = 'unsubmitted' AND NEW.status = 'submitted')
          OR (OLD.status = 'submitted' AND NEW.status IN ('unsubmitted','approved'))
          OR (OLD.status = 'approved' AND NEW.status = 'unsubmitted'))
          THEN RAISE(ABORT, 'invalid timesheet submission transition')
        WHEN OLD.status = 'approved' AND NEW.status = 'unsubmitted' AND NOT (
          ${privilegedActor('NEW.reviewed_by_user_id')}
        ) THEN RAISE(ABORT, 'timesheet withdrawal actor is not an organization policy administrator')
        WHEN OLD.status = 'unsubmitted' AND NEW.status = 'submitted' AND EXISTS (
          SELECT 1 FROM time_entries entry WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND (entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
        ) THEN RAISE(ABORT, 'running time entries cannot be submitted')
        WHEN OLD.status = 'unsubmitted' AND NEW.status = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM time_entries entry WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND entry.approval_status = 'unsubmitted')
          AND NOT EXISTS (SELECT 1 FROM expenses expense WHERE expense.user_id = NEW.user_id
            AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND expense.approval_status = 'unsubmitted')
          THEN RAISE(ABORT, 'timesheet period has no unsubmitted entries')
        WHEN OLD.status = 'submitted' AND NEW.status = 'approved' AND (
          (NOT EXISTS (SELECT 1 FROM time_entries entry
            WHERE entry.timesheet_submission_id = NEW.id AND entry.approval_status = 'submitted')
           AND NOT EXISTS (SELECT 1 FROM expenses expense
            WHERE expense.timesheet_submission_id = NEW.id AND expense.approval_status = 'submitted'))
          OR EXISTS (SELECT 1 FROM time_entries entry WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND (entry.timesheet_submission_id IS NOT NEW.id
              OR entry.approval_status <> 'submitted' OR entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL)))
          OR EXISTS (SELECT 1 FROM expenses expense WHERE expense.user_id = NEW.user_id
            AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND (expense.timesheet_submission_id IS NOT NEW.id
              OR expense.approval_status <> 'submitted'))
        ) THEN RAISE(ABORT, 'timesheet period changed before approval')
      END;
    END`,
  `DROP TRIGGER timesheet_submissions_reject_entries`,
  `CREATE TRIGGER timesheet_submissions_reject_entries
    AFTER UPDATE OF status ON timesheet_submissions
    WHEN OLD.status IN ('submitted','approved') AND NEW.status = 'unsubmitted'
    BEGIN
      UPDATE time_entries SET approval_status = 'unsubmitted', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id
        AND approval_status = CASE OLD.status WHEN 'approved' THEN 'approved' ELSE 'submitted' END;
      UPDATE expenses SET approval_status = 'unsubmitted', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id
        AND approval_status = CASE OLD.status WHEN 'approved' THEN 'approved' ELSE 'submitted' END;
    END`,
  `DROP TRIGGER timesheet_submissions_event_update`,
  `CREATE TRIGGER timesheet_submissions_event_update
    AFTER UPDATE OF status ON timesheet_submissions
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT event.id, 'timesheet_submission', NEW.id, NEW.version + 1,
        CASE WHEN OLD.status = 'approved' AND NEW.status = 'unsubmitted'
          THEN 'timesheet.withdrawn' WHEN NEW.status = 'submitted' THEN 'timesheet.submitted'
          WHEN NEW.status = 'approved' THEN 'timesheet.approved' ELSE 'timesheet.rejected' END,
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', CASE WHEN OLD.status = 'approved' AND NEW.status = 'unsubmitted'
            THEN 'timesheet.withdrawn' WHEN NEW.status = 'submitted' THEN 'timesheet.submitted'
            WHEN NEW.status = 'approved' THEN 'timesheet.approved' ELSE 'timesheet.rejected' END,
          'occurred_at', NEW.updated_at,
          'aggregate', json_object('type', 'timesheet_submission', 'id', NEW.id,
            'sequence', NEW.version + 1),
          'actor', json_object('type', 'user', 'id', CASE WHEN NEW.status = 'submitted'
            THEN NEW.submitted_by_user_id ELSE NEW.reviewed_by_user_id END),
          'timesheet_submission', json_object(
            'user_id', NEW.user_id, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'before_status', OLD.status,
            'after_status', NEW.status, 'rejection_reason', NEW.rejection_reason
          )
        ), NEW.updated_at, NEW.updated_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`,
  `DROP TRIGGER event_outbox_timesheet_submission_insert_guard`,
  `CREATE TRIGGER event_outbox_timesheet_submission_insert_guard
    BEFORE INSERT ON event_outbox
    WHEN NEW.aggregate_type = 'timesheet_submission'
    BEGIN
      SELECT CASE WHEN NEW.command_id IS NOT NULL OR NEW.event_index IS NOT NULL
        OR NEW.event_type NOT IN ('timesheet.status_imported','timesheet.submitted',
          'timesheet.approved','timesheet.rejected','timesheet.withdrawn')
        OR NEW.available_at IS NOT NEW.occurred_at
        OR NOT EXISTS (
          SELECT 1 FROM timesheet_submissions submission
          WHERE submission.id = NEW.aggregate_id
            AND json_extract(NEW.payload_json, '$.schema_version') = 1
            AND json_extract(NEW.payload_json, '$.event_id') = NEW.id
            AND json_extract(NEW.payload_json, '$.event_type') = NEW.event_type
            AND json_extract(NEW.payload_json, '$.occurred_at') = NEW.occurred_at
            AND json_extract(NEW.payload_json, '$.aggregate.type') = NEW.aggregate_type
            AND json_extract(NEW.payload_json, '$.aggregate.id') = NEW.aggregate_id
            AND json_extract(NEW.payload_json, '$.aggregate.sequence') = NEW.aggregate_sequence
            AND json_extract(NEW.payload_json, '$.timesheet_submission.user_id') = submission.user_id
            AND json_extract(NEW.payload_json, '$.timesheet_submission.period_start') = submission.period_start
            AND json_extract(NEW.payload_json, '$.timesheet_submission.period_end') = submission.period_end
            AND json_extract(NEW.payload_json, '$.timesheet_submission.after_status') = submission.status
            AND json_extract(NEW.payload_json, '$.timesheet_submission.rejection_reason')
              IS submission.rejection_reason
            AND ((NEW.event_type = 'timesheet.status_imported'
              AND submission.origin <> 'native' AND NEW.aggregate_sequence = 1
              AND NEW.occurred_at = submission.source_observed_at
              AND json_extract(NEW.payload_json, '$.actor.type') = 'system'
              AND json_type(NEW.payload_json, '$.actor.id') IS NULL
              AND json_extract(NEW.payload_json, '$.timesheet_submission.origin')
                = submission.origin
              AND json_extract(NEW.payload_json, '$.timesheet_submission.source_status')
                = submission.source_status)
              OR (NEW.event_type <> 'timesheet.status_imported'
                AND submission.version + 1 = NEW.aggregate_sequence
                AND submission.updated_at = NEW.occurred_at
                AND NEW.event_type = CASE
                  WHEN json_extract(NEW.payload_json, '$.timesheet_submission.before_status') = 'approved'
                    AND submission.status = 'unsubmitted' THEN 'timesheet.withdrawn'
                  WHEN submission.status = 'submitted' THEN 'timesheet.submitted'
                  WHEN submission.status = 'approved' THEN 'timesheet.approved'
                  ELSE 'timesheet.rejected' END
                AND json_extract(NEW.payload_json, '$.actor.type') = 'user'
                AND json_extract(NEW.payload_json, '$.actor.id') = CASE submission.status
                  WHEN 'submitted' THEN submission.submitted_by_user_id
                  ELSE submission.reviewed_by_user_id END))
        ) THEN RAISE(ABORT, 'timesheet outbox event does not match its submission') END;
    END`,
  `DROP TRIGGER IF EXISTS instance_bootstrap_exact_state`,
  lockPolicyCompatibleInstanceBootstrapExactStateTrigger,
] as const
import { approvalCompatibleInstanceBootstrapExactStateTrigger } from './0012_instance_bootstrap.js'
