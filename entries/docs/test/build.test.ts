import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const dist = join(import.meta.dirname, '..', 'dist')
const root = join(import.meta.dirname, '..', '..', '..')
const page = (path: string) => readFile(join(dist, path), 'utf8')

describe('ezacto.dev build', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: join(import.meta.dirname, '..'), stdio: 'pipe' })
  }, 60_000)

  it('renders every path of the contract on the API page, and serves the document', async () => {
    const openapi = JSON.parse(await readFile(join(root, 'openapi', 'ezacto-v1.openapi.json'), 'utf8'))
    const api = await page('api/index.html')
    let operations = 0
    for (const [path, methods] of Object.entries<Record<string, unknown>>(openapi.paths)) {
      for (const method of Object.keys(methods)) {
        operations += 1
        expect(api, `${method} ${path}`).toContain(`<span class="method ${method}">${method.toUpperCase()}</span>${path.replace(/&/g, '&amp;')}`)
      }
    }
    expect(api.match(/<div class="op"/g)).toHaveLength(operations)
    for (const name of Object.keys(openapi.components.schemas)) {
      expect(api, name).toContain(`id="schema-${name}"`)
    }
    expect(JSON.parse(await page('openapi/v1.json')).info.version).toBe(openapi.info.version)
  })

  it('renders every guide, rewrites repository links to site paths, and leaves no markdown link behind', async () => {
    const guides = (await readdir(join(dist, 'docs'), { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'images')
    expect(guides.length).toBeGreaterThanOrEqual(14)
    for (const guide of guides) {
      const html = await page(join('docs', guide.name, 'index.html'))
      expect(html).toContain(`<link rel="canonical" href="https://ezacto.dev/docs/${guide.name}/">`)
      for (const href of html.match(/href="[^"]*\.md[^"]*"/g) ?? []) {
        expect(href, `${guide.name}: ${href}`).toMatch(/^href="https:\/\/github\.com\/ConflictHQ\/ezacto-oss\//)
      }
    }
    const worker = await page('docs/self-host-worker/index.html')
    expect(worker).toContain('href="/docs/self-host-container/"')
    expect(worker).toContain('href="/docs/restore/"')
    expect(worker).toContain('href="/docs/infra/#env--secrets"')
  })

  it('carries no internal hostname or account identifier', async () => {
    const files = await readdir(dist, { recursive: true })
    for (const file of files.filter((f) => /\.(html|txt|xml|json)$/.test(f))) {
      const text = await readFile(join(dist, file), 'utf8')
      expect(text, file).not.toMatch(/conflict\.media|weareconflict|00000000000000000000000000000000|brain\.ezacto\.dev/i)
    }
  })

  it('lists every page in the sitemap and ships robots and llms.txt', async () => {
    const sitemap = await page('sitemap.xml')
    for (const path of ['/', '/docs/', '/api/', '/cli/', '/docs/self-host-worker/']) {
      expect(sitemap).toContain(`<loc>https://ezacto.dev${path}</loc>`)
    }
    expect(await page('robots.txt')).toContain('Sitemap: https://ezacto.dev/sitemap.xml')
    expect(await page('llms.txt')).toContain('https://ezacto.dev/api/')
  })
})
