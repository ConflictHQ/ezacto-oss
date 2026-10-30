import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  evaluateProjectBudgetAlerts,
  prepareBudgetAlertMail,
} from '../src/project-budget-alerts.js'

/**
 * Issue 934, against a real migrated database on both runtimes.
 *
 * The thing under test is a decision the product has to make by itself, at an
 * hour nobody is watching: has this project crossed its line, is that a new
 * crossing, and who is told. Every case is a way an alert goes missing or goes
 * out twice.
 */

interface Harness {
  orm: InvoiceStateDatabase
  run(statement: string, ...bindings: unknown[]): Promise<void>
  rows<T>(statement: string): Promise<T[]>
  close(): Promise<void>
}

const seedAt = '2026-10-01T09:00:00.000Z'
const from = { email: 'notifications@example.test', name: 'CONFLICT' }

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const orm = createContainerDatabase(sqlite)
  return {
    orm,
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
 * One organization, an administrator, a project manager and a member, and a
 * project with a 100 hour budget that alerts at 85%. Project 1 has two tasks so
 * the same fixture serves the task-budget case.
 */
const seed = async (db: Harness): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, timezone, created_at, updated_at)
     VALUES ('CONFLICT', '{}', 'America/Costa_Rica', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES
       (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
       (2, 'Pia', 'Manager', 'project_manager', '[]', ?, ?),
       (3, 'Mo', 'Member', 'member', '[]', ?, ?)`,
    ...Array.from({ length: 6 }, () => seedAt),
  )
  await db.run(
    `INSERT INTO user_emails (user_id, address, is_primary, verified_at, created_at, updated_at) VALUES
       (1, 'ada@example.test', 1, ?, ?, ?),
       (2, 'pia@example.test', 1, ?, ?, ?),
       (3, 'mo@example.test', 1, ?, ?, ?)`,
    ...Array.from({ length: 9 }, () => seedAt),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Kestrel Environmental', 'USD', ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, budget_by, budget_seconds, notify_when_over_budget,
                           over_budget_pct, created_at, updated_at)
     VALUES (1, 1, 'Site survey', 'project', 360000, 1, 85, ?, ?)`,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Field', ?, ?), (2, 'Report', ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?), (2, 1, 2, 1, ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 3, 0, ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
}

/** Budgeted time against project 1, from the member (assignment 2). */
const track = async (
  db: Harness,
  hours: number,
  date: string,
  task = 1,
  billableRateCents: number | null = null,
  costRateCents: number | null = null,
): Promise<void> => {
  const seconds = Math.round(hours * 3600)
  await db.run(
    `INSERT INTO time_entries (user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at)
     VALUES (3, 1, ?, 2, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    task,
    task,
    date,
    seconds,
    seconds,
    seconds,
    billableRateCents,
    costRateCents,
    seedAt,
    seedAt,
  )
}

const alerts = (db: Harness) =>
  db.rows<{ id: number; period: string; unit: string; closed_at: string | null }>(
    'SELECT id, period, unit, closed_at FROM project_budget_alerts ORDER BY id',
  )
const events = (db: Harness) =>
  db.rows<{ event_type: string; aggregate_id: number; aggregate_sequence: number }>(
    `SELECT event_type, aggregate_id, aggregate_sequence FROM event_outbox
     WHERE event_type = 'project.budget_alert' ORDER BY aggregate_sequence`,
  )

// Wednesday, mid morning in Costa Rica.
const now = '2026-10-14T16:00:00.000Z'

for (const [name, factory] of [
  ['SQLite', container],
  ['real D1', d1],
] as const) {
  describe(`project budget alerts (${name})`, () => {
    let db: Harness | undefined
    afterEach(async () => db?.close())

    const open = async (): Promise<Harness> => {
      db = await factory()
      await seed(db)
      return db
    }

    it('[unit] stays quiet under the threshold and alerts once when it is reached', async () => {
      const test = await open()
      await track(test, 84, '2026-10-05')
      expect(await evaluateProjectBudgetAlerts(test.orm, now)).toEqual({ opened: [], closed: 0 })

      // 85% of 100 hours is exactly 85 hours: the line is inclusive.
      await track(test, 1, '2026-10-06')
      const crossed = await evaluateProjectBudgetAlerts(test.orm, now)
      expect(crossed.opened).toHaveLength(1)
      expect(crossed.opened[0]?.projectId).toBe(1)

      // Evaluating again, or after more time, is the same crossing.
      await track(test, 5, '2026-10-07')
      expect(await evaluateProjectBudgetAlerts(test.orm, now)).toEqual({ opened: [], closed: 0 })
      expect(await alerts(test)).toEqual([
        { id: crossed.opened[0]!.alertId, period: 'lifetime', unit: 'seconds', closed_at: null },
      ])
      expect(await events(test)).toEqual([
        { event_type: 'project.budget_alert', aggregate_id: 1, aggregate_sequence: 1 },
      ])
      // Harvest's own field, in the organization's day.
      expect(
        await test.rows<{ over_budget_notified_on: string }>(
          'SELECT over_budget_notified_on FROM projects WHERE id = 1',
        ),
      ).toEqual([{ over_budget_notified_on: '2026-10-14' }])
    })

    it('[unit] alerts again for a new crossing after usage falls back under the line', async () => {
      const test = await open()
      await track(test, 90, '2026-10-05')
      const first = await evaluateProjectBudgetAlerts(test.orm, now)
      expect(first.opened).toHaveLength(1)

      // The time is deleted, or the budget raised: the crossing is over.
      await test.run('DELETE FROM time_entries')
      expect(await evaluateProjectBudgetAlerts(test.orm, now)).toMatchObject({ opened: [], closed: 1 })

      await track(test, 95, '2026-10-08')
      const second = await evaluateProjectBudgetAlerts(test.orm, now)
      expect(second.opened).toHaveLength(1)
      expect(second.opened[0]!.alertId).not.toBe(first.opened[0]!.alertId)
      expect((await events(test)).map((event) => event.aggregate_sequence)).toEqual([1, 2])
    })

    it('[unit] treats an unset threshold as 100% and never alerts on a zero budget', async () => {
      const test = await open()
      await test.run('UPDATE projects SET over_budget_pct = NULL WHERE id = 1')
      await track(test, 99, '2026-10-05')
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(0)
      await track(test, 1, '2026-10-06')
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(1)

      await test.run('DELETE FROM project_budget_alerts')
      await test.run('UPDATE projects SET budget_seconds = 0 WHERE id = 1')
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(0)
    })

    it('[unit] reads a monthly budget over the current month in the organization zone', async () => {
      const test = await open()
      await test.run('UPDATE projects SET budget_is_monthly = 1 WHERE id = 1')
      // Plenty of time last month, little this month: lifetime spend is not the measure.
      await track(test, 200, '2026-09-10')
      await track(test, 10, '2026-10-02')
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(0)

      await track(test, 80, '2026-10-09')
      const october = await evaluateProjectBudgetAlerts(test.orm, now)
      expect(october.opened).toHaveLength(1)
      expect((await alerts(test))[0]?.period).toBe('2026-10')

      // 02:00 UTC on 1 November is still 31 October in Costa Rica.
      expect(
        await evaluateProjectBudgetAlerts(test.orm, '2026-11-01T02:00:00.000Z'),
      ).toEqual({ opened: [], closed: 0 })

      // Into November: nothing tracked yet, so the October alert closes...
      const rolled = await evaluateProjectBudgetAlerts(test.orm, '2026-11-02T16:00:00.000Z')
      expect(rolled).toEqual({ opened: [], closed: 1 })
      // ...and a crossing in November is a new alert in its own right.
      await track(test, 90, '2026-11-03')
      const november = await evaluateProjectBudgetAlerts(test.orm, '2026-11-04T16:00:00.000Z')
      expect(november.opened).toHaveLength(1)
      expect((await alerts(test)).map((alert) => alert.period)).toEqual(['2026-10', '2026-11'])
    })

    it('[unit] sums only the tasks that carry a budget when budgeted by task', async () => {
      const test = await open()
      await test.run(`UPDATE projects SET budget_by = 'task' WHERE id = 1`)
      await test.run('UPDATE task_assignments SET budget_seconds = 36000 WHERE id = 1')
      // Task 2 has no budget: its 500 hours are not spending against anything.
      await track(test, 500, '2026-10-05', 2)
      await track(test, 8, '2026-10-05', 1)
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(0)
      await track(test, 1, '2026-10-06', 1)
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(1)
    })

    it('[unit] alerts on cost for a cost budget, with expenses when the project includes them', async () => {
      const test = await open()
      await test.run(
        `UPDATE projects SET budget_by = 'project_cost', cost_budget_cents = 100000,
           cost_budget_include_expenses = 1 WHERE id = 1`,
      )
      // 10 hours at $60 cost: $600 of the $1,000 budget.
      await track(test, 10, '2026-10-05', 1, 12000, 6000)
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(0)
      await test.run(
        `INSERT INTO expense_categories (id, name, created_at, updated_at) VALUES (1, 'Travel', ?, ?)`,
        seedAt,
        seedAt,
      )
      await test.run(
        `INSERT INTO expenses (user_id, project_id, expense_category_id, spent_date, total_cost_cents,
           billable, created_at, updated_at) VALUES (3, 1, 1, '2026-10-06', 25000, 1, ?, ?)`,
        seedAt,
        seedAt,
      )
      const crossed = await evaluateProjectBudgetAlerts(test.orm, now)
      expect(crossed.opened).toHaveLength(1)
      expect((await alerts(test))[0]?.unit).toBe('cents')
    })

    it('[unit] evaluates nothing, and closes what is open, once alerts are switched off', async () => {
      const test = await open()
      await track(test, 90, '2026-10-05')
      expect((await evaluateProjectBudgetAlerts(test.orm, now)).opened).toHaveLength(1)

      await test.run('UPDATE projects SET notify_when_over_budget = 0 WHERE id = 1')
      expect(await evaluateProjectBudgetAlerts(test.orm, now)).toEqual({ opened: [], closed: 1 })
      expect(await evaluateProjectBudgetAlerts(test.orm, now)).toEqual({ opened: [], closed: 0 })
      expect(await events(test)).toHaveLength(1)
    })

    it('[unit] opens one alert when two evaluators race the same crossing', async () => {
      const test = await open()
      await track(test, 90, '2026-10-05')
      const [one, two] = await Promise.all([
        evaluateProjectBudgetAlerts(test.orm, now),
        evaluateProjectBudgetAlerts(test.orm, now),
      ])
      expect(one.opened.length + two.opened.length).toBe(1)
      expect(await alerts(test)).toHaveLength(1)
      expect(await events(test)).toHaveLength(1)
    })
  })

  describe(`budget alert mail (${name})`, () => {
    let db: Harness | undefined
    afterEach(async () => db?.close())

    const crossed = async (): Promise<{ test: Harness; alertId: number }> => {
      db = await factory()
      await seed(db)
      await track(db, 90, '2026-10-05')
      const { opened } = await evaluateProjectBudgetAlerts(db.orm, now)
      return { test: db, alertId: opened[0]!.alertId }
    }
    const prepare = (test: Harness, alertId: number, at = now) =>
      prepareBudgetAlertMail(test.orm, { alertId, from, now: at })

    it('[unit] tells the project manager, once, and records it in the email log', async () => {
      const { test, alertId } = await crossed()
      const messages = await prepare(test, alertId)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        to: { email: 'pia@example.test', name: 'Pia Manager' },
        template: 'budget_alert:v1',
        related: { type: 'project', id: 1 },
      })
      expect(messages[0]!.subject).toBe('Budget alert: Site survey has used 90% of its hours budget')
      expect(messages[0]!.text).toContain('Used: 90 hours')
      expect(await test.rows('SELECT status, related_type FROM email_log')).toEqual([
        { status: 'queued', related_type: 'project' },
      ])

      // The outbox redelivers the event: the same message comes back to queue,
      // and nothing new is recorded or composed.
      const again = await prepare(test, alertId)
      expect(again.map((message) => message.deliveryId)).toEqual([messages[0]!.deliveryId])
      expect(await test.rows('SELECT count(*) AS n FROM email_log')).toEqual([{ n: 1 }])
      expect(await test.rows('SELECT count(*) AS n FROM notification_deliveries')).toEqual([{ n: 1 }])

      // Once the log says the message left the queue, a redelivery has nothing to do.
      await test.run(`UPDATE email_log SET status = 'sent', provider = 'smtp', provider_message_id = 'm-1' WHERE id = ?`, messages[0]!.deliveryId)
      expect(await prepare(test, alertId)).toEqual([])
    })

    it('[unit] sends nothing when alerts are turned off between the crossing and the delivery', async () => {
      const { test, alertId } = await crossed()
      await test.run('UPDATE projects SET notify_when_over_budget = 0 WHERE id = 1')
      expect(await prepare(test, alertId)).toEqual([])
      expect(await test.rows('SELECT count(*) AS n FROM email_log')).toEqual([{ n: 0 }])
    })

    it('[unit] sends nothing for a crossing that no longer holds', async () => {
      const { test, alertId } = await crossed()
      await test.run('DELETE FROM time_entries')
      await evaluateProjectBudgetAlerts(test.orm, now)
      expect(await prepare(test, alertId)).toEqual([])
    })

    it('[unit] mails administrators only when the company setting is on, or when nobody manages the project', async () => {
      const { test, alertId } = await crossed()
      await test.run('UPDATE organizations SET budget_alerts_include_admins = 1')
      const withAdmins = await prepare(test, alertId)
      expect(withAdmins.map((message) => message.to.email).sort()).toEqual([
        'ada@example.test',
        'pia@example.test',
      ])

      // Setting off, but the project has no manager to tell: an alert never goes to nobody.
      db = await factory()
      await seed(db)
      await db.run('UPDATE user_assignments SET is_project_manager = 0')
      await track(db, 90, '2026-10-05')
      const { opened } = await evaluateProjectBudgetAlerts(db.orm, now)
      const fallback = await prepare(db, opened[0]!.alertId)
      expect(fallback.map((message) => message.to.email)).toEqual(['ada@example.test'])
    })

    it('[security] shows a project manager a money budget as a percentage only', async () => {
      db = await factory()
      await seed(db)
      await db.run(
        `UPDATE projects SET budget_by = 'task_fees' WHERE id = 1`,
      )
      await db.run('UPDATE task_assignments SET budget_cents = 100000 WHERE id = 1')
      await db.run('UPDATE organizations SET budget_alerts_include_admins = 1')
      await track(db, 10, '2026-10-05', 1, 9000, null)
      const { opened } = await evaluateProjectBudgetAlerts(db.orm, now)
      const messages = await prepare(db, opened[0]!.alertId)
      const byEmail = new Map(messages.map((message) => [message.to.email, message]))
      expect(byEmail.get('pia@example.test')!.subject).toContain('90% of its fee budget')
      expect(byEmail.get('pia@example.test')!.text).not.toContain('$')
      expect(byEmail.get('ada@example.test')!.text).toContain('Budget: $1,000.00')
      expect(byEmail.get('ada@example.test')!.text).toContain('Used: $900.00')
    })

    it('[unit] tells an administrator instead when the manager has no deliverable address', async () => {
      const { test, alertId } = await crossed()
      await test.run('DELETE FROM user_emails WHERE user_id = 2')
      await test.run('UPDATE organizations SET budget_alerts_include_admins = 0')
      // The manager has no address: the administrator is told instead.
      const messages = await prepare(test, alertId)
      expect(messages.map((message) => message.to.email)).toEqual(['ada@example.test'])
    })
  })
}
