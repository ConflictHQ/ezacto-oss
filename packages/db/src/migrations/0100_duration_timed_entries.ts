/**
 * A duration organization may hold stopped start/end entries (issue 943).
 *
 * The calendar records an interval: an entry drawn there carries its start and
 * end times in either mode, and its seconds are derived from them. Everything
 * else in a duration organization -- the week grid, the timer, the API without
 * times -- goes on writing durations, so the two shapes sit side by side on the
 * same day. Each entry's shape is its own once it exists; the update path has
 * always read it from the row (`started_time IS NULL`), not from the
 * organization.
 *
 * Only the insert trigger stood in the way, so only it is replaced:
 *
 * - The `start_end` clause is 0002's, character for character. A start/end
 *   organization behaves exactly as before.
 * - The `duration` clause no longer refuses times. It refuses only a *running*
 *   start/end row -- a `started_time` with no `ended_time`. A running entry in a
 *   duration organization stays a duration timer (`timer_started_at`), which is
 *   invariant 2: one open terminator, chosen by the organization's mode. Mixing
 *   the two running shapes in one organization is not safe: the trigger that
 *   stops a person's previous timer measures from `timer_started_at`, a UTC
 *   instant, to `spent_date || started_time`, a local wall-clock time, so west
 *   of UTC it refuses the start and east of UTC it books hours nobody worked.
 *
 * `time_entries_mode_update` already admits a stopped start/end row in a
 * duration organization -- it fires only on rows that are running -- and keeps
 * refusing a running one, which is what this needs. It is left as it is.
 *
 * No table rebuild, no column, no row is touched: an existing duration entry
 * reads exactly as it did.
 */
export const durationTimedEntriesMigration = [
  `DROP TRIGGER time_entries_mode_insert`,
  `CREATE TRIGGER time_entries_mode_insert BEFORE INSERT ON time_entries
    WHEN (
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'duration'
        AND NEW.started_time IS NOT NULL AND NEW.ended_time IS NULL
    ) OR (
      (SELECT time_entry_mode FROM organizations WHERE id = 1) = 'start_end'
        AND NEW.seconds >= 0
        AND (NEW.timer_started_at IS NOT NULL OR NEW.started_time IS NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'time entry shape does not match organization mode'); END`,
] as const
