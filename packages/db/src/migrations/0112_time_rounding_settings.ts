/**
 * Time rounding as a setting (issue 949).
 *
 * `organizations.time_rounding` was one fixed enum -- none, nearest or up, to
 * 6, 15 or 30 minutes -- held by a column CHECK. Rounding is now two choices:
 * a direction (exact, up, down, nearest) and an increment (6, 10, 15, 20, 30
 * or 60 minutes), set for the organization and overridable per project.
 *
 * No table is rebuilt:
 *
 * - The new columns are added with `ADD COLUMN`, and the organization's are
 *   backfilled from the old enum. `time_rounding` itself stays where it is,
 *   unused: nothing reads it after this migration.
 * - They are validated by triggers rather than CHECKs (0058's pattern), so the
 *   vocabulary can change later without a rebuild either. A project's pair is
 *   null together -- the organization's rule applies -- or set together.
 * - The two 0002 triggers that stop a person's previous timer when a new one
 *   starts are the only SQL that rounds, and they read the old column. They are
 *   dropped and recreated with the rounding clause reading the project's rule,
 *   then the organization's. Every other clause is 0002's text, character for
 *   character (`packages/db/test/time-rounding.test.ts` holds them to it).
 *   Recreating them moves them ahead of the other guards on `time_entries`,
 *   which SQLite in practice fires newest first: when a write breaks one of
 *   their rules *and* another, this rule is now the one reported. Which writes
 *   are accepted does not change, because an abort anywhere backs out the whole
 *   statement, the previous timer's stop included.
 *
 * No time entry is touched. A rounded figure is fixed when an entry is saved
 * and is what an invoice billed; changing the rule applies to time saved
 * afterwards, and re-rounding open time is an explicit, previewed action.
 */

const modes = `'exact', 'up', 'down', 'nearest'`
const increments = `6, 10, 15, 20, 30, 60`

const validRule = (mode: string, minutes: string) => `(
      ${mode} IS NOT NULL AND ${mode} IN (${modes})
      AND ${minutes} IS NOT NULL AND ${minutes} IN (${increments})
    )`

const organizationRuleMessage =
  'time rounding must be exact, up, down or nearest, to 6, 10, 15, 20, 30 or 60 minutes'
const projectRuleMessage =
  'project time rounding must be inherited, or exact, up, down or nearest, to 6, 10, 15, 20, 30 or 60 minutes'

const projectRuleValid = `(
      (NEW.time_rounding_mode IS NULL AND NEW.time_rounding_minutes IS NULL)
      OR ${validRule('NEW.time_rounding_mode', 'NEW.time_rounding_minutes')}
    )`

// 0002's building blocks, copied rather than imported: a migration's text is
// frozen once it has shipped, and these are that text.
const runningPredicate = `timer_started_at IS NOT NULL
      OR (started_time IS NOT NULL AND ended_time IS NULL)`

const maxSafeSeconds = 9_007_199_254_740_991

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

/**
 * The one clause that changes. The rule is the entry's project's where it has
 * one, else the organization's; the increment comes from the same place as
 * the mode, so a project's pair is never mixed with the organization's. Every
 * operand is an integer, so `/` divides and truncates, and a duration here is
 * never negative: up adds an increment less a second before dividing, nearest
 * adds half an increment, down divides as it is.
 */
const projectMode = `(SELECT time_rounding_mode FROM projects WHERE id = time_entries.project_id)`

const effectiveMode = `COALESCE(
      ${projectMode},
      (SELECT time_rounding_mode FROM organizations WHERE id = 1)
    )`

const effectiveIncrement = `(60 * CASE
      WHEN ${projectMode} IS NOT NULL
        THEN (SELECT time_rounding_minutes FROM projects WHERE id = time_entries.project_id)
      ELSE (SELECT time_rounding_minutes FROM organizations WHERE id = 1)
    END)`

