import { sql } from 'drizzle-orm'
import {
  scheduledReviewTokenHash,
  verifyScheduledReviewToken,
  type ScheduledReviewLinkOutcome,
} from '@ezacto/core'
import type { createScheduledActionStore } from './scheduled-actions.js'
type Database = Parameters<typeof createScheduledActionStore>[0]
/** The one mutation this credential permits is recording its authenticated opening. */
export const consumeScheduledReviewLink = async (
  database: Database,
  key: Uint8Array,
  runId: number,
  userId: number,
  token: string,
  now: string,
): Promise<ScheduledReviewLinkOutcome> => {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('Invalid review-link clock.')
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(token)) return 'invalid'
  const hash = await scheduledReviewTokenHash(token)
  const read = async () =>
    (
      await database.all<{ expires_at: string; consumed_at: string | null }>(
        sql`SELECT expires_at,consumed_at FROM scheduled_run_review_links WHERE token_hash=${hash} AND run_id=${runId} AND user_id=${userId}`,
      )
    )[0]
  const record = await read()
  if (
    !record ||
    !(await verifyScheduledReviewToken(token, { runId, userId, expiresAt: record.expires_at }, key))
  )
    return 'invalid'
  if (Date.parse(record.expires_at) <= Date.parse(now)) return 'expired'
  if (record.consumed_at !== null) return 'used'
  const updated = await database.all<{
    run_id: number
  }>(sql`UPDATE scheduled_run_review_links SET consumed_by_user_id=${userId},consumed_at=${now}
    WHERE token_hash=${hash} AND run_id=${runId} AND user_id=${userId} AND consumed_at IS NULL
      AND julianday(expires_at)>julianday(${now}) AND julianday(created_at)<=julianday(${now})
      AND EXISTS(SELECT 1 FROM users WHERE id=${userId} AND is_active=1 AND profile='administrator') RETURNING run_id`)
  if (updated.length) return 'accepted'
  return (await read())?.consumed_at ? 'used' : 'invalid'
}
