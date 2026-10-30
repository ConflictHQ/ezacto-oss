import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  ActivityRollError,
  createActivityRoll,
  rollActivityLog,
  rollableActivityYears,
} from '../src/activity-partitions.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerOutboxService,
  createD1OutboxService,
  type OutboxService,
} from '../src/outbox.js'

type Orm = Parameters<typeof rollActivityLog>[0]

interface Harness {
  orm: Orm
  outbox: OutboxService
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const now = '2027-01-05T09:00:00.000Z'

const container = (): Harness => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    orm: createContainerDatabase(database) as Orm,
    outbox: createContainerOutboxService(database, { now: () => now }),
    run: async (sql, ...bindings) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      database.prepare(sql).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    orm: createD1Database(database) as Orm,
    outbox: createD1OutboxService(database, { now: () => now }),
    run: async (sql, ...bindings) => {
      await database
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(sql)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: () => miniflare.dispose(),
  }
}

let sequence = 0

/** An event that the activity log has already selected, recorded at `at`. */
const seed = async (harness: Harness, id: string, at: string): Promise<void> => {
  sequence += 1
  await harness.run(
    `INSERT INTO event_outbox (
       id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
       payload_json, occurred_at, available_at
     ) VALUES (?, 'user_authentication', 1, ?, 'auth.signed_in', '{"actor":{"type":"system"}}', ?, ?)`,
    id,
    sequence,
    at,
    at,
  )
  await harness.run(`INSERT INTO activity_log (event_id, recorded_at) VALUES (?, ?)`, id, at)
}

const tables = async (harness: Harness): Promise<string[]> =>
  (
    await harness.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activity_log%' ORDER BY name`,
    )
  ).map((row) => row.name)

const outboxEvents = async (harness: Harness): Promise<{ id: string }[]> =>
  harness.rows<{ id: string }>(`SELECT id FROM event_outbox WHERE event_type = 'activity_log.rolled'`)

const engines: readonly (readonly [string, () => Promise<Harness>])[] = [
  ['container', async () => container()],
  ['D1', d1],
]

