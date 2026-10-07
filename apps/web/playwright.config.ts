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

// The navigation is a sidebar by default and a top bar on request, by a cookie
// (the 2026-10 reskin). EZACTO_BROWSER_NAV=topbar starts every spec with that
// cookie set, so the whole suite -- written against the top bar -- can be run
// against it as well as against the sidebar.
const topbarCookie =
  process.env.EZACTO_BROWSER_NAV === 'topbar'
    ? {
        storageState: {
          cookies: [
            {
              name: 'ezacto_nav',
              value: 'topbar',
              domain: '127.0.0.1',
              path: '/',
              expires: -1,
              httpOnly: false,
              secure: false,
              sameSite: 'Lax' as const,
            },
          ],
          origins: [],
        },
      }
    : {}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // A spec gets 30s, but every individual assertion was running on
  // Playwright's 5s default, and the two are not the same budget. The
  // rate-change spec signs in at /team/1, whose post-sign-in fan-out is the
  // heaviest in the file -- whoami, team status, the person, the catalog and a
  // full week snapshot, all concurrently through one Miniflare worker, behind
  // an Argon2id verify at 19 MiB. Every other spec signs in at / and pays for a
  // week load alone. On a loaded two-core runner that one path exceeded 5s and
  // the spec failed at its first heading assertion with 29s of its own budget
  // still unspent.
  expect: { timeout: 15_000 },
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
    ...topbarCookie,
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
