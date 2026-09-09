import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { activityRollStatements } from '../src/activity-partitions.js'
import { migrateContainer } from '../src/migrate.js'

let sequence = 0

const seedEvent = (database: BetterSqlite3.Database, id: string, at: string): void => {
  // The outbox is unique on (aggregate_type, aggregate_id, aggregate_sequence),
  // so each seeded event needs its own sequence rather than one derived from
  // the id.
  sequence += 1
  database
    .prepare(
      `INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at
      ) VALUES (?, 'user_authentication', 1, ?, 'auth.signed_in', '{}', ?, ?)`,
    )
    .run(id, sequence, at, at)
  database.prepare(`INSERT INTO activity_log (event_id, recorded_at) VALUES (?, ?)`).run(id, at)
}

const roll = (database: BetterSqlite3.Database, year: number): void => {
  for (const statement of activityRollStatements(year)) database.prepare(statement).run()
}

const setup = (): BetterSqlite3.Database => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return database
}

describe('activity log partitions', () => {
  it('[db] moves the finished year aside and leaves the hot table empty', () => {
    const database = setup()
    seedEvent(database, 'e-1', '2026-03-01T09:00:00.000Z')
    seedEvent(database, 'e-2', '2026-11-01T09:00:00.000Z')

    roll(database, 2026)

    expect(
      database.prepare(`SELECT count(*) AS n FROM activity_log_2026`).get(),
    ).toEqual({ n: 2 })
    expect(database.prepare(`SELECT count(*) AS n FROM activity_log`).get()).toEqual({ n: 0 })
    database.close()
  })

  it('[db] keeps every row: a roll is a rename, never a delete', () => {
    const database = setup()
    seedEvent(database, 'e-1', '2026-03-01T09:00:00.000Z')
    roll(database, 2026)
    seedEvent(database, 'e-2', '2027-03-01T09:00:00.000Z')

    // The whole point of the design: retention that deleted rows would have to
    // remove the append-only trigger, and a deletion path that exists can later
    // be pointed at anything.
    const total = database
      .prepare(
        `SELECT (SELECT count(*) FROM activity_log)
           + (SELECT count(*) FROM activity_log_2026) AS n`,
      )
      .get()
    expect(total).toEqual({ n: 2 })
    database.close()
  })

  it('[db] the archive is still append-only, and so is the new hot table', () => {
    // An archive nobody watches is exactly where a quiet edit would go, so it
    // keeps its own guards rather than relying on nobody trying.
    const database = setup()
    seedEvent(database, 'e-1', '2026-03-01T09:00:00.000Z')
    roll(database, 2026)
    seedEvent(database, 'e-2', '2027-03-01T09:00:00.000Z')

    expect(() =>
      database.prepare(`DELETE FROM activity_log_2026 WHERE event_id = 'e-1'`).run(),
    ).toThrow(/append-only/)
    expect(() =>
      database.prepare(`UPDATE activity_log_2026 SET recorded_at = '2020-01-01T00:00:00.000Z'`).run(),
    ).toThrow(/immutable/)
    expect(() =>
      database.prepare(`DELETE FROM activity_log WHERE event_id = 'e-2'`).run(),
    ).toThrow(/append-only/)
    database.close()
  })

  it('[db] the new hot table still refuses a duplicate and a bad timestamp', () => {
    // The recreate is where a guard silently goes missing: it is written out
    // again rather than carried across, so anything omitted is simply gone and
    // nothing fails until the day it matters.
    const database = setup()
    roll(database, 2026)
    seedEvent(database, 'e-1', '2027-03-01T09:00:00.000Z')

    expect(() =>
      database
        .prepare(`INSERT INTO activity_log (event_id, recorded_at) VALUES ('e-1', ?)`)
        .run('2027-03-02T09:00:00.000Z'),
    ).toThrow(/already exists/)

    // A fresh event id, so this can only fail on the timestamp. Reusing e-1
    // threw on the duplicate guard instead, which meant the assertion passed
    // whether or not the CHECK survived the recreate.
    database
      .prepare(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          payload_json, occurred_at, available_at
        ) VALUES ('e-bad', 'user_authentication', 9, 1, 'auth.signed_in', '{}', ?, ?)`,
      )
      .run('2027-03-03T09:00:00.000Z', '2027-03-03T09:00:00.000Z')
    expect(() =>
      database
        .prepare(`INSERT INTO activity_log (event_id, recorded_at) VALUES ('e-bad', 'yesterday')`)
        .run(),
    ).toThrow(/CHECK/)
    database.close()
  })

  it('[db] refuses a year that is not one', () => {
    expect(() => activityRollStatements(26)).toThrow(/four-digit year/)
    expect(() => activityRollStatements(2026.5)).toThrow(/four-digit year/)
  })
})