describe.each(engines)('rolling the activity log (%s)', (_name, open) => {
  const opened: Harness[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((harness) => harness.close()))
  })
  const start = async (): Promise<Harness> => {
    const harness = await open()
    opened.push(harness)
    return harness
  }

  // A roll renames the hot table, so the archive holds everything recorded up
  // to the moment of the roll, including the first days of the year after the
  // one it is named for. Reads find a row by table, never by the year in the
  // name, so that costs nothing; what it cannot do is split a table without a
  // DELETE, and the log has none.
  it('[container/D1] rolls a finished year, keeps its rows readable and records the roll', async () => {
    const harness = await start()
    await seed(harness, 'old-1', '2026-03-01T09:00:00.000Z')
    await seed(harness, 'old-2', '2026-11-01T09:00:00.000Z')
    await seed(harness, 'new-1', '2027-01-02T09:00:00.000Z')

    await rollActivityLog(harness.orm, {
      year: 2026,
      actorUserId: 7,
      now,
      captureId: 'request-1',
    })

    expect(await tables(harness)).toEqual(['activity_log', 'activity_log_2026'])
    expect(
      (await harness.rows<{ event_id: string }>(`SELECT event_id FROM activity_log_2026 ORDER BY event_id`)).map(
        (row) => row.event_id,
      ),
    ).toEqual(['new-1', 'old-1', 'old-2'])
    expect(await harness.rows(`SELECT event_id FROM activity_log`)).toEqual([])

    // Archived rows still read as the log, once each.
    expect(await harness.outbox.listActivity({ eventType: 'auth.signed_in' })).toHaveLength(3)

    // The roll is an outbox event until the next drain selects it, and then it
    // reads in the log like any other, with the administrator as its actor.
    expect(await outboxEvents(harness)).toHaveLength(1)
    await harness.outbox.drain()
    const [entry] = await harness.outbox.listActivity({ eventType: 'activity_log.rolled' })
    expect(entry).toMatchObject({
      eventType: 'activity_log.rolled',
      aggregateType: 'activity_log_roll',
      aggregateId: 2026,
      actor: { type: 'user', id: 7 },
      payload: { activity_log_roll: { year: 2026, table: 'activity_log_2026' } },
    })
  })

  it('[container/D1] the archive stays append-only after the roll', async () => {
    const harness = await start()
    await seed(harness, 'old-1', '2026-03-01T09:00:00.000Z')
    await rollActivityLog(harness.orm, { year: 2026, actorUserId: 7, now, captureId: 'request-1' })

    await expect(harness.run(`DELETE FROM activity_log_2026`)).rejects.toThrow(/append-only/u)
    await expect(
      harness.run(`UPDATE activity_log_2026 SET recorded_at = '2026-01-01T00:00:00.000Z'`),
    ).rejects.toThrow(/immutable/u)
  })

  it('[container/D1] refuses the current year and later years without changing anything', async () => {
    const harness = await start()
    await seed(harness, 'new-1', '2027-01-02T09:00:00.000Z')

    for (const year of [2027, 2028]) {
      await expect(
        rollActivityLog(harness.orm, { year, actorUserId: 7, now, captureId: `request-${year}` }),
      ).rejects.toMatchObject({ name: 'ActivityRollError', code: 'current_year' })
    }

    expect(await tables(harness)).toEqual(['activity_log'])
    expect(await outboxEvents(harness)).toEqual([])
  })

  it('[container/D1] refuses a year that already has a partition', async () => {
    const harness = await start()
    await seed(harness, 'old-1', '2026-03-01T09:00:00.000Z')
    await rollActivityLog(harness.orm, { year: 2026, actorUserId: 7, now, captureId: 'request-1' })
    await seed(harness, 'late-1', '2026-12-31T23:00:00.000Z')

    await expect(
      rollActivityLog(harness.orm, { year: 2026, actorUserId: 7, now, captureId: 'request-2' }),
    ).rejects.toMatchObject({ code: 'partition_exists' })

    expect(await tables(harness)).toEqual(['activity_log', 'activity_log_2026'])
    expect(await outboxEvents(harness)).toHaveLength(1)
  })

  it('[container/D1] a roll that fails part way leaves the hot table and the outbox untouched', async () => {
    const harness = await start()
    await seed(harness, 'old-1', '2026-03-01T09:00:00.000Z')
    // The archive's index name is taken, so the roll fails after the rename.
    await harness.run(
      `CREATE INDEX activity_log_recorded_event_2026 ON event_outbox(occurred_at)`,
    )

    await expect(
      rollActivityLog(harness.orm, { year: 2026, actorUserId: 7, now, captureId: 'request-1' }),
    ).rejects.toThrow()

    expect(await tables(harness)).toEqual(['activity_log'])
    expect(
      await harness.rows(`SELECT event_id FROM activity_log WHERE event_id = 'old-1'`),
    ).toHaveLength(1)
    expect(await outboxEvents(harness)).toEqual([])
  })

  it('[container/D1] offers only finished years the hot table still holds, and a roll takes them all', async () => {
    const harness = await start()
    await seed(harness, 'a', '2025-05-01T09:00:00.000Z')
    await seed(harness, 'b', '2026-03-01T09:00:00.000Z')
    await seed(harness, 'c', '2026-04-01T09:00:00.000Z')
    await seed(harness, 'd', '2027-01-02T09:00:00.000Z')

    expect(await rollableActivityYears(harness.orm, now)).toEqual([
      { year: 2025, entries: 1 },
      { year: 2026, entries: 2 },
    ])

    await rollActivityLog(harness.orm, { year: 2025, actorUserId: 7, now, captureId: 'request-1' })
    expect(await rollableActivityYears(harness.orm, now)).toEqual([])
  })

  it('[container/D1] the port reports a refusal as an outcome and rolls on request', async () => {
    const harness = await start()
    await seed(harness, 'old-1', '2026-03-01T09:00:00.000Z')
    const port = createActivityRoll(harness.orm, () => now)

    expect(await port.roll({ year: 2027, actorUserId: 7, requestId: 'r1' })).toBe('current_year')
    expect(await port.roll({ year: 2026, actorUserId: 7, requestId: 'r2' })).toBe('rolled')
    expect(await port.roll({ year: 2026, actorUserId: 7, requestId: 'r3' })).toBe('partition_exists')
    expect(await port.rollable()).toEqual([])
    expect(new ActivityRollError('current_year', 'x')).toBeInstanceOf(Error)
  })
})
