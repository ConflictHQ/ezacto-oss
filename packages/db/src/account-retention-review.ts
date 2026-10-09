import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  RetentionReviewError,
  hasAccountDeletionControlCharacters,
  type AccountRetentionReviewStore,
  type RetentionObligation,
} from '@ezacto/core'
import type * as schema from './schema.js'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Row = Omit<RetentionObligation, 'hold_active'> & { hold_active: number }
const record = (row: Row): RetentionObligation => ({ ...row, hold_active: row.hold_active === 1 })
const time = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const prose = (value: string, required = true) =>
  typeof value === 'string' &&
  value.length <= 2000 &&
  (!required || value.trim().length >= 10) &&
  !hasAccountDeletionControlCharacters(value)
export function createAccountRetentionReviewRepository(
  database: Database,
): AccountRetentionReviewStore {
  const admin = async (actor: number) => {
    if (
      !(
        await database.all(
          sql`SELECT 1 FROM users WHERE id=${actor} AND is_active=1 AND profile='administrator'`,
        )
      ).length
    )
      throw new RetentionReviewError('administrator_required')
  }
  const read = async (actor: number, id: string) => {
    await admin(actor)
    const rows = await database.all<Row>(
      sql`SELECT * FROM account_retention_obligations WHERE request_id=${id} ORDER BY area`,
    )
    if (!rows.length) throw new RetentionReviewError('closure_required')
    return rows.map(record)
  }
  return {
    read,
    async list(actor, now, after = '') {
      await admin(actor)
      if (!time(now)) throw new RetentionReviewError('invalid_review')
      return (
        await database.all<Row>(sql`SELECT * FROM account_retention_obligations
        WHERE (decision IN ('pending','failed','release_hold') OR next_review_at<=${now}) AND request_id||'/'||area>${after}
        ORDER BY request_id,area LIMIT 100`)
      ).map(record)
    },
    async review(input) {
      await admin(input.actorUserId)
      const rows = await read(input.actorUserId, input.requestId)
      const current = rows.find((row) => row.area === input.area)
      if (!current || current.version !== input.expectedVersion)
        throw new RetentionReviewError('review_changed')
      const retain = input.decision === 'retain',
        release = input.decision === 'release_hold'
      if (
        input.acknowledged !== true ||
        !['retain', 'removed', 'not_applicable', 'failed', 'release_hold'].includes(
          input.decision,
        ) ||
        !time(input.now) ||
        !prose(input.evidence) ||
        !prose(input.basis, retain) ||
        !prose(input.releaseCondition, retain) ||
        (retain
          ? input.nextReviewAt === null ||
            !time(input.nextReviewAt) ||
            input.nextReviewAt <= input.now
          : input.nextReviewAt !== null) ||
        (release && !current.hold_active) ||
        (input.decision === 'not_applicable' &&
          current.kind === 'retained_category' &&
          current.area === 'legal_hold' &&
          current.hold_active)
      )
        throw new RetentionReviewError('invalid_review')
      if (current.hold_active && !['retain', 'failed', 'release_hold'].includes(input.decision))
        throw new RetentionReviewError('hold_release_required')
      const updated =
        await database.all<Row>(sql`UPDATE account_retention_obligations SET decision=${input.decision},basis=${input.basis.trim()},release_condition=${input.releaseCondition.trim()},
        evidence=${input.evidence.trim()},next_review_at=${input.nextReviewAt},hold_active=CASE WHEN ${release ? 1 : 0}=1 THEN 0 ELSE hold_active END,
        version=version+1,reviewed_at=${input.now},actor_user_id=${input.actorUserId}
        WHERE request_id=${input.requestId} AND area=${input.area} AND version=${input.expectedVersion}
          AND EXISTS(SELECT 1 FROM users WHERE id=${input.actorUserId} AND is_active=1 AND profile='administrator') RETURNING *`)
      if (!updated[0]) throw new RetentionReviewError('review_changed')
      return record(updated[0])
    },
    async complete(input) {
      const rows = await read(input.actorUserId, input.requestId)
      if (input.acknowledged !== true || !time(input.now) || !input.appleResolved)
        throw new RetentionReviewError('review_incomplete')
      if (
        rows.some(
          (row) =>
            ['pending', 'failed', 'release_hold'].includes(row.decision) ||
            (row.decision === 'retain' && (!row.next_review_at || row.next_review_at <= input.now)),
        )
      )
        throw new RetentionReviewError('review_incomplete')
      const expected = Object.fromEntries(rows.map((row) => [row.area, row.version]))
      if (
        Object.keys(expected).length !== Object.keys(input.expectedReviews).length ||
        Object.entries(expected).some(([key, value]) => input.expectedReviews[key] !== value)
      )
        throw new RetentionReviewError('review_changed')
      const retained = rows
        .filter((row) => row.decision === 'retain')
        .map(
          (row) =>
            `${row.area.replaceAll('_', ' ')} (review by ${row.next_review_at!.slice(0, 10)})`,
        )
      const confirmation = `Local account access and sign-in credentials were removed. The operator reviewed downstream cleanup evidence.${retained.length ? ` Records remain under documented retention: ${retained.join('; ')}.` : ' No reviewed category remains designated for retention.'} This confirms the reviewed request outcome; it does not certify legal compliance or guarantee that all historical copies are physically destroyed.`
      const serialized = JSON.stringify(expected)
      const updated = await database.all<{
        completed_at: string
      }>(sql`UPDATE account_deletion_requests SET status='completed',completed_at=${input.now},completion_confirmation=${confirmation},message=${confirmation},
        updated_at=${input.now},updated_by_user_id=${input.actorUserId},version=version+1
        WHERE id=${input.requestId} AND version=${input.expectedRequestVersion} AND status<>'completed'
          AND EXISTS(SELECT 1 FROM account_closures WHERE request_id=${input.requestId})
          AND EXISTS(SELECT 1 FROM users WHERE id=${input.actorUserId} AND is_active=1 AND profile='administrator')
          AND NOT EXISTS(SELECT 1 FROM account_retention_obligations obligation WHERE request_id=${input.requestId} AND
            (version IS NOT json_extract(${serialized},'$.'||area) OR decision IN ('pending','failed','release_hold') OR (decision='retain' AND (next_review_at IS NULL OR next_review_at<=${input.now}))))
          AND (SELECT count(*) FROM account_retention_obligations WHERE request_id=${input.requestId})=json_array_length(json(${JSON.stringify(Object.keys(expected))}))
          RETURNING completed_at`)
      if (!updated[0]) throw new RetentionReviewError('review_changed')
      return { completed_at: updated[0].completed_at, confirmation }
    },
  }
}
