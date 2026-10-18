import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  DrizzleCalendarProposalRepository,
  proposeCalendarEvents,
  type CalendarEventInput,
} from '../src/calendar-proposals.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TimeEntryActor,
  type TrackedPolicyResolver,
  type TrackedResourceDatabase,
} from '../src/tracked-resource-repository.js'

/**
 * Issue 428, slice 1. A calendar proposal is not a time entry: it becomes one
 * only when its owner accepts it, through the ordinary creation path, and
 * everything that path enforces still applies. Each case runs on both runtimes
 * because the accept is a single batch (better-sqlite3 transaction, D1 batch)
 * and the two are what decide whether a refusal really rolls the entry back.
 */

interface TestDatabase {
  orm: TrackedResourceDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-09-02T12:00:00.000Z'
const stamps = (count: number): string[] => Array.from({ length: count }, () => t0)

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const maya: TimeEntryActor = { userId: 1, profile: 'member' }
const milo: TimeEntryActor = { userId: 6, profile: 'member' }
const ada: TimeEntryActor = { userId: 10, profile: 'administrator' }

const at = (instant: string) => ({
  instant,
  date: instant.slice(0, 10),
  time: instant.slice(11, 16),
})

const policy = (locked: ReadonlySet<string> = new Set()): TrackedPolicyResolver => ({
  isLocked: async (subject: Readonly<PolicySubject>) =>
    subject.entityType === 'tracked_date' && locked.has(subject.spentDate),
})

/**
 * Maya (1) is assigned to the project and its task; Milo (6) is not. Ada (10)
 * is an administrator with her own calendar, to show that administrators see
 * only their own proposals too.
 */
const installFixture = async (
  db: TestDatabase,
  options: { mode?: 'duration' | 'start_end'; rounding?: [string, number]; mayaZone?: string } = {},
): Promise<void> => {
  await db.run(
    `INSERT INTO organizations
       (name, modules, time_entry_mode, time_rounding_mode, time_rounding_minutes, created_at, updated_at)
     VALUES ('Fictional Studio', ?, ?, ?, ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    options.mode ?? 'duration',
    options.rounding?.[0] ?? 'exact',
    options.rounding?.[1] ?? 15,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, timezone, created_at, updated_at)
     VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', 'UTC', ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', ?, ?, ?),
      (6, 'Milo', 'Member', 'member', '[]', 'UTC', ?, ?)`,
    t0,
    t0,
    options.mayaZone ?? 'UTC',
    t0,
    t0,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Fictional Project', 'people', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Fictional Task', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?), (2, 1, 10, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO user_billable_rates (id, user_id, amount_cents, start_date, created_at, updated_at)
     VALUES (1, 1, 9000, NULL, ?, ?), (2, 10, 15000, NULL, ?, ?)`,
    ...stamps(4),
  )
}

const event = (overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  provider: 'google',
  calendarId: 'primary',
  eventId: 'evt-1',
  summary: 'Phase 1 review',
  startsAt: '2026-09-01T14:00:00Z',
  endsAt: '2026-09-01T15:30:00Z',
  sourceVersion: 'etag-1',
  ...overrides,
})

interface ProposalRow {
  id: number
  user_id: number
  status: string
  time_entry_id: number | null
  title: string
  starts_at: string
}
interface EntryRow {
  id: number
  user_id: number
  spent_date: string
  seconds: number
  rounded_seconds: number
  started_time: string | null
  ended_time: string | null
  notes: string | null
  calendar_event_ref: string | null
}

const proposalRows = (db: TestDatabase) =>
  db.rows<ProposalRow>(
    'SELECT id, user_id, status, time_entry_id, title, starts_at FROM calendar_proposals ORDER BY id',
  )
const entryRows = (db: TestDatabase) =>
  db.rows<EntryRow>(
    `SELECT id, user_id, spent_date, seconds, rounded_seconds, started_time, ended_time, notes,
       calendar_event_ref FROM time_entries ORDER BY id`,
  )

const list = (
  repository: DrizzleCalendarProposalRepository,
  userId: number,
  filters: Parameters<DrizzleCalendarProposalRepository['proposals']>[1] = {},
) => repository.proposals(userId, filters).list({ afterId: null, throughId: 999, take: 50 })

for (const [runtime, factory] of factories) {
  describe(`calendar proposals (${runtime})`, () => {
    let database: TestDatabase | null = null

    afterEach(async () => {
      await database?.close()
      database = null
    })

    const setup = async (
      options: Parameters<typeof installFixture>[1] = {},
      resolver: TrackedPolicyResolver = policy(),
    ) => {
      database = await factory()
      await installFixture(database, options)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, resolver)
      return {
        db: database,
        tracked,
        repository: new DrizzleCalendarProposalRepository(database.orm, tracked),
      }
    }

    it('[unit] re-inserting the same provider event is a no-op that keeps a prior discard', async () => {
      const { db, repository } = await setup()
      expect(await proposeCalendarEvents(db.orm, 1, [event()], t0)).toEqual({
        inserted: 1,
        existing: 0,
      })
      const [first] = await list(repository, 1)
      await repository.discard(1, first!.id, t0)

      // The same meeting read again, edited at the source, still changes nothing.
      expect(
        await proposeCalendarEvents(
          db.orm,
          1,
          [event({ summary: 'Renamed', sourceVersion: 'etag-2' })],
          '2026-09-02T13:00:00.000Z',
        ),
      ).toEqual({ inserted: 0, existing: 1 })
      expect(await proposalRows(db)).toEqual([
        {
          id: first!.id,
          user_id: 1,
          status: 'discarded',
          time_entry_id: null,
          title: 'Phase 1 review',
          starts_at: '2026-09-01T14:00:00.000Z',
        },
      ])
      expect(await list(repository, 1)).toEqual([])
    }, 60_000)

    it('[unit] tells the instances of a recurring event, other providers and other people apart', async () => {
      const { db } = await setup()
      const outcome = await proposeCalendarEvents(
        db.orm,
        1,
        [
          event({ occurrence: '2026-09-01T14:00:00Z' }),
          event({ occurrence: '2026-09-08T14:00:00Z' }),
          event({ provider: 'microsoft' }),
          event({ summary: '   ' }),
        ],
        t0,
      )
      expect(outcome).toEqual({ inserted: 4, existing: 0 })
      expect(await proposeCalendarEvents(db.orm, 6, [event()], t0)).toEqual({
        inserted: 1,
        existing: 0,
      })
      expect((await proposalRows(db)).map(({ title }) => title)).toContain('Untitled calendar event')
    }, 60_000)

    it('[unit] cannot hold an interval that ends before it starts, or be handed to somebody else', async () => {
      const { db } = await setup()
      await expect(
        db.run(
          `INSERT INTO calendar_proposals
             (user_id, provider, calendar_id, event_id, title, starts_at, ends_at, created_at, updated_at)
           VALUES (1, 'google', 'primary', 'x', 'Backwards', ?, ?, ?, ?)`,
          '2026-09-01T15:00:00.000Z',
          '2026-09-01T14:00:00.000Z',
          t0,
          t0,
        ),
      ).rejects.toThrow()
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      await expect(db.run('UPDATE calendar_proposals SET user_id = 6')).rejects.toThrow(
        /keeps its owner and event/,
      )
    }, 60_000)

    it('[unit] in duration mode accept stores seconds only, with the reference and the title as notes', async () => {
      const { db, repository } = await setup({ mode: 'duration' })
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)

      const accepted = await repository.accept(
        maya,
        proposal!.id,
        { projectId: 1, taskId: 1 },
        at('2026-09-02T12:05:00.000Z'),
      )

      const entries = await entryRows(db)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        id: accepted.timeEntryId,
        user_id: 1,
        spent_date: '2026-09-01',
        seconds: 5_400,
        started_time: null,
        ended_time: null,
        notes: 'Phase 1 review',
      })
      expect(JSON.parse(entries[0]!.calendar_event_ref!)).toEqual({
        provider: 'google',
        event_id: 'evt-1',
        calendar_id: 'primary',
      })
      expect(accepted.proposal).toMatchObject({
        status: 'accepted',
        timeEntryId: accepted.timeEntryId,
        decidedAt: '2026-09-02T12:05:00.000Z',
      })
      expect(await list(repository, 1)).toEqual([])
    }, 60_000)

    it("[unit] in start/end mode accept stores the event's times on the owner's wall clock", async () => {
      const { db, repository } = await setup({ mode: 'start_end', mayaZone: 'America/Costa_Rica' })
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)

      await repository.accept(
        maya,
        proposal!.id,
        { projectId: 1, taskId: 1, notes: 'Review with the client' },
        at('2026-09-02T12:05:00.000Z'),
      )

      expect(await entryRows(db)).toMatchObject([
        {
          spent_date: '2026-09-01',
          started_time: '08:00',
          ended_time: '09:30',
          seconds: 5_400,
          notes: 'Review with the client',
        },
      ])
    }, 60_000)

    it('[unit] refuses a start/end event that runs past midnight and leaves it open', async () => {
      const { db, repository } = await setup({ mode: 'start_end' })
      await proposeCalendarEvents(
        db.orm,
        1,
        [event({ startsAt: '2026-09-01T23:00:00Z', endsAt: '2026-09-02T01:00:00Z' })],
        t0,
      )
      const [proposal] = await list(repository, 1)
      await expect(
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ).rejects.toMatchObject({ field: 'proposal', reasonCode: 'spans_days' })
      expect(await entryRows(db)).toEqual([])
      expect((await proposalRows(db))[0]).toMatchObject({ status: 'proposed' })
    }, 60_000)

    it('[unit] applies the organization rounding rule, because it goes through the ordinary path', async () => {
      const { db, repository } = await setup({ rounding: ['up', 15] })
      await proposeCalendarEvents(
        db.orm,
        1,
        [event({ startsAt: '2026-09-01T14:00:00Z', endsAt: '2026-09-01T14:20:00Z' })],
        t0,
      )
      const [proposal] = await list(repository, 1)
      await repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0))
      expect(await entryRows(db)).toMatchObject([{ seconds: 1_200, rounded_seconds: 1_800 }])
    }, 60_000)

    it('[security] double accept creates one entry, including two at once', async () => {
      const { db, repository } = await setup()
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)

      const outcomes = await Promise.allSettled([
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      const refused = outcomes.find(({ status }) => status === 'rejected')
      expect((refused as PromiseRejectedResult).reason).toMatchObject({
        code: 'proposal_not_open',
      })
      expect(await entryRows(db)).toHaveLength(1)

      await expect(
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ).rejects.toMatchObject({ code: 'proposal_not_open', status: 'accepted' })
      expect(await entryRows(db)).toHaveLength(1)
    }, 60_000)

    it('[security] a trigger, not the application, refuses to decide a proposal twice', async () => {
      const { db, repository } = await setup()
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)
      await repository.discard(1, proposal!.id, t0)
      await expect(
        db.run(`UPDATE calendar_proposals SET status = 'accepted' WHERE id = ?`, proposal!.id),
      ).rejects.toThrow(/not open/)
      expect((await proposalRows(db))[0]).toMatchObject({ status: 'discarded' })
    }, 60_000)

    it('[security] a locked day refuses the accept and the proposal stays open', async () => {
      const { db, repository } = await setup({}, policy(new Set(['2026-09-01'])))
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)
      await expect(
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ).rejects.toMatchObject({ code: 'tracked_mutation_locked' })
      expect(await entryRows(db)).toEqual([])
      expect((await proposalRows(db))[0]).toMatchObject({ status: 'proposed', time_entry_id: null })
    }, 60_000)

    it('[security] an unassigned task refuses the accept and the proposal stays open', async () => {
      const { db, repository } = await setup()
      await proposeCalendarEvents(db.orm, 6, [event()], t0)
      const [proposal] = await list(repository, 6)
      await expect(
        repository.accept(milo, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ).rejects.toMatchObject({ code: 'project_assignment_required' })
      expect(await entryRows(db)).toEqual([])
      expect((await proposalRows(db))[0]).toMatchObject({ status: 'proposed' })
    }, 60_000)

    it("[security] keeps everyone to their own proposals, administrators included", async () => {
      const { db, repository } = await setup()
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [mine] = await list(repository, 1)

      for (const actor of [milo, ada]) {
        expect(await list(repository, actor.userId)).toEqual([])
        await expect(repository.get(actor.userId, mine!.id)).rejects.toMatchObject({
          code: 'calendar_proposal_not_found',
        })
        await expect(repository.discard(actor.userId, mine!.id, t0)).rejects.toMatchObject({
          code: 'calendar_proposal_not_found',
        })
        await expect(
          repository.accept(actor, mine!.id, { projectId: 1, taskId: 1 }, at(t0)),
        ).rejects.toMatchObject({ code: 'calendar_proposal_not_found' })
      }
      expect(await entryRows(db)).toEqual([])
      expect((await proposalRows(db))[0]).toMatchObject({ status: 'proposed' })
    }, 60_000)

    it('[unit] discard decides once and an accepted or discarded proposal cannot be accepted', async () => {
      const { db, repository } = await setup()
      await proposeCalendarEvents(db.orm, 1, [event()], t0)
      const [proposal] = await list(repository, 1)
      expect(await repository.discard(1, proposal!.id, t0)).toMatchObject({ status: 'discarded' })
      await expect(repository.discard(1, proposal!.id, t0)).rejects.toMatchObject({
        code: 'proposal_not_open',
        status: 'discarded',
      })
      await expect(
        repository.accept(maya, proposal!.id, { projectId: 1, taskId: 1 }, at(t0)),
      ).rejects.toMatchObject({ code: 'proposal_not_open', status: 'discarded' })
      expect(await entryRows(db)).toEqual([])
    }, 60_000)

    it("[unit] lists a week on the owner's local days, and what has been decided only on request", async () => {
      const { db, repository } = await setup({ mayaZone: 'America/Costa_Rica' })
      await proposeCalendarEvents(
        db.orm,
        1,
        [
          // 20:00 on Sunday 30 August in Costa Rica (UTC-6): the week before.
          event({ eventId: 'before', startsAt: '2026-08-31T02:00:00Z', endsAt: '2026-08-31T03:00:00Z' }),
          // 19:00 on Sunday 6 September local: still inside the week of the 31st.
          event({ eventId: 'inside', startsAt: '2026-09-07T01:00:00Z', endsAt: '2026-09-07T02:00:00Z' }),
          // 06:00 on Monday 7 September local: the next week.
          event({ eventId: 'after', startsAt: '2026-09-07T12:00:00Z', endsAt: '2026-09-07T13:00:00Z' }),
        ],
        t0,
      )
      const week = { from: '2026-08-31', to: '2026-09-06' }
      expect((await list(repository, 1, week)).map(({ eventId }) => eventId)).toEqual(['inside'])

      const [inside] = await list(repository, 1, week)
      await repository.discard(1, inside!.id, t0)
      expect(await list(repository, 1, week)).toEqual([])
      expect(
        (await list(repository, 1, { ...week, status: 'discarded' })).map(({ eventId }) => eventId),
      ).toEqual(['inside'])
    }, 60_000)
  })
}
