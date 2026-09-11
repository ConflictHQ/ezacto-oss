import { approvalCompatibleInstanceBootstrapExactStateTrigger } from './0012_instance_bootstrap.js'

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

const approvalModuleEnabled = `COALESCE(
      (SELECT json_extract(modules, '$.approval') FROM organizations WHERE id = 1),
      0
    ) = 1`

const harvestWeekStart = (entry = 'entry') => `date(${entry}.spent_date, '-' || (
  (CAST(strftime('%w', ${entry}.spent_date) AS INTEGER) - CASE (
    SELECT week_start_day FROM organizations WHERE id = 1
  ) WHEN 'sunday' THEN 0 WHEN 'monday' THEN 1 ELSE 6 END + 7) % 7
) || ' days')`

/**
 * 0027 cannot truthfully aggregate partial or contradictory Harvest weeks. This
 * preflight runs against 0026 before any DDL so either the whole upgrade lands or
 * the operator gets the exact offending entry without fabricated approval facts.
 */
export const timesheetApprovalsPreflight = `WITH approval_items AS (
  SELECT 'time_entry' AS resource_kind, id, user_id, spent_date, approval_status, harvest_id, timer_started_at,
    started_time, ended_time
  FROM time_entries
  UNION ALL
  SELECT 'expense', id, user_id, spent_date, approval_status, harvest_id, NULL, NULL, NULL
  FROM expenses
), violations AS (
  SELECT entry.resource_kind, entry.id, 1 AS priority, 'non_harvest_status' AS code
  FROM approval_items entry
  WHERE ${approvalModuleEnabled}
    AND entry.harvest_id IS NULL AND entry.approval_status <> 'unsubmitted'
  UNION ALL
  SELECT entry.resource_kind, entry.id, 2, 'running_source_status'
  FROM approval_items entry
  WHERE ${approvalModuleEnabled}
    AND entry.harvest_id IS NOT NULL AND entry.approval_status <> 'unsubmitted'
    AND (entry.timer_started_at IS NOT NULL
      OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
  UNION ALL
  SELECT entry.resource_kind, entry.id, 3, 'mixed_source_week'
  FROM approval_items entry
  WHERE ${approvalModuleEnabled} AND entry.harvest_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM approval_items peer
      WHERE peer.user_id = entry.user_id
        AND ${harvestWeekStart('peer')} = ${harvestWeekStart('entry')}
        AND peer.approval_status <> entry.approval_status
    )
), selected AS (
  SELECT code FROM violations ORDER BY priority, resource_kind, id LIMIT 1
)
SELECT resource_kind, id, code FROM violations
WHERE code = (SELECT code FROM selected)
ORDER BY resource_kind, id LIMIT 11`

export const timesheetSubmissionsTable = `CREATE TABLE timesheet_submissions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('unsubmitted','submitted','approved')),
    origin TEXT NOT NULL DEFAULT 'native'
      CHECK (origin IN ('native','harvest_import','legacy_backfill')),
    source_status TEXT CHECK (source_status IN ('submitted','approved')),
    source_observed_at TEXT,
    submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    submitted_at TEXT,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at TEXT,
    rejection_reason TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (date(period_start) IS period_start),
    CHECK (date(period_end) IS period_end),
    CHECK (period_end >= period_start),
    CHECK (julianday(period_end) - julianday(period_start) BETWEEN 0 AND 30),
    CHECK (submitted_by_user_id IS NULL OR submitted_by_user_id = user_id),
    CHECK (submitted_at IS NULL OR (${canonicalTimestamp('submitted_at')})),
    CHECK (source_observed_at IS NULL OR (${canonicalTimestamp('source_observed_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (reviewed_at IS NULL OR (${canonicalTimestamp('reviewed_at')})),
    CHECK (
      (status = 'submitted' AND reviewed_by_user_id IS NULL
        AND reviewed_at IS NULL AND rejection_reason IS NULL
        AND ((submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)
          OR (origin <> 'native' AND version = 0 AND source_status = 'submitted'
            AND submitted_by_user_id IS NULL AND submitted_at IS NULL)))
      OR (status = 'approved' AND rejection_reason IS NULL AND (
        (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
          AND ((submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)
            OR (origin <> 'native' AND source_status = 'submitted'
              AND submitted_by_user_id IS NULL AND submitted_at IS NULL)))
        OR (origin <> 'native' AND version = 0 AND source_status = 'approved'
          AND submitted_by_user_id IS NULL AND submitted_at IS NULL
          AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
      ))
      OR (status = 'unsubmitted' AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL
        AND length(trim(rejection_reason)) BETWEEN 1 AND 10000)
    ),
    CHECK (
      (origin = 'native' AND source_status IS NULL AND source_observed_at IS NULL)
      OR (origin <> 'native' AND source_status IS NOT NULL
        AND source_observed_at IS NOT NULL)
    )
  ) STRICT`

