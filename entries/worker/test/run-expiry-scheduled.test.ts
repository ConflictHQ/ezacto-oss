import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

/** The scheduled event the minute cron fires, at 2026-09-02T12:00:00Z. */
const minuteCron =
  'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*'

const createTestWorker = async () => {
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
      RELEASE: 'run-expiry-scheduled-test',
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)
  // Any data request applies the migrations.
  await miniflare.dispatchFetch('https://worker.test/api/v1')
  return miniflare
}

/** Issue 63: the minute cron settles proposed runs whose deadline has passed. */
describe('scheduled run expiry', () => {
  it('[integration] the minute cron expires a lapsed run and leaves a standing one', async () => {
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')
    const created = '2026-09-01T00:00:00.000Z'
    await database.batch([
      database.prepare(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (1, 'Operator', 'One', 'administrator', '[]', ?, ?)`,
      ).bind(created, created),
      database.prepare(
        `INSERT INTO scheduled_jobs (id, action, name, scope_json, cadence, created_by_user_id, created_at, updated_at)
         VALUES (1, 'month_end_pack', 'Month end', '{}', '0 9 1 * *', 1, ?, ?)`,
      ).bind(created, created),
      database.prepare(
        `INSERT INTO proposed_runs (id, job_id, occurrence_key, proposed_at, expires_at, created_at, updated_at)
         VALUES (1, 1, '2026-08', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', ?, ?),
                (2, 1, '2026-09', '2026-09-01T09:00:00.000Z', '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).bind(created, created, created, created),
    ])

    const response = await miniflare.dispatchFetch(minuteCron)

    expect(response.status).toBe(200)
    const runs = await database
      .prepare('SELECT id, state, settled_reason FROM proposed_runs ORDER BY id')
      .all<{ id: number; state: string; settled_reason: string | null }>()
    expect(runs.results).toEqual([
      { id: 1, state: 'expired', settled_reason: 'nobody confirmed it before the deadline' },
      { id: 2, state: 'proposed', settled_reason: null },
    ])
  })
})
