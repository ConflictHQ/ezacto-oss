import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { activityRollStatements } from '../src/activity-partitions.js'
import { exportBundle, type BackupObjectStore } from '../src/backup.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerOutboxService,
  createD1OutboxService,
  type OutboxService,
} from '../src/outbox.js'

interface Harness {
  outbox: OutboxService
  /** Writes an event and selects it into whichever table is hot right now. */
  seed(id: string, at: string, eventType?: string): Promise<void>
  roll(year: number): Promise<void>
  tableNames(): Promise<string[]>
  close(): Promise<void>
}

let sequence = 0

const seedSql = (id: string, at: string, eventType: string) => {
  sequence += 1
  return {
    event: [
      `INSERT INTO event_outbox (
         id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
         payload_json, occurred_at, available_at
       ) VALUES (?, 'user_authentication', 1, ?, ?, '{"actor":{"type":"system"}}', ?, ?)`,
      [id, sequence, eventType, at, at],
    ] as const,
    selection: [`INSERT INTO activity_log (event_id, recorded_at) VALUES (?, ?)`, [id, at]] as const,
  }
}

const container = (): Harness => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    outbox: createContainerOutboxService(database, { now: () => '2030-01-01T00:00:00.000Z' }),
    seed: async (id, at, eventType = 'auth.signed_in') => {
      const { event, selection } = seedSql(id, at, eventType)
      database.prepare(event[0]).run(...event[1])
      database.prepare(selection[0]).run(...selection[1])
    },
    roll: async (year) => {
      for (const statement of activityRollStatements(year)) database.prepare(statement).run()
    },
    tableNames: async () =>
      (
        database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
          name: string
        }[]
      ).map((row) => row.name),
    close: async () => {
      database.close()
    },
  }
}

const d1 = async (): Promise<Harness & { database: D1Database }> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    database,
    outbox: createD1OutboxService(database, { now: () => '2030-01-01T00:00:00.000Z' }),
    seed: async (id, at, eventType = 'auth.signed_in') => {
      const { event, selection } = seedSql(id, at, eventType)
      await database.batch([
        database.prepare(event[0]).bind(...event[1]),
        database.prepare(selection[0]).bind(...selection[1]),
      ])
    },
    roll: async (year) => {
      await database.batch(activityRollStatements(year).map((statement) => database.prepare(statement)))
    },
    tableNames: async () =>
      (
        await database
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all<{ name: string }>()
      ).results.map((row) => row.name),
    close: () => miniflare.dispose(),
  }
}

const ids = async (outbox: OutboxService, input?: Parameters<OutboxService['listActivity']>[0]) =>
  (await outbox.listActivity(input)).map((entry) => entry.id)

const engines: readonly (readonly [string, () => Promise<Harness>])[] = [
  ['container', async () => container()],
  ['D1', d1],
]

describe.each(engines)('activity log reads across partitions (%s)', (_name, open) => {
  const opened: Harness[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((harness) => harness.close()))
  })
  const start = async (): Promise<Harness> => {
    const harness = await open()
    opened.push(harness)
    return harness
  }

  it('[container/D1] a window spanning the boundary returns both tables in one ordered result', async () => {
    const { outbox, seed, roll } = await start()
    await seed('a-2026-03', '2026-03-01T09:00:00.000Z')
    await seed('b-2026-11', '2026-11-01T09:00:00.000Z')
    await roll(2026)
    await seed('c-2027-02', '2027-02-01T09:00:00.000Z')

    expect(await ids(outbox, { from: '2026-01-01', to: '2027-12-31' })).toEqual([
      'c-2027-02',
      'b-2026-11',
      'a-2026-03',
    ])
  })

  it('[container/D1] filters still narrow the archived rows', async () => {
    const { outbox, seed, roll } = await start()
    await seed('old-in', '2026-03-01T09:00:00.000Z', 'api_token.created')
    await seed('old-out', '2026-04-01T09:00:00.000Z', 'auth.signed_in')
    await roll(2026)
    await seed('new-in', '2027-03-01T09:00:00.000Z', 'api_token.created')

    expect(await ids(outbox, { eventType: 'api_token.created' })).toEqual(['new-in', 'old-in'])
    expect(await ids(outbox, { from: '2026-04-01', to: '2026-04-01' })).toEqual(['old-out'])
  })

  it('[container/D1] a cursor resumes across the boundary without repeating or skipping', async () => {
    const { outbox, seed, roll } = await start()
    await seed('e1', '2026-03-01T09:00:00.000Z')
    await seed('e2', '2026-03-02T09:00:00.000Z')
    await roll(2026)
    await seed('e3', '2027-03-01T09:00:00.000Z')
    await seed('e4', '2027-03-02T09:00:00.000Z')

    const seen: string[] = []
    let after: { recordedAt: string; eventId: string } | null = null
    for (;;) {
      const page = await outbox.listActivity({ limit: 1, after })
      if (page.length === 0) break
      seen.push(page[0]!.id)
      after = { recordedAt: page[0]!.recordedAt, eventId: page[0]!.id }
    }
    expect(seen).toEqual(['e4', 'e3', 'e2', 'e1'])
  })

  it('[container/D1] the snapshot sees the archive when the hot table is empty', async () => {
    const { outbox, seed, roll } = await start()
    expect(await outbox.activitySnapshot()).toBeNull()
    await seed('e1', '2026-03-01T09:00:00.000Z')
    await roll(2026)

    expect(await outbox.activitySnapshot()).toBe('2026-03-01T09:00:00.000Z')
    expect(await ids(outbox)).toEqual(['e1'])
  })

  it('[container/D1] two rolled years and the hot table read as one log', async () => {
    const { outbox, seed, roll, tableNames } = await start()
    await seed('y25', '2025-06-01T09:00:00.000Z')
    await roll(2025)
    await seed('y26', '2026-06-01T09:00:00.000Z')
    await roll(2026)
    await seed('y27', '2027-06-01T09:00:00.000Z')

    expect(await tableNames()).toEqual(
      expect.arrayContaining(['activity_log', 'activity_log_2025', 'activity_log_2026']),
    )
    expect(await ids(outbox)).toEqual(['y27', 'y26', 'y25'])
  })
})

describe('activity partitions in the backup bundle', () => {
  it('[container/D1] a rolled year is exported with its rows, not silently dropped', async () => {
    const harness = await d1()
    try {
      await harness.seed('e1', '2026-03-01T09:00:00.000Z')
      await harness.seed('e2', '2026-04-01T09:00:00.000Z')
      await harness.roll(2026)
      await harness.seed('e3', '2027-01-05T09:00:00.000Z')

      const objects = new Map<string, string>()
      const store: BackupObjectStore = {
        put: async (key, body) => {
          objects.set(key, body)
        },
      }
      const manifest = await exportBundle(harness.database, store, 'backups/test/')

      expect(manifest.tables.activity_log?.row_count).toBe(1)
      expect(manifest.tables.activity_log_2026?.row_count).toBe(2)
      const archived = objects.get('backups/test/tables/activity_log_2026.csv')
      expect(archived).toContain('e1')
      expect(archived).toContain('e2')
    } finally {
      await harness.close()
    }
  })
})