export const timeRoundingSettingsRoundedSeconds = (seconds: string) => `CASE ${effectiveMode}
      WHEN 'exact' THEN ${seconds}
      WHEN 'up' THEN ((${seconds} + ${effectiveIncrement} - 1) / ${effectiveIncrement}) * ${effectiveIncrement}
      WHEN 'down' THEN (${seconds} / ${effectiveIncrement}) * ${effectiveIncrement}
      WHEN 'nearest' THEN ((${seconds} + ${effectiveIncrement} / 2) / ${effectiveIncrement}) * ${effectiveIncrement}
    END`

const roundedSeconds = timeRoundingSettingsRoundedSeconds

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

export const timeRoundingSettingsMigration = [
  `ALTER TABLE organizations ADD COLUMN time_rounding_mode TEXT NOT NULL DEFAULT 'exact'`,
  `ALTER TABLE organizations ADD COLUMN time_rounding_minutes INTEGER NOT NULL DEFAULT 15`,
  // The old enum's every value, spelled out: none is exact (the increment kept
  // at its default for whenever rounding is switched on), the rest say both.
  `UPDATE organizations SET
    time_rounding_mode = CASE time_rounding
      WHEN 'none' THEN 'exact'
      WHEN 'nearest_6' THEN 'nearest'
      WHEN 'nearest_15' THEN 'nearest'
      WHEN 'nearest_30' THEN 'nearest'
      WHEN 'up_6' THEN 'up'
      WHEN 'up_15' THEN 'up'
      WHEN 'up_30' THEN 'up'
    END,
    time_rounding_minutes = CASE time_rounding
      WHEN 'nearest_6' THEN 6
      WHEN 'up_6' THEN 6
      WHEN 'nearest_30' THEN 30
      WHEN 'up_30' THEN 30
      ELSE 15
    END`,
  `ALTER TABLE projects ADD COLUMN time_rounding_mode TEXT`,
  `ALTER TABLE projects ADD COLUMN time_rounding_minutes INTEGER`,
  `CREATE TRIGGER organizations_time_rounding_insert
    BEFORE INSERT ON organizations
    WHEN NOT ${validRule('NEW.time_rounding_mode', 'NEW.time_rounding_minutes')}
    BEGIN SELECT RAISE(ABORT, '${organizationRuleMessage}'); END`,
  `CREATE TRIGGER organizations_time_rounding_update
    BEFORE UPDATE OF time_rounding_mode, time_rounding_minutes ON organizations
    WHEN NOT ${validRule('NEW.time_rounding_mode', 'NEW.time_rounding_minutes')}
    BEGIN SELECT RAISE(ABORT, '${organizationRuleMessage}'); END`,
  `CREATE TRIGGER projects_time_rounding_insert
    BEFORE INSERT ON projects
    WHEN NOT ${projectRuleValid}
    BEGIN SELECT RAISE(ABORT, '${projectRuleMessage}'); END`,
  `CREATE TRIGGER projects_time_rounding_update
    BEFORE UPDATE OF time_rounding_mode, time_rounding_minutes ON projects
    WHEN NOT ${projectRuleValid}
    BEGIN SELECT RAISE(ABORT, '${projectRuleMessage}'); END`,
  `DROP TRIGGER time_entries_stop_previous_insert`,
  `CREATE TRIGGER time_entries_stop_previous_insert BEFORE INSERT ON time_entries
    WHEN ${newRunningPredicate}
    BEGIN
      ${rejectBackwardBoundary};
      ${rejectUnsafeTotal};
      ${stopPreviousRunningEntry};
    END`,
  `DROP TRIGGER time_entries_stop_previous_update`,
  `CREATE TRIGGER time_entries_stop_previous_update
    BEFORE UPDATE OF user_id, timer_started_at, started_time, ended_time ON time_entries
    WHEN ${newRunningPredicate}
    BEGIN
      ${rejectBackwardBoundary};
      ${rejectUnsafeTotal};
      ${stopPreviousRunningEntry};
    END`,
] as const
