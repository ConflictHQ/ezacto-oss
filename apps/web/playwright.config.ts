import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.env.EZACTO_BROWSER_FIXTURE_EMAIL ??= 'browser-owner@example.test'
process.env.EZACTO_BROWSER_FIXTURE_PASSWORD ??= randomBytes(32).toString(
  'base64url',
)
process.env.EZACTO_BROWSER_FIXTURE_INSTANT ??= '2026-08-31T01:00:00.000Z'
process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE ??= 'America/Costa_Rica'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    timezoneId: process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE,
    viewport: { width: 390, height: 844 },
    // Authentication acceptance uses a generated password. Keep it out of
    // retained traces as well as URLs, browser storage, and console output.
    trace: 'off',
  },
  webServer: {
    command: 'node apps/web/scripts/browser-worker-harness.mjs',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:4173/healthz',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
