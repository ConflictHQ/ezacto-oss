// snapshot/manifest.json — the load-bearing artifact shared with extract/verify
// (migration-spec §2.3). This story only writes the account/preflight subset;
// `resources` and `updated_since` are filled in by extract and must survive any
// later write from another command (§2.4: they are the resume record).

import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The authenticating user, recorded because it changes what the snapshot *is*:
 * a member-scoped PAT sees only its own time entries and projects, so a partial
 * snapshot must be distinguishable from a complete one — by `extract` (which
 * warns before its first request) and by `reconcile` (which must be able to
 * explain the resulting deltas, migration-spec §6).
 */
export interface ManifestPreflightUser {
  id: number
  access_roles: string[]
  is_administrator: boolean
}

/**
 * Everything `/v2/company` tells us that a later command needs, recorded once at
 * preflight because extract is the expensive, rate-limited step and none of the
 * commands after it call `/v2/company` again (migration-spec §1 step 2, §2.1).
 *
 * Two groups, and the distinction matters when this drifts between runs:
 *  - *parse inputs* — `clock` decides how `started_time`/`ended_time` strings are
 *    read back, `wants_timestamp_timers` which time-entry shape to expect, and the
 *    four `*_feature` flags which resource trees exist at all.
 *  - *display settings* — carried verbatim into the `organization` row at load.
 */
export interface ManifestCompanySettings {
  clock: string
  wants_timestamp_timers: boolean
  expense_feature: boolean
  invoice_feature: boolean
  estimate_feature: boolean
  approval_feature: boolean
  week_start_day: string
  time_format: string
  date_format: string
  currency_code_display: string
  currency_symbol_display: string
  decimal_symbol: string
  thousands_separator: string
  weekly_capacity: number
}

/** The scalar keys of ManifestCompanySettings, for drift reporting on a re-run. */
export const COMPANY_SETTING_KEYS = [
  'clock',
  'wants_timestamp_timers',
  'expense_feature',
  'invoice_feature',
  'estimate_feature',
  'approval_feature',
  'week_start_day',
  'time_format',
  'date_format',
  'currency_code_display',
  'currency_symbol_display',
  'decimal_symbol',
  'thousands_separator',
  'weekly_capacity',
] as const satisfies readonly (keyof ManifestCompanySettings)[]

export interface ManifestPreflight extends ManifestCompanySettings {
  user: ManifestPreflightUser
}

export interface Manifest {
  account: { id: string; name: string }
  company_name: string
  started_at: string
  finished_at: string | null
  tool_version: string
  preflight: ManifestPreflight
  resources: Record<string, unknown>
  updated_since: Record<string, unknown>
}

const MANIFEST_FILE = 'manifest.json'

/**
 * Writes manifest.json atomically (tmp + fsync + rename): §2.4 resumability
 * depends on the file surviving a crash or a 429 storm mid-write — a truncated
 * manifest loses every cursor and watermark in the snapshot.
 */
export const writeManifest = async (dir: string, data: Manifest): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const target = join(dir, MANIFEST_FILE)
  const tmp = `${target}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, target)
}

export const readManifest = async (dir: string): Promise<Manifest> => {
  const raw = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  return JSON.parse(raw) as Manifest
}

/** Same as readManifest, but `null` when the snapshot dir has no manifest yet. */
export const readManifestIfExists = async (dir: string): Promise<Manifest | null> => {
  try {
    return await readManifest(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
