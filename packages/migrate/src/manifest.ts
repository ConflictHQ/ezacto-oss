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

/**
 * Per-resource extract progress — the resume record §2.4 rests on. Rewritten
 * after every page, so a crash or a 429 storm leaves a snapshot that describes
 * itself accurately rather than one that has to be re-derived from raw/.
 */
export interface ManifestResource {
  /** Objects appended to raw/<resource>.jsonl so far. */
  count: number
  /**
   * `total_entries` as Harvest reported it, summed over the sweeps this resource is
   * made of (one per pass, one per parent), or null when no page carried it.
   *
   * The only outside witness to how big the collection was. `count` is what we
   * wrote, and is self-consistent with any truncation — a `links.next: null` that
   * should not have been null leaves both numbers agreeing on a snapshot that is
   * missing most of the account. Recorded here because re-asking Harvest costs the
   * extract budget again, and `verify` runs later (migration-spec §6).
   */
  total_entries: number | null
  /** Pages consumed; with `requests`, the cost record §2.2 asks extract to print. */
  pages: number
  requests: number
  /**
   * Child parents that answered 404: rows deleted between the parent sweep and the
   * fan-out. Extract runs against an account people are still using (§5), so this is
   * a race rather than a failure — but their children are absent from the snapshot
   * and will not turn up on a re-read, so a consumer comparing counts has to know.
   */
  missing_parents: number
  /**
   * The next page URL exactly as Harvest returned it in `links.next`, or null at
   * the end of the collection. A *URL*, never a bare cursor: the doc mandate is to
   * follow `links` verbatim (research §0.4), and a resume that rebuilt a URL from a
   * stored cursor would be constructing pagination links by hand at the one moment
   * it matters most.
   */
  next_url: string | null
  /** For child steps (per-user rates, per-invoice messages), the parent id in flight. */
  parent_id: number | null
  /** Index into the step's `passes` — which sweep of a multi-pass step is in flight. */
  pass: number
  complete: boolean
  /**
   * True while `count`/`pages`/`next_url` describe an `updated_since`-filtered
   * pass over an already-complete resource, rather than the original full sweep.
   * Read back on resume so a killed incremental pass continues as one — with
   * `updated_since` still applied and without re-imposing the full-sweep
   * `total_entries` shortfall check a filtered query cannot satisfy — instead of
   * being mistaken for an interrupted first sweep.
   */
  incremental: boolean
  /** Why this resource holds nothing: a disabled feature, or a 403 on an optional step. */
  skipped_reason: string | null
  /** Captured before the step's first request — the watermark a later incremental run reads. */
  started_at: string
  finished_at: string | null
}

export interface Manifest {
  account: { id: string; name: string }
  company_name: string
  started_at: string
  finished_at: string | null
  tool_version: string
  preflight: ManifestPreflight
  resources: Record<string, ManifestResource>
  /** ISO watermark per resource: the time extract started sweeping it. */
  updated_since: Record<string, string>
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
