import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activityRollStatements, migrateContainer } from '@ezacto/db'
import { createBackup, restoreBackup } from '../src/backup.js'

/**
 * A rolled year lives in its own table, so a backup that named only
 * `activity_log` would drop it without a sound (issue 8). The bundle discovers
 * its tables, and this pins that it keeps discovering them, and that a restore
 * brings the archive back still append-only.
 */
describe('ez backup covers rolled activity log years', () => {
  let directory: string
  let databasePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-activity-'))
    databasePath = join(directory, 'db.sqlite')
    const database = new BetterSqlite3(databasePath)
    migrateContainer(database)
    const seed = (id: string, sequence: number, at: string): void => {
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
    seed('e-2026-a', 1, '2026-03-01T09:00:00.000Z')
    seed('e-2026-b', 2, '2026-04-01T09:00:00.000Z')
    for (const statement of activityRollStatements(2026)) database.prepare(statement).run()
    seed('e-2027', 3, '2027-01-05T09:00:00.000Z')
    database.close()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('[unit] the bundle holds the archived year as a table and a CSV', async () => {
    const backup = await createBackup({
      databasePath,
      outputDirectory: directory,
      now: new Date('2027-02-01T00:00:00.000Z'),
    })

    const counts = Object.fromEntries(backup.manifest.tables.map((table) => [table.name, table.row_count]))
    expect(counts['activity_log']).toBe(1)
    expect(counts['activity_log_2026']).toBe(2)
    const csv = await readFile(join(backup.bundleDirectory, 'tables', 'activity_log_2026.csv'), 'utf8')
    expect(csv).toContain('e-2026-a')
    expect(csv).toContain('e-2026-b')
  })

  it('[unit] a restore recreates the archive with its rows and its guards', async () => {
    const backup = await createBackup({
      databasePath,
      outputDirectory: directory,
      now: new Date('2027-02-01T00:00:00.000Z'),
    })
    const target = join(directory, 'restored.sqlite')
    await restoreBackup({
      bundleDirectory: backup.bundleDirectory,
      targetDatabasePath: target,
      restoredAt: '2027-02-02T09:00:00.000Z',
    })

    const restored = new BetterSqlite3(target)
    try {
      expect(restored.prepare(`SELECT count(*) AS n FROM activity_log_2026`).get()).toEqual({ n: 2 })
      expect(() => restored.prepare(`DELETE FROM activity_log_2026`).run()).toThrow(/append-only/)
      expect(() =>
        restored.prepare(`UPDATE activity_log_2026 SET recorded_at = '2020-01-01T00:00:00.000Z'`).run(),
      ).toThrow(/immutable/)
    } finally {
      restored.close()
    }
  })
})
