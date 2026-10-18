import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { prepareTimeReminders } from '../src/time-reminders.js'

/**
 * Issue 935, against a real migrated database on both runtimes.
 *
 * A reminder is a decision made in somebody else's local time, at an hour
 * nobody is watching, and it must be made once. Each case is a way a person
 * gets a reminder they should not, misses one they should, or gets it twice.
 */

interface Harness {
  orm: InvoiceStateDatabase
  run(statement: string, ...bindings: unknown[]): Promise<void>
  rows<T>(statement: string): Promise<T[]>
  close(): Promise<void>
}

const seedAt = '2026-10-01T09:00:00.000Z'
const from = { email: 'notifications@example.test', name: 'CONFLICT' }
const appUrl = 'https://time.example.test'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (statement, ...bindings) => void sqlite.prepare(statement).run(...bindings),
    rows: async <T>(statement: string) => sqlite.prepare(statement).all() as T[],
    close: async () => void sqlite.close(),
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
    orm: createD1Database(database),
    run: async (statement, ...bindings) =>
      void (await database.prepare(statement).bind(...bindings).run()),
    rows: async <T>(statement: string) =>
      ((await database.prepare(statement).all()).results ?? []) as T[],
    close: async () => miniflare.dispose(),
  }
}

/**
 * Costa Rica is UTC-6 all year; Warsaw is UTC+2 until 25 October. Ada
 * administers, Pia manages Mo, Mo works from Warsaw, Lee has no zone of his own
 * and so keeps the organization's.
 */
const seed = async (db: Harness): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, timezone, week_start_day, created_at, updated_at)
     VALUES ('CONFLICT', '{"approval":true}', 'America/Costa_Rica', 'monday', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, timezone, created_at, updated_at) VALUES
       (1, 'Ada', 'Admin', 'administrator', '[]', 'UTC', ?, ?),
       (2, 'Pia', 'Manager', 'project_manager', '[]', 'UTC', ?, ?),
       (3, 'Mo', 'Member', 'member', '[]', 'Europe/Warsaw', ?, ?),
       (4, 'Lee', 'Member', 'member', '[]', 'UTC', ?, ?),
       (5, 'Nia', 'NoMail', 'member', '[]', 'UTC', ?, ?)`,
    ...Array.from({ length: 10 }, () => seedAt),
  )
  await db.run(
    `INSERT INTO user_emails (user_id, address, is_primary, verified_at, created_at, updated_at) VALUES
       (1, 'ada@example.test', 1, ?, ?, ?),
       (2, 'pia@example.test', 1, ?, ?, ?),
       (3, 'mo@example.test', 1, ?, ?, ?),
       (4, 'lee@example.test', 1, ?, ?, ?)`,
    ...Array.from({ length: 12 }, () => seedAt),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Kestrel', 'USD', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Site survey', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Field', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 3, 0, ?, ?), (3, 1, 4, 0, ?, ?)`,
    ...Array.from({ length: 6 }, () => seedAt),
  )
  await db.run(`INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
    VALUES (2, 3, '${seedAt}', '${seedAt}')`)
}

/** Daily reminder on weekdays at 17:00 local, by email. */
const daily = (db: Harness, userId: number, time = '17:00') =>
  db.run(
    `UPDATE notification_preferences SET daily_reminder_enabled = 1, email_enabled = 1,
       reminder_time = ?, reminder_days = '["monday","tuesday","wednesday","thursday","friday"]'
     WHERE user_id = ?`,
    time,
    userId,
  )

const assignmentOf: Record<number, number> = { 2: 1, 3: 2, 4: 3 }

