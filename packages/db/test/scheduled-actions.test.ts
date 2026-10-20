import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  createScheduledActionStore,
  sweepExpiredRuns,
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

/**
 * Issue 62. A confirmed run executes durably, per item, and a resume never
 * repeats work that already happened.
 *
 * The reason state lives on the item rather than the run: a run that half
 * worked is neither done nor undone, and re-running it from a run-level flag
 * repeats the half that succeeded. For a month-end pack, that is sending
 * invoices to clients twice.
 */
describe('executing a confirmed run, exactly once per item (#62)', () => {
  const confirmed = async (store: ScheduledActionStore) => {
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    const ok = await store.confirm(proposed.run.id, 1, t(10))
    if (ok.outcome !== 'confirmed') throw new Error(ok.outcome)
    return proposed.run.id
  }

  it('[money] a resume does not repeat what already completed', async () => {
    const { store } = await fixture()
    const runId = await confirmed(store)
    const [first, second] = await store.outstanding(runId)

    // The first item ran; then the process died holding the second.
    await store.claimItem(first!.id, t(11))
    await store.completeItem(first!.id, t(11))
    await store.claimItem(second!.id, t(11))

    // What a resume picks up: the one left running, and not the one done.
    const afterCrash = await store.outstanding(runId)
    expect(afterCrash.map((row) => row.id)).toEqual([second!.id])
    expect(afterCrash[0]?.state).toBe('running')
  })

  it('[money] a completed item can never be claimed or moved again', async () => {
    const { sqlite: database, store } = await fixture()
    const runId = await confirmed(store)
    const [first] = await store.outstanding(runId)
    await store.claimItem(first!.id, t(11))
    await store.completeItem(first!.id, t(11))

    // Through the store it is simply unclaimable...
    expect(await store.claimItem(first!.id, t(12))).toBe(false)
    expect(await store.completeItem(first!.id, t(12))).toBe(false)
    // ...and the schema refuses it even to a writer going around the store,
    // which is what makes a resume safe to run as often as it likes.
    expect(() =>
      database.prepare(`UPDATE run_items SET state = 'pending' WHERE id = ?`).run(first!.id),
    ).toThrow(/cannot run again/u)
  })

  it('[money] a re-run after partial failure touches only the failed item', async () => {
    const { store } = await fixture()
    const runId = await confirmed(store)
    const [first, second] = await store.outstanding(runId)
    await store.claimItem(first!.id, t(11))
    await store.completeItem(first!.id, t(11))
    await store.claimItem(second!.id, t(11))
    await store.failItem(second!.id, t(11), 'the client has no invoice address')

    const retry = await store.outstanding(runId)
    expect(retry.map((row) => row.id)).toEqual([second!.id])
    // The reason is carried, because whoever re-runs it decides from that.
    expect(retry[0]?.failureReason).toBe('the client has no invoice address')
    expect(retry[0]?.attemptCount).toBe(1)
  })

  it('[money] counts attempts, so an item failing forever is visible as that', async () => {
    const { store } = await fixture()
    const runId = await confirmed(store)
    const [first] = await store.outstanding(runId)
    for (const hour of [11, 12, 13]) {
      await store.claimItem(first!.id, t(hour))
      await store.failItem(first!.id, t(hour), 'still unreachable')
    }
    expect((await store.outstanding(runId))[0]?.attemptCount).toBe(3)
  })

  it('[money] the run is not finished while anything is outstanding', async () => {
    const { store } = await fixture()
    const runId = await confirmed(store)
    const [first, second] = await store.outstanding(runId)
    await store.claimItem(first!.id, t(11))
    await store.completeItem(first!.id, t(11))

    // A partial run stays visibly partial. Reporting it finished would leave
    // items nobody ever did and nobody was told about.
    expect(await store.settleRun(runId, t(12))).toBe(false)
    expect((await store.read(runId))?.state).toBe('confirmed')

    await store.claimItem(second!.id, t(12))
    await store.completeItem(second!.id, t(12))
    expect(await store.settleRun(runId, t(13))).toBe(true)
    expect((await store.read(runId))?.state).toBe('completed')
  })

  it('[money] nothing executes for a run nobody confirmed', async () => {
    // 0067 stops a settled run changing state; this stops its items moving
    // underneath it, which is the last place to refuse before work happens.
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
    const [first] = await store.outstanding(proposed.run.id)
    await expect(store.claimItem(first!.id, t(11))).rejects.toThrow(/only a confirmed run/u)
  })

  it('[money] a result must say when it finished or why it did not', async () => {
    const { sqlite: database, store } = await fixture()
    const runId = await confirmed(store)
    const [first] = await store.outstanding(runId)
    expect(() =>
      database
        .prepare(`UPDATE run_items SET state = 'done', completed_at = NULL WHERE id = ?`)
        .run(first!.id),
    ).toThrow(/must say when or why/u)
    expect(() =>
      database
        .prepare(`UPDATE run_items SET state = 'failed', failure_reason = NULL WHERE id = ?`)
        .run(first!.id),
    ).toThrow(/must say when or why/u)
  })
})

