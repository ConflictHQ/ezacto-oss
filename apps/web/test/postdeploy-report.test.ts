import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
// Use the ZIP reader already bundled by the same pinned Playwright reporter.
type ZipEntry = { fileName: string }
type ReportZip = {
  on(event: 'entry', listener: (entry: ZipEntry) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  readEntry(): void
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: Readable) => void): void
}
const { yauzl } = require('playwright-core/lib/utilsBundle') as {
  yauzl: { fromBuffer(buffer: Buffer, options: { lazyEntries: boolean }, callback: (error: Error | null, zip: ReportZip) => void): void }
}
const reportContents = (buffer: Buffer) => new Promise<string[]>((resolve, reject) => {
  const contents: string[] = []
  yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error)
    zip.on('error', reject)
    zip.on('end', () => resolve(contents))
    zip.on('entry', entry => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error)
        const chunks: Buffer[] = []
        stream.on('error', reject)
        stream.on('data', chunk => chunks.push(Buffer.from(chunk as Uint8Array)))
        stream.on('end', () => {
          contents.push(Buffer.concat(chunks).toString('utf8'))
          zip.readEntry()
        })
      })
    })
    zip.readEntry()
  })
})

it('keeps a synthetic session cookie out of retained HTML steps when browser cleanup transport fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-cleanup-report-'))
  const secret = randomUUID()
  try {
    const testModule = JSON.stringify(require.resolve('@playwright/test'))
    const helper = JSON.stringify(resolve('e2e/postdeploy/diagnostics.ts'))
    await writeFile(join(directory, 'probe.spec.ts'), `
import { test } from ${testModule}
import { cleanupClient } from ${helper}
for (const phase of ['lookup', 'deletion']) {
  test('cleanup transport failure during ' + phase, async ({ page, context }) => {
    await context.addCookies([{ name: 'session', value: process.env.EZACTO_REPORT_COOKIE!, domain: 'ezacto.io', path: '/', secure: true, httpOnly: true }])
    await context.route('https://ezacto.io/**', async route => {
      const request = route.request()
      if (!new URL(request.url()).pathname.startsWith('/api/')) {
        return route.fulfill({ contentType: 'text/html', body: '<title>Cleanup report regression</title>' })
      }
      if (!request.headers().cookie?.includes(process.env.EZACTO_REPORT_COOKIE!)) throw new Error('Synthetic session was not sent')
      if (phase === 'deletion' && request.method() === 'GET') {
        return route.fulfill({ json: { data: { name: 'Deployment E2E report-marker' } } })
      }
      await route.abort('connectionrefused')
    })
    await page.goto('https://ezacto.io/')
    await cleanupClient(page, 123, 'Deployment E2E report-marker', () => {})
  })
}
`)
    await writeFile(join(directory, 'playwright.config.ts'), `
import { defineConfig } from ${testModule}
export default defineConfig({ testDir: '.', workers: 1, retries: 0,
  reporter: [['json', { outputFile: 'report.json' }], ['html', { outputFolder: 'html', open: 'never' }]],
  use: { headless: true, trace: 'off', screenshot: 'off' }
})
`)
    const result = await promisify(execFile)(process.execPath, [join(dirname(require.resolve('playwright/package.json')), 'cli.js'), 'test', '--config', join(directory, 'playwright.config.ts')], {
      cwd: directory, env: { ...process.env, EZACTO_REPORT_COOKIE: secret }, timeout: 30_000,
    }).then(() => ({ code: 0 }), (error: unknown) => error as { code: number })
    expect(result.code).toBe(1)
    const json = await readFile(join(directory, 'report.json'), 'utf8')
    expect(JSON.parse(json).stats.unexpected).toBe(2)
    const html = await readFile(join(directory, 'html/index.html'), 'utf8')
    const embedded = [...html.matchAll(/base64,([A-Za-z0-9+/=]+)/g)]
      .map(match => Buffer.from(match[1]!, 'base64')).find(buffer => buffer.subarray(0, 2).toString() === 'PK')
    expect(embedded).toBeDefined()
    const retained = (await reportContents(embedded!)).join('\n')
    expect(retained).toContain('Deployment test cleanup could not finish client lookup.')
    expect(retained).toContain('Deployment test cleanup could not finish client deletion.')
    expect(retained).not.toContain(secret)
    expect(json).not.toContain(secret)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
