import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

/** The scheduled event the daily cron fires, at 2026-09-02T12:00:00Z. */
const dailyCron =
  'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=0+3+*+*+*'

/** The hourly cron, which the automatic schedule is checked on (#1102). */
const hourlyCron =
  'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=0+*+*+*+*'

const createTestWorker = async (extraBindings: Record<string, string>) => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    external: ['node:async_hooks'],
    target: 'es2022',
    write: false,
  })
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'deel-sync-scheduled-test',
      ...extraBindings,
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)
  await miniflare.dispatchFetch('https://worker.test/api/v1')
  return miniflare
}

/**
 * Issue 103. Only the refusals are exercised through the bundle: a
 * configured run would reach for the real Deel API, and a test must never do
 * that. The configured path is tested against recorded fixtures in
 * `@ezacto/integrations` and `@ezacto/db`.
 */
describe('Deel time sync schedule', () => {
  it.each([
    ['nothing configured', {}],
    ['a token but no start date', { DEEL_TOKEN: 'fixture-token' }],
    ['a start date but no token', { DEEL_SYNC_START_DATE: '2026-09-01' }],
  ])('[integration] the daily cron does nothing with %s', async (_label, bindings) => {
    const miniflare = await createTestWorker(bindings)
    const database = await miniflare.getD1Database('DB')

    const response = await miniflare.dispatchFetch(dailyCron)

    expect(response.status).toBe(200)
    const runs = await database.prepare('SELECT count(*) AS n FROM deel_sync_runs').first<{ n: number }>()
    const log = await database.prepare('SELECT count(*) AS n FROM deel_transfer_log').first<{ n: number }>()
    expect(runs?.n).toBe(0)
    expect(log?.n).toBe(0)
  })

  it('[integration] a configured sync stays silent on the schedule while it is manual', async () => {
    // Manual is the default (#1102): the hourly cron reads the setting and
    // returns before any call to Deel, so this runs without the network.
    const miniflare = await createTestWorker({
      DEEL_TOKEN: 'fixture-token',
      DEEL_SYNC_START_DATE: '2026-09-01',
    })
    const database = await miniflare.getD1Database('DB')

    for (const url of [dailyCron, hourlyCron]) {
      expect((await miniflare.dispatchFetch(url)).status).toBe(200)
    }

    const runs = await database.prepare('SELECT count(*) AS n FROM deel_sync_runs').first<{ n: number }>()
    const log = await database.prepare('SELECT count(*) AS n FROM deel_transfer_log').first<{ n: number }>()
    expect(runs?.n).toBe(0)
    expect(log?.n).toBe(0)
  })
})
