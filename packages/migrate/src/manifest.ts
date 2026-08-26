// snapshot/manifest.json — the load-bearing artifact shared with extract/verify
// (migration-spec §2.3). This story only writes the account/preflight subset;
// `resources` and `updated_since` are left as empty placeholders for extract to fill.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ManifestPreflight {
  clock: string
  wants_timestamp_timers: boolean
  expense_feature: boolean
  invoice_feature: boolean
  estimate_feature: boolean
  approval_feature: boolean
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

export const writeManifest = async (dir: string, data: Manifest): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export const readManifest = async (dir: string): Promise<Manifest> => {
  const raw = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  return JSON.parse(raw) as Manifest
}
