import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateD1, migrateD1Through, migrationIds } from '../src/migrate.js'
import { timesheetApprovalsPreflight } from '../src/migrations/0027_timesheet_approvals.js'

describe('D1 migration concurrency', () => {
  let miniflare: Miniflare | undefined

  afterEach(async () => miniflare?.dispose())

  it('[security] atomically converges concurrent cold-isolate migration checks', async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    const database = await miniflare.getD1Database('DB')

    await Promise.all(Array.from({ length: 4 }, async () => migrateD1(database)))

    const migrations = await database
      .prepare('SELECT id FROM _ezacto_migrations ORDER BY id')
      .all<{ id: string }>()
    expect(migrations.results.map(({ id }) => id)).toEqual(migrationIds)
    expect(
      await database.prepare('SELECT count(*) AS count FROM api_tokens').first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })

  it('[security] rejects invalid approval data written between D1 preflight and migration batch', async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    const database = await miniflare.getD1Database('DB')
    await migrateD1Through(database, '0026_invoice_generation')
    const instant = '2026-08-31T12:00:00.000Z'
    await database.batch([
      database
        .prepare(
          `INSERT INTO organizations (name, modules, created_at, updated_at)
           VALUES ('Approval org', '{"approval":true,"expenses":true,"invoices":true}', ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO users
            (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
           VALUES (1, 'Maya', '', 'member', '[]', ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO clients (id, name, currency, created_at, updated_at)
           VALUES (1, 'Approval client', 'USD', ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO projects (id, client_id, name, created_at, updated_at)
           VALUES (1, 1, 'Approval project', ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO tasks (id, name, created_at, updated_at)
           VALUES (1, 'Approval task', ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO user_assignments
            (id, project_id, user_id, created_at, updated_at)
           VALUES (1, 1, 1, ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO task_assignments
            (id, project_id, task_id, billable, created_at, updated_at)
           VALUES (1, 1, 1, 1, ?, ?)`,
        )
        .bind(instant, instant),
      database
        .prepare(
          `INSERT INTO time_entries (
            id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
            spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
            approval_status, created_at, updated_at
          ) VALUES (1, 1, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600, 1,
            'unsubmitted', ?, ?)`,
        )
        .bind(instant, instant),
    ])

    let interleaved = false
    const interleavedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            const statement = target.prepare(query)
            if (query !== timesheetApprovalsPreflight) return statement
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === 'all') {
                  return async () => {
                    const result = await statementTarget.all()
                    interleaved = true
                    await database
                      .prepare(`UPDATE time_entries SET approval_status = 'approved' WHERE id = 1`)
                      .run()
                    return result
                  }
                }
                const value = Reflect.get(statementTarget, statementProperty)
                return typeof value === 'function' ? value.bind(statementTarget) : value
              },
            })
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await expect(migrateD1(interleavedDatabase)).rejects.toThrow(/CHECK constraint failed/)
    expect(interleaved).toBe(true)
    expect(
      await database
        .prepare(`SELECT id FROM _ezacto_migrations WHERE id = '0027_timesheet_approvals'`)
        .all(),
    ).toMatchObject({ results: [] })
    expect(
      await database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'timesheet_submissions', '_ezacto_0027_timesheet_approvals_preflight_guard'
           )`,
        )
        .all(),
    ).toMatchObject({ results: [] })

    await database.prepare(`UPDATE time_entries SET approval_status = 'unsubmitted' WHERE id = 1`).run()
    await expect(migrateD1(database)).resolves.toBeUndefined()
    expect(
      await database
        .prepare(`SELECT id FROM _ezacto_migrations WHERE id = '0027_timesheet_approvals'`)
        .first(),
    ).toEqual({ id: '0027_timesheet_approvals' })
  })
})
