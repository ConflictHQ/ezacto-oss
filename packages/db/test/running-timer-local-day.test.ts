import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { DrizzleTrackedResourceRepository } from '../src/tracked-resource-repository.js'

/**
 * Issue 651. Starting a timer in the evening filed the entry on the next day.
 *
 * The Start-a-timer modal shows a Date field prefilled with the local date, and
 * the entry was stored against the UTC date. West of UTC those differ every
 * evening: a session at 23:14 on a Saturday landed on Sunday, and a
 * Sunday-evening session landed in the following week's timesheet entirely.
 *
 * The refusals in this path already said "the current organization-local date".
 * Nothing applied a timezone, so they described a rule the code did not have.
 */

const at = '2026-09-01T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

// The instant from the report: 23:14 on Saturday 2026-09-12 at UTC-6, which is
// already Sunday the 13th in UTC.
const EVENING = '2026-09-13T05:14:58.220Z'

const fixture = async (timezone: string, userTimezone?: string) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, timezone, time_entry_mode, created_at, updated_at)
      VALUES ('CONFLICT', '{"time":true}', '${timezone}', 'duration', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, timezone, created_at, updated_at)
      VALUES (1, 'R.', 'Adeyemi', 'administrator', 1, '[]', '${userTimezone ?? 'UTC'}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (1, 1, 'Phase 1', 'P1', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  const orm = createContainerDatabase(database)
  return new DrizzleTrackedResourceRepository(orm as never, {
    isLocked: async () => false,
  } as never)
}

// The clock is UTC, because an instant is. What the repository does with it is
// what this is about.
const utcBoundary = (instant: string) => ({
  instant,
  date: instant.slice(0, 10),
  time: instant.slice(11, 16),
})

describe('the day a running timer is filed on', () => {
  it('[money] is the organization local day, not the UTC one', async () => {
    const tracked = await fixture('America/Costa_Rica')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    // The day the operator was working, and the day the modal displayed.
    expect(entry.spentDate).toBe('2026-09-12')
    // The instant is untouched: the moment is not local to anybody.
    expect(entry.timerStartedAt).toBe(EVENING)
  })

  it('[money] still agrees with UTC for an organization that runs on UTC', async () => {
    // The default, and every deployment that has not set a timezone.
    const tracked = await fixture('UTC')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-13')
  })

  it('[money] accepts the local date the form displayed, and refuses the UTC one', async () => {
    // The refusal is what made this unfixable from the form: the entry's date is
    // frozen while the timer runs, so a client sending the date it showed had to
    // either be obeyed or told. It was neither -- it was ignored.
    const tracked = await fixture('America/Costa_Rica')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1, spentDate: '2026-09-12' },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-12')

    const second = await fixture('America/Costa_Rica')
    await expect(
      second.createTimeEntry(
        1,
        { projectId: 1, taskId: 1, spentDate: '2026-09-13' },
        utcBoundary(EVENING),
      ),
    ).rejects.toMatchObject({ reasonCode: 'timer_owned', field: 'spent_date' })
    // This case builds two fixtures, so it migrates twice; give it room.
  }, 20000)

  it("[money] follows the user's own timezone over the organization's", async () => {
    // The organization runs on UTC but the person tracking is at UTC-6. Their
    // evening session is still the 12th for them, and that is the day it files.
    const tracked = await fixture('UTC', 'America/Costa_Rica')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-12')
    expect(entry.timerStartedAt).toBe(EVENING)
  })

  it('[money] a user still on the UTC default defers to the organization', async () => {
    // The user timezone column defaults to 'UTC'; that is "unset", so the
    // organization timezone decides the day.
    const tracked = await fixture('America/Costa_Rica', 'UTC')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-12')
  })

  it('[money] a timezone a calendar cannot use defers to the organization, not to UTC', async () => {
    // The regression this exists to stop. People imported from Harvest carry
    // its display names -- "Central America", "Warsaw" -- which `Intl` refuses.
    // Preferring one unconditionally threw downstream and the catch there fell
    // all the way back to UTC, which discarded a working organization zone and
    // restored the wrong-day bug for every imported person at once.
    const tracked = await fixture('America/Costa_Rica', 'Central America')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    // The organization's day, which is the answer everybody had before
    // personal timezones existed.
    expect(entry.spentDate).toBe('2026-09-12')
  })

  it('[unit] an unusable organization timezone still files rather than refusing', async () => {
    // A settings problem is not a reason to refuse a timer. With no usable zone
    // anywhere the entry files on the UTC day, which is wrong but is what it
    // was before any of this and is better than losing the session.
    const tracked = await fixture('Central America', 'Warsaw')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-13')
  })

  it('[money] rolls the other way east of UTC', async () => {
    // 22:40Z on the 12th is already the 13th in Tokyo, so the same bug files an
    // entry a day early rather than a day late.
    const tracked = await fixture('Asia/Tokyo')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary('2026-09-12T22:40:00.000Z'),
    )
    expect(entry.spentDate).toBe('2026-09-13')
  })

  it('[security] falls back to UTC rather than refusing a timer on a bad timezone', async () => {
    // A misconfigured zone is a settings problem. Refusing to start a timer over
    // it would make a cosmetic misconfiguration stop the day's work.
    const tracked = await fixture('Not/AZone')
    const entry = await tracked.createTimeEntry(
      1,
      { projectId: 1, taskId: 1 },
      utcBoundary(EVENING),
    )
    expect(entry.spentDate).toBe('2026-09-13')
  })
})
