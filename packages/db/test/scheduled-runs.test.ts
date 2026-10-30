import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createScheduledActionStore } from '../src/scheduled-actions.js'
import { createScheduledRunsService } from '../src/scheduled-runs.js'

/** Issue 61, slice A: the administrator's read, confirm and cancel of a proposed run. */

const t = (hour: number): string =>
  `2026-09-13T${String(hour).padStart(2, '0')}:00:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO scheduled_jobs
      (id, action, name, scope_json, cadence, created_by_user_id, created_at, updated_at)
      VALUES (1, 'month_end_pack', 'Month end', '{"clients":[1]}', '0 9 1 * *', 1,
        '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  const db = createContainerDatabase(database)
  const proposed = await createScheduledActionStore(db).propose({
    jobId: 1,
    occurrenceKey: '2026-08',
    items: [
      {
        subjectType: 'invoice',
        subjectId: 1315,
        description: 'Kestrel Environmental August work detail',
        amountCents: 936_850,
        currency: 'USD',
        target: 'ap@kestrel.example.test',
        quantitySeconds:5400,
        clientName:'Kestrel Environmental',
      },
    ],
    proposedAt: t(9),
    expiresAt: t(21),
  })
  if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
  return { service: createScheduledRunsService(db), id: proposed.run.id }
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('reading a proposed run', () => {
  it('returns the run with its concrete items', async () => {
    const { service, id } = await fixture()
    expect(await service.read(id)).toMatchObject({
      id,
      state: 'proposed',
      confirmed_by: null,
      expires_at: t(21),
      items: [{ subject_id: 1315, amount_cents: 936_850, currency: 'USD', quantity_seconds:5400, client_name:'Kestrel Environmental', state: 'pending' }],
    })
    expect(await service.read(id + 100)).toBeNull()
  })
})

describe('confirming', () => {
  it('records who confirmed, and a second confirm changes nothing', async () => {
    const { service, id } = await fixture()
    const first = await service.confirm(id, 1, t(10))
    expect(first).toMatchObject({ outcome: 'ok', run: { state: 'confirmed', confirmed_by: 1, confirmed_at: t(10) } })
    expect(await service.confirm(id, 1, t(11))).toEqual(first)
  })

  it('refuses past the deadline and settles the run as expired', async () => {
    const { service, id } = await fixture()
    expect(await service.confirm(id, 1, t(22))).toMatchObject({
      outcome: 'expired',
      run: { state: 'expired', confirmed_by: null },
    })
    expect((await service.read(id))?.state).toBe('expired')
    expect((await service.confirm(id, 1, t(10))).outcome).toBe('not_proposed')
  })

  it('refuses a cancelled run and an unknown one', async () => {
    const { service, id } = await fixture()
    await service.cancel(id, 1, t(10))
    expect((await service.confirm(id, 1, t(11))).outcome).toBe('not_proposed')
    expect(await service.confirm(id + 100, 1, t(11))).toEqual({ outcome: 'not_found' })
  })
})

describe('cancelling', () => {
  it('moves a proposed run to cancelled, and repeating it changes nothing', async () => {
    const { service, id } = await fixture()
    const first = await service.cancel(id, 1, t(10))
    expect(first).toMatchObject({ outcome: 'ok', run: { state: 'cancelled', confirmed_by: null } })
    expect(await service.cancel(id, 1, t(11))).toEqual(first)
  })

  it('refuses a confirmed run and an unknown one', async () => {
    const { service, id } = await fixture()
    await service.confirm(id, 1, t(10))
    expect((await service.cancel(id, 1, t(11))).outcome).toBe('not_proposed')
    expect((await service.read(id))?.state).toBe('confirmed')
    expect(await service.cancel(id + 100, 1, t(11))).toEqual({ outcome: 'not_found' })
  })
})