export const timesheetSubmissionsUserPeriodUniqueIndex = `CREATE UNIQUE INDEX timesheet_submissions_user_period_unique
    ON timesheet_submissions(user_id, period_start, period_end)`

export const timesheetSubmissionsQueueIndex = `CREATE INDEX timesheet_submissions_queue
    ON timesheet_submissions(status, coalesce(submitted_at, source_observed_at), id)`

export const timesheetSubmissionsInsertGuard = `CREATE TRIGGER timesheet_submissions_insert_guard
    BEFORE INSERT ON timesheet_submissions
    BEGIN
      SELECT CASE
        WHEN NOT (${approvalModuleEnabled})
          THEN RAISE(ABORT, 'timesheet approval module is disabled')
        WHEN NEW.origin = 'legacy_backfill'
          THEN RAISE(ABORT, 'legacy timesheet backfill is migration-only')
        WHEN NEW.origin = 'native' AND (
          NEW.status <> 'submitted' OR NEW.version <> 0
          OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
          OR NEW.rejection_reason IS NOT NULL OR NEW.submitted_by_user_id IS NULL
          OR NEW.submitted_at IS NULL
        )
          THEN RAISE(ABORT, 'timesheet submission must start submitted')
        WHEN NEW.origin = 'harvest_import' AND (
          NEW.status IS NOT NEW.source_status OR NEW.version <> 0
          OR NEW.source_status NOT IN ('submitted','approved')
          OR NEW.source_observed_at IS NULL OR NEW.submitted_by_user_id IS NOT NULL
          OR NEW.submitted_at IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL
          OR NEW.reviewed_at IS NOT NULL OR NEW.rejection_reason IS NOT NULL
          OR NEW.period_end <> date(NEW.period_start, '+6 days')
          OR NOT EXISTS (
            SELECT 1 FROM time_entries entry
            WHERE entry.user_id = NEW.user_id
              AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND entry.harvest_id IS NOT NULL
              AND entry.source_approval_status = NEW.source_status
              AND entry.approval_status = 'unsubmitted'
          ) AND NOT EXISTS (
            SELECT 1 FROM expenses expense
            WHERE expense.user_id = NEW.user_id
              AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND expense.harvest_id IS NOT NULL
              AND expense.source_approval_status = NEW.source_status
              AND expense.approval_status = 'unsubmitted'
          ) OR EXISTS (
            SELECT 1 FROM time_entries entry
            WHERE entry.user_id = NEW.user_id
              AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND entry.source_approval_status IS NOT NEW.source_status
          ) OR EXISTS (
            SELECT 1 FROM expenses expense
            WHERE expense.user_id = NEW.user_id
              AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND expense.source_approval_status IS NOT NEW.source_status
          )
        ) THEN RAISE(ABORT, 'Harvest timesheet source period is inconsistent')
        WHEN EXISTS (
          SELECT 1 FROM timesheet_submissions existing
          WHERE existing.user_id = NEW.user_id
            AND existing.period_start <= NEW.period_end
            AND existing.period_end >= NEW.period_start
            AND NOT (existing.period_start = NEW.period_start
              AND existing.period_end = NEW.period_end)
        ) THEN RAISE(ABORT, 'timesheet submission period overlaps an existing period')
        WHEN EXISTS (
          SELECT 1 FROM time_entries entry
          WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND (entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
        ) THEN RAISE(ABORT, 'running time entries cannot be submitted')
        WHEN NOT EXISTS (
          SELECT 1 FROM time_entries entry
          WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND entry.approval_status = 'unsubmitted'
        ) AND NOT EXISTS (
          SELECT 1 FROM expenses expense
          WHERE expense.user_id = NEW.user_id
            AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND expense.approval_status = 'unsubmitted'
        ) THEN RAISE(ABORT, 'timesheet period has no unsubmitted entries')
      END;
    END`

export const timesheetSubmissionsRejectDelete = `CREATE TRIGGER timesheet_submissions_reject_delete
    BEFORE DELETE ON timesheet_submissions
    BEGIN SELECT RAISE(ABORT, 'timesheet submissions are durable workflow records'); END`

