import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createD1InstanceThemeStore, migrateD1 } from '@ezacto/db/d1'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'

/**
 * The Worker serves the shell from an app composed with no runtime services, so
 * the question this file answers is the one no unit test can: does a palette an
 * administrator saved actually reach the browser, and does the page stay up
 * when it cannot?
 *
 * The unit tests either side of this prove the rule and the route. What they
 * cannot prove is that the two are wired to each other in the app `index.ts`
 * actually serves -- which is exactly the gap that shipped an Accounting
 * settings screen reading four client methods nothing supplied.
 */
const instances: Miniflare[] = []

const dark = { ground: '#1D1D1D', surface: '#282828', ink: '#F4F4F4' }

const environment = async (
  options: { migrate?: boolean } = {},
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
    RELEASE: 'instance-theme-test',
  } as unknown as WorkerEnv
}

/** The services-less app: exactly what `index.ts` serves every page from. */
const shellApp = () =>
  createApp(undefined, workerBrandAssetSurface, workerInstanceThemeSurface)

const storePalette = async (
  env: WorkerEnv,
  palette: Readonly<Record<string, string>> = dark,
): Promise<void> => {
  await createD1InstanceThemeStore(env.DB).put({
    palette,
    updatedByUserId: null,
    now: '2026-09-11T12:00:00.000Z',
  })
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()))
})

// 20s, matching `brand-assets`: each case boots a real D1 and renders a whole
// page, which the 5s default swallows on a loaded runner and reports as a
// failure of the feature rather than of the budget.
describe('worker instance theme (issue 591)', () => {
  it('[integration] a saved palette reaches an anonymous browser as CSS', async () => {
    const env = await environment()
    await storePalette(env)
    const app = shellApp()

    const page = await app.request('/', {}, env)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<link rel="stylesheet" href="/assets/instance-theme.css">')

    // The sign-in page is fetched without a session, so the stylesheet it links
    // has to be reachable without one.
    const stylesheet = await app.request('/assets/instance-theme.css', {}, env)
    expect(stylesheet.status).toBe(200)
    expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8')
    const css = await stylesheet.text()
    expect(css).toContain('--ez-ground: #1D1D1D;')
    expect(css).toContain('--ez-surface: #282828;')
    expect(css).toContain('--ez-ink: #F4F4F4;')
  }, 20_000)

  it('[security] the palette stylesheet is allowed by the page own CSP', async () => {
    // The reason this is a stylesheet rather than an inline `<style>` block. If
    // the policy ever loses `style-src 'self'`, the palette stops applying and
    // the only symptom is an instance quietly wearing the built-in colours.
    const env = await environment()
    await storePalette(env)
    const page = await shellApp().request('/', {}, env)
    expect(page.headers.get('content-security-policy')).toContain("style-src 'self'")
  }, 20_000)

  it('[integration] an instance with no palette links no stylesheet', async () => {
    const env = await environment()
    const html = await (await shellApp().request('/', {}, env)).text()
    expect(html).not.toContain('/assets/instance-theme.css')
    expect(html).toContain('/assets/ezacto.css')
  }, 20_000)

  it('[integration] a database that has not run the migration still renders the page', async () => {
    // The shell is served by a path that deliberately has not run migrations. A
    // theme lookup is never allowed to be the reason a page fails to render.
    const env = await environment({ migrate: false })
    const app = shellApp()

    const page = await app.request('/', {}, env)
    expect(page.status).toBe(200)
    expect(await page.text()).not.toContain('/assets/instance-theme.css')

    const stylesheet = await app.request('/assets/instance-theme.css', {}, env)
    expect(stylesheet.status).toBe(200)
    expect(await stylesheet.text()).toBe('')
  }, 20_000)

  it('[integration] the stylesheet follows the palette when it changes', async () => {
    const env = await environment()
    const app = shellApp()
    await storePalette(env)
    const first = await app.request('/assets/instance-theme.css', {}, env)
    const firstTag = first.headers.get('etag')

    await storePalette(env, { action: '#0B5E37' })
    const second = await app.request('/assets/instance-theme.css', {}, env)
    const css = await second.text()
    expect(css).toContain('--ez-action: #0B5E37;')
    // Replaced, not merged -- a slot dropped from the palette goes back to the
    // built-in colour rather than lingering.
    expect(css).not.toContain('--ez-ground')
    expect(second.headers.get('etag')).not.toBe(firstTag)
  }, 20_000)
})
