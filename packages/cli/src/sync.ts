import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { verifyBackup, type BackupManifest } from './backup.js'
import type { S3Client } from './s3.js'

export interface SyncDestination {
  client: S3Client
  bucket: string
  /** Key prefix with no leading or trailing slash; may be empty. */
  prefix: string
}

export interface SyncObject {
  /** Path inside the bundle, also the tail of the object key. */
  path: string
  key: string
  sha256: string
  action: 'uploaded' | 'skipped'
}

export interface SyncResult {
  bundleName: string
  objects: SyncObject[]
  uploaded: number
  skipped: number
  uploadedBytes: number
}

const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')

/**
 * Copy a backup bundle to an S3-compatible bucket as `<prefix>/<bundle>/<path>`.
 *
 * - The bundle is verified first. A missing manifest or any mismatched hash
 *   refuses the sync before a single byte leaves, so a corrupt bundle is never
 *   promoted to the only off-site copy.
 * - Every object is sent with its sha256 and the destination checks it.
 * - An object already there with the same size and checksum is skipped, so a
 *   sync interrupted at any point resumes by running it again.
 * - `manifest.json` goes last. A prefix without a manifest is an incomplete
 *   upload by definition; a prefix with one is complete.
 */
export const syncBundle = async (
  bundleDirectory: string,
  destination: SyncDestination,
): Promise<SyncResult> => {
  const directory = resolve(bundleDirectory)
  const verification = await verifyBackup(directory)
  if (!verification.valid) {
    throw new Error(
      `refusing to sync ${directory}: the bundle failed verification\n${verification.errors.map((error) => `  - ${error}`).join('\n')}`,
    )
  }
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as BackupManifest

  for (const attachment of manifest.attachments) {
    if (attachment.path.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(
        `refusing to sync ${directory}: attachment path ${attachment.path} leaves the bundle`,
      )
    }
  }

  const bundleName = basename(directory)
  const root = [destination.prefix, bundleName].filter((part) => part !== '').join('/')
  const paths = [
    'db.sqlite',
    ...manifest.tables.map((table) => `tables/${table.name}.csv`),
    ...manifest.attachments.map((attachment) => attachment.path),
    'RESTORE.md',
    'manifest.json',
  ]

  const objects: SyncObject[] = []
  let uploadedBytes = 0
  for (const path of paths) {
    const body = await readFile(join(directory, path))
    const digest = sha256(body)
    const key = `${root}/${path}`
    const existing = await destination.client.head(destination.bucket, key)
    if (
      existing !== null &&
      existing.size === body.length &&
      existing.sha256 === digest
    ) {
      objects.push({ path, key, sha256: digest, action: 'skipped' })
      continue
    }
    await destination.client.put(destination.bucket, key, body, digest)
    uploadedBytes += body.length
    objects.push({ path, key, sha256: digest, action: 'uploaded' })
  }

  return {
    bundleName,
    objects,
    uploaded: objects.filter((object) => object.action === 'uploaded').length,
    skipped: objects.filter((object) => object.action === 'skipped').length,
    uploadedBytes,
  }
}
