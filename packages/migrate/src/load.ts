/** Local CLI facade; the shared engine itself has no filesystem/native dependency. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as engine from './load-engine.js'
import { fileChildIndexStore, type ChildIndexStore } from './child-index-store.js'
import { fileSnapshotSource, type SnapshotSource } from './snapshot-source.js'
import { snapshotDigest, verifySnapshot } from './verify.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import type { ImportDatabase } from '@ezacto/db/importer'
export * from './load-engine.js'
export type LoadNextChunkOptions = Omit<
  engine.LoadNextChunkOptions,
  'source' | 'indexStore' | 'artifacts'
> & {
  snapshotDir: string
  source?: SnapshotSource
  indexStore?: ChildIndexStore
}
export type ClaimLoadLeaseOptions = Omit<engine.ClaimLoadLeaseOptions, 'source' | 'artifacts'> & {
  snapshotDir: string
  source?: SnapshotSource
}
const fileArtifacts = async (snapshotDir: string): Promise<engine.SnapshotArtifacts> => {
  const [manifestText, checksumsText] = await Promise.all([
    readFile(join(snapshotDir, 'manifest.json'), 'utf8'),
    readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
  ])
  return {
    manifestText,
    checksumsText,
    readBinary: (path) => readFile(join(snapshotDir, path)),
    binaryKey: (path) => path,
    verify: (manifest) => verifySnapshot(snapshotDir, manifest),
    digest: (manifest) => snapshotDigest(snapshotDir, manifest),
  }
}
export const loadNextChunk = async (input: LoadNextChunkOptions): Promise<engine.LoadChunkResult> =>
  engine.loadNextChunk({
    ...input,
    source: input.source ?? fileSnapshotSource(input.snapshotDir),
    indexStore: input.indexStore ?? fileChildIndexStore(input.snapshotDir),
    artifacts: await fileArtifacts(input.snapshotDir),
  })
export const claimLoadLease = async (input: ClaimLoadLeaseOptions): Promise<engine.LoadLease> =>
  engine.claimLoadLease({
    ...input,
    source: input.source ?? fileSnapshotSource(input.snapshotDir),
    artifacts: await fileArtifacts(input.snapshotDir),
  })

export interface RunLoadOptions extends Omit<LoadNextChunkOptions, 'database'> {
  databasePath: string
}

export interface RunLoadResult {
  snapshotSha256: string
  loadedRows: number
  invocations: number
  anomalies: engine.LoadAnomaly[]
}

export const runLoad = async (options: RunLoadOptions): Promise<RunLoadResult> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'load')
  try {
    const [{ default: BetterSqlite3 }, databaseModule] = await Promise.all([
      import('better-sqlite3'),
      import('@ezacto/db'),
    ])
    const sqlite = new BetterSqlite3(options.databasePath)
    try {
      databaseModule.migrateContainer(sqlite)
      const database = databaseModule.createContainerDatabase(sqlite) as ImportDatabase
      let loadedRows = 0
      let invocations = 0
      let snapshotSha256 = ''
      while (true) {
        const result = await loadNextChunk({ ...options, database })
        snapshotSha256 = result.snapshotSha256
        loadedRows += result.loadedRows
        invocations++
        if (result.complete) {
          const report = await engine.assertLoadComplete(database, snapshotSha256)
          return { snapshotSha256, loadedRows, invocations, anomalies: report.anomalies }
        }
      }
    } finally {
      sqlite.close()
    }
  } finally {
    await releaseSnapshotLock(lock)
  }
}
