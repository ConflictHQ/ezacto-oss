import {
  migrationInputPrefix,
  parseMigrationSnapshotCatalog,
  queuedMigrationLimits,
  QueuedMigrationError,
  type MigrationSnapshotCatalog,
  type MigrationSnapshotFile,
} from '@ezacto/core'
import { childIndexBytesNeeded, type SnapshotArtifacts } from './load-engine.js'
import type { Manifest, ManifestBinaryAsset } from './manifest.js'
import { RESOURCES } from './resources.js'
import { linesFromStream, type SnapshotSource } from './r2-snapshot-source.js'
import { sha256Hex } from './portable-hash.js'
export interface QueuedSnapshot {
  catalog: MigrationSnapshotCatalog
  manifest: Manifest
  source: SnapshotSource
  artifacts: SnapshotArtifacts
}
const invalid = (field: string): never => {
  throw new QueuedMigrationError('invalid_migration_snapshot', field)
}
const changed = (field: string): never => {
  throw new QueuedMigrationError('migration_snapshot_changed', field)
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The only binary files that may be copied or exposed as imported attachments. */
export const declaredSnapshotBinaries = (
  manifest: Manifest,
): readonly Pick<ManifestBinaryAsset, 'path' | 'bytes' | 'sha256'>[] => {
  const output = new Map<string, Pick<ManifestBinaryAsset, 'path' | 'bytes' | 'sha256'>>()
  const candidates: unknown[] = [
    ...Object.values(manifest.binaries?.receipts ?? {}),
    ...Object.values(manifest.binaries?.avatars ?? {}),
    ...Object.values(manifest.binaries?.invoice_pdfs?.records ?? {}),
  ]
  for (const item of candidates) {
    if (!record(item)) return invalid('binaries')
    if (
      typeof item.path !== 'string' ||
      !/^(?:receipts|avatars|invoice-pdfs)\/[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,10})?$/.test(
        item.path,
      ) ||
      typeof item.sha256 !== 'string' ||
      item.path.split('/')[1]!.split('.')[0] !== item.sha256 ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > queuedMigrationLimits.binaryBytes
    )
      return invalid('binaries')
    const previous = output.get(item.path)
    if (previous && (previous.sha256 !== item.sha256 || previous.bytes !== item.bytes))
      return invalid('binaries')
    output.set(item.path, { path: item.path, bytes: item.bytes, sha256: item.sha256 })
  }
  return [...output.values()]
}

export const openQueuedSnapshot = async (
  bucket: Pick<R2Bucket, 'get' | 'head'>,
  input: unknown,
  indexBudget: number = queuedMigrationLimits.indexBytes,
): Promise<QueuedSnapshot> => {
  const catalog = parseMigrationSnapshotCatalog(input),
    prefix = migrationInputPrefix(catalog.jobId)
  const files = new Map(catalog.files.map((file) => [file.path, file]))
  const fileFor = (path: string): MigrationSnapshotFile => files.get(path) ?? invalid('files')
  const head = async (path: string) => {
    const expected = fileFor(path),
      actual = await bucket.head(prefix + path)
    if (!actual || actual.etag !== expected.etag || actual.size !== expected.bytes)
      return changed(path)
    return expected
  }
  const read = async (path: string): Promise<Uint8Array> => {
    const expected = fileFor(path),
      actual = await bucket.get(prefix + path, { onlyIf: { etagMatches: expected.etag } })
    if (
      !actual ||
      !('body' in actual) ||
      actual.etag !== expected.etag ||
      actual.size !== expected.bytes
    )
      return changed(path)
    const bytes = new Uint8Array(await actual.arrayBuffer())
    if (bytes.length !== expected.bytes || sha256Hex(bytes) !== expected.sha256)
      return changed(path)
    return bytes
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const [manifestBytes, checksumBytes] = await Promise.all([
    read('manifest.json'),
    read('checksums.json'),
  ])
  const manifestText = decoder.decode(manifestBytes),
    checksumsText = decoder.decode(checksumBytes)
  const manifest = validateQueuedSnapshotMetadata(catalog, manifestText, checksumsText, indexBudget)
  const binaryPaths = new Set(declaredSnapshotBinaries(manifest).map((binary) => binary.path))
  const source: SnapshotSource = {
    openRaw: async function* (resource, offset) {
      const path = `raw/${resource}.jsonl`,
        expected = fileFor(path)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > expected.bytes)
        return invalid('byteOffset')
      if (offset === expected.bytes) {
        await head(path)
        return
      }
      const actual = await bucket.get(prefix + path, {
        onlyIf: { etagMatches: expected.etag },
        ...(offset === 0 ? {} : { range: { offset } }),
      })
      if (
        !actual ||
        !('body' in actual) ||
        actual.etag !== expected.etag ||
        actual.size !== expected.bytes
      )
        return changed(path)
      yield* linesFromStream(actual.body, {
        maxLineBytes: expected.maxLineBytes ?? queuedMigrationLimits.lineBytes,
      })
    },
    size: async (resource) => (await head(`raw/${resource}.jsonl`)).bytes,
    fingerprint: async (resource) => {
      const file = await head(`raw/${resource}.jsonl`)
      return `${file.bytes}:${file.etag}`
    },
    describe: (resource) => prefix + `raw/${resource}.jsonl`,
  }
  const immutableOnly = async (): Promise<never> => {
    throw new QueuedMigrationError('migration_requires_immutable_admission')
  }
  return {
    catalog,
    manifest,
    source,
    artifacts: {
      manifestText,
      checksumsText,
      readBinary: (path) =>
        binaryPaths.has(path)
          ? read(path)
          : Promise.reject(new QueuedMigrationError('invalid_migration_binary')),
      binaryKey: (path) => (binaryPaths.has(path) ? prefix + path : invalid('binary')),
      verify: immutableOnly,
      digest: immutableOnly,
    },
  }
}

