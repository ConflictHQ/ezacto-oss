import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'
process.env.EZACTO_BROWSER_CALENDAR_FIXTURE = '1'
export default defineConfig({
  ...base,
  testMatch: '**/calendar-oauth.browser.ts',
  outputDir: './test-results/calendar-oauth',
  use: { ...base.use, baseURL: `http://localhost:${process.env.EZACTO_BROWSER_PORT}` },
})
