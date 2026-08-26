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
  /**
   * Lines in raw/<resource>.jsonl — one per object, and after an incremental
   * pass has merged, one per object id. Unchanged while such a pass is in
   * flight: its rows are staged beside the file until it finishes.
   */
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
   *
   * It describes the last *full* sweep, and nothing later: an `updated_since` pass
   * merges rows into the file `count` describes without ever re-tallying the
   * collection, so once `incremental` is true this number and `count` are no longer
   * a pair. The pass's own witness is the pair below — read that one instead.
   */
  total_entries: number | null
  /**
   * The same pair, scoped to one `updated_since` pass: the rows it staged into
   * raw/<resource>.jsonl.incoming, and Harvest's `total_entries` for the *filtered*
   * query, summed over the pass's sweeps.
   *
   * A filtered pass needs a witness of its own, and had none: `total_entries` above
   * counts the collection rather than the changed rows, and `count` describes a file
   * the pass has not merged into yet, so comparing either to the other reads every
   * ordinary pass as a truncation. Left with no comparison at all, a filtered sweep
   * that stopped at a `links.next: null` that should not have been null was stamped
   * `complete`, given a fresh watermark, and the rows it never fetched went behind
   * that watermark permanently — the same silent loss the full-sweep path refuses.
   * These two are self-contained: both count only what this pass asked for and got.
   *
   * Reset at the start of every pass — one is always re-run from page 1, never
   * resumed from a cursor — and 0/null on a full-sweep record.
   */
  staged_count: number
  staged_total_entries: number | null
  /** Pages consumed; with `requests`, the cost record §2.2 asks extract to print. */
  pages: number
  requests: number
  /**
   * Child parents that answered 404: rows deleted between the parent sweep and the
   * fan-out. Extract runs against an account people are still using (§5), so this is
   * a race rather than a failure — but their children are absent from the snapshot
   * and will not turn up on a re-read, so a consumer comparing counts has to know.
   *
   * Written at the refusal, not after the last parent: a fan-out is resumed from a
   * checkpoint, and a tally only added up at the end of the loop is a tally a crash
   * erases — leaving the resumed run to report full coverage of a resource whose
   * children are demonstrably absent.
   */
  missing_parents: number
  /**
   * Parents an `optional` step was refused for, and the status they were refused
   * with (403 "not authorized for this object", 404). Checkpointed per refusal for
   * the same reason as `missing_parents`: `skipped_reason` below is composed after
   * the last parent, so without these a crash mid-fan-out loses every refusal the
   * dead run observed, and the resumed run — which skips past those parents — has
   * nothing left to compose it from.
   */
  refused_parents: number
  refused_status: number | null
  /**
   * The next page URL exactly as Harvest returned it in `links.next`, or null at
   * the end of the collection. A *URL*, never a bare cursor: the doc mandate is to
   * follow `links` verbatim (research §0.4), and a resume that rebuilt a URL from a
   * stored cursor would be constructing pagination links by hand at the one moment
   * it matters most.
   */
  next_url: string | null
  /**
   * For child steps (per-user rates, per-invoice messages), the parent the fan-out
   * last dealt with — swept, or recorded missing/refused.
   *
   * Read back *positionally*: it means "every parent before this one in
   * raw/<parent>.jsonl was dealt with, and this one up to `next_url`". So it
   * describes the parent file as that run left it, not a set of ids — and a parent
   * file emptied and swept again from page 1 is a different file, over which the
   * checkpoint means nothing. extract drops it there rather than resuming into a
   * list that may have reordered, dropped the checkpointed id, or grown rows in
   * front of it.
   */
  parent_id: number | null
  /** Index into the step's `passes` — which sweep of a multi-pass step is in flight. */
  pass: number
  complete: boolean
  /**
   * True from the moment a run claims this resource until its passes (or its
   * parents) are exhausted — so a record found `interrupted: true` is one a
   * process died inside, and the cursor above is a checkpoint worth resuming
   * from. Cleared when the sweep runs out of passes, whatever its tallies then
   * say.
   *
   * `next_url: null` cannot carry that on its own. It reads identically for
   * "this pass ran to the end of its cursor", "this pass never got a page" and
   * "the sweep ended short of total_entries", and only the middle case has
   * anything left to fetch at the recorded spot. Resuming either of the others
   * issues no requests at all: it stamped a watermark over rows that had never
   * been fetched, and it made a short sweep unfinishable — every re-run
   * reproducing it exactly, forever.
   */
  interrupted: boolean
  /**
   * True while `count`/`pages`/`next_url` describe an `updated_since`-filtered
   * pass over an already-complete resource, rather than the original full sweep.
   * Read back on resume so a killed incremental pass is re-run as one — with
   * `updated_since` still applied and measured against the pass's own witness pair
   * rather than the full-sweep tally a filtered query cannot satisfy — instead of
   * being mistaken for an interrupted first sweep and re-sweeping the account.
   *
   * The pass's rows live in raw/<resource>.jsonl.incoming until it finishes, so
   * `count` keeps describing raw/<resource>.jsonl throughout one, and an
   * interrupted pass is re-run from its first page rather than resumed from a
   * cursor: it is bounded by what changed since the watermark, and a filtered
   * sweep whose rows have not been merged yet has nothing to duplicate.
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
