import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createReportDefinition } from '../src/report-definitions.js'
import { runReportDefinition } from '../src/report-runner.js'
import { createSavedReportStore } from '../src/saved-reports.js'

const at = '2026-09-14T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => { sqlite?.close(); sqlite = null })

const definition = (id = 'client-hours') => createReportDefinition({
  id,
  name: 'Client hours and margin',
  fields: [{ id: 'client_name', label: 'Client', visible: true }],
  metrics: ['hours', 'billable', 'cost', 'margin'],
  filters: [{ field: 'spent_date', operator: 'between', value: ['2026-08-01', '2026-08-31'] }],
  groupBy: { dimension: 'client' },
  createdAt: at,
})

const fixture = async () => {
  sqlite = new BetterSqlite3(':memory:')
  await migrateContainer(sqlite)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Owner', 'One', 'administrator', '[]', '${at}', '${at}'),
             (2, 'Shared', 'Two', 'accounting', '[]', '${at}', '${at}'),
             (3, 'Outside', 'Three', 'accounting', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Kestrel', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Launch', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Build', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at) VALUES (1, 1, 1, 1, '${at}', '${at}');
    INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id, spent_date,
       seconds, seconds_without_timer, rounded_seconds, billable, billable_rate_cents,
       cost_rate_cents, created_at, updated_at)
      VALUES (1, 1, 1, 1, 1, 1, '2026-08-15', 3600, 3600, 3600, 1, 20000, NULL, '${at}', '${at}');
  `)
  const database = createContainerDatabase(sqlite)
  return { database, store: createSavedReportStore(database) }
}

describe('saved report library and runner', () => {
  it('enforces owner/share/revoke/pin and optimistic versions', async () => {
    const { store } = await fixture()
    await store.create({
      definition: definition(), ownerUserId: 1,
      presentation: { result: 'summary', grouped: true, includeZeroValues: false },
    })
    await expect(store.read('client-hours', 3)).resolves.toBeNull()
    expect(await store.setShared('client-hours', 1, 2, true, at)).toBe(true)
    await expect(store.read('client-hours', 2)).resolves.toMatchObject({ shared: true })
    expect(await store.setPinned('client-hours', 2, true, at)).toBe(true)
    await expect(store.list({ viewerUserId: 2, view: 'shared' })).resolves.toEqual([
      expect.objectContaining({ pinned: true, ownerUserId: 1 }),
    ])
    expect(await store.update({
      reportId: 'client-hours', ownerUserId: 1, expectedVersion: 9,
      changes: { name: 'Wrong', updatedAt: '2026-09-14T13:00:00.000Z' },
    })).toBe('version_conflict')
    expect(await store.update({
      reportId: 'client-hours', ownerUserId: 1, expectedVersion: 1,
      changes: { name: 'Updated', updatedAt: '2026-09-14T13:00:00.000Z' },
    })).toMatchObject({ definition: { version: 2, name: 'Updated' } })
    expect(await store.setShared('client-hours', 1, 2, false, at)).toBe(true)
    await expect(store.read('client-hours', 2)).resolves.toBeNull()
  })

  it('runs live data, redacts money, and renders missing rates as a fixable dash cell', async () => {
    const { database } = await fixture()
    const result = await runReportDefinition(
      database,
      definition(),
      { result: 'summary', grouped: true, includeZeroValues: false },
      { billableMoney: true, costMoney: true },
    )
    expect(result.rows[0]).toMatchObject({
      label: 'Kestrel',
      metrics: {
        hours: { value: 3600 },
        billable: { value: 20000 },
        cost: { value: null, missingReason: 'missing_rate', fixUrl: '/team/1/rates' },
        margin: { value: null, missingReason: 'missing_rate' },
      },
      entryIds: [1],
    })
    expect(result.rows[0]?.drillThrough).toContain('client_id=1')
    const redacted = await runReportDefinition(
      database,
      definition(),
      { result: 'summary', grouped: true, includeZeroValues: false },
      { billableMoney: false, costMoney: false },
    )
    expect(redacted.rows[0]?.metrics).toEqual({ hours: { value: 3600 } })
  })
})
