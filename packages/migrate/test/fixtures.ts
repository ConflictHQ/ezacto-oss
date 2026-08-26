// Shared preflight fixtures. `/v2/company` carries fourteen settings the manifest
// records, so spelling them out per test would bury what each test is actually
// asserting — every test states only the fields it cares about.

import type { ManifestCompanySettings, ManifestPreflight } from '../src/manifest.js'

export const COMPANY_SETTINGS: ManifestCompanySettings = {
  clock: '12h',
  wants_timestamp_timers: true,
  expense_feature: true,
  invoice_feature: true,
  estimate_feature: true,
  approval_feature: true,
  week_start_day: 'Monday',
  time_format: 'decimal',
  date_format: '%m/%d/%Y',
  currency_code_display: 'iso_code_none',
  currency_symbol_display: 'symbol_before',
  decimal_symbol: '.',
  thousands_separator: ',',
  weekly_capacity: 126000,
}

/** A verbatim `/v2/company` response body. */
export const COMPANY_RESPONSE: Record<string, unknown> = {
  name: 'CONFLICT',
  ...COMPANY_SETTINGS,
}

export const ADMIN_USER = { id: 1, access_roles: ['administrator'], is_administrator: true }

export const preflight = (overrides: Partial<ManifestPreflight> = {}): ManifestPreflight => ({
  ...COMPANY_SETTINGS,
  user: ADMIN_USER,
  ...overrides,
})
