import {
  migrationInputPrefix,
  parseMigrationLoadMessage,
  QueuedMigrationError,
  type MigrationLoadMessage,
} from '@ezacto/core'
import { createD1Database } from '@ezacto/db/d1'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import {
  assertLoadComplete,
  claimLoadLease,
  loadNextChunk,
  readLoadProgress,
  releaseLoadLease,
  LoadLeaseHeldError,
  LoadLeaseLostError,
  LoadSnapshotChangedError,
  type LoadLease,
} from './load-engine.js'
import { openQueuedSnapshot } from './queued-snapshot.js'
import { r2ChildIndexStore } from './r2-child-index-store.js'
import { migrationD1 } from './queued-d1.js'

import type {
  QueuedLoaderEnvironment,
  QueuedLoadDeliveryOptions,
  QueuedLoadDeliveryResult,
} from './queued-loader-api.js'
export type {
  QueuedLoaderEnvironment,
  QueuedLoadDeliveryOptions,
  QueuedLoadDeliveryResult,
  MigrationQueueProducer,
} from './queued-loader-api.js'

/** Delivery contains no options or credentials. All authority comes from the pinned D1 job. */
export const deliverQueuedLoad = async (
  env: QueuedLoaderEnvironment,
  body: unknown,
  deliveryAttempts: number,
  options: QueuedLoadDeliveryOptions = {},
): Promise<QueuedLoadDeliveryResult> => {
  let message: MigrationLoadMessage
  try {
    message = parseMigrationLoadMessage(body)
  } catch {
    return { retryAfterSeconds: 60 }
  } // Poison messages reach the configured DLQ.
  const now = options.now ?? Date.now,
    timestamp = () => new Date(now()).toISOString()
  const store = createQueuedMigrationStore(env.DB),
    database = createD1Database(env.DB)
  const job = await store.job(message.runId)
  if (!job || job.status === 'cancelled') return { ack: true }
  const cleanCompletedInput = async () => {
    if (job.sourceCleanedAt !== null) return
    const prefix = migrationInputPrefix(job.id)
    // Receipts/avatars/PDFs are retained archive/attachment objects. Raw rows,
    // metadata and rebuildable index caches have no purpose after verified completion.
    const keys = job.catalog.files
      .filter(
        (file) =>
          file.path.startsWith('raw/') ||
          file.path === 'manifest.json' ||
          file.path === 'checksums.json',
      )
      .map((file) => prefix + file.path)
    keys.push(`migrate/${job.id}/index/checkpoint.json`, `migrate/${job.id}/catalog.json`)
    try {
      for (let at = 0; at < keys.length; at += 1000)
        await env.ATTACHMENTS.delete(keys.slice(at, at + 1000))
      await store.sourceCleaned(job.id, timestamp())
    } catch (error) {
      await store.cleanupFailed(job.id, timestamp())
      throw error
    }
  }
  if (job.status === 'completed') {
    await cleanCompletedInput()
    return { ack: true }
  }
  if (job.status === 'failed') return { retryAfterSeconds: 60 }
  const publish = async () => {
    const intent = await store.pending(message.runId)
    if (intent) {
      try {
        await env.MIGRATION_QUEUE.send(intent)
      } catch (error) {
        await store.publicationFailed(intent, timestamp())
        throw error
      }
      await store.sent(intent, timestamp())
    }
  }
  if (message.sequence < job.sequence) {
    await publish()
    return { ack: true }
  }
  if (message.sequence !== job.sequence || job.status === 'ready') return { retryAfterSeconds: 60 }
  let lease: LoadLease | undefined
  try {
    const snapshot = await openQueuedSnapshot(env.ATTACHMENTS, job.catalog)
    if (!(await store.begin(message, timestamp()))) {
      await publish()
      return { ack: true }
    }
    lease = await claimLoadLease({
      database,
      source: snapshot.source,
      artifacts: snapshot.artifacts,
      now,
      ...(options.leaseTtlMs === undefined ? {} : { ttlMs: options.leaseTtlMs }),
    })
    const fenced = createD1Database(migrationD1(env.DB, job.id, lease))
    const result = await loadNextChunk({
      database: fenced,
      source: snapshot.source,
      artifacts: snapshot.artifacts,
      indexStore: r2ChildIndexStore(env.ATTACHMENTS, `migrate/${job.id}/index`),
      lease,
      immutableSnapshotSha256: job.snapshotSha256,
      ...job.options,
      maxRows: options.maxRows ?? 25,
      maxStatements: options.maxStatements ?? 100,
    })
    if (result.complete) await assertLoadComplete(fenced, job.snapshotSha256)
    const progress = await readLoadProgress(fenced)
    await store.checkpoint(
      message,
      lease,
      {
        resource: result.resource ?? null,
        rowsDone: progress.reduce((sum, row) => sum + row.rowsLoaded, 0),
        complete: result.complete,
      },
      timestamp(),
    )
    // A durable intent exists before send. Redelivery of the previous sequence republishes it.
    await releaseLoadLease(database, lease)
    lease = undefined
    if (result.complete) await cleanCompletedInput()
    await publish()
    return { ack: true }
  } catch (error) {
    if (error instanceof LoadLeaseHeldError)
      return {
        retryAfterSeconds: Math.min(300, Math.max(1, Math.ceil((error.expiresAt - now()) / 1000))),
      }
    if (
      error instanceof LoadLeaseLostError ||
      (error instanceof QueuedMigrationError && error.code === 'migration_lease_lost')
    )
      return { retryAfterSeconds: 5 }
    const permanent =
      error instanceof QueuedMigrationError || error instanceof LoadSnapshotChangedError
    if (permanent || deliveryAttempts >= 5) {
      const code =
        error instanceof QueuedMigrationError
          ? error.code
          : error instanceof LoadSnapshotChangedError
            ? 'migration_snapshot_changed'
            : 'migration_chunk_failed'
      await store.fail(message, code, timestamp(), lease)
    }
    return { retryAfterSeconds: 60 }
  } finally {
    if (lease) {
      // Cancellation/failure can remove job write authority, but releasing this lease
      // uses the raw control connection and still requires the current holder/fence.
      try {
        await releaseLoadLease(database, lease)
      } catch (error) {
        if (!(error instanceof LoadLeaseLostError)) throw error
      }
    }
  }
}
