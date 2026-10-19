import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readManifest, writeManifest } from '../src/manifest.js'
import { checksumReportDigest, snapshotDigest, type ChecksumReport } from '../src/verify.js'

/** Re-seals checksums.json after a test edits the invented snapshot. */
export const refreshChecksum = async (snapshotDir: string): Promise<void> => {
  const checksumsPath = join(snapshotDir, 'checksums.json')
  const checksums = JSON.parse(await readFile(checksumsPath, 'utf8')) as ChecksumReport
  checksums.snapshot_sha256 = await snapshotDigest(snapshotDir, await readManifest(snapshotDir))
  const { report_sha256: previous, ...payload } = checksums
  void previous
  checksums.report_sha256 = checksumReportDigest(payload)
  await writeFile(checksumsPath, `${JSON.stringify(checksums)}\n`)
}

/**
 * Pads the fixture's users to `length` invented accounts, so the child index
 * has more parents than one invocation's work budget and a build spans several
 * invocations. The invented addresses use the reserved `.invalid` domain.
 */
export const inflateUsers = async (snapshotDir: string, length: number): Promise<void> => {
  const userPath = join(snapshotDir, 'raw', 'users.jsonl')
  const originalUsers = (await readFile(userPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const users = Array.from({ length }, (_, index) => ({
    ...(originalUsers[index] ?? originalUsers[0]),
    id: originalUsers[index]?.id ?? 1_700_000 + index,
    email: originalUsers[index]?.email ?? `padding-${index}@example.invalid`,
  }))
  await writeFile(userPath, `${users.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const manifest = await readManifest(snapshotDir)
  manifest.preflight.organization_currency = 'USD'
  manifest.resources.users!.count = users.length
  await writeManifest(snapshotDir, manifest)
  await refreshChecksum(snapshotDir)
}