export const timesheetSubmissionsSubmitEntriesInsert = `CREATE TRIGGER timesheet_submissions_submit_entries_insert
    AFTER INSERT ON timesheet_submissions
    WHEN NEW.origin = 'native'
    BEGIN
      UPDATE time_entries
      SET approval_status = 'submitted', timesheet_submission_id = NEW.id,
        updated_at = NEW.updated_at
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN NEW.period_start AND NEW.period_end
        AND approval_status = 'unsubmitted';
      UPDATE expenses
      SET approval_status = 'submitted', timesheet_submission_id = NEW.id,
        updated_at = NEW.updated_at
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN NEW.period_start AND NEW.period_end
        AND approval_status = 'unsubmitted';
    END`

export const timesheetSubmissionsSubmitEntriesUpdate = `CREATE TRIGGER timesheet_submissions_submit_entries_update
    AFTER UPDATE OF status ON timesheet_submissions
    WHEN OLD.status = 'unsubmitted' AND NEW.status = 'submitted'
    BEGIN
      UPDATE time_entries
      SET approval_status = 'submitted', timesheet_submission_id = NEW.id,
        updated_at = NEW.updated_at
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN NEW.period_start AND NEW.period_end
        AND approval_status = 'unsubmitted';
      UPDATE expenses
      SET approval_status = 'submitted', timesheet_submission_id = NEW.id,
        updated_at = NEW.updated_at
      WHERE user_id = NEW.user_id
        AND spent_date BETWEEN NEW.period_start AND NEW.period_end
        AND approval_status = 'unsubmitted';
    END`

export const timesheetSubmissionsApproveEntries = `CREATE TRIGGER timesheet_submissions_approve_entries
    AFTER UPDATE OF status ON timesheet_submissions
    WHEN OLD.status = 'submitted' AND NEW.status = 'approved'
    BEGIN
      UPDATE time_entries
      SET approval_status = 'approved', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id AND approval_status = 'submitted';
      UPDATE expenses
      SET approval_status = 'approved', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id AND approval_status = 'submitted';
    END`

export const timesheetSubmissionsEventInsert = `CREATE TRIGGER timesheet_submissions_event_insert
    AFTER INSERT ON timesheet_submissions
    WHEN NEW.origin = 'native'
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT
        event.id, 'timesheet_submission', NEW.id, NEW.version + 1,
        'timesheet.submitted',
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', 'timesheet.submitted', 'occurred_at', NEW.updated_at,
          'aggregate', json_object(
            'type', 'timesheet_submission', 'id', NEW.id, 'sequence', NEW.version + 1
          ),
          'actor', json_object('type', 'user', 'id', NEW.submitted_by_user_id),
          'timesheet_submission', json_object(
            'user_id', NEW.user_id, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'before_status', NULL,
            'after_status', NEW.status, 'rejection_reason', NULL
          )
        ),
        NEW.updated_at, NEW.updated_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`

export const timesheetSubmissionsImportEventInsert = `CREATE TRIGGER timesheet_submissions_import_event_insert
    AFTER INSERT ON timesheet_submissions
    WHEN NEW.origin = 'harvest_import'
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT
        event.id, 'timesheet_submission', NEW.id, 1, 'timesheet.status_imported',
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', 'timesheet.status_imported', 'occurred_at', NEW.source_observed_at,
          'aggregate', json_object(
            'type', 'timesheet_submission', 'id', NEW.id, 'sequence', 1
          ),
          'actor', json_object('type', 'system'),
          'timesheet_submission', json_object(
            'user_id', NEW.user_id, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'before_status', NULL,
            'after_status', NEW.status, 'rejection_reason', NULL,
            'origin', NEW.origin, 'source_status', NEW.source_status
          )
        ), NEW.source_observed_at, NEW.source_observed_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`

/**
 * Person-period approval aggregate. Time and expense entries retain the public
 * three-axis status while this row preserves the batch identity and latest
 * review reason.
 */
