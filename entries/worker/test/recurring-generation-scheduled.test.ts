import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

const at = '2026-08-01T00:00:00.000Z'

/** The scheduled event the daily cron fires, at 2026-09-02T12:00:00Z. */
const dailyCron =
  'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=0+3+*+*+*'

const amountConfig = JSON.stringify({
  schema_version: 1,
  type: 'fixed_lines',
  line_items: [
    {
      kind: 'Service',
      description: 'Sanitized monthly retainer',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: false,
      taxed2: false,
      project_id: null,
    },
  ],
})

const createTestWorker = async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'recurring-generation-scheduled-test',
    },
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)

  // Migrations run lazily on the first data request.
  await miniflare.dispatchFetch('https://worker.test/api/v1')
  return miniflare
}

describe('Recurring generation schedule', () => {
  it('[integration] issues the due definitions on the daily cron and nothing else', async () => {
    // Through the deployed bundle rather than the engine, because the defect
    // was never in the engine: `generate` worked, and no scheduled handler
    // called it. A definition whose date had passed waited for a person.
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')

    await database
      .prepare(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
         VALUES (1, 'Sanitized Organization', '{"invoices":true}', ?, ?)`,
      )
      .bind(at, at)
      .run()
    await database
      .prepare(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (1, 'Sanitized Client', 'USD', ?, ?), (2, 'Other Client', 'USD', ?, ?)`,
      )
      .bind(at, at, at, at)
      .run()
    await database
      .prepare(
        `INSERT INTO recurring_invoices (
           id, client_id, definition_status, subject_template, notes_template,
           every_n_months, day_of_month, next_issue_on, amount_config, created_at, updated_at
         ) VALUES
           (1, 1, 'complete', 'Services for %invoice_issue_month_name%', '', 1, 1, '2026-09-01', ?, ?, ?),
           (2, 2, 'complete', 'Services for %invoice_issue_month_name%', '', 1, 1, '2026-10-01', ?, ?, ?)`,
      )
      .bind(amountConfig, at, at, amountConfig, at, at)
      .run()

    const response = await miniflare.dispatchFetch(dailyCron)
    expect(response.status).toBe(200)

    const invoices = await database
      .prepare(
        `SELECT recurring_invoice_id AS definitionId, issue_date AS issueDate,
           created_by_user_id AS createdByUserId, amount_cents AS amountCents
         FROM invoices ORDER BY id`,
      )
      .all<{
        definitionId: number
        issueDate: string
        createdByUserId: number | null
        amountCents: number
      }>()
    // Definition 2 is not due until October, and the invoice that was issued
    // carries the period's own date rather than the day the cron happened to
    // run -- a run delayed past midnight still bills the day it was for.
    expect(invoices.results).toEqual([
      {
        definitionId: 1,
        issueDate: '2026-09-01',
        createdByUserId: null,
        amountCents: 125_000,
      },
    ])

    // Nobody pressed anything, and the ledger says so. This is the branch of
    // the actor CHECK that nothing wrote before there was a cron behind it.
    const command = await database
      .prepare(
        `SELECT actor_type AS actorType, actor_id AS actorId, completed
         FROM invoice_command_ledger WHERE command_kind = 'recurring.generate'`,
      )
      .all<{ actorType: string; actorId: number | null; completed: number }>()
    expect(command.results).toEqual([
      { actorType: 'system', actorId: null, completed: 1 },
    ])

    // The cadence moved, so tomorrow's cron does not find this period again.
    const definitions = await database
      .prepare(`SELECT id, next_issue_on AS nextIssueOn FROM recurring_invoices ORDER BY id`)
      .all<{ id: number; nextIssueOn: string }>()
    expect(definitions.results).toEqual([
      { id: 1, nextIssueOn: '2026-10-01' },
      { id: 2, nextIssueOn: '2026-10-01' },
    ])
  }, 30_000)

  it('[integration] leaves due definitions alone on the every-minute cron', async () => {
    // The minute cron drains the outbox, and it runs 1,440 times a day. Putting
    // the sweep there would mean 1,439 scans of the same rows for the one that
    // could find anything; the day is the finest resolution a cadence has.
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')

    await database
      .prepare(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
         VALUES (1, 'Sanitized Organization', '{"invoices":true}', ?, ?)`,
      )
      .bind(at, at)
      .run()
    await database
      .prepare(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
      )
      .bind(at, at)
      .run()
    await database
      .prepare(
        `INSERT INTO recurring_invoices (
           id, client_id, definition_status, subject_template, notes_template,
           every_n_months, day_of_month, next_issue_on, amount_config, created_at, updated_at
         ) VALUES (1, 1, 'complete', 'Services', '', 1, 1, '2026-09-01', ?, ?, ?)`,
      )
      .bind(amountConfig, at, at)
      .run()

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*',
    )
    expect(response.status).toBe(200)

    const invoices = await database
      .prepare(`SELECT count(*) AS count FROM invoices`)
      .first<{ count: number }>()
    expect(invoices?.count).toBe(0)
  }, 30_000)
})
