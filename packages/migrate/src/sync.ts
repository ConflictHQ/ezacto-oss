// `ezacto-migrate sync` — keep a parallel-run snapshot current without making
// it lossy. It first delegates all changed-row handling to extract, then walks
// every current collection by ID. Raw rows are intentionally never removed:
// deleted_upstream is a tombstone instruction for a downstream upsert/load.

import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarvestEnv } from './env.js'
import {
  createExtractSession,
  runExtract,
  type ExtractResult,
  type ExtractSession,
} from './extract.js'
import { readIds, restoreDeletedRows } from './jsonl.js'
import {
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestFullIdSweep,
} from './manifest.js'
import { paginate } from './paginator.js'
import { RESOURCES, type ResourceStep } from './resources.js'

export interface RunSyncOptions {
  env: HarvestEnv
  snapshotDir: string
  now?: () => Date
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
  timeoutMs?: number
}

export interface SyncSweepResult extends ManifestFullIdSweep {
  deleted: number
  restored: number
}

export interface SyncResult {
  extract: ExtractResult
  sweeps: Record<string, SyncSweepResult>
  /** New tombstones written during this run. */
  deleted: number
  /** Existing tombstones cleared because an ID reappeared upstream. */
  restored: number
  /** Both phases, including identity checks and retry attempts. */
  requests: number
  durationMs: number
}

const isApiError = (err: unknown): err is Error & { status: number } =>
  err instanceof Error && typeof (err as { status?: unknown }).status === 'number'

const idFrom = (value: unknown, resource: string): number => {
  if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'number') {
    throw new Error(`${resource}: full-ID sweep received a row without a numeric "id"`)
  }
  return (value as { id: number }).id
}

/** All IDs represented by raw/<resource>.jsonl, excluding known tombstones. */
const currentRawIds = async (
  snapshotDir: string,
  resource: string,
  deleted: ReadonlySet<number>,
): Promise<number[]> => {
  const ids: number[] = []
  for await (const id of readIds(snapshotDir, resource)) {
    if (!deleted.has(id)) ids.push(id)
  }
  return ids
}

/**
 * Follow every page of an unfiltered collection, retaining just its IDs. A
 * missing or mismatched total_entries is not a witness: callers must not mark
 * a deletion from a sweep that cannot prove it reached the end.
 */
const witnessedIds = async (
  step: ResourceStep,
  session: ExtractSession,
  parentIds: readonly number[] | null,
): Promise<{ ids: Set<number>; totalEntries: number; requests: number } | null> => {
  const ids = new Set<number>()
  let totalEntries = 0
  let requests = 0
  let hasWitness = true

  const sweep = async (path: string, params?: Record<string, string>): Promise<void> => {
    let tallied = false
    for await (const page of paginate(
      { resource: `${step.name} ID sweep`, path, collection: step.collection, params },
      session.config,
      session.deps,
    )) {
      if (!tallied) {
        if (page.totalEntries === null) {
          // Some documented nested endpoints omit total_entries. Follow their
          // pages anyway, but do not publish a deletion decision this response
          // cannot prove. A healthy account must not fail sync merely because an
          // endpoint cannot provide the required witness.
          hasWitness = false
        } else {
          totalEntries += page.totalEntries
        }
        tallied = true
      }
      requests += page.requests
      for (const object of page.objects) ids.add(idFrom(object, step.name))
    }
  }

  try {
    if (step.kind === 'list') {
      for (const pass of step.passes ?? [undefined]) await sweep(step.path, { ...step.params, ...pass })
    } else {
      for (const parentId of parentIds ?? []) await sweep(step.path(parentId))
    }
  } catch (err) {
    // An optional endpoint that is disabled cannot witness absence. Leave its
    // previous deletion state untouched rather than translating a 403 into an
    // account-wide tombstone.
    if (step.kind === 'child' && step.optional && isApiError(err) && [403, 404, 422].includes(err.status)) {
      return null
    }
    throw err
  }

  if (!hasWitness) return null
  if (ids.size !== totalEntries) {
    throw new Error(
      `${step.name}: full-ID sweep saw ${ids.size} distinct id(s), but Harvest reported ` +
        `${totalEntries}; no deletion marks were published`,
    )
  }
  return { ids, totalEntries, requests }
}

const enabled = (manifest: Manifest, step: ResourceStep): boolean =>
  !step.requires || manifest.preflight[step.requires]

/**
 * The extractor legitimately replaces full-sweep files (child and
 * noUpdatedSince resources). Sync needs their old IDs and verbatim rows until
 * it has a completed witness, so it durably snapshots raw/ before extraction.
 */
