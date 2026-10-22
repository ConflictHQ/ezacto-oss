import { readFile, stat } from 'node:fs/promises'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import { isMigrationLoadId, queuedMigrationLimits, QueuedMigrationError } from '@ezacto/core'
import { cloudflareMigrationOperator } from './cloudflare-operator.js'
import { startQueuedSnapshot, uploadQueuedSnapshot } from './queued-upload.js'

export const queuedMigrationCommands = [
  'queue-upload',
  'queue-start',
  'queue-status',
  'queue-retry',
  'queue-cancel',
] as const
export const runQueuedMigrationCommand = async (
  command: string,
  values: Record<string, unknown>,
): Promise<number> => {
  const text = (name: string) =>
    typeof values[name] === 'string' ? (values[name] as string) : undefined
  const databaseId = text('target-d1'),
    bucket = text('bucket'),
    queueId = text('queue-id')
  const runId = text('run-id') ?? (command === 'queue-upload' ? crypto.randomUUID() : undefined)
  if (!databaseId || !bucket || !queueId || !runId || !isMigrationLoadId(runId))
    throw new Error(
      'Queued commands require --target-d1, --bucket, --queue-id and --run-id (upload may generate one).',
    )
  if (
    command !== 'queue-status' &&
    command !== 'queue-upload' &&
    text('confirm-target-d1') !== databaseId
  )
    throw new Error(
      'Repeat --target-d1 as --confirm-target-d1 before starting, retrying or cancelling a run.',
    )
  const operator = cloudflareMigrationOperator({
    databaseId,
    bucket,
    queueId,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
  })
  const store = createQueuedMigrationStore(operator.database)
  try {
    if (command === 'queue-upload') {
      // Persist this safe review identity in the terminal before a long stream can be interrupted.
      console.log(
        JSON.stringify({
          run_id: runId,
          target_d1: databaseId,
          bucket,
          queue_id: queueId,
          action: 'upload_only',
        }),
      )
      let decisions: unknown = {}
      if (text('input')) {
        if ((await stat(text('input')!)).size > queuedMigrationLimits.optionsBytes)
          throw new QueuedMigrationError('invalid_migration_options', 'options')
        decisions = JSON.parse(await readFile(text('input')!, 'utf8'))
      }
      const status = await uploadQueuedSnapshot(
        {
          snapshotDir: text('snapshot-dir') ?? './snapshot',
          runId,
          options: {
            ...(typeof decisions === 'object' && decisions !== null && !Array.isArray(decisions)
              ? decisions
              : (() => {
                  throw new QueuedMigrationError('invalid_migration_options', 'options')
                })()),
            ...(text('organization-currency') === undefined
              ? {}
              : { organizationCurrency: text('organization-currency') }),
            ...(text('organization-address') === undefined
              ? {}
              : { organizationAddress: text('organization-address') }),
          },
        },
        operator,
      )
      console.log(JSON.stringify(status))
      return 0
    }
    if (command === 'queue-start') {
      console.log(
        JSON.stringify(
          await startQueuedSnapshot(
            { runId, confirmDatabaseId: text('confirm-target-d1')! },
            operator,
          ),
        ),
      )
      return 0
    }
    if (command === 'queue-retry') {
      const prior = await store.status(runId)
      const message =
        prior?.status === 'completed' && prior.sourceCleanedAt === null
          ? { kind: 'migration-load-v1' as const, runId, sequence: prior.sequence }
          : await store.retry(runId, new Date().toISOString())
      await operator.send(message)
      await store.sent(message, new Date().toISOString())
    }
    if (command === 'queue-cancel') await store.cancel(runId, new Date().toISOString())
    const status = await store.status(runId)
    if (!status) throw new QueuedMigrationError('migration_not_found', 'id')
    console.log(JSON.stringify(status))
    return 0
  } catch (error) {
    if (error instanceof QueuedMigrationError) throw new Error(`${error.code}: ${error.message}`)
    throw new Error(
      'migration_command_failed: verify the deployment migration ledger, Cloudflare permissions and the private snapshot before retrying; provider and source diagnostics are redacted.',
    )
  }
}
