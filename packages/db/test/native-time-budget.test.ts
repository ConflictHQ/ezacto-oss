import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { evaluateProjectBudgetAlerts } from '../src/project-budget-alerts.js'
import { createReportRepository } from '../src/reports.js'
import { createStoppedTimeEntry } from '../src/time-entries.js'

/**
 * Issue 1028: time tracked in ezacto itself counts toward the project's budget,
 * under the project's own budget setting, and the budget report and the budget
 * alert read the same figure. These run against a real migrated database and
 * create the time through the same path the week grid and the API use.
 */

const seedAt = '2026-10-01T09:00:00.000Z'
const now = '2026-10-14T16:00:00.000Z'
const admin = { userId: 1, profile: 'administrator' } as const

let sqlite: BetterSqlite3.Database | undefined
afterEach(() => sqlite?.close())

const open = (budgetBy: 'project' | 'task_fees') => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const db = sqlite
  const run = (statement: string, ...bindings: unknown[]) => db.prepare(statement).run(...bindings)
  run(
    `INSERT INTO organizations (name, modules, timezone, created_at, updated_at)
     VALUES ('CONFLICT', '{}', 'America/Costa_Rica', ?, ?)`,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES
       (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?), (3, 'Mo', 'Member', 'member', '[]', ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO user_emails (user_id, address, is_primary, verified_at, created_at, updated_at)
     VALUES (1, 'ada@example.test', 1, ?, ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Kestrel Environmental', 'USD', ?, ?)`,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO projects (id, client_id, name, budget_by, budget_seconds, notify_when_over_budget,
                           over_budget_pct, created_at, updated_at)
     VALUES (1, 1, 'Site survey', ?, 360000, 1, 85, ?, ?)`,
    budgetBy,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Field', ?, ?), (2, 'Internal', ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
  // Task 1 bills, task 2 does not. A fee budget gives each a 10 000 cent line.
  run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, budget_cents, created_at, updated_at)
     VALUES (1, 1, 1, 1, 10000, ?, ?), (2, 1, 2, 0, 10000, ?, ?)`,
    seedAt,
    seedAt,
    seedAt,
    seedAt,
  )
  run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 3, 0, ?, ?)`,
    seedAt,
    seedAt,
  )
  const orm = createContainerDatabase(db)
  const track = (hours: number, date: string, task: 1 | 2) =>
    createStoppedTimeEntry(orm, {
      userId: 3,
      projectId: 1,
      taskId: task,
      userAssignmentId: 1,
      taskAssignmentId: task,
      spentDate: date,
      seconds: Math.round(hours * 3600),
      createdAt: seedAt,
      updatedAt: seedAt,
    })
  return { db, run, orm, track }
}

describe('native time and project budgets (issue 1028)', () => {
  it('[unit] a native crossing alerts exactly once, on the figure the report shows', async () => {
    const { db, orm, track } = open('project')
    // The default a native entry is created with: not flagged, and on a
    // non-billable task. All time counts toward an hours budget.
    const entry = await track(80, '2026-10-05', 2)
    expect(entry.budgeted).toBe(false)
    expect(entry.billable).toBe(false)
    expect((await evaluateProjectBudgetAlerts(orm, now)).opened).toHaveLength(0)

    await track(5, '2026-10-06', 1)
    const crossed = await evaluateProjectBudgetAlerts(orm, now)
    expect(crossed.opened).toHaveLength(1)

    // Evaluating again, or tracking more, is the same crossing.
    await track(2, '2026-10-07', 1)
    expect((await evaluateProjectBudgetAlerts(orm, now)).opened).toHaveLength(0)
    expect(db.prepare(`SELECT count(*) AS n FROM project_budget_alerts`).get()).toEqual({ n: 1 })
    expect(
      db
        .prepare(`SELECT count(*) AS n FROM event_outbox WHERE event_type = 'project.budget_alert'`)
        .get(),
    ).toEqual({ n: 1 })

    // The alert recorded what the report reads, not a figure of its own.
    const report = await createReportRepository(orm).projectBudget(
      1,
      { from: '1970-01-01', to: '9999-12-31' },
      admin,
    )
    expect(report?.grains[0]?.spentAmount).toBe(87 * 3600)
    expect(db.prepare(`SELECT spent_amount AS spent FROM project_budget_alerts`).get()).toEqual({
      spent: 85 * 3600,
    })
  })

  it('[unit] counts existing native entries without a rewrite, and leaves Harvest flags alone', async () => {
    const { run, orm, track } = open('project')
    await track(10, '2026-10-05', 1)
    // Carried over from Harvest as not budgeted: Harvest said so, and it stays.
    run(
      `INSERT INTO time_entries (harvest_id, user_id, project_id, task_id, user_assignment_id,
         task_assignment_id, spent_date, seconds, seconds_without_timer, rounded_seconds,
         billable, budgeted, source_approval_status, created_at, updated_at)
       VALUES ('h-1', 3, 1, 1, 1, 1, '2026-10-05', 36000, 36000, 36000, 1, 0, 'unsubmitted', ?, ?)`,
      seedAt,
      seedAt,
    )
    const report = await createReportRepository(orm).projectBudget(
      1,
      { from: '1970-01-01', to: '9999-12-31' },
      admin,
    )
    expect(report?.grains[0]?.spentAmount).toBe(10 * 3600)
  })

  it('[unit] a fee budget counts billable native time only', async () => {
    const { run, orm, track } = open('task_fees')
    await track(10, '2026-10-05', 1)
    await track(10, '2026-10-05', 2)
    run(`UPDATE time_entries SET billable_rate_cents = 100`)
    const report = await createReportRepository(orm).projectBudget(
      1,
      { from: '1970-01-01', to: '9999-12-31' },
      admin,
    )
    const spent = (taskAssignmentId: number) =>
      report?.grains.find((grain) => grain.sourceId === taskAssignmentId)?.spentAmount
    expect(spent(1)).toBe(1000)
    expect(spent(2)).toBe(0)
  })
})
