import { defineConfig } from '@playwright/test'

if (!/^[a-f0-9]{40}$/.test(process.env.EZACTO_EXPECTED_RELEASE ?? '')) {
  throw new Error('EZACTO_EXPECTED_RELEASE must identify the deployed commit')
}

export default defineConfig({
  testDir: './e2e/postdeploy',
  testMatch: '**/*.live.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: 'test-results/postdeploy',
  reporter: [['line'], ['html', { outputFolder: 'playwright-report/postdeploy', open: 'never' }]],
  use: {
    // This suite writes disposable demo records. It must never target real books.
    baseURL: 'https://ezacto.io',
    browserName: 'chromium',
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'deployed-desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'deployed-mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
})
