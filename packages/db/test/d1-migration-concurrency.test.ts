import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateD1 } from '../src/migrate.js'

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
    ])
    expect(
      await database.prepare('SELECT count(*) AS count FROM api_tokens').first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })
})
