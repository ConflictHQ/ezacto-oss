import Database from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { atomic, nativeClient, type ActivityDatabase } from '../src/activity-log.js'
import { createOrganizationHolidayRepository } from '../src/organization-holidays.js'
import { DrizzleAllocationRepository } from '../src/allocations.js'
const now = '2026-10-12T12:00:00.000Z',
  later = '2026-10-12T12:01:00.000Z'
for (const runtime of ['SQLite', 'D1'] as const)
  describe(`organization holidays (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      let database: ActivityDatabase
      if (runtime === 'SQLite') {
        const sqlite = new Database(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite)
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        database = createD1Database(d1)
        close = () => mf.dispose()
      }
      const client = nativeClient(database)
      const query = async <T>(sql: string, ...params: unknown[]) =>
        (await atomic(client, [{ sql, params }]))[0] as T[]
      await query(
        `INSERT INTO organizations(id,name,week_start_day,timezone,modules,created_at,updated_at) VALUES(1,'Fixture','monday','America/New_York',?,?,?)`,
        JSON.stringify({ expenses: true, invoices: true, approval: true }),
        now,
        now,
      )
      await query(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,weekly_capacity,is_active,created_at,updated_at) VALUES
      (1,'Admin','Fixture','administrator','[]',126000,1,?,?), (2,'Member','Fixture','member','[]',72000,1,?,?), (3,'Archived','Fixture','member','[]',126000,0,?,?)`,
        ...Array(6).fill(now),
      )
      return { query, database, repository: createOrganizationHolidayRepository(database) }
    }
    it('atomically audits CRUD, rejects duplicates/stale versions and live role changes, and enforces dates in SQL', async () => {
      const f = await setup(),
        r = f.repository
      const holiday = await r.create(1, { date: '2026-10-12', name: 'Office closed' }, now)
      expect(holiday).toMatchObject({ date: '2026-10-12', version: 0 })
      await expect(
        r.create(1, { date: holiday.date, name: 'Duplicate' }, now),
      ).rejects.toMatchObject({ code: 'holiday_date_exists' })
      await expect(
        r.create(2, { date: '2026-10-13', name: 'Forbidden' }, now),
      ).rejects.toMatchObject({ code: 'holiday_forbidden' })
      const updated = await r.update(
        1,
        holiday.id,
        { date: holiday.date, name: 'Changed' },
        0,
        later,
      )
      expect(updated.version).toBe(1)
      await expect(
        r.update(1, holiday.id, { date: holiday.date, name: 'Stale' }, 0, later),
      ).rejects.toMatchObject({ code: 'holiday_changed' })
      await f.query("UPDATE users SET profile='administrator' WHERE id=2")
      await f.query("UPDATE users SET profile='member' WHERE id=2")
      await expect(
        r.update(2, holiday.id, { date: holiday.date, name: 'Demoted' }, 1, later),
      ).rejects.toMatchObject({ code: 'holiday_forbidden' })
      await r.remove(1, holiday.id, 1, later)
      expect(await r.get(holiday.id)).toBeNull()
      const events = await f.query<{ payload_json: string; aggregate_sequence: number }>(
        "SELECT payload_json,aggregate_sequence FROM event_outbox WHERE aggregate_type='organization_calendar' ORDER BY aggregate_sequence",
      )
      expect(events).toHaveLength(3)
      expect(events.map((e) => e.aggregate_sequence)).toEqual([1, 2, 3])
      expect(JSON.parse(events[0]!.payload_json).holiday.after.id).toBe(holiday.id)
      expect(JSON.parse(events[2]!.payload_json).holiday.before).toMatchObject({
        id: holiday.id,
        name: 'Changed',
        version: 1,
      })
      for (const date of ['2026-02-30', '2026-13-01', 'not-a-date'])
        await expect(
          f.query(
            'INSERT INTO organization_holidays(holiday_date,name,created_at,updated_at) VALUES(?,?,?,?)',
            date,
            'Bad date',
            now,
            now,
          ),
        ).rejects.toThrow()
      await f.query(
        `CREATE TRIGGER fixture_holiday_audit_failure BEFORE INSERT ON event_outbox WHEN NEW.event_type='organization_holiday.created' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`,
      )
      await expect(
        r.create(1, { date: '2026-10-14', name: 'Must roll back' }, now),
      ).rejects.toThrow()
      expect(await f.query('SELECT * FROM organization_holidays')).toHaveLength(0)
    })
    it('reduces every active person’s capacity without double-subtracting leave, touching work, or removing weekends', async () => {
      const f = await setup(),
        r = f.repository,
        planning = new DrizzleAllocationRepository(f.database)
      const viewer = { userId: 1, profile: 'administrator' as const, managerGrants: [] }
      const report = () => planning.capacity(viewer, { from: '2026-10-12', to: '2026-10-18' })
      await f.query(
        "INSERT INTO time_off(user_id,start_date,end_date,kind,seconds_per_day,created_at,updated_at) VALUES(2,'2026-10-12','2026-10-12','vacation',7200,?,?)",
        now,
        now,
      )
      await r.create(1, { date: '2026-10-12', name: 'Office closed' }, now)
      const weekend = await r.create(1, { date: '2026-10-17', name: 'Weekend event' }, now)
      let result = await report()
      expect(result.people.map((p) => p.userId)).toEqual([1, 2])
      expect(result.people.find((p) => p.userId === 2)!.weeks[0]).toMatchObject({
        timeOffSeconds: 14400,
        availableCapacitySeconds: 57600,
        trackedSeconds: 0,
      })
      expect(result.people.find((p) => p.userId === 1)!.weeks[0]).toMatchObject({
        timeOffSeconds: 25200,
        availableCapacitySeconds: 100800,
      })
      await r.remove(1, weekend.id, 0, later)
      for (const date of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
        await r.create(1, { date, name: 'Closed' }, now)
      result = await report()
      expect(result.people.every((p) => p.weeks[0]!.availableCapacitySeconds === 0)).toBe(true)
      for (const table of ['time_entries', 'invoices', 'invoice_payments'])
        expect(await f.query(`SELECT * FROM ${table}`)).toHaveLength(0)
      const source = r.entries({ from: '2026-10-13', to: '2026-10-14' })
      const throughId = await source.highWatermark()
      expect(await source.list({ afterId: null, throughId: throughId!, take: 10 })).toHaveLength(2)
    })
  })
