import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

const bundleWorker = async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  return bundled.outputFiles[0]!.text
}

const createTestWorker = async () => {
  const script = await bundleWorker()
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'nightly-export-test',
    },
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    modules: true,
    script,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)

  await miniflare.dispatchFetch('https://worker.test/api/v1')

  return miniflare
}

describe('Nightly export scheduled handler', () => {
  it('[config] declares the nightly cron trigger in both deployments', () => {
    const configuration = readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    )
    const nightlyCron = configuration.match(/"0 3 \* \* \*"/gu)
    expect(nightlyCron).toHaveLength(2)
  })

  it('[integration] exports tables to R2 and records a completed backup run', async () => {
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')

    await database
      .prepare(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
         VALUES (1, 'Nightly Test Org', '{}', ?, ?)`,
      )
      .bind('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
      .run()

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=0+3+*+*+*',
    )
    expect(response.status).toBe(200)

    const runs = await database
      .prepare(
        `SELECT id, status, trigger, r2_prefix, table_count, total_rows, error_message
         FROM backup_runs ORDER BY id DESC LIMIT 1`,
      )
      .all<{
        id: number
        status: string
        trigger: string
        r2_prefix: string | null
        table_count: number | null
        total_rows: number | null
        error_message: string | null
      }>()

    expect(runs.results).toHaveLength(1)
    const run = runs.results[0]!
    expect(run.status).toBe('completed')
    expect(run.trigger).toBe('nightly')
    expect(run.r2_prefix).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\/$/)
    expect(run.table_count).toBeGreaterThan(0)
    expect(run.total_rows).toBeGreaterThanOrEqual(1)
    expect(run.error_message).toBeNull()

    const bucket = await miniflare.getR2Bucket('ATTACHMENTS')
    const prefix = run.r2_prefix!
    const manifestObject = await bucket.get(`${prefix}manifest.json`)
    expect(manifestObject).not.toBeNull()
    const manifestText = await manifestObject!.text()
    const manifest = JSON.parse(manifestText) as { schema_version: number; tables: Record<string, unknown> }
    expect(manifest.schema_version).toBe(1)
    expect(manifest.tables).toHaveProperty('organizations')

    const orgCsv = await bucket.get(`${prefix}tables/organizations.csv`)
    expect(orgCsv).not.toBeNull()
    const orgText = await orgCsv!.text()
    expect(orgText).toContain('Nightly Test Org')

    const restoreMd = await bucket.get(`${prefix}RESTORE.md`)
    expect(restoreMd).not.toBeNull()
  }, 30_000)

  it('[integration] skips nightly export when ATTACHMENTS binding is absent', async () => {
    const script = await bundleWorker()
    const miniflare = new Miniflare({
      bindings: {
        API_CURSOR_SIGNING_KEY: cursorSecret,
        ENVIRONMENT: 'test',
        RELEASE: 'no-r2-test',
      },
      compatibilityDate: '2026-08-06',
      d1Databases: ['DB'],
      modules: true,
      script,
      unsafeTriggerHandlers: true,
    })
    miniflares.push(miniflare)

    await miniflare.dispatchFetch('https://worker.test/api/v1')

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=0+3+*+*+*',
    )
    expect(response.status).toBe(200)

    const database = await miniflare.getD1Database('DB')
    const runs = await database
      .prepare('SELECT COUNT(*) AS count FROM backup_runs')
      .first<{ count: number }>()
    expect(runs!.count).toBe(0)
  }, 30_000)

  it('[integration] still drains outbox on the per-minute cron', async () => {
    const miniflare = await createTestWorker()

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*',
    )
    expect(response.status).toBe(200)

    const database = await miniflare.getD1Database('DB')
    const runs = await database
      .prepare('SELECT COUNT(*) AS count FROM backup_runs')
      .first<{ count: number }>()
    expect(runs!.count).toBe(0)
  }, 30_000)
})
