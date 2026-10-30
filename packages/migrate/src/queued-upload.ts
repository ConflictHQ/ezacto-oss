import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  isMigrationLoadId,
  migrationInputPrefix,
  parseMigrationLoadOptions,
  parseMigrationSnapshotCatalog,
  queuedMigrationLimits,
  QueuedMigrationError,
  type MigrationSnapshotFile,
} from '@ezacto/core'
import { assertCutoverMigrationLedger, type MigrationLedgerRow } from '@ezacto/db'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import { childIndexBytesNeeded } from './load-engine.js'
import { readManifest } from './manifest.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import {
  checksumReportDigest,
  snapshotDigest,
  verifySnapshot,
  type ChecksumReport,
} from './verify.js'
import {
  declaredSnapshotBinaries,
  queuedSourceFingerprint,
  validateQueuedSnapshotMetadata,
} from './queued-snapshot.js'
import { RESOURCES } from './resources.js'
import { cloudflareMigrationOperator } from './cloudflare-operator.js'
type Operator = ReturnType<typeof cloudflareMigrationOperator>
const invalid = (code: string): never => {
  throw new QueuedMigrationError(code)
}

/** Upload/review and start are separate commands. This method never enqueues a load. */
export const uploadQueuedSnapshot = async (
  input: { snapshotDir: string; runId: string; options?: unknown },
  operator: Operator,
) => {
  if (!isMigrationLoadId(input.runId)) return invalid('invalid_migration_id')
  const decisions = parseMigrationLoadOptions(input.options ?? {}),
    store = createQueuedMigrationStore(operator.database)
  const ledger = await operator.database
    .prepare('SELECT id,statements_sha256 FROM _ezacto_migrations ORDER BY id')
    .all<MigrationLedgerRow>()
  assertCutoverMigrationLedger(ledger.results)
  const lock = await acquireSnapshotLock(input.snapshotDir, 'load')
  try {
    const root = await realpath(input.snapshotDir)
    const safePath = async (path: string, emptyAllowed = false): Promise<string | null> => {
      const absolute = resolve(root, path)
      const actual = await realpath(absolute).catch((error) => {
        if (emptyAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (actual === null) return null
      if (!actual.startsWith(root + sep) || (await stat(actual)).isDirectory())
        return invalid('invalid_migration_file')
      return actual
    }
    const metadata = async (path: string) => {
      const absolute = await safePath(path)
      if ((await stat(absolute!)).size > queuedMigrationLimits.metadataBytes)
        return invalid('migration_metadata_too_large')
      return readFile(absolute!, 'utf8')
    }
    const manifestText = await metadata('manifest.json'),
      checksumsText = await metadata('checksums.json')
    const manifest = await readManifest(root),
      checksums = JSON.parse(checksumsText) as ChecksumReport
    const { report_sha256, ...report } = checksums
    if (checksumReportDigest(report) !== report_sha256)
      return invalid('invalid_migration_checksums')
    const paths = new Map<string, { emptyAllowed: boolean; sha256?: string; bytes?: number }>([
      ['manifest.json', { emptyAllowed: false }],
      ['checksums.json', { emptyAllowed: false }],
    ])
    for (const [name, resource] of Object.entries(manifest.resources)) {
      const step = RESOURCES.find((step) => step.name === name)
      if (!step) return invalid('invalid_migration_resource')
      paths.set(`raw/${name}.jsonl`, { emptyAllowed: resource.count === 0 })
      if (step.kind === 'child')
        paths.set(`raw/${name}.lineage.jsonl`, { emptyAllowed: resource.count === 0 })
    }
    for (const asset of declaredSnapshotBinaries(manifest))
      paths.set(asset.path, { emptyAllowed: false, sha256: asset.sha256, bytes: asset.bytes })
    if (
      paths.size > queuedMigrationLimits.files ||
      childIndexBytesNeeded(manifest) > queuedMigrationLimits.indexBytes
    )
      return invalid('migration_snapshot_too_large')
    const plan: { file: Omit<MigrationSnapshotFile, 'etag'>; absolute: string | null }[] = []
    // Bound every raw line before the existing verifier parses JSON rows.
    for (const [path, declared] of paths) {
      const absolute = await safePath(path, declared.emptyAllowed),
        raw = path.startsWith('raw/')
      const maximum = raw
        ? queuedMigrationLimits.rawBytes
        : path.endsWith('.json')
          ? queuedMigrationLimits.metadataBytes
          : queuedMigrationLimits.binaryBytes
      if (absolute && (await stat(absolute)).size > maximum)
        return invalid('migration_object_too_large')
      const hash = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0,
        line = 0,
        maxLineBytes = 0
      if (absolute)
        for await (const chunk of createReadStream(absolute)) {
          const buffer = Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > maximum) return invalid('migration_object_too_large')
          hash.update(buffer)
          if (raw) {
            decoder.decode(buffer, { stream: true })
            for (const byte of buffer) {
              if (byte === 10) {
                maxLineBytes = Math.max(maxLineBytes, line)
                line = 0
              } else line++
              if (line > queuedMigrationLimits.lineBytes) return invalid('migration_line_too_large')
            }
          }
        }
      if (raw) {
        decoder.decode()
        maxLineBytes = Math.max(maxLineBytes, line)
      }
      const sha256 = hash.digest('hex')
      if (declared.sha256 !== undefined && (sha256 !== declared.sha256 || bytes !== declared.bytes))
        return invalid('migration_binary_mismatch')
      plan.push({ file: { path, bytes, sha256, ...(raw ? { maxLineBytes } : {}) }, absolute })
    }
    if ((await verifySnapshot(root, manifest)).length !== 0)
      return invalid('migration_verification_failed')
    if ((await snapshotDigest(root, manifest)) !== checksums.snapshot_sha256)
      return invalid('migration_snapshot_changed')
    const existing = await store.job(input.runId)
    if (existing) {
      if (
        existing.snapshotSha256 !== checksums.snapshot_sha256 ||
        JSON.stringify(existing.options) !== JSON.stringify(decisions)
      )
        return invalid('migration_input_immutable')
      return (await store.status(input.runId))!
    }
    if (
      (await store.blocked()) ||
      (await operator.database
        .prepare('SELECT 1 FROM users UNION ALL SELECT 1 FROM organizations LIMIT 1')
        .first())
    )
      return invalid('migration_destination_not_empty')
    const prefix = migrationInputPrefix(input.runId),
      files: MigrationSnapshotFile[] = []
    for (const { file, absolute } of plan) {
      const key = prefix + file.path
      let remote = await operator.inspectObject(key, file.bytes)
      if (remote === null) {
        const body = absolute
          ? (Readable.toWeb(createReadStream(absolute)) as unknown as BodyInit)
          : new Uint8Array(0)
        await operator.putObject(key, body, file.bytes)
        remote = await operator.inspectObject(key, file.bytes)
      }
      if (!remote || remote.bytes !== file.bytes || remote.sha256 !== file.sha256)
        return invalid('migration_upload_mismatch')
      files.push({ ...file, etag: remote.etag })
    }
    const catalog = parseMigrationSnapshotCatalog({
      version: 1,
      jobId: input.runId,
      snapshotSha256: checksums.snapshot_sha256,
      manifestSha256: files.find((file) => file.path === 'manifest.json')!.sha256,
      checksumsSha256: files.find((file) => file.path === 'checksums.json')!.sha256,
      sourceFingerprint: queuedSourceFingerprint({ files }, manifest),
      sourceRows: Object.values(manifest.resources).reduce(
        (sum, resource) => sum + resource.count,
        0,
      ),
      indexBytes: childIndexBytesNeeded(manifest),
      files,
    })
    validateQueuedSnapshotMetadata(catalog, manifestText, checksumsText)
    // Re-check after streaming: advisory file locks cannot stop an external editor.
    if (
      (await snapshotDigest(root, manifest)) !== catalog.snapshotSha256 ||
      (await metadata('manifest.json')) !== manifestText ||
      (await metadata('checksums.json')) !== checksumsText
    )
      return invalid('migration_snapshot_changed')
    return store.create(catalog, decisions, new Date().toISOString())
  } finally {
    await releaseSnapshotLock(lock)
  }
}

export const startQueuedSnapshot = async (
  input: { runId: string; confirmDatabaseId: string },
  operator: Operator,
) => {
  if (!isMigrationLoadId(input.runId) || operator.databaseId !== input.confirmDatabaseId)
    return invalid('migration_target_confirmation_required')
  const store = createQueuedMigrationStore(operator.database),
    now = new Date().toISOString()
  const message = await store.start(input.runId, now)
  await operator.send(message)
  await store.sent(message, new Date().toISOString())
  return (await store.status(input.runId))!
}
