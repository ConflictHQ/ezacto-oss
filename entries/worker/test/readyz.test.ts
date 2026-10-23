import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

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
      API_CURSOR_SIGNING_KEY: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE',
      ENVIRONMENT: 'test',
      RELEASE: 'readyz-test',
    },
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  })
  miniflares.push(miniflare)
  return miniflare
}

describe('readiness endpoint', () => {
  it('[integration] applies pending migrations on the first check, before any data request', async () => {
    const miniflare = await createTestWorker()
    const database = await miniflare.getD1Database('DB')

    const response = await miniflare.dispatchFetch('https://worker.test/readyz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready', release: 'readyz-test' })
    const ledger = await database
      .prepare('SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1')
      .first<{ id: string }>()
    expect(ledger?.id).toMatch(/^\d{4}_/u)
  })

  it('[security] answers only ready or unavailable, with no ledger detail', async () => {
    const miniflare = await createTestWorker()
    const response = await miniflare.dispatchFetch('https://worker.test/readyz')
    const body = await response.text()
    expect(body).not.toMatch(/_ezacto_migrations|statements_sha256/u)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
