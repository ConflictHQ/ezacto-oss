// A completed entry with no billable duration cannot be reviewed or staged.
// Running timer placeholders still begin at zero; this guard applies once an
// entry is stopped. Existing imported zero and negative rows remain untouched.
const completed = (row: 'NEW') =>
  `(${row}.timer_started_at IS NULL AND NOT (${row}.started_time IS NOT NULL AND ${row}.ended_time IS NULL))`

export const nonzeroStoppedTimeMigration = [
  `CREATE TRIGGER time_entries_nonzero_stopped_insert
    BEFORE INSERT ON time_entries
    WHEN NEW.seconds >= 0 AND NEW.rounded_seconds = 0 AND ${completed('NEW')}
    BEGIN SELECT RAISE(ABORT,'time_entry_zero_duration'); END`,
  `CREATE TRIGGER time_entries_nonzero_stopped_update
    BEFORE UPDATE OF seconds, rounded_seconds, timer_started_at, started_time, ended_time, project_id, spent_date ON time_entries
    WHEN NEW.seconds >= 0 AND NEW.rounded_seconds = 0 AND ${completed('NEW')}
      AND (
        OLD.seconds IS NOT NEW.seconds OR OLD.rounded_seconds IS NOT NEW.rounded_seconds
        OR OLD.timer_started_at IS NOT NEW.timer_started_at
        OR OLD.started_time IS NOT NEW.started_time OR OLD.ended_time IS NOT NEW.ended_time
        OR OLD.project_id IS NOT NEW.project_id OR OLD.spent_date IS NOT NEW.spent_date
      )
    BEGIN SELECT RAISE(ABORT,'time_entry_zero_duration'); END`,
] as const
