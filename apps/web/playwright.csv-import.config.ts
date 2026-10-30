import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.env['EZACTO_CSV_FIXTURE_PORT'] ??= '4191'
process.env['EZACTO_CSV_FIXTURE_PASSWORD'] ??= randomBytes(32).toString('base64url')
if (!process.env['EZACTO_CSV_FIXTURE_DIRECTORY']) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ezacto-owned-csv-browser-')))
  process.env['EZACTO_CSV_FIXTURE_DIRECTORY'] = directory
  process.env['EZACTO_CSV_FIXTURE_NONCE'] = randomBytes(32).toString('hex')
  writeFileSync(join(directory, '.owned-browser-fixture'), process.env['EZACTO_CSV_FIXTURE_NONCE']!, { mode: 0o600 })
}
const directory = realpathSync(process.env['EZACTO_CSV_FIXTURE_DIRECTORY']!)
if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('ezacto-owned-csv-browser-') || !process.env['EZACTO_CSV_FIXTURE_NONCE'] || readFileSync(join(directory, '.owned-browser-fixture'), 'utf8') !== process.env['EZACTO_CSV_FIXTURE_NONCE']) throw new Error('Refusing an unowned CSV browser fixture directory')
const origin = `http://localhost:${process.env['EZACTO_CSV_FIXTURE_PORT']}`

export default defineConfig({
  testDir: './e2e', testMatch: '**/csv-import.container.ts', fullyParallel: false, workers: 1, retries: 0,
  // The preceding standard browser suite owns the parent; retain its receipts and PNGs.
  outputDir: './test-results/csv-container',
  timeout: 90_000, expect: { timeout: 15_000 }, reporter: 'line',
  use: { baseURL: origin, browserName: 'chromium', headless: true, viewport: { width: 390, height: 844 }, trace: 'off' },
  webServer: { command: 'node apps/web/scripts/browser-csv-container-harness.mjs', cwd: repositoryRoot, url: `${origin}/healthz`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe' },
})
