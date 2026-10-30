/** Public Worker contract. Credentials and source options stay outside queue deliveries. */
export interface MigrationQueueProducer {
  send(message: { kind: 'migration-load-v1'; runId: string; sequence: number }): Promise<unknown>
}
export interface QueuedLoaderEnvironment {
  DB: D1Database
  ATTACHMENTS: R2Bucket
  MIGRATION_QUEUE: MigrationQueueProducer
}
export interface QueuedLoadDeliveryOptions {
  now?: () => number
  maxRows?: number
  maxStatements?: number
  leaseTtlMs?: number
}
export type QueuedLoadDeliveryResult = { ack: true } | { retryAfterSeconds: number }
export declare const deliverQueuedLoad: (
  env: QueuedLoaderEnvironment,
  body: unknown,
  deliveryAttempts: number,
  options?: QueuedLoadDeliveryOptions,
) => Promise<QueuedLoadDeliveryResult>