export const timesheetApprovalsMigration = [
  `CREATE TABLE _ezacto_0027_timesheet_approvals_preflight_guard (
    value INTEGER NOT NULL CHECK (value = 0)
  ) STRICT`,
  `INSERT INTO _ezacto_0027_timesheet_approvals_preflight_guard (value)
   SELECT 1 FROM (${timesheetApprovalsPreflight}) LIMIT 1`,
  `DROP TABLE _ezacto_0027_timesheet_approvals_preflight_guard`,
  timesheetSubmissionsTable,
  timesheetSubmissionsUserPeriodUniqueIndex,
  timesheetSubmissionsQueueIndex,
  `ALTER TABLE time_entries ADD COLUMN timesheet_submission_id INTEGER
    REFERENCES timesheet_submissions(id) ON DELETE RESTRICT`,
  `ALTER TABLE time_entries ADD COLUMN source_approval_status TEXT
    CHECK (source_approval_status IS NULL
      OR source_approval_status IN ('unsubmitted','submitted','approved'))`,
  `ALTER TABLE expenses ADD COLUMN timesheet_submission_id INTEGER
    REFERENCES timesheet_submissions(id) ON DELETE RESTRICT`,
  `ALTER TABLE expenses ADD COLUMN source_approval_status TEXT
    CHECK (source_approval_status IS NULL
      OR source_approval_status IN ('unsubmitted','submitted','approved'))`,
  `UPDATE time_entries SET source_approval_status = approval_status
    WHERE harvest_id IS NOT NULL`,
  `UPDATE expenses SET source_approval_status = approval_status
    WHERE harvest_id IS NOT NULL`,
  `UPDATE time_entries SET approval_status = 'unsubmitted'
    WHERE NOT (${approvalModuleEnabled})`,
  `UPDATE expenses SET approval_status = 'unsubmitted'
    WHERE NOT (${approvalModuleEnabled})`,
  `INSERT INTO timesheet_submissions (
      user_id, period_start, period_end, status, origin, source_status,
      source_observed_at, submitted_by_user_id, submitted_at,
      reviewed_by_user_id, reviewed_at, rejection_reason, version, created_at, updated_at
    )
    WITH approval_items AS (
      SELECT user_id, spent_date, approval_status, updated_at FROM time_entries
      WHERE harvest_id IS NOT NULL
      UNION ALL
      SELECT user_id, spent_date, approval_status, updated_at FROM expenses
      WHERE harvest_id IS NOT NULL
    )
    SELECT entry.user_id, ${harvestWeekStart('entry')},
      date(${harvestWeekStart('entry')}, '+6 days'), entry.approval_status,
      'legacy_backfill', entry.approval_status, max(entry.updated_at),
      NULL, NULL, NULL, NULL, NULL, 0, max(entry.updated_at), max(entry.updated_at)
    FROM approval_items entry
    WHERE ${approvalModuleEnabled} AND entry.approval_status IN ('submitted','approved')
    GROUP BY entry.user_id, ${harvestWeekStart('entry')}, entry.approval_status`,
  `UPDATE time_entries AS entry
    SET timesheet_submission_id = (
      SELECT submission.id FROM timesheet_submissions submission
      WHERE submission.user_id = entry.user_id
        AND entry.spent_date BETWEEN submission.period_start AND submission.period_end
        AND submission.origin = 'legacy_backfill'
        AND submission.source_status = entry.source_approval_status
    )
    WHERE ${approvalModuleEnabled} AND entry.source_approval_status IN ('submitted','approved')`,
  `UPDATE expenses AS expense
    SET timesheet_submission_id = (
      SELECT submission.id FROM timesheet_submissions submission
      WHERE submission.user_id = expense.user_id
        AND expense.spent_date BETWEEN submission.period_start AND submission.period_end
        AND submission.origin = 'legacy_backfill'
        AND submission.source_status = expense.source_approval_status
    )
    WHERE ${approvalModuleEnabled} AND expense.source_approval_status IN ('submitted','approved')`,
  `WITH events AS MATERIALIZED (
      SELECT submission.*, lower(hex(randomblob(16))) AS event_id
      FROM timesheet_submissions submission WHERE submission.origin = 'legacy_backfill'
    )
    INSERT INTO event_outbox (
      id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
      payload_json, occurred_at, available_at, attempt_count
    ) SELECT
      event_id, 'timesheet_submission', id, 1, 'timesheet.status_imported',
      json_object(
        'schema_version', 1, 'event_id', event_id,
        'event_type', 'timesheet.status_imported', 'occurred_at', source_observed_at,
        'aggregate', json_object('type', 'timesheet_submission', 'id', id, 'sequence', 1),
        'actor', json_object('type', 'system'),
        'timesheet_submission', json_object(
          'user_id', user_id, 'period_start', period_start, 'period_end', period_end,
          'before_status', NULL, 'after_status', status, 'rejection_reason', NULL,
          'origin', origin, 'source_status', source_status
        )
      ), source_observed_at, source_observed_at, 0
    FROM events`,
  `CREATE INDEX time_entries_timesheet_submission_id
    ON time_entries(timesheet_submission_id) WHERE timesheet_submission_id IS NOT NULL`,
  `CREATE INDEX expenses_timesheet_submission_id
    ON expenses(timesheet_submission_id) WHERE timesheet_submission_id IS NOT NULL`,
  timesheetSubmissionsInsertGuard,
  `CREATE TRIGGER timesheet_submissions_update_guard
    BEFORE UPDATE ON timesheet_submissions
    BEGIN
      SELECT CASE
        WHEN NOT (${approvalModuleEnabled})
          THEN RAISE(ABORT, 'timesheet approval module is disabled')
        WHEN OLD.id <> NEW.id OR OLD.user_id <> NEW.user_id
          OR OLD.period_start <> NEW.period_start OR OLD.period_end <> NEW.period_end
          OR OLD.origin <> NEW.origin OR OLD.source_status IS NOT NEW.source_status
          OR OLD.source_observed_at IS NOT NEW.source_observed_at
          OR (OLD.submitted_by_user_id IS NOT NEW.submitted_by_user_id AND NOT (
            OLD.status = 'unsubmitted' AND NEW.status = 'submitted'
            AND OLD.submitted_by_user_id IS NULL AND NEW.submitted_by_user_id = NEW.user_id
          ))
          OR OLD.created_at <> NEW.created_at
          THEN RAISE(ABORT, 'timesheet submission identity is immutable')
        WHEN NEW.version <> OLD.version + 1
          THEN RAISE(ABORT, 'timesheet submission version must advance once')
        WHEN NOT (
          (OLD.status = 'unsubmitted' AND NEW.status = 'submitted')
          OR (OLD.status = 'submitted' AND NEW.status IN ('unsubmitted','approved'))
        ) THEN RAISE(ABORT, 'invalid timesheet submission transition')
        WHEN OLD.status = 'unsubmitted' AND NEW.status = 'submitted' AND EXISTS (
          SELECT 1 FROM time_entries entry
          WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND (entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
        ) THEN RAISE(ABORT, 'running time entries cannot be submitted')
        WHEN OLD.status = 'unsubmitted' AND NEW.status = 'submitted' AND NOT EXISTS (
          SELECT 1 FROM time_entries entry
          WHERE entry.user_id = NEW.user_id
            AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND entry.approval_status = 'unsubmitted'
        ) AND NOT EXISTS (
          SELECT 1 FROM expenses expense
          WHERE expense.user_id = NEW.user_id
            AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
            AND expense.approval_status = 'unsubmitted'
        ) THEN RAISE(ABORT, 'timesheet period has no unsubmitted entries')
        WHEN OLD.status = 'submitted' AND NEW.status = 'approved' AND (
          (NOT EXISTS (
            SELECT 1 FROM time_entries entry
            WHERE entry.timesheet_submission_id = NEW.id
              AND entry.approval_status = 'submitted'
          ) AND NOT EXISTS (
            SELECT 1 FROM expenses expense
            WHERE expense.timesheet_submission_id = NEW.id
              AND expense.approval_status = 'submitted'
          ))
          OR EXISTS (
            SELECT 1 FROM time_entries entry
            WHERE entry.user_id = NEW.user_id
              AND entry.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND (entry.timesheet_submission_id IS NOT NEW.id
                OR entry.approval_status <> 'submitted'
                OR entry.timer_started_at IS NOT NULL
                OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL))
          )
          OR EXISTS (
            SELECT 1 FROM expenses expense
            WHERE expense.user_id = NEW.user_id
              AND expense.spent_date BETWEEN NEW.period_start AND NEW.period_end
              AND (expense.timesheet_submission_id IS NOT NEW.id
                OR expense.approval_status <> 'submitted')
          )
        ) THEN RAISE(ABORT, 'timesheet period changed before approval')
      END;
    END`,
  timesheetSubmissionsRejectDelete,
  timesheetSubmissionsSubmitEntriesInsert,
  timesheetSubmissionsSubmitEntriesUpdate,
  timesheetSubmissionsApproveEntries,
  `CREATE TRIGGER timesheet_submissions_reject_entries
    AFTER UPDATE OF status ON timesheet_submissions
    WHEN OLD.status = 'submitted' AND NEW.status = 'unsubmitted'
    BEGIN
      UPDATE time_entries
      SET approval_status = 'unsubmitted', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id AND approval_status = 'submitted';
      UPDATE expenses
      SET approval_status = 'unsubmitted', updated_at = NEW.updated_at
      WHERE timesheet_submission_id = NEW.id AND approval_status = 'submitted';
    END`,
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
      OR (${approvalModuleEnabled} AND NEW.source_approval_status IS NOT NULL AND (
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
  `CREATE TRIGGER time_entries_source_approval_normalize_insert
    AFTER INSERT ON time_entries
    WHEN ${approvalModuleEnabled}
      AND NEW.source_approval_status IN ('submitted','approved')
    BEGIN
      INSERT INTO timesheet_submissions (
        user_id, period_start, period_end, status, origin, source_status,
        source_observed_at, submitted_by_user_id, submitted_at,
        reviewed_by_user_id, reviewed_at, rejection_reason, version, created_at, updated_at
      ) VALUES (
        NEW.user_id, ${harvestWeekStart('NEW')},
        date(${harvestWeekStart('NEW')}, '+6 days'), NEW.source_approval_status,
        'harvest_import', NEW.source_approval_status, NEW.updated_at,
        NULL, NULL, NULL, NULL, NULL, 0, NEW.updated_at, NEW.updated_at
      ) ON CONFLICT(user_id, period_start, period_end) DO NOTHING;
      UPDATE time_entries
      SET approval_status = NEW.source_approval_status,
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
      SET approval_status = NEW.source_approval_status,
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
  `CREATE TRIGGER time_entries_source_approval_immutable
    BEFORE UPDATE OF harvest_id, source_approval_status ON time_entries
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.source_approval_status IS NOT NEW.source_approval_status
    BEGIN SELECT RAISE(ABORT, 'Harvest approval source observation is immutable'); END`,
  `CREATE TRIGGER time_entries_submission_shape_insert
    BEFORE INSERT ON time_entries
    WHEN (NEW.approval_status <> 'unsubmitted' AND NEW.timesheet_submission_id IS NULL)
      OR (NEW.timesheet_submission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.id = NEW.timesheet_submission_id
          AND submission.user_id = NEW.user_id
          AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
          AND NEW.approval_status = submission.status
      ))
    BEGIN SELECT RAISE(ABORT, 'time entry does not match its timesheet submission'); END`,
  `CREATE TRIGGER time_entries_approval_period_insert_guard
    BEFORE INSERT ON time_entries
    WHEN EXISTS (
      SELECT 1 FROM timesheet_submissions submission
      WHERE submission.user_id = NEW.user_id
        AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
        AND NOT (
          ${approvalModuleEnabled}
          AND submission.origin IN ('harvest_import','legacy_backfill')
          AND NEW.harvest_id IS NOT NULL
          AND NEW.source_approval_status = submission.source_status
          AND NEW.approval_status = 'unsubmitted'
          AND NEW.timesheet_submission_id IS NULL
          AND NEW.timer_started_at IS NULL
          AND NOT (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL)
        )
        AND (
          submission.status = 'approved'
          OR (submission.status = 'submitted' AND (
            NEW.timesheet_submission_id IS NOT submission.id
            OR NEW.approval_status <> 'submitted'
            OR NEW.timer_started_at IS NOT NULL
            OR (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL)
          ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'approved or pending timesheet period rejects a running or new entry'); END`,
  `CREATE TRIGGER time_entries_approval_period_update_guard
    BEFORE UPDATE OF spent_date, timer_started_at, started_time, ended_time ON time_entries
    WHEN EXISTS (
      SELECT 1 FROM timesheet_submissions submission
      WHERE submission.user_id = NEW.user_id
        AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
        AND (
          submission.status = 'approved'
          OR (submission.status = 'submitted' AND (
            NEW.timesheet_submission_id IS NOT submission.id
            OR NEW.approval_status <> 'submitted'
            OR NEW.timer_started_at IS NOT NULL
            OR (NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL)
          ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'approved or pending timesheet period rejects a running or new entry'); END`,
  `CREATE TRIGGER time_entries_submission_shape_update
    BEFORE UPDATE OF timesheet_submission_id, approval_status, user_id, spent_date ON time_entries
    WHEN (NEW.approval_status <> 'unsubmitted' AND NEW.timesheet_submission_id IS NULL)
      OR (NEW.timesheet_submission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.id = NEW.timesheet_submission_id
          AND submission.user_id = NEW.user_id
          AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
          AND NEW.approval_status = submission.status
      ))
    BEGIN SELECT RAISE(ABORT, 'time entry does not match its timesheet submission'); END`,
  `CREATE TRIGGER time_entries_approval_delete_guard
    BEFORE DELETE ON time_entries
    WHEN OLD.approval_status = 'approved'
    BEGIN SELECT RAISE(ABORT, 'approved timesheet entries cannot be deleted'); END`,
  `CREATE TRIGGER expenses_source_approval_insert_guard
    BEFORE INSERT ON expenses
    WHEN (NEW.harvest_id IS NULL) <> (NEW.source_approval_status IS NULL)
      OR (NEW.source_approval_status IS NOT NULL AND (
        NEW.approval_status <> 'unsubmitted' OR NEW.timesheet_submission_id IS NOT NULL
      ))
      OR (${approvalModuleEnabled} AND NEW.source_approval_status IS NOT NULL AND (
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
  `CREATE TRIGGER expenses_source_approval_normalize_insert
    AFTER INSERT ON expenses
    WHEN ${approvalModuleEnabled}
      AND NEW.source_approval_status IN ('submitted','approved')
    BEGIN
      INSERT INTO timesheet_submissions (
        user_id, period_start, period_end, status, origin, source_status,
        source_observed_at, submitted_by_user_id, submitted_at,
        reviewed_by_user_id, reviewed_at, rejection_reason, version, created_at, updated_at
      ) VALUES (
        NEW.user_id, ${harvestWeekStart('NEW')},
        date(${harvestWeekStart('NEW')}, '+6 days'), NEW.source_approval_status,
        'harvest_import', NEW.source_approval_status, NEW.updated_at,
        NULL, NULL, NULL, NULL, NULL, 0, NEW.updated_at, NEW.updated_at
      ) ON CONFLICT(user_id, period_start, period_end) DO NOTHING;
      UPDATE expenses
      SET approval_status = NEW.source_approval_status,
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
      SET approval_status = NEW.source_approval_status,
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
  `CREATE TRIGGER expenses_source_approval_immutable
    BEFORE UPDATE OF harvest_id, source_approval_status ON expenses
    WHEN OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.source_approval_status IS NOT NEW.source_approval_status
    BEGIN SELECT RAISE(ABORT, 'Harvest expense approval source observation is immutable'); END`,
  `CREATE TRIGGER expenses_submission_shape_insert
    BEFORE INSERT ON expenses
    WHEN (NEW.approval_status <> 'unsubmitted' AND NEW.timesheet_submission_id IS NULL)
      OR (NEW.timesheet_submission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.id = NEW.timesheet_submission_id
          AND submission.user_id = NEW.user_id
          AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
          AND NEW.approval_status = submission.status
      ))
    BEGIN SELECT RAISE(ABORT, 'expense does not match its timesheet submission'); END`,
  `CREATE TRIGGER expenses_approval_period_insert_guard
    BEFORE INSERT ON expenses
    WHEN EXISTS (
      SELECT 1 FROM timesheet_submissions submission
      WHERE submission.user_id = NEW.user_id
        AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
        AND NOT (
          ${approvalModuleEnabled}
          AND submission.origin IN ('harvest_import','legacy_backfill')
          AND NEW.harvest_id IS NOT NULL
          AND NEW.source_approval_status = submission.source_status
          AND NEW.approval_status = 'unsubmitted'
          AND NEW.timesheet_submission_id IS NULL
        )
        AND (submission.status = 'approved'
          OR (submission.status = 'submitted' AND (
            NEW.timesheet_submission_id IS NOT submission.id
            OR NEW.approval_status <> 'submitted'
          )))
    )
    BEGIN SELECT RAISE(ABORT, 'approved or pending timesheet period rejects a new expense'); END`,
  `CREATE TRIGGER expenses_approval_period_update_guard
    BEFORE UPDATE OF spent_date ON expenses
    WHEN EXISTS (
      SELECT 1 FROM timesheet_submissions submission
      WHERE submission.user_id = NEW.user_id
        AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
        AND (submission.status = 'approved'
          OR (submission.status = 'submitted' AND (
            NEW.timesheet_submission_id IS NOT submission.id
            OR NEW.approval_status <> 'submitted'
          )))
    )
    BEGIN SELECT RAISE(ABORT, 'approved or pending timesheet period rejects an expense move'); END`,
  `CREATE TRIGGER expenses_submission_shape_update
    BEFORE UPDATE OF timesheet_submission_id, approval_status, user_id, spent_date ON expenses
    WHEN (NEW.approval_status <> 'unsubmitted' AND NEW.timesheet_submission_id IS NULL)
      OR (NEW.timesheet_submission_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM timesheet_submissions submission
        WHERE submission.id = NEW.timesheet_submission_id
          AND submission.user_id = NEW.user_id
          AND NEW.spent_date BETWEEN submission.period_start AND submission.period_end
          AND NEW.approval_status = submission.status
      ))
    BEGIN SELECT RAISE(ABORT, 'expense does not match its timesheet submission'); END`,
  `CREATE TRIGGER expenses_approval_delete_guard
    BEFORE DELETE ON expenses
    WHEN OLD.approval_status = 'approved'
    BEGIN SELECT RAISE(ABORT, 'approved timesheet expenses cannot be deleted'); END`,
  timesheetSubmissionsEventInsert,
  timesheetSubmissionsImportEventInsert,
  `CREATE TRIGGER timesheet_submissions_event_update
    AFTER UPDATE OF status ON timesheet_submissions
    BEGIN
      INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at, attempt_count
      ) SELECT
        event.id, 'timesheet_submission', NEW.id, NEW.version + 1,
        CASE NEW.status
          WHEN 'submitted' THEN 'timesheet.submitted'
          WHEN 'approved' THEN 'timesheet.approved'
          ELSE 'timesheet.rejected'
        END,
        json_object(
          'schema_version', 1, 'event_id', event.id,
          'event_type', CASE NEW.status
            WHEN 'submitted' THEN 'timesheet.submitted'
            WHEN 'approved' THEN 'timesheet.approved'
            ELSE 'timesheet.rejected'
          END,
          'occurred_at', NEW.updated_at,
          'aggregate', json_object(
            'type', 'timesheet_submission', 'id', NEW.id, 'sequence', NEW.version + 1
          ),
          'actor', json_object(
            'type', 'user', 'id', CASE WHEN NEW.status = 'submitted'
              THEN NEW.submitted_by_user_id ELSE NEW.reviewed_by_user_id END
          ),
          'timesheet_submission', json_object(
            'user_id', NEW.user_id, 'period_start', NEW.period_start,
            'period_end', NEW.period_end, 'before_status', OLD.status,
            'after_status', NEW.status, 'rejection_reason', NEW.rejection_reason
          )
        ),
        NEW.updated_at, NEW.updated_at, 0
      FROM (SELECT lower(hex(randomblob(16))) AS id) event;
    END`,
  `CREATE TRIGGER event_outbox_timesheet_submission_insert_guard
    BEFORE INSERT ON event_outbox
    WHEN NEW.aggregate_type = 'timesheet_submission'
    BEGIN
      SELECT CASE WHEN (
        NEW.command_id IS NOT NULL OR NEW.event_index IS NOT NULL
        OR NEW.event_type NOT IN (
          'timesheet.status_imported','timesheet.submitted',
          'timesheet.approved','timesheet.rejected'
        )
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
            AND json_extract(NEW.payload_json, '$.aggregate.sequence')
              = NEW.aggregate_sequence
            AND json_extract(NEW.payload_json, '$.timesheet_submission.user_id')
              = submission.user_id
            AND json_extract(NEW.payload_json, '$.timesheet_submission.period_start')
              = submission.period_start
            AND json_extract(NEW.payload_json, '$.timesheet_submission.period_end')
              = submission.period_end
            AND json_extract(NEW.payload_json, '$.timesheet_submission.after_status')
              = submission.status
            AND json_extract(NEW.payload_json, '$.timesheet_submission.rejection_reason')
              IS submission.rejection_reason
            AND (
              (
                NEW.event_type = 'timesheet.status_imported'
                AND submission.origin <> 'native'
                AND NEW.aggregate_sequence = 1
                AND NEW.occurred_at = submission.source_observed_at
                AND json_extract(NEW.payload_json, '$.actor.type') = 'system'
                AND json_type(NEW.payload_json, '$.actor.id') IS NULL
                AND json_extract(NEW.payload_json, '$.timesheet_submission.origin')
                  = submission.origin
                AND json_extract(NEW.payload_json, '$.timesheet_submission.source_status')
                  = submission.source_status
              ) OR (
                NEW.event_type <> 'timesheet.status_imported'
                AND submission.version + 1 = NEW.aggregate_sequence
                AND submission.updated_at = NEW.occurred_at
                AND NEW.event_type = CASE submission.status
                  WHEN 'submitted' THEN 'timesheet.submitted'
                  WHEN 'approved' THEN 'timesheet.approved'
                  ELSE 'timesheet.rejected'
                END
                AND json_extract(NEW.payload_json, '$.actor.type') = 'user'
                AND json_extract(NEW.payload_json, '$.actor.id') = CASE submission.status
                  WHEN 'submitted' THEN submission.submitted_by_user_id
                  ELSE submission.reviewed_by_user_id
                END
              )
            )
        )
      ) THEN RAISE(ABORT, 'timesheet outbox event does not match its submission') END;
    END`,
  `CREATE TRIGGER event_outbox_timesheet_submission_delete_guard
    BEFORE DELETE ON event_outbox
    WHEN OLD.aggregate_type = 'timesheet_submission'
    BEGIN SELECT RAISE(ABORT, 'timesheet submission events are immutable'); END`,
  `DROP TRIGGER IF EXISTS instance_bootstrap_exact_state`,
  approvalCompatibleInstanceBootstrapExactStateTrigger,
] as const
