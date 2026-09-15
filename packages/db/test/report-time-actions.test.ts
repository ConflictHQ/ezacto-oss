import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { executeReportTimeAction } from '../src/report-time-actions.js'

const at = '2026-09-14T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => { sqlite?.close(); sqlite = null })

const fixture = async () => {
  sqlite = new BetterSqlite3(':memory:')
  await migrateContainer(sqlite)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}'),
             (2, 'Worker', 'Two', 'member', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, created_at, updated_at)
      VALUES (1, 1, 'Origin', '${at}', '${at}'), (2, 1, 'Destination', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Old task', 1, 1, 1, '${at}', '${at}'), (2, 'New task', 1, 0, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 2, '${at}', '${at}'), (2, 2, 2, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, hourly_rate_cents, created_at, updated_at)
      VALUES (1, 1, 1, 1, 10000, '${at}', '${at}'), (2, 2, 2, 1, 12000, '${at}', '${at}');
    INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id, spent_date,
       seconds, seconds_without_timer, rounded_seconds, billable, billable_rate_cents,
       cost_rate_cents, created_at, updated_at)
      VALUES (10, 2, 1, 1, 1, 1, '2026-09-10', 3600, 3600, 3600, 1, 10000, NULL, '${at}', '${at}');
  `)
  return createContainerDatabase(sqlite)
}

describe('Detailed time confirmed actions', () => {
  it('moves eligible rows and replays the same command without applying it twice', async () => {
    const database = await fixture()
    const input = {
      commandId: 'move-visible-1', actorUserId: 1, action: 'move' as const,
      entryIds: [10, 999], projectId: 2, taskId: 2,
      completedAt: '2026-09-14T13:00:00.000Z',
    }
    await expect(executeReportTimeAction(database, input)).resolves.toEqual({
      commandId: 'move-visible-1', action: 'move', requested: 2,
      changedEntryIds: [10], ineligibleEntryIds: [999], replayed: false,
    })
    await expect(executeReportTimeAction(database, input)).resolves.toMatchObject({ replayed: true })
    expect(sqlite!.prepare('SELECT project_id, task_id, billable_rate_cents FROM time_entries WHERE id = 10').get())
      .toEqual({ project_id: 2, task_id: 2, billable_rate_cents: null })
  })

  it('refuses reuse of a command id for different rows', async () => {
    const database = await fixture()
    const base = {
      commandId: 'move-visible-2', actorUserId: 1, action: 'move' as const,
      entryIds: [10], projectId: 2, taskId: 2, completedAt: '2026-09-14T13:00:00.000Z',
    }
    await executeReportTimeAction(database, base)
    await expect(executeReportTimeAction(database, { ...base, entryIds: [11] }))
      .resolves.toBe('command_conflict')
  })
})
