// Resolve the portable workspace source in clean checkouts; the npm entry is a standalone bundle.
import { deliverQueuedLoad } from '../../../packages/migrate/src/queued-loader.js'
import { ensureRuntimeDatabaseReady } from './runtime.js'
import type { WorkerEnv } from './app.js'

export const consumeMigrationBatch = async (batch: MessageBatch<unknown>, env: WorkerEnv) => {
  if (!env.DB || !env.ATTACHMENTS || !env.MIGRATION_QUEUE)
    throw new Error('Queued migration bindings are incomplete')
  // Privacy quarantine applies to imports too. This deliberately does not use the
  // ordinary-service migration barrier, which the importer itself owns.
  await ensureRuntimeDatabaseReady(env.DB)
  for (const message of batch.messages) {
    const result = await deliverQueuedLoad(
      { DB: env.DB, ATTACHMENTS: env.ATTACHMENTS, MIGRATION_QUEUE: env.MIGRATION_QUEUE },
      message.body,
      message.attempts,
    )
    if ('ack' in result) message.ack()
    else message.retry({ delaySeconds: result.retryAfterSeconds })
  }
}
