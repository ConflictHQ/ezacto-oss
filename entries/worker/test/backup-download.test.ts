import { totpCodeForStep, totpStep } from '@ezacto/core'
import { createApiApp, installBackupDownloadMintRoute, installBackupDownloadRedeemRoute } from '@ezacto/api'
import { migrateD1 } from '@ezacto/db/d1'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { isServicePath } from '../src/data-request.js'
import { runNightlyExport } from '../src/nightly-export.js'
import type { WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * Issue 39: the signed download of a backup, through the services the Worker
 * composes, against a real D1 and a real R2 bucket holding a real nightly
 * export. The container runs the link rules against SQLite in the db package's
 * test; it has no bundle to link to.
 */

const miniflares: Miniflare[] = []
afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

const setup = async (options: { export?: boolean } = {}) => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
  })
  miniflares.push(miniflare)
  const db = await miniflare.getD1Database('DB')
  const bucket = await miniflare.getR2Bucket('ATTACHMENTS')
  await migrateD1(db)
  const at = '2026-09-01T00:00:00.000Z'
  await db
    .prepare("INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', ?, ?)")
    .bind(at, at)
    .run()
  await db
    .prepare(
      `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
       VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    )
    .bind(at, at)
    .run()
  if (options.export !== false) await runNightlyExport(db, bucket as unknown as R2Bucket)
  const env = {
    DB: db,
    ATTACHMENTS: bucket,
    ENVIRONMENT: 'test',
    RELEASE: 'test',
    API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    APP_BASE_URL: 'https://app.example.test',
    // Miniflare's bucket is its own R2 implementation, the same shape at runtime.
  } as unknown as WorkerEnv
  const services = await createRuntimeServices(env)
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) => {
          const profile = request.headers.get('x-test-profile')
          if (profile === null) return null
          return {
            type: 'user' as const,
            userId: 1,
            profile: profile as 'administrator',
            managerGrants: [],
            authentication: { kind: 'session' as const, sessionId: 'session-1' },
          }
        },
      },
    },
    installApi(api) {
      installBackupDownloadMintRoute(api, {
        service: services.backupDownloads!,
        activity: services.activity!,
        clock: () => new Date().toISOString(),
      })
    },
    installApp(root) {
      installBackupDownloadRedeemRoute(root, {
        service: services.backupDownloads!,
        activity: services.activity!,
        clock: () => new Date().toISOString(),
        clientKey: () => 'test-client',
      })
    },
  })
  const mint = (body: unknown = {}, profile = 'administrator') =>
    app.request('/api/v1/backup/download-links', {
      method: 'POST',
      headers: { 'x-test-profile': profile, 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    })
  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
  const download = (token: string) => app.request(`/backup-download/${token}`)
  const events = async () =>
    JSON.stringify((await db.prepare('SELECT * FROM event_outbox').all()).results)
  return { db, bucket, services, mint, tokenOf, download, events }
}

interface Minted {
  data: { id: number; run_id: number; url: string; expires_at: string }
}

describe('the signed backup download on the Worker', () => {
  it('[api] is reachable by the app that has the services', () => {
    expect(isServicePath('/backup-download/abc')).toBe(true)
  })

  it('[api] mints a link, serves the bundle as a ZIP exactly once, and logs both ends', async () => {
    const { mint, tokenOf, download, events } = await setup()
    const response = await mint()
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as Minted
    expect(data.url.startsWith('https://app.example.test/backup-download/')).toBe(true)
    const token = tokenOf(data.url)

    const file = await download(token)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('application/zip')
    expect(file.headers.get('cache-control')).toBe('no-store')
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('manifest.json')
    expect(text).toContain('RESTORE.md')
    expect(text).toContain('tables/users.csv')

    const again = await download(token)
    expect(again.status).toBe(404)
    expect(await again.text()).toBe('Not found')

    const log = await events()
    expect(log).toContain('backup.exported')
    expect(log).toContain('link_minted')
    expect(log).toContain('downloaded')
    expect(log).not.toContain(token)
  })

  it('[api] refuses with one plain 404: unknown, malformed and drifted-manifest links', async () => {
    const { mint, tokenOf, download, bucket, db } = await setup()
    const refusals = [await download('A'.repeat(43)), await download('nope')]
    const { data } = (await (await mint()).json()) as Minted
    const run = await db
      .prepare('SELECT r2_prefix FROM backup_runs ORDER BY id DESC LIMIT 1')
      .first<{ r2_prefix: string }>()
    await bucket.put(`${run!.r2_prefix}manifest.json`, '{"tables":{}}')
    refusals.push(await download(tokenOf(data.url)))
    for (const refusal of refusals) {
      expect(refusal.status).toBe(404)
      expect(await refusal.text()).toBe('Not found')
    }
    // The link was spent by the refusal; a second try is the same 404.
    expect((await download(tokenOf(data.url))).status).toBe(404)
  })

  it('[api] aborts the stream rather than send a table that fails its checksum', async () => {
    const { mint, tokenOf, download, bucket, db } = await setup()
    const { data } = (await (await mint()).json()) as Minted
    const run = await db
      .prepare('SELECT r2_prefix FROM backup_runs ORDER BY id DESC LIMIT 1')
      .first<{ r2_prefix: string }>()
    await bucket.put(`${run!.r2_prefix}tables/users.csv`, 'tampered')
    const response = await download(tokenOf(data.url))
    let received = ''
    let failed = false
    try {
      received = await response.text()
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(received).not.toContain('tampered')
  })

  it('[api] refuses to mint without a completed run', async () => {
    const none = await setup({ export: false })
    expect((await none.mint()).status).toBe(404)
  })

  it('[api] refuses to mint for any other profile', async () => {
    const some = await setup()
    expect((await some.mint({}, 'accounting')).status).toBe(403)
    expect((await some.mint({}, 'member')).status).toBe(403)
  })

  it('[api] needs a fresh authenticator code to mint once one is enrolled', async () => {
    const { mint, services, download, tokenOf } = await setup()
    const offer = await services.twoFactor!.beginEnrolment(1)
    const step = totpStep(Date.now())
    expect(await services.twoFactor!.confirmEnrolment(1, await totpCodeForStep(offer.secret, step))).toBe(
      'enabled',
    )

    const missing = await mint()
    expect(missing.status).toBe(401)
    const wrong = await mint({ code: '000000' })
    expect(wrong.status).toBe(401)
    // The code that enrolled the factor is spent; the next step's is fresh.
    const fresh = await mint({ code: await totpCodeForStep(offer.secret, step + 1) })
    expect(fresh.status).toBe(201)
    const { data } = (await fresh.json()) as Minted
    expect((await download(tokenOf(data.url))).status).toBe(200)
  })
})