const captureRaw = async (snapshotDir: string, backupDir: string, resource: string): Promise<boolean> => {
  const source = join(snapshotDir, 'raw', `${resource}.jsonl`)
  const target = join(backupDir, 'raw', `${resource}.jsonl`)
  await mkdir(join(backupDir, 'raw'), { recursive: true })
  try {
    await copyFile(source, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  const handle = await open(target, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Incrementally extract, then publish deletion marks resource-by-resource only
 * after their entire full-ID witness has completed. This is deliberately
 * one-directional: no Harvest request here ever writes or mutates upstream.
 */
export const runSync = async (options: RunSyncOptions): Promise<SyncResult> => {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.log(line))
  const started = Date.now()
  const initial = await readManifest(options.snapshotDir)
  const session = createExtractSession({
    env: options.env,
    accountId: initial.account.id,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    log,
    sleep: options.sleep,
  })

  const backupDir = await mkdtemp(join(options.snapshotDir, '.sync-before-'))
  try {
    const backedUp = new Set<string>()
    for (const step of RESOURCES) {
      if (enabled(initial, step) && (await captureRaw(options.snapshotDir, backupDir, step.name))) {
        backedUp.add(step.name)
      }
    }

    const extract = await runExtract({ ...options, session })
    const manifest = await readManifest(options.snapshotDir)
    const deletedUpstream: Record<string, number[]> = { ...(manifest.deleted_upstream ?? {}) }
    const fullIdSweeps: Record<string, ManifestFullIdSweep> = { ...(manifest.full_id_sweeps ?? {}) }
    const sweeps: Record<string, SyncSweepResult> = {}
    let deleted = 0
    let restored = 0

    for (const step of RESOURCES) {
      if (!enabled(manifest, step)) continue

      const restorePriorRows = async (): Promise<void> => {
        if (!backedUp.has(step.name)) return
        const allPriorIds = new Set<number>()
        for await (const id of readIds(backupDir, step.name)) allPriorIds.add(id)
        const restoredRows = await restoreDeletedRows(
          options.snapshotDir,
          step.name,
          backupDir,
          allPriorIds,
        )
        manifest.resources[step.name].count += restoredRows
      }

      const priorDeleted = new Set(deletedUpstream[step.name] ?? [])
      const parents =
        step.kind === 'child'
          ? await currentRawIds(options.snapshotDir, step.parent, new Set(deletedUpstream[step.parent] ?? []))
          : null
      let witness: Awaited<ReturnType<typeof witnessedIds>>
      try {
        witness = await witnessedIds(step, session, parents)
      } catch (err) {
        // A short/malformed witness is not permission to discard rows that a
        // full extract replaced. Restore the pre-sync bytes before surfacing
        // the refusal, without publishing any deletion metadata.
        await restorePriorRows()
        await writeManifest(options.snapshotDir, manifest)
        throw err
      }
      if (witness === null) {
        await restorePriorRows()
        await writeManifest(options.snapshotDir, manifest)
        log(`${step.name}: no full-ID witness available; leaving deletion marks unchanged`)
        continue
      }

      // Compute the entire delta against the pre-extract source when it exists.
      // Full extract steps replace their raw file, so comparing against the file
      // after extract would erase the very IDs sync is supposed to tombstone.
      const nextDeleted = new Set(priorDeleted)
      let added = 0
      let cleared = 0
      if (backedUp.has(step.name)) {
        for await (const id of readIds(backupDir, step.name)) {
          if (!witness.ids.has(id) && !nextDeleted.has(id)) {
            nextDeleted.add(id)
            added += 1
          }
        }
      }
      for (const id of witness.ids) {
        if (nextDeleted.delete(id)) cleared += 1
      }

      // Re-add only rows the witness has proved gone, and only after the full
      // witness. This keeps raw/ lossless even though extract replaces a full
      // resource file as part of its normal resumable extraction semantics.
      if (backedUp.has(step.name)) {
        const restoredRows = await restoreDeletedRows(
          options.snapshotDir,
          step.name,
          backupDir,
          nextDeleted,
        )
        manifest.resources[step.name].count += restoredRows
      }

      const fullIdSweep: ManifestFullIdSweep = {
        completed_at: now().toISOString(),
        seen_count: witness.ids.size,
        total_entries: witness.totalEntries,
        requests: witness.requests,
      }
      if (nextDeleted.size === 0) delete deletedUpstream[step.name]
      else deletedUpstream[step.name] = [...nextDeleted].sort((a, b) => a - b)
      fullIdSweeps[step.name] = fullIdSweep
      manifest.deleted_upstream = deletedUpstream
      manifest.full_id_sweeps = fullIdSweeps
      await writeManifest(options.snapshotDir, manifest)

      sweeps[step.name] = { ...fullIdSweep, deleted: added, restored: cleared }
      deleted += added
      restored += cleared
    }

    return {
      extract,
      sweeps,
      deleted,
      restored,
      requests: session.limiter.granted,
      durationMs: Date.now() - started,
    }
  } finally {
    await rm(backupDir, { recursive: true, force: true })
  }
}
