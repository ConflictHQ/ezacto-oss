import { canonicalTimestamp } from './0029_outbox_delivery.js'

/** A throttled background run resumes later without sleeping or losing its CDC cursor. */
export const quickBooksRetryMigration = [
  `ALTER TABLE quickbooks_sync_cursors ADD COLUMN retry_not_before TEXT
    CHECK (retry_not_before IS NULL OR (${canonicalTimestamp('retry_not_before')}))`,
] as const
