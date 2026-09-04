import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateD1, migrateD1Through } from '../src/migrate.js'
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
    expect(migrations.results.map(({ id }) => id)).toEqual([
      '0000_org_people',
      '0001_clients',
      '0002_projects_time',
      '0003_rate_resolver',
      '0004_invoice_foundation',
      '0005_invoice_payments_totals',
      '0006_invoice_state_events',
      '0007_expenses',
      '0008_retainer_ledger',
      '0009_three_axis_state',
      '0010_recurring_invoices',
      '0011_api_tokens',
      '0012_instance_bootstrap',
      '0013_password_auth',
      '0014_sessions',
      '0015_oidc_transactions',
      '0016_email_log',
      '0017_email_delivery_details',
      '0018_estimates',
      '0019_attachments',
      '0020_argon2_passwords',
      '0021_estimate_commands',
      '0022_resource_create_commands',
      '0023_migration_import_authority',
      '0024_migration_worksheet_completions',
      '0025_time_entry_note_requirements',
      '0026_invoice_generation',
      '0027_timesheet_approvals',
      '0028_timesheet_lock_policy',
      '0029_outbox_delivery',
      '0030_email_templates',
      '0031_team_people',
    ])
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
