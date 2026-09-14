import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  createScheduledActionStore,
  type ScheduledActionStore,
} from '../src/scheduled-actions.js'

/**
 * Issue 63. Its two acceptances pull in opposite directions and are the whole
 * point of the model: a manifest lists concrete items and never a count, and
 * nothing expires into action.
 */

const t = (hour: number): string =>
  `2026-09-13T${String(hour).padStart(2, '0')}:00:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<{
  sqlite: BetterSqlite3.Database
  store: ScheduledActionStore
}> => {
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
  return { sqlite: database, store: createScheduledActionStore(createContainerDatabase(database)) }
}

const items = [
  {
    subjectType: 'invoice',
    subjectId: 1315,
    description: 'Kestrel Environmental — August work detail',
    amountCents: 936_850,
    currency: 'USD',
    target: 'ap@kestrel.example.test',
  },
  {
    subjectType: 'invoice',
    subjectId: 1316,
    description: 'Northpeak — August work detail',
    amountCents: 412_000,
    currency: 'USD',
    target: 'billing@northpeak.example.test',
  },
]

const propose = (store: ScheduledActionStore, overrides: Record<string, unknown> = {}) =>
  store.propose({
    jobId: 1,
    occurrenceKey: '2026-08',
    items,
    proposedAt: t(9),
    expiresAt: t(21),
    ...overrides,
  } as never)

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('a manifest is items, never a count (#63)', () => {
  it('[money] keeps every concrete thing the run would do', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    const manifest = await store.manifest(proposed.run.id)
    // A person confirming this is agreeing to these two rows, not to "2
    // invoices" -- and disagreeing with one of them means being shown it.
    expect(manifest).toHaveLength(2)
    expect(manifest[0]).toMatchObject({
      subjectType: 'invoice',
      subjectId: 1315,
      amountCents: 936_850,
      currency: 'USD',
      target: 'ap@kestrel.example.test',
    })
  })

  it('[money] refuses to propose a run with nothing in it', async () => {
    // A run that cannot render its manifest does not propose. Showing an
    // operator an empty confirmation is asking them to agree to nothing.
    const { store } = await fixture()
    expect(await propose(store, { items: [] })).toEqual({ outcome: 'empty_manifest' })
  })

  it('[money] refuses a confirmation of a run with no items, even around the store', async () => {
    const { sqlite: database, store } = await fixture()
    database.exec(`
      INSERT INTO proposed_runs (id, job_id, occurrence_key, state, proposed_at, expires_at,
                                 created_at, updated_at)
        VALUES (99, 1, '2026-07', 'proposed', '${t(9)}', '${t(21)}', '${t(9)}', '${t(9)}')`)
    await expect(store.confirm(99, 1, t(10))).rejects.toThrow(/nothing to confirm/u)
  })

  it('[money] refuses an amount with no currency', async () => {
    // An amount without its unit is not an amount, and a manifest row that
    // says 936850 of something is not a thing to agree to.
    const { sqlite: database } = await fixture()
    expect(() =>
      database.exec(`
        INSERT INTO proposed_runs (id, job_id, occurrence_key, state, proposed_at, expires_at,
                                   created_at, updated_at)
          VALUES (98, 1, '2026-06', 'proposed', '${t(9)}', '${t(21)}', '${t(9)}', '${t(9)}');
        INSERT INTO run_items (run_id, subject_type, subject_id, description, amount_cents, created_at)
          VALUES (98, 'invoice', 1, 'No unit', 100, '${t(9)}')`),
    ).toThrow()
  })
})

describe('nothing expires into action (#63)', () => {
  it('[money] refuses to confirm past the deadline, sweep or no sweep', async () => {
    // Checked at confirmation rather than trusted to have been swept. A run
    // whose expiry passed a minute ago is not confirmable because nothing has
    // run the sweep yet -- otherwise the rule is "unless you are quick".
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    expect(await store.confirm(proposed.run.id, 1, t(22))).toEqual({ outcome: 'expired' })
    expect((await store.read(proposed.run.id))?.state).toBe('proposed')
  })

  it('[money] settles what lapsed, and says so', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    expect(await store.expire(t(22))).toEqual([proposed.run.id])
    const after = await store.read(proposed.run.id)
    expect(after?.state).toBe('expired')
    // Expired rather than deleted: what somebody asks later is why the pack did
    // not go, and a deleted row cannot answer that.
    expect(after?.settledReason).toContain('nobody confirmed it')
  })

  it('[money] cannot resurrect a run that already lapsed', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    await store.expire(t(22))
    expect(await store.confirm(proposed.run.id, 1, t(10))).toEqual({ outcome: 'not_proposed' })
  })

  it('[money] refuses to move a settled run even around the store', async () => {
    const { sqlite: database, store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    await store.expire(t(22))
    expect(() =>
      database
        .prepare(`UPDATE proposed_runs SET state = 'confirmed' WHERE id = ?`)
        .run(proposed.run.id),
    ).toThrow(/settled run cannot change state/u)
  })

  it('[money] leaves a standing run confirmable, with who agreed and when', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    const confirmed = await store.confirm(proposed.run.id, 1, t(10))
    expect(confirmed).toMatchObject({
      outcome: 'confirmed',
      run: { state: 'confirmed', confirmedByUserId: 1, confirmedAt: t(10) },
    })
  })
})

describe('one run per occurrence (#63)', () => {
  it('[money] refuses a second proposal for the same month', async () => {
    // A scheduler that fires twice finds the run already there rather than
    // proposing the pack again.
    const { store } = await fixture()
    await propose(store)
    expect(await propose(store)).toEqual({ outcome: 'already_proposed' })
  })

  it('[db] lets a different occurrence through', async () => {
    const { store } = await fixture()
    await propose(store)
    expect(await propose(store, { occurrenceKey: '2026-09' })).toMatchObject({
      outcome: 'proposed',
    })
  })

  it('[money] freezes the manifest once it is no longer merely proposed', async () => {
    // The confirmation is a signature on a document. Adding to it afterwards
    // would make that signature cover something the person never saw.
    const { sqlite: database, store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    await store.confirm(proposed.run.id, 1, t(10))
    expect(() =>
      database.exec(`
        INSERT INTO run_items (run_id, subject_type, subject_id, description, created_at)
          VALUES (${proposed.run.id}, 'invoice', 999, 'Snuck in', '${t(11)}')`),
    ).toThrow(/cannot gain items/u)
  })
})