describe('the expiry sweep, run from the cron and the tick (#63)', () => {
  it('[container] settles a lapsed run with the reason recorded', async () => {
    const { sqlite, store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    expect(await sweepExpiredRuns(store, t(22), () => undefined)).toEqual([proposed.run.id])
    const row = sqlite
      .prepare('SELECT state, settled_reason FROM proposed_runs WHERE id = ?')
      .get(proposed.run.id)
    expect(row).toEqual({
      state: 'expired',
      settled_reason: 'nobody confirmed it before the deadline',
    })
  })

  it('[container] leaves a run whose deadline has not passed', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    expect(await sweepExpiredRuns(store, '2026-09-13T20:59:59.999Z', () => undefined)).toEqual([])
    expect((await store.read(proposed.run.id))?.state).toBe('proposed')
  })

  it('[container] cannot be confirmed once swept', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    await sweepExpiredRuns(store, t(22), () => undefined)
    expect(await store.confirm(proposed.run.id, 1, t(22))).toEqual({ outcome: 'not_proposed' })
  })

  it('[unit] reports a failing sweep and does not throw, so the rest of the tick runs', async () => {
    const failure = new Error('database is locked')
    const reported: unknown[] = []
    const result = await sweepExpiredRuns(
      {
        expire: async () => {
          throw failure
        },
      },
      t(22),
      (error) => reported.push(error),
    )
    expect(result).toEqual([])
    expect(reported).toEqual([failure])
  })
})

describe('quantity and client on a manifest item (#63)', () => {
  it('[unit] keeps hours and client name as data', async () => {
    const { store } = await fixture()
    const proposed = await propose(store, {
      items: [{ ...items[0], quantitySeconds: 27_000, clientName: 'Kestrel Environmental' }],
    })
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    const [row] = await store.manifest(proposed.run.id)
    expect(row?.quantitySeconds).toBe(27_000)
    expect(row?.clientName).toBe('Kestrel Environmental')
  })

  it('[unit] allows null for a non-time action', async () => {
    const { store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    const [row] = await store.manifest(proposed.run.id)
    expect(row?.quantitySeconds).toBeNull()
    expect(row?.clientName).toBeNull()
  })

  it('[unit] refuses a negative quantity', async () => {
    const { store } = await fixture()
    await expect(
      propose(store, { items: [{ ...items[0], quantitySeconds: -1 }] }),
    ).rejects.toThrow()
  })

  it('[container] leaves items written without the new columns untouched', async () => {
    const { sqlite, store } = await fixture()
    const proposed = await propose(store)
    if (proposed.outcome !== 'proposed') throw new Error('expected a proposal')
    const rows = sqlite
      .prepare('SELECT description, amount_cents FROM run_items WHERE run_id = ? ORDER BY id')
      .all(proposed.run.id)
    expect(rows).toEqual(
      items.map((i) => ({ description: i.description, amount_cents: i.amountCents })),
    )
  })
})