const track = (db: Harness, userId: number, hours: number, date: string) => {
  const seconds = Math.round(hours * 3600)
  return db.run(
    `INSERT INTO time_entries (user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
     VALUES (?, 1, 1, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
    userId,
    assignmentOf[userId],
    date,
    seconds,
    seconds,
    seconds,
    seedAt,
    seedAt,
  )
}

/** Submits a week the way the product does: the submission row marks the entries. */
const submitWeek = (db: Harness, userId: number, start: string, end: string) =>
  db.run(
    `INSERT INTO timesheet_submissions (user_id, period_start, period_end, status,
       submitted_by_user_id, submitted_at, version, created_at, updated_at)
     VALUES (?, ?, ?, 'submitted', ?, ?, 0, ?, ?)`,
    userId,
    start,
    end,
    userId,
    seedAt,
    seedAt,
    seedAt,
  )

const ledger = (db: Harness) =>
  db.rows<{ kind: string; user_id: number; period: string; outcome: string; skip_reason: string | null }>(
    `SELECT kind, user_id, period, outcome, skip_reason FROM notification_deliveries ORDER BY id`,
  )

const run = (db: Harness, now: string) => prepareTimeReminders(db.orm, { now, from, appUrl })

// Wednesday 14 October. 15:30Z is 17:30 in Warsaw (UTC+2) and 09:30 in Costa Rica.
const wednesday = '2026-10-14T15:30:00.000Z'

for (const [name, factory] of [
  ['SQLite', container],
  ['real D1', d1],
] as const) {
  describe(`daily time reminder (${name})`, () => {
    let db: Harness | undefined
    afterEach(async () => db?.close())

    const open = async (): Promise<Harness> => {
      db = await factory()
      await seed(db)
      return db
    }

    it('[unit] reminds somebody who has tracked less than a usual day, at their own local time, once', async () => {
      const test = await open()
      await daily(test, 3)
      // Lee is due at 17:00 too, but in Costa Rica, where it is half past nine.
      await daily(test, 4)
      await track(test, 3, 2, '2026-10-14')

      const sent = await run(test, wednesday)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        to: { email: 'mo@example.test', name: 'Mo Member' },
        template: 'time_reminder:v1',
        from,
      })
      expect(sent[0]!.subject).toBe('Time reminder: log your hours for Wednesday, October 14')
      expect(sent[0]!.text).toContain('logged 2 hours')
      expect(sent[0]!.text).toContain('usual 7 hours')
      expect(sent[0]!.text).toContain('https://time.example.test/settings/user')
      expect(await ledger(test)).toEqual([
        { kind: 'daily_time_reminder', user_id: 3, period: '2026-10-14', outcome: 'queued', skip_reason: null },
      ])
      expect(await test.rows('SELECT status, related_type FROM email_log')).toEqual([
        { status: 'queued', related_type: null },
      ])

      // A minute later, and again: decided for the day.
      expect(await run(test, '2026-10-14T15:31:00.000Z')).toEqual([])
      expect(await run(test, '2026-10-14T15:32:00.000Z')).toEqual([])
      expect(await test.rows('SELECT count(*) AS n FROM email_log')).toEqual([{ n: 1 }])

      // Lee's 17:00 comes at 23:00Z.
      const lee = await run(test, '2026-10-14T23:00:00.000Z')
      expect(lee.map((message) => message.to.email)).toEqual(['lee@example.test'])
    })

    it('[unit] does not remind somebody who has tracked enough, and says so once', async () => {
      const test = await open()
      await daily(test, 3)
      await track(test, 3, 7, '2026-10-14')
      expect(await run(test, wednesday)).toEqual([])
      expect(await ledger(test)).toEqual([
        { kind: 'daily_time_reminder', user_id: 3, period: '2026-10-14', outcome: 'skipped', skip_reason: 'enough_tracked' },
      ])
      // Time deleted afterwards does not reopen a decided day.
      await test.run('DELETE FROM time_entries')
      expect(await run(test, '2026-10-14T15:45:00.000Z')).toEqual([])
    })

    it('[unit] counts a running timer as it runs', async () => {
      const test = await open()
      await daily(test, 3)
      await track(test, 3, 6, '2026-10-14')
      // Started 90 minutes ago: 6h banked plus 1.5h running is 7.5h, over the usual 7.
      await test.run(
        `INSERT INTO time_entries (user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, timer_started_at,
           created_at, updated_at)
         VALUES (3, 1, 1, 2, 1, '2026-10-14', 0, 0, 0, 1, '2026-10-14T14:00:00.000Z', ?, ?)`,
        seedAt,
        seedAt,
      )
      expect(await run(test, wednesday)).toEqual([])
      expect((await ledger(test))[0]?.skip_reason).toBe('enough_tracked')
    })

    it('[unit] waits for the time, skips a day that was not chosen, and never mails at midnight', async () => {
      const test = await open()
      await daily(test, 3)
      // 16:59 in Warsaw.
      expect(await run(test, '2026-10-14T14:59:00.000Z')).toEqual([])
      expect(await ledger(test)).toEqual([])
      // Saturday 17:30 in Warsaw: not a reminder day.
      expect(await run(test, '2026-10-17T15:30:00.000Z')).toEqual([])
      expect(await ledger(test)).toEqual([])
      // A sweep that only arrives at 20:00 in Warsaw has missed the window.
      expect(await run(test, '2026-10-14T18:00:00.000Z')).toEqual([])
      expect(await ledger(test)).toEqual([
        { kind: 'daily_time_reminder', user_id: 3, period: '2026-10-14', outcome: 'skipped', skip_reason: 'late' },
      ])
    })

    it('[unit] reads zero capacity as "nothing tracked at all"', async () => {
      const test = await open()
      await daily(test, 3)
      await test.run('UPDATE users SET weekly_capacity = 0 WHERE id = 3')
      await track(test, 3, 0.5, '2026-10-14')
      expect(await run(test, wednesday)).toEqual([])
      expect((await ledger(test))[0]?.skip_reason).toBe('enough_tracked')

      await test.run('DELETE FROM time_entries')
      await test.run('DELETE FROM notification_deliveries')
      expect(await run(test, '2026-10-14T15:40:00.000Z')).toHaveLength(1)
    })

    it('[unit] reminds only people who switched it on, by email, and who can be reached', async () => {
      const test = await open()
      await daily(test, 3)
      await daily(test, 5)
      // An imported desktop-only preference: stored, but there is nothing to deliver it by.
      await test.run(
        'UPDATE notification_preferences SET desktop_enabled = 1, email_enabled = 0 WHERE user_id = 3',
      )
      await test.run('UPDATE users SET is_active = 0 WHERE id = 4')
      await daily(test, 4)
      // Mo has the channel off, Nia has no address, Lee is deactivated.
      expect(await run(test, wednesday)).toEqual([])
      expect(await run(test, '2026-10-14T23:00:00.000Z')).toEqual([])
      expect(await ledger(test)).toEqual([])
    })

    it('[unit] queues a recorded reminder again from the record when it never left the queue', async () => {
      const test = await open()
      await daily(test, 3)
      const [first] = await run(test, wednesday)
      // 15:40 is a ten-minute mark and the record is over five minutes old.
      const again = await run(test, '2026-10-14T15:40:00.000Z')
      expect(again.map((message) => message.deliveryId)).toEqual([first!.deliveryId])
      expect(again[0]!.text).toBe(first!.text)
      expect(await test.rows('SELECT count(*) AS n FROM email_log')).toEqual([{ n: 1 }])

      // Once the log says it was sent, there is nothing to queue.
      await test.run(
        `UPDATE email_log SET status = 'sent', provider = 'smtp', provider_message_id = 'm-1' WHERE id = ?`,
        first!.deliveryId,
      )
      expect(await run(test, '2026-10-14T15:50:00.000Z')).toEqual([])
    })
  })

  describe(`week-end submission reminder and manager digest (${name})`, () => {
    let db: Harness | undefined
    afterEach(async () => db?.close())

    // Monday 19 October: 09:00 in Warsaw is 07:00Z, 09:00 in Costa Rica is 15:00Z.
    const mondayInWarsaw = '2026-10-19T07:00:00.000Z'
    const mondayInCostaRica = '2026-10-19T15:00:00.000Z'

    const open = async (): Promise<Harness> => {
      db = await factory()
      await seed(db)
      await db.run(
        `UPDATE organizations SET submission_reminder_day = 'monday', submission_reminder_time = '09:00'`,
      )
      return db
    }

    it('[unit] reminds, on Monday morning local time, those with last week still unsubmitted', async () => {
      const test = await open()
      await track(test, 3, 5, '2026-10-14')
      await track(test, 3, 8, '2026-10-16')
      await track(test, 4, 6, '2026-10-15')
      // Pia has submitted hers.
      await track(test, 2, 6, '2026-10-15')
      await submitWeek(test, 2, '2026-10-12', '2026-10-18')

      const warsaw = await run(test, mondayInWarsaw)
      expect(warsaw.map((message) => message.to.email)).toEqual(['mo@example.test'])
      expect(warsaw[0]!.subject).toBe('Timesheet reminder: submit your week of Monday, October 12')
      expect(warsaw[0]!.text).toContain('Monday, October 12 to Sunday, October 18')
      expect(warsaw[0]!.template).toBe('submission_reminder:v1')

      // Lee, in Costa Rica, has the same Monday morning six hours later.
      const costaRica = await run(test, mondayInCostaRica)
      expect(costaRica.map((message) => message.to.email)).toEqual(['lee@example.test'])

      // Decided for the week; Pia, who submitted, and Ada, who has nothing, were not mailed.
      expect(await run(test, '2026-10-19T15:01:00.000Z')).toEqual([])
      const decided = (await ledger(test)).filter((row) => row.kind === 'submission_reminder')
      expect(decided.every((row) => row.period === '2026-10-12')).toBe(true)
      expect(decided.filter((row) => row.outcome === 'queued').map((row) => row.user_id).sort()).toEqual([3, 4])
      expect(
        decided.filter((row) => row.skip_reason === 'nothing_to_submit').map((row) => row.user_id).sort(),
      ).toEqual([1, 2])
    })

    it('[unit] reminds about the week now ending when the schedule is late in the week', async () => {
      const test = await open()
      await test.run(
        `UPDATE organizations SET submission_reminder_day = 'friday', submission_reminder_time = '16:00'`,
      )
      await track(test, 3, 5, '2026-10-14')
      // Friday 16 October 16:00 in Warsaw is 14:00Z: the week of 12 October is the one ending.
      const sent = await run(test, '2026-10-16T14:00:00.000Z')
      expect(sent.map((message) => message.to.email)).toEqual(['mo@example.test'])
      expect(sent[0]!.text).toContain('Monday, October 12 to Sunday, October 18')
    })

    it('[unit] honours the opt-out, the Approval module and an unset schedule', async () => {
      const test = await open()
      await track(test, 3, 5, '2026-10-14')
      await test.run('UPDATE notification_preferences SET include_in_team_reminders = 0 WHERE user_id = 3')
      expect(await run(test, mondayInWarsaw)).toEqual([])

      await test.run('UPDATE notification_preferences SET include_in_team_reminders = 1 WHERE user_id = 3')
      await test.run(`UPDATE organizations SET modules = '{"approval":false}'`)
      expect(await run(test, mondayInWarsaw)).toEqual([])

      await test.run(`UPDATE organizations SET modules = '{"approval":true}'`)
      await test.run(
        `UPDATE organizations SET submission_reminder_day = NULL, submission_reminder_time = NULL`,
      )
      expect(await run(test, mondayInWarsaw)).toEqual([])
      expect(await ledger(test)).toEqual([])
    })

    it('[unit] new people start opted in to team reminders', async () => {
      const test = await open()
      expect(
        await test.rows('SELECT user_id, include_in_team_reminders AS v FROM notification_preferences ORDER BY user_id'),
      ).toEqual([1, 2, 3, 4, 5].map((user_id) => ({ user_id, v: 1 })))
    })

    it('[unit] refuses half a schedule', async () => {
      const test = await open()
      await expect(
        test.run(`UPDATE organizations SET submission_reminder_time = NULL`),
      ).rejects.toThrow()
    })

    it('[unit] tells a manager who of the people they approve has not submitted, and nobody when all have', async () => {
      const test = await open()
      await test.run('UPDATE notification_preferences SET weekly_digest = 1 WHERE user_id IN (1, 2, 3)')
      await track(test, 3, 5, '2026-10-14')
      await track(test, 4, 4, '2026-10-15')

      const digests = await run(test, '2026-10-19T15:00:00.000Z')
      const byEmail = new Map(digests.map((message) => [message.to.email, message]))
      // Pia approves Mo only; Ada approves everybody (Lee included, but not herself).
      expect(byEmail.get('pia@example.test')!.text).toContain('- Mo Member')
      expect(byEmail.get('pia@example.test')!.text).not.toContain('Lee Member')
      expect(byEmail.get('ada@example.test')!.text).toContain('- Lee Member')
      expect(byEmail.get('ada@example.test')!.text).toContain('- Mo Member')
      expect(byEmail.get('ada@example.test')!.subject).toBe('Timesheet digest: 2 people have not submitted')
      // Mo is a member, not an approver: his digest preference does nothing.
      expect(byEmail.has('mo@example.test')).toBe(false)

      // Everybody submitted: no digest, one recorded skip.
      const quiet = await factory()
      try {
        await seed(quiet)
        await quiet.run(
          `UPDATE organizations SET submission_reminder_day = 'monday', submission_reminder_time = '09:00'`,
        )
        await quiet.run('UPDATE notification_preferences SET weekly_digest = 1 WHERE user_id = 1')
        await track(quiet, 3, 5, '2026-10-14')
        await submitWeek(quiet, 3, '2026-10-12', '2026-10-18')
        expect((await run(quiet, '2026-10-19T15:00:00.000Z')).map((message) => message.template)).not.toContain(
          'submission_digest:v1',
        )
        expect((await ledger(quiet)).filter((row) => row.kind === 'submission_digest')).toEqual([
          { kind: 'submission_digest', user_id: 1, period: '2026-10-12', outcome: 'skipped', skip_reason: 'everyone_submitted' },
        ])
      } finally {
        await quiet.close()
      }
    })
  })
}

/**
 * Migration 0114 on a database that already has people, which is every
 * deployment it will run on. The cases above only see people added after it,
 * through the trigger it recreates.
 */
const before0114 = '0113_project_budget_alerts'

interface UpgradeHarness {
  run(statement: string, ...bindings: unknown[]): Promise<void>
  rows<T>(statement: string): Promise<T[]>
  /** Applies what is pending, the way a deploy does. */
  upgrade(): Promise<void>
  close(): Promise<void>
}

const containerBefore0114 = async (): Promise<UpgradeHarness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainerThrough(sqlite, before0114)
  return {
    run: async (statement, ...bindings) => void sqlite.prepare(statement).run(...bindings),
    rows: async <T>(statement: string) => sqlite.prepare(statement).all() as T[],
    upgrade: async () => migrateContainer(sqlite),
    close: async () => void sqlite.close(),
  }
}

const d1Before0114 = async (): Promise<UpgradeHarness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1Through(database, before0114)
  return {
    run: async (statement, ...bindings) =>
      void (await database.prepare(statement).bind(...bindings).run()),
    rows: async <T>(statement: string) =>
      ((await database.prepare(statement).all()).results ?? []) as T[],
    upgrade: () => migrateD1(database),
    close: async () => miniflare.dispose(),
  }
}

for (const [name, factory] of [
  ['SQLite', containerBefore0114],
  ['real D1', d1Before0114],
] as const) {
  describe(`migration 0114 (${name})`, () => {
    let db: UpgradeHarness | undefined
    afterEach(async () => db?.close())

    it('[unit] opts in the people already there, and switches nothing else on', async () => {
      db = await factory()
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at)
         VALUES ('CONFLICT', '{"approval":true}', ?, ?)`,
        seedAt,
        seedAt,
      )
      await db.run(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES
           (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
           (2, 'Mo', 'Member', 'member', '[]', ?, ?)`,
        ...Array.from({ length: 4 }, () => seedAt),
      )
      const preferences = () =>
        db!.rows(
          `SELECT user_id, include_in_team_reminders AS team, daily_reminder_enabled AS daily,
             email_enabled AS email, weekly_digest AS digest
           FROM notification_preferences ORDER BY user_id`,
        )
      // Before it: the zero the delivery-unavailable rule forced on everybody.
      expect(await preferences()).toEqual([
        { user_id: 1, team: 0, daily: 0, email: 0, digest: 0 },
        { user_id: 2, team: 0, daily: 0, email: 0, digest: 0 },
      ])

      await db.upgrade()

      // In, so that opting out is a choice somebody makes; nothing else is on.
      expect(await preferences()).toEqual([
        { user_id: 1, team: 1, daily: 0, email: 0, digest: 0 },
        { user_id: 2, team: 1, daily: 0, email: 0, digest: 0 },
      ])
      // No schedule until an administrator sets one: the upgrade alone
      // reminds nobody.
      expect(
        await db.rows(
          'SELECT submission_reminder_day AS day, submission_reminder_time AS time FROM organizations',
        ),
      ).toEqual([{ day: null, time: null }])
      // Somebody added afterwards starts in as well, through the new trigger.
      await db.run(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (3, 'Lee', 'Member', 'member', '[]', ?, ?)`,
        seedAt,
        seedAt,
      )
      expect((await preferences()).at(-1)).toEqual({ user_id: 3, team: 1, daily: 0, email: 0, digest: 0 })
    })
  })
}
