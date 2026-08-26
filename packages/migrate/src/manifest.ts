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

export interface ManifestPreflight {
  clock: string
  wants_timestamp_timers: boolean
  expense_feature: boolean
  invoice_feature: boolean
  estimate_feature: boolean
  approval_feature: boolean
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
