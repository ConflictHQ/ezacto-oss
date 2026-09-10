import { createHash } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { brandAssetFileKey } from '@ezacto/api'
import { createD1BrandAssetStore, migrateD1 } from '@ezacto/db/d1'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'

/**
 * The Worker serves the shell from an app composed with no runtime services, so
 * the question this file answers is the one no unit test can: does a mark an
 * operator uploaded actually reach the sign-in page, and does an anonymous
 * browser get the bytes?
 */
const instances: Miniflare[] = []

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x77, 0x6f, 0x72, 0x64,
])
const pngHash = createHash('sha256').update(pngBytes).digest('hex')

const environment = async (
  options: { migrate?: boolean; vars?: Record<string, string> } = {},
): Promise<WorkerEnv> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
  })
  instances.push(miniflare)
  const database = await miniflare.getD1Database('DB')
  if (options.migrate !== false) await migrateD1(database)
  return {
    DB: database,
    ATTACHMENTS: await miniflare.getR2Bucket('ATTACHMENTS'),
    API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
    ENVIRONMENT: 'test',
    RELEASE: 'brand-asset-test',
    ...options.vars,
    // Miniflare's bucket is structurally its own R2 implementation rather than
    // the workers-types declaration; the runtime object is the same shape.
  } as unknown as WorkerEnv
}

const storeMark = async (env: WorkerEnv): Promise<string> => {
  const fileKey = brandAssetFileKey(pngHash)
  await env.ATTACHMENTS!.put(fileKey, pngBytes, {
    httpMetadata: { contentType: 'image/png' },
  })
  await createD1BrandAssetStore(env.DB).put({
    slot: 'wordmark_dark',
    contentHash: pngHash,
    fileKey,
    contentType: 'image/png',
    byteSize: pngBytes.byteLength,
    uploadedByUserId: null,
    now: '2026-09-09T12:00:00.000Z',
  })
  return `/brand/wordmark-dark/${pngHash}`
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()))
})

describe('worker brand assets (#489)', () => {
  it('[integration] the sign-in page an anonymous browser gets carries the stored mark', async () => {
    const env = await environment()
    const url = await storeMark(env)
    // The services-less app: exactly what `index.ts` serves every page from.
    const app = createApp(undefined, workerBrandAssetSurface)

    const page = await app.request('/', {}, env)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain(`<img class="brand-mark" src="${url}"`)

    const served = await app.request(url, {}, env)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(pngBytes)
  })

  it('[integration] the deploy-time URL still renders when nothing is uploaded', async () => {
    const env = await environment({
      vars: { BRAND_WORDMARK_DARK: 'https://cdn.example/dark.png' },
    })
    const html = await (
      await createApp(undefined, workerBrandAssetSurface).request('/', {}, env)
    ).text()
    expect(html).toContain('src="https://cdn.example/dark.png"')
  })

  it('[integration] an uploaded mark displaces the deploy-time URL', async () => {
    const env = await environment({
      vars: { BRAND_WORDMARK_DARK: 'https://cdn.example/dark.png' },
    })
    const url = await storeMark(env)
    const html = await (
      await createApp(undefined, workerBrandAssetSurface).request('/', {}, env)
    ).text()
    expect(html).toContain(`src="${url}"`)
    expect(html).not.toContain('https://cdn.example/dark.png')
  })

  it('[integration] a database that has not run 0045 yet still renders the page', async () => {
    // The page path deliberately never runs migrations, so on a database that
    // has not reached 0045 the table simply is not there. A brand lookup must
    // not be the reason a page fails.
    const env = await environment({ migrate: false })
    const page = await createApp(undefined, workerBrandAssetSurface).request('/', {}, env)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).not.toContain('brand-mark')
    expect(html).toContain('data-brand="ezacto"')
  })
})
