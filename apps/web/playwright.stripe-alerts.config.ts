import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.env['EZACTO_STRIPE_FIXTURE_PORT'] ??= '4195'
process.env['EZACTO_STRIPE_FIXTURE_PASSWORD'] ??= randomBytes(32).toString('base64url')
process.env['EZACTO_STRIPE_FIXTURE_WEBHOOK_SECRET'] ??= randomBytes(32).toString('base64url')
if (!process.env['EZACTO_STRIPE_FIXTURE_DIRECTORY']) {
  process.env['EZACTO_STRIPE_FIXTURE_DIRECTORY'] = realpathSync(mkdtempSync(join(tmpdir(), 'ezacto-owned-stripe-browser-')))
  process.env['EZACTO_STRIPE_FIXTURE_NONCE'] = randomBytes(32).toString('hex')
  writeFileSync(join(process.env['EZACTO_STRIPE_FIXTURE_DIRECTORY'], '.owned-browser-fixture'), process.env['EZACTO_STRIPE_FIXTURE_NONCE'], { mode: 0o600 })
}
const directory = realpathSync(process.env['EZACTO_STRIPE_FIXTURE_DIRECTORY']!)
if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('ezacto-owned-stripe-browser-') || !process.env['EZACTO_STRIPE_FIXTURE_NONCE'] || readFileSync(join(directory, '.owned-browser-fixture'), 'utf8') !== process.env['EZACTO_STRIPE_FIXTURE_NONCE']) throw new Error('Refusing an unowned Stripe browser fixture')
export default defineConfig({
  testDir: './e2e', testMatch: '**/stripe-alerts.container.ts', workers: 1, fullyParallel: false, retries: 0,
  outputDir: './test-results/stripe-alerts', timeout: 60_000, expect: { timeout: 15_000 }, reporter: 'line',
  use: { baseURL: `http://localhost:${process.env['EZACTO_STRIPE_FIXTURE_PORT']}`, browserName: 'chromium', headless: true, viewport: { width: 390, height: 844 }, trace: 'off' },
  webServer: { command: 'node apps/web/scripts/browser-stripe-container-harness.mjs', cwd: repository, url: `http://localhost:${process.env['EZACTO_STRIPE_FIXTURE_PORT']}/healthz`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe', gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 } },
})
