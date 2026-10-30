import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Background work follows the operator's invoices switch (issue 1254): with it
 * off the daily cron issues nothing and leaves the due definition as it was, and
 * switching it back on, over the same database, issues what was waiting.
 */

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const at = '2026-08-01T00:00:00.000Z'
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

const miniflares: Miniflare[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const bundle = async (): Promise<string> =>
  (
    await build({
      entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
      bundle: true,
      conditions: ['development'],
      format: 'esm',
      platform: 'browser',
      external: ['node:async_hooks'],
      target: 'es2022',
      write: false,
    })
  ).outputFiles[0]!.text

const start = async (script: string, persist: string, flags: Record<string, string>) => {
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'module-flags-scheduled-test',
      ...flags,
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    d1Persist: persist,
    modules: true,
    script,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)
  await miniflare.dispatchFetch('https://worker.test/api/v1')
  return miniflare
}

describe('module switches and the schedule', () => {
  it('[integration] skips recurring generation while invoices are off and resumes when they are on', async () => {
    const script = await bundle()
    const persist = await mkdtemp(join(tmpdir(), 'ezacto-module-flags-'))
    directories.push(persist)

    const off = await start(script, persist, { INVOICES_ENABLED: 'false' })
    const database = await off.getD1Database('DB')
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

    expect((await off.dispatchFetch(dailyCron)).status).toBe(200)
    const count = async (table: string): Promise<number> =>
      (await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
    expect(await count('invoices')).toBe(0)
    expect(
      (await database.prepare('SELECT next_issue_on AS d FROM recurring_invoices').first<{ d: string }>())!.d,
    ).toBe('2026-09-01')
    await off.dispose()
    miniflares.splice(miniflares.indexOf(off), 1)

    const on = await start(script, persist, {})
    expect((await on.dispatchFetch(dailyCron)).status).toBe(200)
    const resumed = await on.getD1Database('DB')
    expect(
      (await resumed.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>())!.n,
    ).toBe(1)
  }, 120_000)
})