/** A pure admission check shared by the uploader and the Worker. */
export const validateQueuedSnapshotMetadata = (
  catalog: MigrationSnapshotCatalog,
  manifestText: string,
  checksumsText: string,
  indexBudget: number = queuedMigrationLimits.indexBytes,
): Manifest => {
  if (
    sha256Hex(manifestText) !== catalog.manifestSha256 ||
    sha256Hex(checksumsText) !== catalog.checksumsSha256
  )
    return invalid('metadata')
  const files = new Map(catalog.files.map((file) => [file.path, file]))
  const fileFor = (path: string) => files.get(path) ?? invalid('files')
  const manifest = JSON.parse(manifestText) as Manifest,
    checksums: unknown = JSON.parse(checksumsText)
  if (
    !record(manifest) ||
    typeof manifest.finished_at !== 'string' ||
    !Number.isFinite(Date.parse(manifest.finished_at)) ||
    !record(manifest.preflight) ||
    !record(manifest.preflight.user) ||
    manifest.preflight.user.is_administrator !== true ||
    !record(manifest.resources) ||
    !record(checksums)
  )
    return invalid('metadata')
  const { report_sha256: reportDigest, ...report } = checksums
  if (
    report.snapshot_sha256 !== catalog.snapshotSha256 ||
    sha256Hex(JSON.stringify(report)) !== reportDigest
  )
    return invalid('checksums')
  const required = new Set(['manifest.json', 'checksums.json'])
  let rows = 0
  for (const [name, progress] of Object.entries(manifest.resources)) {
    const step = RESOURCES.find((resource) => resource.name === name)
    if (
      !step ||
      !record(progress) ||
      typeof progress.count !== 'number' ||
      !Number.isSafeInteger(progress.count) ||
      progress.count < 0 ||
      progress.complete !== true ||
      progress.interrupted === true
    )
      return invalid('resources')
    rows += progress.count
    required.add(`raw/${name}.jsonl`)
    if (step.kind === 'child') required.add(`raw/${name}.lineage.jsonl`)
  }
  for (const binary of declaredSnapshotBinaries(manifest)) {
    const entry = fileFor(binary.path)
    if (entry.sha256 !== binary.sha256 || entry.bytes !== binary.bytes) return invalid('binaries')
    required.add(binary.path)
  }
  if (rows !== catalog.sourceRows) return invalid('sourceRows')
  if (childIndexBytesNeeded(manifest) !== catalog.indexBytes) return invalid('indexBytes')
  if (catalog.indexBytes > indexBudget)
    throw new QueuedMigrationError('migration_snapshot_too_large', 'indexBytes')
  if (files.size !== required.size || [...required].some((path) => !files.has(path)))
    return invalid('files')
  if (queuedSourceFingerprint(catalog, manifest) !== catalog.sourceFingerprint)
    return invalid('sourceFingerprint')
  return manifest
}
export const queuedSourceFingerprint = (
  catalog: Pick<MigrationSnapshotCatalog, 'files'>,
  manifest: Manifest,
): string => {
  const files = new Map(catalog.files.map((file) => [file.path, file]))
  const fileFor = (path: string) => files.get(path) ?? invalid('files')
  const names: string[] = []
  for (const step of RESOURCES) {
    if ((manifest.resources[step.name]?.count ?? 0) === 0) continue
    names.push(step.name)
    if (step.kind === 'child') names.push(`${step.name}.lineage`)
  }
  const fingerprint = sha256Hex(
    names
      .sort()
      .map((name) => {
        const file = fileFor(`raw/${name}.jsonl`)
        return `${name}=${file.bytes}:${file.etag}`
      })
      .join('\n'),
  )
  return fingerprint
}
