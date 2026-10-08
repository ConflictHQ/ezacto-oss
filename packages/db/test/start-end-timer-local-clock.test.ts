import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { DrizzleTrackedResourceRepository } from '../src/tracked-resource-repository.js'

/**
 * Issue 945. In a start_end organization a running timer is a local start time
 * and no end, and stopping it measured that start against the UTC clock: in
 * America/Costa_Rica a 09:00 timer stopped at 10:00 came out at 25,200
 * seconds, ending at 16:00. A restart filed a start/end entry on the UTC date
 * and time the same way. The clock the Worker hands in is UTC, because an
 * instant is; the start was local, so the stop has to be.
 *
 * The local clock is the entry owner's: their own zone, then the
 * organization's, as the day a timer is filed on is decided.
 */

const at = '2026-09-01T12:00:00.000Z'

interface Fixture {
  tracked: DrizzleTrackedResourceRepository
  close(): Promise<void>
}

const seed = (organizationZone: string, userZones: readonly [string, string]): string => `
  INSERT INTO organizations (name, modules, timezone, time_entry_mode, created_at, updated_at)
    VALUES ('Clock Org', '{"time":true}', '${organizationZone}', 'start_end', '${at}', '${at}');
  INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, timezone, created_at, updated_at)
    VALUES (1, 'Ines', 'Okafor', 'administrator', 1, '[]', '${userZones[0]}', '${at}', '${at}'),
           (2, 'Tomas', 'Varga', 'member', 1, '[]', '${userZones[1]}', '${at}', '${at}');
  INSERT INTO clients (id, name, currency, created_at, updated_at)
    VALUES (1, 'Clock Client', 'USD', '${at}', '${at}');
  INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
    VALUES (1, 1, 'Clock Project', 'CLK', 1, 'time_materials', '${at}', '${at}');
  INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
    VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
  INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
    VALUES (1, 1, 1, '${at}', '${at}'), (2, 1, 2, '${at}', '${at}');
  INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
    VALUES (1, 1, 1, 1, '${at}', '${at}');
`

const policy = { isLocked: async () => false } as never

const containerFixture = async (
  organizationZone: string,
  userZones: readonly [string, string],
): Promise<Fixture> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec(seed(organizationZone, userZones))
  return {
    tracked: new DrizzleTrackedResourceRepository(createContainerDatabase(database) as never, policy),
    close: async () => {
      database.close()
    },
  }
}

const d1Fixture = async (
  organizationZone: string,
  userZones: readonly [string, string],
): Promise<Fixture> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  for (const statement of seed(organizationZone, userZones)
    .split(';')
    .map((text) => text.trim())
    .filter((text) => text !== '')) {
    await d1.prepare(statement).run()
  }
  return {
    tracked: new DrizzleTrackedResourceRepository(createD1Database(d1) as never, policy),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerFixture],
  ['D1', d1Fixture],
] as const

/** The Worker's clock: an instant, with the UTC date and time beside it. */
const utc = (instant: string) => ({
  instant,
  date: instant.slice(0, 10),
  time: instant.slice(11, 16),
})

const ines = { userId: 1, profile: 'administrator' } as const
const tomas = { userId: 2, profile: 'member' } as const

for (const [runtime, factory] of factories) {
  describe(`a start/end timer keeps its owner's clock (${runtime})`, () => {
    let open: Fixture | null = null
    afterEach(async () => {
      await open?.close()
      open = null
    })
    const fixture = async (
      organizationZone: string,
      userZones: readonly [string, string] = ['UTC', 'UTC'],
    ): Promise<DrizzleTrackedResourceRepository> => {
      open = await factory(organizationZone, userZones)
      return open.tracked
    }

    it('[money] stops an hour after it started, six hours west of UTC', async () => {
      const tracked = await fixture('America/Costa_Rica')
      // 09:00 in Costa Rica is 15:00 UTC.
      const started = await tracked.createTimeEntry(
        ines,
        { projectId: 1, taskId: 1 },
        utc('2026-09-14T15:00:00.000Z'),
      )
      expect(started).toMatchObject({ spentDate: '2026-09-14', startedTime: '09:00', endedTime: null })

      const stopped = await tracked.stopTimeEntry(ines, started.id, utc('2026-09-14T16:00:00.000Z'))
      expect(stopped).toMatchObject({
        spentDate: '2026-09-14',
        startedTime: '09:00',
        endedTime: '10:00',
        seconds: 3_600,
      })
    })

    it('[money] stops an hour after it started, two hours east of UTC', async () => {
      const tracked = await fixture('Europe/Berlin')
      // 09:00 in Berlin in September is 07:00 UTC; the UTC clock would read
      // the stop as an hour *before* the start.
      const started = await tracked.createTimeEntry(
        ines,
        { projectId: 1, taskId: 1 },
        utc('2026-09-14T07:00:00.000Z'),
      )
      const stopped = await tracked.stopTimeEntry(ines, started.id, utc('2026-09-14T08:00:00.000Z'))
      expect(stopped).toMatchObject({
        spentDate: '2026-09-14',
        startedTime: '09:00',
        endedTime: '10:00',
        seconds: 3_600,
      })
    })

    it('[money] restarts on the local evening, not on the next UTC day', async () => {
      const tracked = await fixture('America/Costa_Rica')
      const earlier = await tracked.createTimeEntry(
        ines,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-11',
          startedTime: '08:00',
          endedTime: '09:00',
        },
        utc('2026-09-11T16:00:00.000Z'),
      )
      expect(earlier.seconds).toBe(3_600)

      // 19:30 on Saturday the 12th in Costa Rica is 01:30 on Sunday in UTC.
      const restarted = await tracked.restartTimeEntry(
        ines,
        earlier.id,
        utc('2026-09-13T01:30:00.000Z'),
      )
      expect(restarted).toMatchObject({
        spentDate: '2026-09-12',
        startedTime: '19:30',
        endedTime: null,
      })
      const stopped = await tracked.stopTimeEntry(ines, earlier.id, utc('2026-09-13T02:30:00.000Z'))
      // The hour it already held, and the hour since the restart.
      expect(stopped).toMatchObject({ endedTime: '20:30', seconds: 7_200 })
    })

    it("[money] stops a teammate's timer on the teammate's clock, not the administrator's", async () => {
      // The organization is on UTC, the administrator in Berlin, the person
      // tracking in Costa Rica: their day and their clock are what count.
      const tracked = await fixture('UTC', ['Europe/Berlin', 'America/Costa_Rica'])
      const started = await tracked.createTimeEntry(
        tomas,
        { projectId: 1, taskId: 1 },
        utc('2026-09-14T15:00:00.000Z'),
      )
      expect(started).toMatchObject({ userId: 2, startedTime: '09:00' })

      const stopped = await tracked.stopTimeEntry(ines, started.id, utc('2026-09-14T16:00:00.000Z'))
      expect(stopped).toMatchObject({ userId: 2, endedTime: '10:00', seconds: 3_600 })
    })
  })
}
